"use strict";

const fs = require("fs");
const path = require("path");
const { appDir } = require("./settings");

/**
 * Append-only transcription log at data/history.jsonl.
 *
 * JSON Lines rather than a single JSON array so appending is a plain write with
 * no read-modify-write, which keeps it cheap and safe against a crash midway
 * through a dictation.
 *
 * Beyond being useful on its own, this is the only way to review what the model
 * actually heard when a transcription comes out wrong.
 */

const HISTORY_FILE = "history.jsonl";

/** Keeps the file from growing without bound. */
const MAX_ENTRIES = 5000;

function historyPath() {
  return path.join(appDir(), HISTORY_FILE);
}

/**
 * Records one transcription.
 *
 * Never throws: a logging failure must not lose the user's text or break the
 * paste that follows.
 */
function append(entry) {
  try {
    const dir = appDir();
    fs.mkdirSync(dir, { recursive: true });

    const line = JSON.stringify({
      at: new Date().toISOString(),
      engine: entry.engine,
      model: entry.model,
      durationMs: entry.durationMs,
      raw: entry.raw,
      text: entry.text,
    });

    fs.appendFileSync(historyPath(), line + "\n", "utf8");
  } catch (e) {
    console.warn(`[Typist] Could not write history: ${e.message}`);
  }
}

/** Most recent entries, newest first. Malformed lines are skipped. */
function recent(limit = 50) {
  try {
    const contents = fs.readFileSync(historyPath(), "utf8");
    const lines = contents.split(/\r?\n/).filter(Boolean);
    const out = [];

    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        // Truncated final line from an interrupted write; ignore it.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Trims the file to MAX_ENTRIES, keeping the newest. */
function prune() {
  try {
    const file = historyPath();
    const contents = fs.readFileSync(file, "utf8");
    const lines = contents.split(/\r?\n/).filter(Boolean);
    if (lines.length <= MAX_ENTRIES) return;

    fs.writeFileSync(file, lines.slice(-MAX_ENTRIES).join("\n") + "\n", "utf8");
  } catch {
    // Nothing to prune, or unreadable.
  }
}

function clear() {
  try {
    fs.rmSync(historyPath(), { force: true });
  } catch (e) {
    console.warn(`[Typist] Could not clear history: ${e.message}`);
  }
}

/** Number of entries currently recorded. */
function count() {
  try {
    return fs.readFileSync(historyPath(), "utf8").split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Writes a shareable copy of the corpus to `destDir`.
 *
 * Deliberately rebuilds each record field by field rather than copying the file,
 * so only known-safe fields can ever leave the machine. The API key lives in
 * config.json and is never part of a history entry, and no audio is retained at
 * any point — only text.
 *
 * Returns the path written.
 */
function exportCorpus(destDir, meta = {}) {
  const entries = recent(Number.MAX_SAFE_INTEGER).reverse();

  const safeLabel = String(meta.participantId || "anonymous")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "anonymous";

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `typist-corpus-${safeLabel}-${stamp}.json`;
  const dest = path.join(destDir, filename);

  const payload = {
    participantId: safeLabel,
    exportedAt: new Date().toISOString(),
    appVersion: meta.appVersion || "unknown",
    entryCount: entries.length,
    note: "Transcription text only. No audio was recorded or retained.",
    entries: entries.map((e) => ({
      at: e.at,
      engine: e.engine,
      model: e.model,
      durationMs: e.durationMs,
      raw: e.raw,
      text: e.text,
    })),
  };

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2), "utf8");

  return dest;
}

module.exports = {
  append,
  recent,
  count,
  prune,
  clear,
  exportCorpus,
  historyPath,
  MAX_ENTRIES,
};
