"use strict";

const { clipboard } = require("electron");
const { execFile } = require("child_process");

/**
 * Puts text on the clipboard and pastes it into the focused window.
 *
 * The keystroke is synthesised through a C# shim that PowerShell compiles at
 * runtime via .NET. That deliberately avoids a native Node module, since no
 * C++ toolchain is available on this machine, and avoids SendKeys, which is
 * unreliable and translates characters through the active keyboard layout.
 *
 * Virtual-key codes are used rather than a character because "the V key" is not
 * where a Latin 'v' lives on AZERTY, Dvorak or non-Latin layouts. VK_V is the
 * physical-key identity that Ctrl+V shortcuts are defined against.
 */

/**
 * Notes on the struct layout, both of which caused silent failures when first
 * written:
 *
 *  - INPUT is a union sized by its LARGEST member, MOUSEINPUT, not KEYBDINPUT.
 *    Declaring only the keyboard member makes Marshal.SizeOf report 32 bytes
 *    instead of 40, and SendInput rejects a cbSize that disagrees with its own
 *    sizeof(INPUT), returning "0 events injected" and no error. MOUSEINPUT is
 *    declared purely so the size is right.
 *  - FieldOffset(8) is correct for 64-bit processes: 4-byte type plus 4 bytes of
 *    padding before the union.
 *
 * All four events are submitted in one SendInput call so the OS injects them as
 * a single uninterruptible block; a partial sequence can leave Ctrl logically
 * stuck down.
 */
const PASTE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TypistInput {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MOUSEINPUT mi;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }
  [DllImport("user32.dll", SetLastError=true)]
  static extern uint SendInput(uint n, INPUT[] p, int cb);
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 2;
  const ushort VK_CONTROL = 0x11;
  const ushort VK_V = 0x56;
  static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.ki.wVk = vk;
    i.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return i;
  }
  public static uint PasteCtrlV() {
    INPUT[] inputs = new INPUT[] {
      Key(VK_CONTROL, false), Key(VK_V, false),
      Key(VK_V, true), Key(VK_CONTROL, true)
    };
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
[TypistInput]::PasteCtrlV()
`;

const CLIPBOARD_ATTEMPTS = 3;
const CLIPBOARD_RETRY_MS = 50;
const PRE_KEYSTROKE_MS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes to the clipboard and verifies it took.
 *
 * Windows lets only one process hold the clipboard open at a time, so a write
 * can transiently fail when a clipboard manager or remote-desktop client has it.
 * Note that clipboard.readText() returns a Promise in Electron 44, so the
 * read-back must be awaited.
 */
async function setClipboard(text) {
  let lastValue = null;

  for (let attempt = 1; attempt <= CLIPBOARD_ATTEMPTS; attempt++) {
    clipboard.writeText(text);
    await sleep(CLIPBOARD_RETRY_MS);

    lastValue = await Promise.resolve(clipboard.readText());
    if (lastValue === text) return;

    console.warn(`[Typist] Clipboard verify ${attempt}/${CLIPBOARD_ATTEMPTS} failed`);
  }

  throw new Error(
    `Could not write to the clipboard after ${CLIPBOARD_ATTEMPTS} attempts. ` +
      "Another application may be holding it open."
  );
}

function sendPasteKeystroke() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PASTE_SCRIPT],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `Paste keystroke failed: ${String(stderr || err.message).trim().split("\n")[0]}`
            )
          );
          return;
        }

        const sent = Number.parseInt(String(stdout).trim(), 10);
        if (!Number.isFinite(sent) || sent < 4) {
          // Usually UIPI: a medium-integrity process cannot inject input into a
          // window owned by an elevated process.
          reject(
            new Error(
              `Paste was blocked (${stdout.trim() || 0}/4 events delivered). The focused ` +
                "window may be running elevated. The text is on your clipboard — press " +
                "Ctrl+V to paste it manually."
            )
          );
          return;
        }

        resolve();
      }
    );
  });
}

async function pasteText(text) {
  await setClipboard(text);

  // The clipboard handle is released by now; let the foreground window catch up
  // before injecting input.
  await sleep(PRE_KEYSTROKE_MS);

  if (process.platform !== "win32") {
    throw new Error("Automatic paste is only implemented on Windows. The text is on your clipboard.");
  }

  await sendPasteKeystroke();
}

module.exports = { pasteText, setClipboard };
