"use strict";

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  session,
  screen,
  shell,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const settingsStore = require("./lib/settings");
const { pasteText } = require("./lib/paste");
const { cleanupText } = require("./lib/cleanup");
const transcribeLib = require("./lib/transcribe");
const whisperRuntime = require("./lib/whisperRuntime");
const keyWatch = require("./lib/keyWatch");
const history = require("./lib/history");

/**
 * Dev mode is opt-in via TYPIST_DEV=1 rather than derived from app.isPackaged,
 * because the normal `electron .` flow runs unpackaged against the built dist/
 * and must not try to reach the Vite dev server.
 */
const IS_DEV = process.env.TYPIST_DEV === "1";
const DEV_URL = "http://localhost:1420";

/** Renderer files live in dist/ once built by Vite. */
const DIST = path.join(__dirname, "..", "dist");

/**
 * Records a fatal or startup problem to disk.
 *
 * A packaged GUI app has no console, so an early failure otherwise leaves nothing
 * to diagnose: the process just disappears. Falls back to the temp directory
 * because this can run before the data directory is known to be writable.
 */
function writeLog(level, message) {
  const line = `[${new Date().toISOString()}] ${level} ${message}\n`;

  for (const dir of [safeAppDir(), os.tmpdir()]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "typist.log"), line, "utf8");
      return;
    } catch {
      // Try the next location.
    }
  }
}

/**
 * Traces lifecycle milestones to disk.
 *
 * Kept permanently rather than used once: a packaged GUI app has no console, so
 * without this a startup failure on someone else's machine is undiagnosable.
 */
function logEvent(message) {
  console.log(`[Typist] ${message}`);
  writeLog("INFO ", message);
}

function logStartupError(message) {
  console.error(`[Typist] ${message}`);
  writeLog("ERROR", message);
}

function safeAppDir() {
  try {
    return settingsStore.appDir();
  } catch {
    return null;
  }
}

// Without these, an unhandled rejection terminates the main process silently,
// which is exactly how the packaged build failed: visible in Task Manager for a
// moment, then gone, with no message anywhere. Log and keep running instead.
process.on("uncaughtException", (e) => {
  logStartupError(`uncaughtException: ${e && e.stack ? e.stack : e}`);
});

