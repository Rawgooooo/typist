"use strict";

/**
 * Syntax-checks every main-process JavaScript file.
 *
 * `tsc` and Vite only cover the renderer (src/), so nothing validated electron/
 * at all. A duplicate `const os = require("os")` shipped in a packaged build and
 * failed at runtime with "Identifier 'os' has already been declared" — a syntax
 * error that any parse would have caught. This runs as part of `npm run build`.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "electron");

function collect(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = collect(root);
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    failed += 1;
    const detail = String(e.stderr || e.message).trim();
    console.error(`FAIL ${path.relative(root, file)}\n${detail}\n`);
  }
}

if (failed > 0) {
  console.error(`${failed} of ${files.length} main-process files failed to parse.`);
  process.exit(1);
}

console.log(`syntax ok: ${files.length} main-process files`);
