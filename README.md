# Typist

Push-to-talk dictation for Windows. Press a hotkey, speak, and the transcribed
text is pasted into whatever window has focus.

Transcription runs through the Groq cloud API, or locally with whisper.cpp.
Electron + TypeScript, no native modules.

## Setup

```powershell
npm install
```

Put your Groq key in `.env` (gitignored):

```ini
GROQ_API_KEY=gsk_your_key_here
```

## Run

```powershell
npm run build
npm start
```

Default hotkey **Ctrl+Shift+D**. Press to start, press again to stop.

## Package

```powershell
npm run package        # ARM64 NSIS installer
npm run package:x64    # x64
```

Release builds request administrator rights, because Windows UIPI blocks
synthetic keystrokes from reaching elevated windows otherwise. A manifest alone
would prompt for UAC on every launch, so register the logon task instead — it
starts elevated with no prompt and doubles as autostart:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
```

## Where things are stored

Everything lives in `data/` next to the app, not under `%APPDATA%`, so it stays
on whichever drive the app sits on. Local whisper models are 466 MB to 1.5 GB, so
that matters.

```
data/config.json      Settings, including the API key
data/history.jsonl     One JSON object per transcription
data/ggml-*.bin        Whisper models
data/whisper/          whisper.cpp runtime
```

For a packaged build this is beside the executable. Override with
`TYPIST_DATA_DIR` if you want it elsewhere. `data/` is gitignored.

Most options are in the UI. `hotkey` is display-only and must be edited in
`config.json`.

`.env` is read from the working directory, its parent, next to the executable,
and finally `data/.env`. Anything saved through the UI takes precedence over the
environment.

Optional, applied only before a `config.json` exists:

```ini
TYPIST_HOTKEY=CommandOrControl+Shift+D
TYPIST_ENGINE=cloud
```

## Engines

**Groq Cloud** (default) needs only the API key. Two models are selectable:

| Model | Word error rate | Notes |
|---|---|---|
| `whisper-large-v3` | 10.3% | Default. Use this for dictation. |
| `whisper-large-v3-turbo` | 12% | ~2.5x faster, a pruned fine-tune of the above. |

Rates are Groq's published figures. Turbo trades accuracy for throughput, which
is the wrong trade when errors are the thing you care about.

**Local Whisper** runs offline and needs two downloads from the Engine tab: a
model (`small` ~466 MB or `medium` ~1.5 GB) and the whisper.cpp runtime (~8 MB).

### Improving accuracy

**Vocabulary hints** (Engine tab) pass a prompt to Whisper to steer spelling of
names and jargon, capped at 224 tokens by the API. It demonstrably changes the
output but is not a reliable spelling fix — in local testing it corrected some
words and mangled others. Treat it as a nudge, not a guarantee.

If accuracy is still poor, check the history log to see exactly what the model
heard. Most real-world problems are audio, not model: a distant or bargey
microphone, a Bluetooth headset clipping the start of speech, or background noise.
A wired or built-in array mic usually beats Bluetooth for dictation.

## History

Every transcription is appended to `data/history.jsonl` with a timestamp, engine,
model and duration, and is browsable in the History tab. JSON Lines so appending
never rewrites the file. Capped at 5000 entries, pruned at startup. Can be turned
off in the UI.

## How it works

Nothing here needs a C++ toolchain, which is deliberate:

- **Capture** runs in a hidden renderer window using `getUserMedia` and
  `MediaRecorder`, then re-encodes to 16 kHz mono WAV via `OfflineAudioContext` —
  the format whisper.cpp requires and Groq accepts.
- **Paste** writes the clipboard and synthesises Ctrl+V through a C# shim that
  PowerShell compiles at runtime. Virtual-key codes are used rather than a
  character, since "the V key" is elsewhere on AZERTY, Dvorak and non-Latin
  layouts.
- **Push-to-talk** polls `GetAsyncKeyState` the same way. Electron's
  `globalShortcut` fires only on key press and has no release event; the usual fix
  is a native keyboard hook.
- **Local whisper** is fetched on demand, because `whisper-cli.exe` needs
  `whisper.dll`, `ggml.dll`, `ggml-base.dll` and a runtime-selected
  `ggml-cpu-*.dll` beside it. `Expand-Archive` handles extraction, so there is no
  zip dependency.

Two Win32 details that failed silently when first written, kept here so they
don't get reintroduced:

- `INPUT` is a union sized by its *largest* member, `MOUSEINPUT`, not
  `KEYBDINPUT`. Declaring only the keyboard member yields `sizeof` 32 instead of
  40, and `SendInput` rejects a mismatched `cbSize` by reporting 0 events sent
  with no error.
- PowerShell 5.1 has no `[ushort]` type accelerator; call sites need `[uint16]`.

## Layout

```
electron/
  main.js              Lifecycle, windows, hotkey, IPC, recording state
  preload.js           contextBridge surface
  verify-pipeline.js   Standalone transcription check
  compare-models.js    Runs one file through both cloud models
  lib/                 settings, paste, transcribe, whisperRuntime, keyWatch,
                       history, cleanup
src/
  main.ts              Settings UI
  recorder.ts          Capture and WAV encoding
  typist-api.ts        Types for the preload surface
index.html  overlay.html  recorder.html
```

Test the transcription path without the UI:

```powershell
node electron\verify-pipeline.js <path-to-wav>
node electron\compare-models.js <path-to-wav>
```

## Distributing for a trial

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-trial.ps1
```

Produces `release\Typist Setup 0.1.0.exe` — a single installer covering both x64
and ARM64 — plus `READ-ME-FIRST.txt` for testers.

Trial builds are `asInvoker` rather than `requireAdministrator`. Elevation only
buys the ability to paste into elevated windows, and is not worth giving every
tester a UAC prompt on each launch on top of the SmartScreen warning an unsigned
installer already causes. Paste still works in normal applications.

The script scans the packaged output for a leaked API key and refuses to finish if
it finds one. `.env` and `data/` sit outside electron-builder's file whitelist, so
your key is not bundled, but the check is there because the cost of being wrong is
someone else's bill. Note it matches a real key shape rather than the bare `gsk_`
prefix, since the settings UI legitimately contains `placeholder="gsk_..."`.

Testers supply their own Groq key through the UI. Collected corpora arrive as
`typist-corpus-<name>-<date>.json`: transcription text, timestamps, engine and
model only. No audio is recorded at any point, and keys never enter the export.

## Limitations

- Paste cannot reach Windows' secure desktop (UAC dialog, lock screen,
  Ctrl+Alt+Del). Nothing can inject input there by design.
- Paste overwrites the clipboard without restoring the previous contents.
- Builds are unsigned, so SmartScreen warns on the installer.
- On ARM64, local whisper runs the x64 build under emulation; upstream publishes
  no win-arm64 asset. Cloud is unaffected.
- A single push-to-talk hold is capped at five minutes.