process.on("unhandledRejection", (reason) => {
  logStartupError(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

let mainWindow = null;
let overlayWindow = null;
let recorderWindow = null;

/** Guards against re-entering shutdown from several paths at once. */
let isQuitting = false;

/**
 * Destroys the always-open background windows.
 *
 * `destroy()` rather than `close()`: close is cancellable and fires the normal
 * lifecycle, which during shutdown can leave a window alive and hold the process
 * open with no visible UI.
 */
function destroyBackgroundWindows() {
  for (const win of [overlayWindow, recorderWindow]) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  overlayWindow = null;
  recorderWindow = null;
}

/**
 * Shuts the app down completely, so no process is left behind in Task Manager.
 */
function quitApp() {
  if (isQuitting) return;
  isQuitting = true;

  logEvent("quitApp: tearing down");
  cancelPtt();

  try {
    globalShortcut.unregisterAll();
  } catch {
    // Nothing registered, or already torn down.
  }

  destroyBackgroundWindows();
  app.quit();
}

let settings = settingsStore.DEFAULTS;
let activeHotkey = settingsStore.DEFAULT_HOTKEY;

/** ready | recording | transcribing */
let recordingState = "ready";
let pttWatcher = null;
let cachedMicrophones = [];

/** Resolves when the recorder window hands back a WAV, or rejects on failure. */
let pendingCapture = null;

// ── State ───────────────────────────────────────────────

function setState(next) {
  recordingState = next;
  broadcast("recording-state", next);

  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const cls =
    next === "recording" ? "mic recording" : next === "transcribing" ? "mic transcribing" : "mic";

  overlayWindow.webContents
    .executeJavaScript(`document.getElementById('mic').className = ${JSON.stringify(cls)};`)
    .catch(() => {});

  // The indicator is only meaningful while something is happening. Keeping it on
  // screen permanently makes it an obstruction, so it is hidden when idle.
  if (next === "ready") {
    overlayWindow.hide();
  } else if (!overlayWindow.isVisible()) {
    overlayWindow.showInactive();
  }
}

function broadcast(channel, payload) {
  for (const win of [mainWindow, overlayWindow, recorderWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function reportError(message) {
  console.error(`[Typist] ${message}`);
  broadcast("typist-error", String(message));
}

// ── Windows ─────────────────────────────────────────────

/**
 * Loads a renderer document into a window.
 *
 * Production must use loadFile rather than a hand-built `file://` URL. Joining a
 * Windows path onto `file://` yields `file://Q:\...\app.asar\dist\index.html`,
 * where Chromium reads `Q:` as the hostname and the load fails. Because the
 * resulting rejection was neither awaited nor caught, it surfaced as an unhandled
 * promise rejection and killed the main process on startup — the app appeared in
 * Task Manager and vanished. Dev was unaffected because it loads over http.
 */
function loadRenderer(win, file) {
  const done = IS_DEV
    ? win.loadURL(`${DEV_URL}/${file}`)
    : win.loadFile(path.join(DIST, file));

  return done.catch((e) => {
    // Tearing down a window that is still loading aborts the load. That is
    // expected during shutdown and must not be reported as a failure, or the log
    // ends with an alarming ERR_FAILED that looks like the cause of the exit.
    if (isQuitting) return;
    logStartupError(`Failed to load ${file}: ${e.message}`);
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 620,
    minWidth: 720,
    minHeight: 520,
    title: "Typist",
    // The OS chrome is replaced by the in-app title bar in index.html, so the
    // window is frameless. Frameless windows stay edge-resizable on Windows.
    frame: false,
    backgroundColor: "#000000",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void loadRenderer(mainWindow, "index.html");

  mainWindow.once("ready-to-show", () => {
    logEvent("main window ready-to-show");
    mainWindow.show();
  });

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    logStartupError(`main renderer gone: ${JSON.stringify(details)}`);
  });

  mainWindow.webContents.on("did-finish-load", () => logEvent("main window did-finish-load"));

  // The window can be maximized by double-clicking the drag strip or by Windows
  // snap, neither of which routes through the IPC handler, so the glyph is kept
  // in sync from the window's own events.
  const sendMaximized = (isMaximized) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-maximized", isMaximized);
    }
  };
  mainWindow.on("maximize", () => sendMaximized(true));
  mainWindow.on("unmaximize", () => sendMaximized(false));

  // Closing the settings window quits the whole app.
  //
  // The recorder and overlay windows are always open, so `window-all-closed`
  // never fired and the process stayed alive headlessly. Relaunching then hit the
  // single-instance lock, the new instance exited, and the survivor had no main
  // window left to show — the app became unlaunchable until killed from Task
  // Manager.
  //
  // Tradeoff: the global hotkey only works while Typist is open. Keeping it alive
  // in the background would need a tray icon so there is a visible way to quit
  // and reopen it.
  mainWindow.on("closed", () => {
    logEvent("main window closed -> quitting app");
    mainWindow = null;
    quitApp();
  });

  // If the document fails to load, ready-to-show never fires and the app would
  // sit invisible with no explanation. Show it anyway so the failure is visible.
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logStartupError(`did-fail-load ${code} ${desc} ${url}`);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
}

function createOverlayWindow() {
  const primary = screen.getPrimaryDisplay();
  const { width } = primary.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 50,
    height: 50,
    x: Math.max(0, width - 70),
    y: 10,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // Shown only while recording or transcribing; see setState.
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Keeps the indicator above full-screen windows too.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setIgnoreMouseEvents(true);
  void loadRenderer(overlayWindow, "overlay.html");
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

/**
 * Hidden window that owns microphone capture.
 *
 * getUserMedia and MediaRecorder are web APIs, so capture has to happen in a
 * renderer. A dedicated hidden window is used rather than the settings window so
 * that closing the settings window does not kill recording.
 */
function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Capture must keep running while the window is hidden.
      backgroundThrottling: false,
    },
  });

  void loadRenderer(recorderWindow, "recorder.html");
  recorderWindow.on("closed", () => {
    recorderWindow = null;
  });
}

// ── Recording flow ──────────────────────────────────────

function startRecording() {
  if (recordingState !== "ready") {
    throw new Error("Already recording or transcribing");
  }
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    throw new Error("Recorder is not ready yet");
  }

  recorderWindow.webContents.send("capture-command", {
    action: "start",
    deviceId: settings.microphone,
  });
  setState("recording");
}

/**
 * Stops capture and resolves with the WAV bytes the recorder window returns.
 */
