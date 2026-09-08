"use strict";

/**
 * End-to-end check of the transcription path, runnable under plain Node without
 * launching the app.
 *
 *   node electron/verify-pipeline.js <path-to-wav>
 *
 * Exercises the real .env loading, the real Groq call, and the real text cleanup,
 * so a pass means the credential and the request shape are both correct.
 */

const path = require("path");
const settingsStore = require("./lib/settings");
const { cleanupText } = require("./lib/cleanup");
const transcribe = require("./lib/transcribe");
const whisperRuntime = require("./lib/whisperRuntime");

async function main() {
  const wav = process.argv[2];
  if (!wav) {
    console.error("usage: node electron/verify-pipeline.js <path-to-wav>");
    process.exit(2);
  }

  const envPath = settingsStore.loadDotenv([path.join(__dirname, "..")]);
  console.log(`env file: ${envPath ?? "none found"}`);

  const settings = settingsStore.load();
  console.log(`engine: ${settings.engine}`);
  console.log(`hotkey: ${settings.hotkey}`);
  console.log(`groq key present: ${Boolean(settings.groqApiKey)}`);
  console.log(`groq key length: ${String(settings.groqApiKey).length}`);
  console.log(`whisper runtime installed: ${whisperRuntime.isInstalled()}`);
  console.log(`model 'small' downloaded: ${transcribe.isModelDownloaded("small")}`);

  console.log("\ncalling Groq...");
  const started = Date.now();
  const raw = await transcribe.transcribeGroq(settings.groqApiKey, wav);
  const ms = Date.now() - started;

  console.log(`raw       : ${JSON.stringify(raw)}`);
  console.log(`cleaned   : ${JSON.stringify(cleanupText(raw))}`);
  console.log(`round trip: ${ms}ms`);
  console.log("\nPIPELINE_OK");
}

main().catch((e) => {
  console.error(`\nPIPELINE_FAILED: ${e.message}`);
  process.exit(1);
});
