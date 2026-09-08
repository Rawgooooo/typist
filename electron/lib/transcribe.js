"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { appDir } = require("./settings");
const whisperRuntime = require("./whisperRuntime");

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Groq speech-to-text models, most accurate first.
 *
 * Word error rates are Groq's published figures. turbo is a pruned fine-tune of
 * large-v3 traded for throughput, which is the wrong trade for dictation.
 */
const CLOUD_MODELS = Object.freeze({
  "whisper-large-v3": { label: "Large v3 — most accurate (10.3% WER)", wer: 10.3 },
  "whisper-large-v3-turbo": { label: "Large v3 Turbo — faster, less accurate (12% WER)", wer: 12 },
});

const DEFAULT_CLOUD_MODEL = "whisper-large-v3";

function modelFilename(modelSize) {
  return `ggml-${modelSize}.bin`;
}

function modelDownloadUrl(modelSize) {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelSize}.bin`;
}

function modelPath(modelSize) {
  return path.join(appDir(), modelFilename(modelSize));
}

function isModelDownloaded(modelSize) {
  try {
    return fs.statSync(modelPath(modelSize), { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/** Transcribes via the Groq cloud API. */
async function transcribeGroq(apiKey, wavPath, options = {}) {
  if (!String(apiKey || "").trim()) {
    throw new Error("Groq API key not set. Enter your key in the Engine tab.");
  }

  const model = CLOUD_MODELS[options.model] ? options.model : DEFAULT_CLOUD_MODEL;
  const audio = await fs.promises.readFile(wavPath);

  const form = new FormData();
  form.append("model", model);
  form.append("language", "en");
  form.append("response_format", "json");
  // Groq recommend 0 for transcription; anything higher invites invention.
  form.append("temperature", "0");

  // Optional context to steer spelling of names and jargon. The API caps this at
  // 224 tokens, so it is truncated generously by character count rather than
  // risking a rejected request.
  const prompt = String(options.prompt || "").trim();
  if (prompt) form.append("prompt", prompt.slice(0, 800));

  form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");

  const response = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Groq API error (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json();
  if (typeof json.text !== "string") {
    throw new Error("Groq response contained no 'text' field");
  }

  return json.text;
}

/** Transcribes locally with the downloaded whisper.cpp runtime. */
function transcribeLocal(modelSize, wavPath, options = {}) {
  return new Promise((resolve, reject) => {
    const model = modelPath(modelSize);

    if (!isModelDownloaded(modelSize)) {
      reject(
        new Error(
          `Whisper model not found at ${model}. Download a model from the Engine tab first.`
        )
      );
      return;
    }

    if (!whisperRuntime.isInstalled()) {
      reject(
        new Error(
          "The local whisper runtime is not installed. Install it from the Engine tab, " +
            "or switch to Groq Cloud."
        )
      );
      return;
    }

    const exe = whisperRuntime.whisperExePath();

    const args = ["-m", model, "-f", wavPath, "--no-timestamps", "-l", "en"];

    const prompt = String(options.prompt || "").trim();
    if (prompt) args.push("--prompt", prompt.slice(0, 800));

    execFile(
      exe,
      args,
      {
        // The DLLs sit beside the executable, which Windows' default search
        // order covers; this also keeps any stray output files out of the user's
        // working directory.
        cwd: whisperRuntime.runtimeDir(),
        // Without this, spawning a console app from a GUI process flashes a
        // console window on every transcription.
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `whisper-cli failed: ${String(stderr || err.message).trim().split("\n").slice(0, 3).join(" ")}`
            )
          );
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

async function transcribe(settings, wavPath) {
  if (settings.engine === "local") {
    return transcribeLocal(settings.whisperModel, wavPath, { prompt: settings.prompt });
  }
  if (settings.engine === "cloud") {
    return transcribeGroq(settings.groqApiKey, wavPath, {
      model: settings.cloudModel,
      prompt: settings.prompt,
    });
  }
  throw new Error(`Unknown engine: ${settings.engine}`);
}

module.exports = {
  CLOUD_MODELS,
  DEFAULT_CLOUD_MODEL,
  transcribe,
  transcribeGroq,
  transcribeLocal,
  modelFilename,
  modelDownloadUrl,
  modelPath,
  isModelDownloaded,
};
