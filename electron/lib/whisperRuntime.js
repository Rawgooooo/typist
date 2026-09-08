"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { appDir } = require("./settings");

/**
 * Manages the local whisper.cpp runtime.
 *
 * The Windows whisper.cpp build is not a single executable: whisper-cli.exe
 * loads whisper.dll, ggml.dll, ggml-base.dll and one of several ggml-cpu-*.dll
 * variants chosen at runtime from detected CPU features, all of which must sit
 * beside it. So it is downloaded on demand into the app data directory rather
 * than bundled, which also keeps the installer small.
 */

/** Pinned so behaviour cannot change under us. Bump deliberately. */
const RELEASE_TAG = "b4938";

/**
 * Upstream publishes Windows binaries for x64 and Win32 only; there is no
 * win-arm64 asset. On Windows on ARM this x64 build runs under the OS's x64
 * emulation: functional, but slower than native. Cloud transcription avoids the
 * penalty entirely.
 */
const ASSET = "whisper-bin-x64.zip";

const RUNTIME_DIR = "whisper";
const WHISPER_EXE = "whisper-cli.exe";
const REQUIRED = [WHISPER_EXE, "whisper.dll", "ggml.dll", "ggml-base.dll"];

function downloadUrl() {
  return `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE_TAG}/${ASSET}`;
}

function runtimeDir() {
  return path.join(appDir(), RUNTIME_DIR);
}

function whisperExePath() {
  return path.join(runtimeDir(), WHISPER_EXE);
}

/**
 * True when the runtime looks usable. The DLLs are checked too, because an
 * interrupted extraction can leave the exe present but unloadable.
 */
function isInstalled() {
  const dir = runtimeDir();
  return REQUIRED.every((f) => {
    try {
      return fs.statSync(path.join(dir, f), { throwIfNoEntry: false })?.isFile() === true;
    } catch {
      return false;
    }
  });
}

/**
 * Streams a download to disk, reporting progress as a 0-100 percentage.
 *
 * Writes to a `.part` file and renames only after the byte count matches
 * Content-Length. Writing straight to the final name meant an interrupted
 * download (closing the app mid-transfer, losing the network) left a truncated
 * file that existence checks happily accepted as complete — a 1.5 GB model would
 * be reported as downloaded at 85 MB, and only fail later inside whisper.
 */
async function downloadWithProgress(url, dest, onProgress) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const total = Number(response.headers.get("content-length") || 0);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const partial = `${dest}.part`;
  const handle = await fs.promises.open(partial, "w");
  let downloaded = 0;

  try {
    for await (const chunk of response.body) {
      await handle.write(chunk);
      downloaded += chunk.length;
      if (onProgress) {
        onProgress({
          downloaded,
          total,
          percent: total > 0 ? (downloaded / total) * 100 : 0,
        });
      }
    }
  } catch (e) {
    await handle.close();
    await fs.promises.rm(partial, { force: true }).catch(() => {});
    throw e;
  }

  await handle.close();

  if (total > 0 && downloaded !== total) {
    await fs.promises.rm(partial, { force: true }).catch(() => {});
    throw new Error(
      `Download incomplete: got ${downloaded} of ${total} bytes. Please try again.`
    );
  }

  // Rename is atomic on the same volume, so the final path either does not exist
  // or is a complete file.
  await fs.promises.rename(partial, dest);
}

/**
 * Expands a zip using PowerShell's Expand-Archive.
 *
 * Chosen over an npm zip library purely to keep the dependency count at zero;
 * Expand-Archive ships with Windows PowerShell 5.1.
 */
function expandArchive(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const script =
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' ` +
      `-DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;

    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 300000 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`Failed to extract archive: ${String(stderr || err.message).trim().split("\n")[0]}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Moves the executable and every DLL out of the archive's nested folder into the
 * runtime directory.
 *
 * Every DLL is taken rather than a fixed list: whisper-cli selects a ggml-cpu-*
 * variant at runtime, and the set of variants changes between releases. Taking
 * them all costs a few MB and avoids a missing-dependency failure that would only
 * surface at transcription time.
 */
function flattenInto(sourceRoot, destDir) {
  let moved = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      const lower = entry.name.toLowerCase();
      const wanted = lower === WHISPER_EXE || lower.endsWith(".dll");
      if (!wanted) continue;

      fs.copyFileSync(full, path.join(destDir, entry.name));
      moved += 1;
    }
  };

  walk(sourceRoot);
  return moved;
}

async function install(onProgress) {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typist-whisper-"));
  const zipPath = path.join(tempRoot, ASSET);
  const extractDir = path.join(tempRoot, "extracted");

  try {
    await downloadWithProgress(downloadUrl(), zipPath, onProgress);
    await expandArchive(zipPath, extractDir);

    const moved = flattenInto(extractDir, dir);
    console.log(`[Typist] Installed ${moved} whisper runtime files`);

    if (!isInstalled()) {
      throw new Error(
        "The whisper runtime archive did not contain the expected files. Try installing again."
      );
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = {
  RELEASE_TAG,
  downloadUrl,
  runtimeDir,
  whisperExePath,
  isInstalled,
  install,
  downloadWithProgress,
};
