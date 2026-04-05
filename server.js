const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const app = express();
const upload = multer({ dest: "/tmp/uploads" });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function safeText(text = "") {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .replace(/\n/g, " ");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function downloadFile(fileUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fileUrl);
    const client = parsed.protocol === "https:" ? https : http;

    client
      .get(fileUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
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

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "ffmpeg api is running",
  });
});

async function processVideo({ inputFile, hook, cta, username, fps, res }) {
  const outputFile = `/tmp/output-${Date.now()}.mp4`;

  try {
    const filters = [
      "scale=1080:1920:force_original_aspect_ratio=increase",
      "crop=1080:1920",
      `fps=${Number.isFinite(fps) ? fps : 30}`,
    ];

    if (hook) {
      filters.push(
        `drawtext=fontfile='${FONT_PATH}':text='${hook}':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h*0.12):box=1:boxcolor=black@0.55:boxborderw=18:enable='between(t,0,2.5)'`
      );
    }

    if (cta) {
      filters.push(
        `drawtext=fontfile='${FONT_PATH}':text='${cta}':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h*0.82):box=1:boxcolor=black@0.55:boxborderw=18:enable='gte(t,5)'`
      );
    }

    if (username) {
      filters.push(
        `drawtext=fontfile='${FONT_PATH}':text='${username}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h*0.73):box=1:boxcolor=black@0.45:boxborderw=12`
      );
    }

    const args = [
      "-y",
      "-i",
      inputFile,
      "-vf",
      filters.join(","),
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

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="processed.mp4"');

    const stream = fs.createReadStream(outputFile);
    stream.on("close", () => {
      fs.promises.unlink(inputFile).catch(() => {});
      fs.promises.unlink(outputFile).catch(() => {});
    });
    stream.pipe(res);
  } catch (error) {
    fs.promises.unlink(inputFile).catch(() => {});
    fs.promises.unlink(outputFile).catch(() => {});
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}

app.post("/process", upload.single("video"), async (req, res) => {
  const hook = safeText(req.body.hook || "");
  const cta = safeText(req.body.cta || "");
  const username = safeText(req.body.username || "");
  const fps = Number(req.body.fps || 30);

  let inputFile = req.file?.path;

  try {
    if (!inputFile && req.body.video_url) {
      inputFile = `/tmp/input-${Date.now()}.mp4`;
      await downloadFile(req.body.video_url, inputFile);
    }

    if (!inputFile) {
      return res.status(400).json({
        ok: false,
        error: "video or video_url is required",
      });
    }

    await processVideo({ inputFile, hook, cta, username, fps, res });
  } catch (error) {
    if (inputFile) {
      fs.promises.unlink(inputFile).catch(() => {});
    }
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`ffmpeg api listening on port ${PORT}`);
});