function requestAudio() {
  return new Promise((resolve, reject) => {
    if (pendingCapture) {
      reject(new Error("A capture is already being finalised"));
      return;
    }

    const timer = setTimeout(() => {
      pendingCapture = null;
      reject(new Error("Timed out waiting for audio from the recorder"));
    }, 30000);

    pendingCapture = {
      resolve: (buf) => {
        clearTimeout(timer);
        pendingCapture = null;
        resolve(buf);
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingCapture = null;
        reject(err);
      },
    };

    recorderWindow.webContents.send("capture-command", { action: "stop" });
  });
}

async function stopAndTranscribe() {
  if (recordingState !== "recording") {
    throw new Error("Not currently recording");
  }
  setState("transcribing");

  const wavPath = path.join(os.tmpdir(), `typist-recording-${Date.now()}.wav`);

  try {
    const wav = await requestAudio();
    if (!wav || wav.byteLength === 0) {
      throw new Error("No audio captured. Check the microphone is not muted.");
    }

    await fs.promises.writeFile(wavPath, Buffer.from(wav));

    const started = Date.now();
    const raw = await transcribeLib.transcribe(settings, wavPath);
    const durationMs = Date.now() - started;
    const cleaned = cleanupText(raw);

    if (settings.saveHistory) {
      history.append({
        engine: settings.engine,
        model: settings.engine === "cloud" ? settings.cloudModel : settings.whisperModel,
        durationMs,
        raw,
        text: cleaned,
      });
    }

    if (!cleaned) {
      throw new Error("Nothing was transcribed. Try speaking a little longer.");
    }

    await pasteText(cleaned);
    return cleaned;
  } finally {
    // Always reset state and remove the recording, success or failure. Leaving
    // the state machine in "transcribing" would wedge the app until restart.
    await fs.promises.rm(wavPath, { force: true }).catch(() => {});
    setState("ready");
  }
}

async function toggleRecording() {
  if (recordingState === "ready") {
    startRecording();
    return "recording";
  }
  if (recordingState === "recording") {
    return stopAndTranscribe();
  }
  throw new Error("Currently transcribing, please wait");
}

function cancelPtt() {
  if (pttWatcher) {
    pttWatcher.cancel();
    pttWatcher = null;
  }
}

async function onHotkey() {
  try {
    if (settings.recordingMode === "push-to-talk") {
      if (recordingState !== "ready") return;

      startRecording();

      cancelPtt();
      pttWatcher = keyWatch.watchForRelease(activeHotkey, () => {
        pttWatcher = null;
        stopAndTranscribe().catch((e) => reportError(e.message));
      });

      if (!pttWatcher.supported) {
        // Without release detection, hold-to-talk cannot end on its own; fall
        // back to toggle semantics rather than recording forever.
        reportError(
          "Push-to-talk could not watch for key release with this hotkey; " +
            "press the hotkey again to stop."
        );
      }
      return;
    }

    await toggleRecording();
  } catch (e) {
    reportError(e.message);
  }
}

// ── Hotkey registration ─────────────────────────────────

function registerHotkey() {
  globalShortcut.unregisterAll();

  const desired = settings.hotkey || settingsStore.DEFAULT_HOTKEY;

  const tryRegister = (accelerator) => {
    try {
      return globalShortcut.register(accelerator, onHotkey);
    } catch (e) {
      console.error(`[Typist] Invalid accelerator '${accelerator}': ${e.message}`);
      return false;
    }
  };

  if (tryRegister(desired)) {
    activeHotkey = desired;
    console.log(`[Typist] Global shortcut registered: ${desired}`);
    return;
  }

  console.error(`[Typist] Failed to register '${desired}' (another app may own it)`);

  if (desired !== settingsStore.FALLBACK_HOTKEY && tryRegister(settingsStore.FALLBACK_HOTKEY)) {
    activeHotkey = settingsStore.FALLBACK_HOTKEY;
    settings.hotkey = settingsStore.FALLBACK_HOTKEY;
    console.log(`[Typist] Fell back to ${settingsStore.FALLBACK_HOTKEY}`);
    reportError(`Hotkey '${desired}' was unavailable; using ${settingsStore.FALLBACK_HOTKEY} instead.`);
    return;
  }

  reportError("No global hotkey could be registered. Use the button in the app to record.");
}

// ── IPC ─────────────────────────────────────────────────

