#!/usr/bin/env node
"use strict";

/**
 * Syntax-checks the Electron main process.
 *
 * `tsc` only covers src/ (the renderer). Everything under electron/ is plain
 * JavaScript that nothing validated, so a syntax error there could not be caught
 * until the packaged app tried to start — which is exactly how a duplicate
 * `const os = require("os")` shipped inside a 206 MB installer and killed the app
 * on launch with a dialog.
 *
 * `node --check` parses without executing, so this is fast and has no side
 * effects. Wired into `npm run build`.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "electron");

function collect(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collect(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(root);
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    const detail = String(e.stderr || e.message).trim();
    failures.push({ file, detail });
  }
}

const rel = (f) => path.relative(path.resolve(__dirname, ".."), f);

if (failures.length > 0) {
  console.error(`\nSyntax errors in ${failures.length} main-process file(s):\n`);
  for (const { file, detail } of failures) {
    console.error(`  ${rel(file)}`);
    console.error(
      detail
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")
    );
    console.error("");
  }
  process.exit(1);
}

console.log(`main process: ${files.length} file(s) OK`);
