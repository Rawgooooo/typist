"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Default global hotkey. Electron accelerator syntax; CommandOrControl resolves
 * to Ctrl on Windows and Cmd on macOS.
 *
 * The original default was Shift+Space, which on Windows collides with
 * parameter-info in Visual Studio and JetBrains IDEs and with some IME language
 * switching.
 */
const DEFAULT_HOTKEY = "CommandOrControl+Shift+D";
const FALLBACK_HOTKEY = "CommandOrControl+Alt+D";

const DEFAULTS = Object.freeze({
  microphone: "default",
  // Cloud works immediately with a key; local needs a model plus a runtime
  // downloaded first.
  engine: "cloud",
  whisperModel: "small",
  /**
   * Groq model. large-v3 is the accurate one: Groq publish 10.3% word error rate
   * for it versus 12% for whisper-large-v3-turbo, which is a pruned fine-tune
   * aimed at throughput. Dictation is error-sensitive, so accuracy wins over the
   * latency difference.
   */
  cloudModel: "whisper-large-v3",
  groqApiKey: "",
  recordingMode: "toggle",
  hotkey: DEFAULT_HOTKEY,
  /**
   * Optional context passed to Whisper to steer spelling and style, e.g. names
   * and jargon you use often. Capped at 224 tokens by the API.
   */
  prompt: "",
  /** Appends each transcription to data/history.jsonl. */
  saveHistory: true,
  /**
   * Free-text label identifying whose corpus this is, stamped into exports so
   * files from different testers can be told apart.
   */
  participantId: "",
});

/**
 * True only when running from a packaged build.
 *
 * Guarded because this module is also loaded by verify-pipeline.js under plain
 * Node, where `require("electron")` resolves to the binary path string rather
 * than the API object.
 */
function isPackaged() {
  try {
    return require("electron").app?.isPackaged === true;
  } catch {
    return false;
  }
}

/** Directory of the running executable, or null outside Electron. */
function exeDir() {
  try {
    const { app } = require("electron");
    return app ? path.dirname(app.getPath("exe")) : null;
  } catch {
    return null;
  }
}

/**
 * Where config, models and history live: a `data` folder beside the app rather
 * than under %APPDATA%, so everything stays self-contained on whichever drive the
 * app sits on.
 *
 * - Packaged: next to the executable.
 * - Source checkout: the repo root, i.e. two levels up from electron/lib.
 * - `TYPIST_DATA_DIR` overrides both.
 *
 * Keeping local whisper models here matters: they are hundreds of MB to 1.5 GB,
 * and putting them on the system drive is exactly what we want to avoid.
 */
function appRoot() {
  if (isPackaged()) {
    const dir = exeDir();
    if (dir) return dir;
  }
  return path.resolve(__dirname, "..", "..");
}

function appDir() {
  const override = process.env.TYPIST_DATA_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(appRoot(), "data");
}

function configPath() {
  return path.join(appDir(), "config.json");
}

/**
 * Minimal .env parser. Avoids a dependency for what is a handful of KEY=VALUE
 * lines, and deliberately does not overwrite variables already present in the
 * real environment.
 */
function parseEnv(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    if (key) out[key] = value;
  }
  return out;
}

/**
 * Loads the first .env found among the candidate locations.
 *
 * Several places are checked so the same code works when run from the repo
 * root, under `npm run dev` (cwd may be the repo root), and as a packaged app
 * launched from a shortcut or scheduled task, where the working directory is not
 * useful.
 */
function loadDotenv(extraDirs = []) {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "..", ".env"),
    ...extraDirs.map((d) => path.join(d, ".env")),
    path.join(appDir(), ".env"),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
      const parsed = parseEnv(fs.readFileSync(candidate, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      return candidate;
    } catch {
      // Unreadable candidate: try the next one.
    }
  }
  return null;
}

function nonEmptyEnv(key) {
  const v = process.env[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function groqKeyFromEnv() {
  return nonEmptyEnv("TYPIST_GROQ_API_KEY") || nonEmptyEnv("GROQ_API_KEY");
}

function load() {
  let stored = {};
  let existed = false;

  try {
    stored = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    existed = true;
  } catch {
    stored = {};
  }

  const settings = { ...DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };

  // The environment only fills a blank key, so anything entered in the UI wins
  // and persists from then on.
  if (!String(settings.groqApiKey || "").trim()) {
    const fromEnv = groqKeyFromEnv();
    if (fromEnv) settings.groqApiKey = fromEnv;
  }

  // These apply only on first run. Otherwise they would silently undo UI changes
  // on every launch.
  if (!existed) {
    const hotkey = nonEmptyEnv("TYPIST_HOTKEY");
    if (hotkey) settings.hotkey = hotkey;

    const engine = nonEmptyEnv("TYPIST_ENGINE");
    if (engine === "local" || engine === "cloud") settings.engine = engine;
  }

  return settings;
}

function save(settings) {
  const dir = appDir();
  fs.mkdirSync(dir, { recursive: true });
  const merged = { ...DEFAULTS, ...settings };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

module.exports = {
  DEFAULTS,
  DEFAULT_HOTKEY,
  FALLBACK_HOTKEY,
  appDir,
  configPath,
  parseEnv,
  loadDotenv,
  load,
  save,
};
