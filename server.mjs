import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import AdmZip from "adm-zip";
import cors from "cors";

// ---------- CONFIG ----------

// CHANGE THIS:
const GITHUB_OWNER = "superaceCZ";
const GITHUB_REPO = "android-apk-builder";
const GITHUB_BRANCH = "main";
const GITHUB_WORKFLOW_FILE = "build-apk.yml"; // file name in .github/workflows/
const ZIP_NAME = "AndroidProject.zip";  
const CANONICAL_ZIP_NAME = "AndroidProject.zip";// must match your export name

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("ERROR: GITHUB_TOKEN env var not set.");
  // Render will show this in logs if you forget to set it
}

// ---------- EXPRESS SETUP ----------

const app = express();
const upload = multer(); // in-memory
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ---------- GITHUB HELPERS ----------

const GITHUB_API_BASE = "https://api.github.com";

async function uploadZipToGithub(buffer) {
  const base64Content = buffer.toString("base64");

  // Check if file already exists
  let existingSha;
  const getRes = await fetch(
    `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
      ZIP_NAME
    )}?ref=${GITHUB_BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (getRes.ok) {
    const data = await getRes.json();
    existingSha = data.sha;
  }

  const body = {
    message: "DroidBuilder export",
    content: base64Content,
    branch: GITHUB_BRANCH,
  };
  if (existingSha) body.sha = existingSha;

  const putRes = await fetch(
    `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
      ZIP_NAME
    )}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!putRes.ok) {
    const txt = await putRes.text();
    throw new Error(`GitHub upload failed (${putRes.status}): ${txt}`);
  }

  const putData = await putRes.json();
  console.log("Uploaded ZIP, commit:", putData.commit?.sha);
}

async function triggerWorkflowDispatch() {
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: GITHUB_BRANCH }),
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `Workflow dispatch failed (${res.status}): ${txt}`
    );
  }

  console.log("Workflow dispatch triggered.");
}

async function pollLatestWorkflowRun(maxAttempts = 30, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Polling workflow runs (attempt ${attempt}/${maxAttempts})`);

    const runsRes = await fetch(
      `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/runs?branch=${GITHUB_BRANCH}&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!runsRes.ok) {
      const txt = await runsRes.text();
      throw new Error(
        `Failed to list workflow runs (${runsRes.status}): ${txt}`
      );
    }

    const data = await runsRes.json();
    const run = data.workflow_runs?.[0];
    if (!run) {
      console.log("No workflow run found yet.");
    } else {
      console.log(
        `Latest run: id=${run.id}, status=${run.status}, conclusion=${run.conclusion}`
      );
      if (run.status === "completed") {
        return run;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Timeout waiting for workflow run to complete.");
}

async function downloadArtifactZip(runId) {
  // List artifacts for this run
  const artifactsRes = await fetch(
    `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/artifacts`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!artifactsRes.ok) {
    const txt = await artifactsRes.text();
    throw new Error(
      `Failed to list artifacts (${artifactsRes.status}): ${txt}`
    );
  }

  const artifactsData = await artifactsRes.json();
  const artifact = artifactsData.artifacts?.find(
    (a) => a.name === "app-debug-apk"
  );

  if (!artifact) {
    console.error("Available artifacts:", artifactsData.artifacts);
    throw new Error('Artifact "app-debug-apk" not found.');
  }

  // Download artifact as zip
  const zipRes = await fetch(artifact.archive_download_url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!zipRes.ok) {
    const txt = await zipRes.text();
    throw new Error(
      `Failed to download artifact zip (${zipRes.status}): ${txt}`
    );
  }

  const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
  return zipBuffer;
}

function extractApkFromArtifactZip(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Grab the first .apk file we find
  const apkEntry = entries.find((e) => e.entryName.endsWith(".apk"));
  if (!apkEntry) {
    throw new Error("No .apk file found inside artifact zip.");
  }

  console.log("Found APK in artifact:", apkEntry.entryName);
  const apkBuffer = apkEntry.getData();
  return apkBuffer;
}

// ---------- ROUTES ----------

// Simple sanity check
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, message: "Backend is alive." });
});

// Main build endpoint
app.post(
  "/api/build-apk",
  upload.single("file"), // expects field name "file"
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      console.log(
        "Received ZIP:",
        req.file.originalname,
        "size:",
        req.file.size
      );

      const zipBuffer = req.file.buffer;

      // 1) upload ZIP to GitHub
      await uploadZipToGithub(zipBuffer);

      // 2) trigger workflow
      await triggerWorkflowDispatch();

      // 3) poll for completion
      const run = await pollLatestWorkflowRun();
      if (run.conclusion !== "success") {
        return res.status(500).json({
          error: "Workflow did not succeed.",
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.html_url,
        });
      }

      // 4) download artifact zip
      const artifactZip = await downloadArtifactZip(run.id);

      // 5) extract APK
      const apkBuffer = extractApkFromArtifactZip(artifactZip);

      // 6) send APK to client
      res.setHeader(
        "Content-Type",
        "application/vnd.android.package-archive"
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="app-debug.apk"'
      );
      res.send(apkBuffer);
    } catch (err) {
      console.error("Error in /api/build-apk:", err);
      res.status(500).json({
        error: err.message || "Unknown error",
      });
    }
  }
);

// ---------- START SERVER ----------

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
