const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const app = express();
const upload = multer({ dest: "/tmp/uploads" });

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function normalizeText(text = "") {
  return String(text)
    .replace(/[‘’‚‛‹›]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\r/g, "")
    .trim();
}

function downloadFile(fileUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fileUrl);
    const client = parsed.protocol === "https:" ? https : http;

    client
      .get(fileUrl, (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          return resolve(downloadFile(response.headers.location, outputPath));
        }

        if (response.statusCode !== 200) {
          return reject(new Error(`Download failed with status ${response.statusCode}`));
        }

        const fileStream = fs.createWriteStream(outputPath);
        response.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close();
          resolve();
        });

        fileStream.on("error", reject);
      })
      .on("error", reject);
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      args,
      { maxBuffer: 100 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message || "ffmpeg failed"));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "ffmpeg api is running",
  });
});

app.post("/process", upload.single("video"), async (req, res) => {
  let inputFile = req.file?.path || null;
  const id = Date.now();
  const outputFile = `/tmp/output-${id}.mp4`;

  const hook = normalizeText(req.body.hook || "");
  const cta = normalizeText(req.body.cta || "");
  const username = normalizeText(req.body.username || "");
  const fps = Number(req.body.fps || 60);

  const hookFile = `/tmp/hook-${id}.txt`;
  const ctaFile = `/tmp/cta-${id}.txt`;
  const usernameFile = `/tmp/username-${id}.txt`;
  const filterFile = `/tmp/filter-${id}.txt`;

  try {
    if (!inputFile && req.body.video_url) {
      inputFile = `/tmp/input-${id}.mp4`;
      await downloadFile(req.body.video_url, inputFile);
    }

    if (!inputFile) {
      return res.status(400).json({
        ok: false,
        error: "video or video_url is required",
      });
    }

    const cleanupFiles = [];

    if (hook) {
      fs.writeFileSync(hookFile, hook, "utf8");
      cleanupFiles.push(hookFile);
    }

    if (cta) {
      fs.writeFileSync(ctaFile, cta, "utf8");
      cleanupFiles.push(ctaFile);
    }

    if (username) {
      fs.writeFileSync(usernameFile, username, "utf8");
      cleanupFiles.push(usernameFile);
    }

    const lines = [
      `scale=1080:1920:force_original_aspect_ratio=increase`,
      `crop=1080:1920`,
      `fps=${Number.isFinite(fps) ? fps : 60}`,
    ];

    if (hook) {
      lines.push(
        `drawtext=fontfile='${FONT_PATH}':textfile='${hookFile}':reload=1:fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h*0.12):box=1:boxcolor=black@0.55:boxborderw=18:enable='between(t,0,2.5)'`
      );
    }

    if (cta) {
      lines.push(
        `drawtext=fontfile='${FONT_PATH}':textfile='${ctaFile}':reload=1:fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h*0.82):box=1:boxcolor=black@0.55:boxborderw=18:enable='gte(t,5)'`
      );
    }

    if (username) {
      lines.push(
        `drawtext=fontfile='${FONT_PATH}':textfile='${usernameFile}':reload=1:fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h*0.73):box=1:boxcolor=black@0.45:boxborderw=12`
      );
    }

    fs.writeFileSync(filterFile, lines.join(","), "utf8");
    cleanupFiles.push(filterFile);

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputFile,
      "-filter_complex_script",
      filterFile,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputFile,
    ];

    await runFfmpeg(args);

    if (!fs.existsSync(outputFile)) {
      throw new Error("Output file was not created");
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="processed.mp4"');

    const stream = fs.createReadStream(outputFile);

    stream.on("error", (err) => {
      console.error("Read stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: "Failed to read output video",
        });
      }
    });

    stream.on("close", () => {
      if (inputFile) fs.promises.unlink(inputFile).catch(() => {});
      fs.promises.unlink(outputFile).catch(() => {});
      cleanupFiles.forEach((file) => fs.promises.unlink(file).catch(() => {}));
    });

    stream.pipe(res);
  } catch (error) {
    console.error("Process error:", error);

    if (inputFile) fs.promises.unlink(inputFile).catch(() => {});
    fs.promises.unlink(outputFile).catch(() => {});
    [hookFile, ctaFile, usernameFile, filterFile].forEach((file) =>
      fs.promises.unlink(file).catch(() => {})
    );

    res.status(500).json({
      ok: false,
      error: error.message || "Unknown processing error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`ffmpeg api listening on port ${PORT}`);
});