function registerIpc() {
  ipcMain.handle("settings:get", () => settings);

  ipcMain.handle("settings:save", (_e, incoming) => {
    const hotkeyChanged = incoming?.hotkey && incoming.hotkey !== settings.hotkey;
    settings = settingsStore.save({ ...settings, ...incoming });
    if (hotkeyChanged) registerHotkey();
    return settings;
  });

  ipcMain.handle("model:check", (_e, modelSize) => transcribeLib.isModelDownloaded(modelSize));

  ipcMain.handle("model:download", async (_e, modelSize) => {
    const dest = transcribeLib.modelPath(modelSize);
    await whisperRuntime.downloadWithProgress(
      transcribeLib.modelDownloadUrl(modelSize),
      dest,
      (p) => broadcast("download-progress", p)
    );
  });

  ipcMain.handle("runtime:check", () => whisperRuntime.isInstalled());

  ipcMain.handle("runtime:install", async () => {
    await whisperRuntime.install((p) => broadcast("download-progress", p));
  });

  ipcMain.handle("recording:state", () => recordingState);
  ipcMain.handle("recording:toggle", async () => {
    cancelPtt();
    return toggleRecording();
  });

  ipcMain.handle("recording:audio", (_e, wavBuffer) => {
    if (pendingCapture) pendingCapture.resolve(wavBuffer);
  });

  ipcMain.handle("recording:error", (_e, message) => {
    if (pendingCapture) {
      pendingCapture.reject(new Error(message));
    } else {
      reportError(message);
    }
  });

  ipcMain.handle("recording:microphones", (_e, mics) => {
    cachedMicrophones = Array.isArray(mics) ? mics : [];
  });

  ipcMain.handle("microphones:list", () => cachedMicrophones);

  ipcMain.handle("history:recent", (_e, limit) => history.recent(limit ?? 50));
  ipcMain.handle("history:clear", () => history.clear());
  ipcMain.handle("history:path", () => history.historyPath());
  ipcMain.handle("history:count", () => history.count());

  ipcMain.handle("history:export", () => {
    if (history.count() === 0) {
      throw new Error("Nothing to export yet — no transcriptions recorded.");
    }

    // Desktop, so a non-technical tester can find and attach it without being
    // told where the app data directory is.
    const dest = history.exportCorpus(app.getPath("desktop"), {
      participantId: settings.participantId,
      appVersion: app.getVersion(),
    });

    // Opens Explorer with the file selected.
    shell.showItemInFolder(dest);
    return dest;
  });

  ipcMain.handle("cloud:models", () => transcribeLib.CLOUD_MODELS);
  ipcMain.handle("paths:dataDir", () => settingsStore.appDir());

  // Window chrome. The frameless window has no OS buttons, so the renderer's
  // title bar drives these.
  ipcMain.handle("window:minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  ipcMain.handle("window:close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  ipcMain.handle("window:is-maximized", () =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
  );
}

// ── Startup ─────────────────────────────────────────────

logEvent(`main.js loaded (packaged=${app.isPackaged}, dev=${IS_DEV})`);

// A second instance would fight over the global hotkey and the config file.
if (!app.requestSingleInstanceLock()) {
  logEvent("another instance already holds the lock; exiting");
  app.quit();
} else {
  app.on("second-instance", () => {
    logEvent("second instance launched; surfacing existing window");

    // Recreate rather than only focusing. If the main window is gone but the
    // process is somehow still alive, focusing a destroyed window would silently
    // do nothing and the app would look broken.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      return;
    }

    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    const loadedEnv = settingsStore.loadDotenv([
      path.dirname(app.getPath("exe")),
      path.join(__dirname, ".."),
    ]);
    console.log(
      loadedEnv ? `[Typist] Loaded environment from ${loadedEnv}` : "[Typist] No .env found"
    );

    settings = settingsStore.load();
    console.log(`[Typist] Data directory: ${settingsStore.appDir()}`);
    history.prune();

    // Desktop app: microphone access is granted rather than prompted, since
    // there is no meaningful place to show a permission dialog.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === "media");
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");

    registerIpc();
    logEvent("ipc registered");

    createRecorderWindow();
    logEvent("recorder window created");

    createOverlayWindow();
    logEvent("overlay window created");

    createMainWindow();
    logEvent("main window created");

    registerHotkey();
    setState("ready");
    logEvent("startup complete");
  });

  app.on("window-all-closed", () => {
    logEvent("window-all-closed fired");
    quitApp();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    logEvent("before-quit");
  });

  app.on("will-quit", () => {
    logEvent("will-quit");
    cancelPtt();
    globalShortcut.unregisterAll();
    destroyBackgroundWindows();
  });

  app.on("quit", (_e, code) => logEvent(`quit (exit code ${code})`));
}
