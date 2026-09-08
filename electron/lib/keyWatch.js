"use strict";

const { spawn } = require("child_process");

/**
 * Detects release of the hotkey's main key, for push-to-talk.
 *
 * Electron's globalShortcut fires only on key *press*; it has no release event.
 * The usual fix is a native keyboard hook (uiohook-napi and friends), which needs
 * a C++ toolchain to build. None is available on this machine, so release is
 * detected by polling GetAsyncKeyState from a short-lived PowerShell process.
 *
 * Polling at 40ms is imperceptible for hold-to-talk and costs almost nothing,
 * since the process only lives for the duration of one held key.
 */

/** Maps the final segment of an Electron accelerator to a virtual-key code. */
function acceleratorToVk(accelerator) {
  const parts = String(accelerator || "")
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);

  const key = parts.at(-1);
  if (!key) return null;

  if (/^[A-Za-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);

  const named = {
    Space: 0x20,
    Enter: 0x0d,
    Return: 0x0d,
    Tab: 0x09,
    Escape: 0x1b,
    Esc: 0x1b,
    Backspace: 0x08,
    Delete: 0x2e,
    Insert: 0x2d,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Up: 0x26,
    Down: 0x28,
    Left: 0x25,
    Right: 0x27,
  };

  if (named[key] !== undefined) return named[key];

  const fn = /^F(\d{1,2})$/.exec(key);
  if (fn) {
    const n = Number(fn[1]);
    if (n >= 1 && n <= 24) return 0x70 + (n - 1);
  }

  return null;
}

function pollScript(vk) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TypistKeyState {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@
# Wait for the key to actually be down first: the shortcut handler can fire
# marginally before this process is up, and starting in the "already released"
# state would stop the recording instantly.
$deadline = [DateTime]::UtcNow.AddSeconds(2)
$sawDown = $false
while ([DateTime]::UtcNow -lt $deadline) {
  if (([TypistKeyState]::GetAsyncKeyState(${vk}) -band 0x8000) -ne 0) { $sawDown = $true; break }
  Start-Sleep -Milliseconds 10
}
if (-not $sawDown) { Write-Output 'RELEASED'; exit 0 }

# Cap the hold at five minutes so a stuck key cannot record forever.
$maxHold = [DateTime]::UtcNow.AddMinutes(5)
while ([DateTime]::UtcNow -lt $maxHold) {
  if (([TypistKeyState]::GetAsyncKeyState(${vk}) -band 0x8000) -eq 0) { break }
  Start-Sleep -Milliseconds 40
}
Write-Output 'RELEASED'
`;
}

/**
 * Starts watching for release of the accelerator's main key.
 *
 * Returns a handle with cancel(). onRelease fires exactly once.
 */
function watchForRelease(accelerator, onRelease) {
  const vk = acceleratorToVk(accelerator);

  if (vk === null) {
    console.warn(
      `[Typist] Cannot determine a virtual-key code for '${accelerator}'; ` +
        "push-to-talk release detection is unavailable."
    );
    return { cancel() {}, supported: false };
  }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onRelease();
  };

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", pollScript(vk)],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );

  child.stdout.on("data", (buf) => {
    if (String(buf).includes("RELEASED")) finish();
  });

  child.stderr.on("data", (buf) => {
    const msg = String(buf).trim();
    if (msg) console.warn(`[Typist] key watcher: ${msg.split("\n")[0]}`);
  });

  child.on("error", (e) => {
    console.warn(`[Typist] key watcher failed to start: ${e.message}`);
    finish();
  });

  child.on("exit", () => finish());

  return {
    supported: true,
    cancel() {
      done = true;
      if (!child.killed) child.kill();
    },
  };
}

module.exports = { watchForRelease, acceleratorToVk };
