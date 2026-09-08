"use strict";

/**
 * Runs the same audio through both Groq models so accuracy differences are
 * measured rather than assumed.
 *
 *   node electron/compare-models.js <path-to-wav>
 */

const path = require("path");
const settingsStore = require("./lib/settings");
const transcribe = require("./lib/transcribe");

async function main() {
  const wav = process.argv[2];
  if (!wav) {
    console.error("usage: node electron/compare-models.js <path-to-wav>");
    process.exit(2);
  }

  settingsStore.loadDotenv([path.join(__dirname, "..")]);
  const settings = settingsStore.load();

  console.log(`data dir: ${settingsStore.appDir()}`);
  console.log(`audio   : ${wav}\n`);

  for (const model of Object.keys(transcribe.CLOUD_MODELS)) {
    const started = Date.now();
    try {
      const text = await transcribe.transcribeGroq(settings.groqApiKey, wav, { model });
      console.log(`${model}`);
      console.log(`  ${Date.now() - started}ms`);
      console.log(`  ${JSON.stringify(text)}\n`);
    } catch (e) {
      console.log(`${model}\n  FAILED: ${e.message}\n`);
    }
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
