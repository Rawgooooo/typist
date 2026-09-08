import type { DownloadProgress, RecordingState, Settings, TypistApi } from "./typist-api";

declare global {
  interface Window {
    typist: TypistApi;
  }
}

const api = window.typist;

// DOM elements
const statusDot = document.getElementById("status-dot")!;
const statusText = document.getElementById("status-text")!;
const micSelect = document.getElementById("mic-select") as HTMLSelectElement;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
const engineLocal = document.getElementById("engine-local")!;
const engineCloud = document.getElementById("engine-cloud")!;
const localSettings = document.getElementById("local-settings")!;
const cloudSettings = document.getElementById("cloud-settings")!;
const whisperRuntimeRow = document.getElementById("whisper-runtime-row")!;
const runtimeStatus = document.getElementById("runtime-status")!;
const runtimeBtn = document.getElementById("runtime-btn") as HTMLButtonElement;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const downloadProgress = document.getElementById("download-progress")!;
const progressFill = document.getElementById("progress-fill")!;
const groqKey = document.getElementById("groq-key") as HTMLInputElement;
const cloudModelRow = document.getElementById("cloud-model-row")!;
const cloudModelSelect = document.getElementById("cloud-model-select") as HTMLSelectElement;
const promptInput = document.getElementById("prompt-input") as HTMLTextAreaElement;
const historyOn = document.getElementById("history-on")!;
const historyOff = document.getElementById("history-off")!;
const historyClear = document.getElementById("history-clear") as HTMLButtonElement;
const participantInput = document.getElementById("participant-input") as HTMLInputElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const historyList = document.getElementById("history-list")!;
const historyPathHint = document.getElementById("history-path-hint")!;
const modeToggle = document.getElementById("mode-toggle")!;
const modePtt = document.getElementById("mode-ptt")!;
const hotkeyText = document.getElementById("hotkey-text")!;
const errorBanner = document.getElementById("error-banner")!;
const errorText = document.getElementById("error-text")!;
const errorDismiss = document.getElementById("error-dismiss")!;

type Platform = "windows" | "macos" | "other";

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows|Win32|Win64/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  return "other";
}

const platform = detectPlatform();
document.body.classList.add(`platform-${platform}`);

/**
 * Renders an Electron accelerator for display. CommandOrControl resolves to Cmd
 * on macOS and Ctrl elsewhere.
 */
function formatHotkey(accelerator: string): string {
  const mod = platform === "macos" ? "Cmd" : "Ctrl";
  let out = accelerator
    .replace(/CommandOrControl/gi, mod)
    .replace(/CmdOrCtrl/gi, mod);

  out = platform === "macos"
    ? out.replace(/\bAlt\b/gi, "Option")
    : out.replace(/\bSuper\b/gi, "Win").replace(/\bMeta\b/gi, "Win");

  return out;
}

function showError(message: string) {
  errorText.textContent = message;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  errorBanner.classList.add("hidden");
  errorText.textContent = "";
}

function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) {
    // Electron prefixes IPC rejections with "Error invoking remote method ...:".
    return e.message.replace(/^Error invoking remote method '[^']*':\s*/, "");
  }
  return String(e);
}

errorDismiss.addEventListener("click", hideError);

// Section navigation
const navItems = document.querySelectorAll(".nav-item");
const sections = document.querySelectorAll(".content-section");

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.getAttribute("data-section");
    navItems.forEach((n) => n.classList.remove("active"));
    sections.forEach((s) => s.classList.remove("active"));
    item.classList.add("active");
    document.getElementById(`section-${target}`)?.classList.add("active");
  });
});

let currentSettings: Settings;

async function loadSettings() {
  currentSettings = await api.getSettings();

  await populateMicrophones();

  setEngine(currentSettings.engine);

  modelSelect.value = currentSettings.whisperModel;
  await checkModelStatus();
  await checkRuntimeStatus();
  await populateCloudModels();

  groqKey.value = currentSettings.groqApiKey;
  promptInput.value = currentSettings.prompt ?? "";
  participantInput.value = currentSettings.participantId ?? "";

  setRecordingMode(currentSettings.recordingMode);
  setSaveHistory(currentSettings.saveHistory !== false);

  hotkeyText.textContent = formatHotkey(currentSettings.hotkey);

  try {
    historyPathHint.textContent = `Appended to ${await api.getHistoryPath()}`;
  } catch {
    // Non-fatal: the hint just keeps its default wording.
  }

  await renderHistory();

  applyState(await api.getRecordingState());
}

/**
 * Enumerates audio inputs in this window rather than reading a list cached from
 * the recorder window over IPC.
 *
 * The cached approach raced the recorder's startup: whichever window finished
 * first won, and if the settings window asked before the recorder had been
 * granted microphone permission, it got an empty list or blank labels. Device
 * enumeration is a plain web API, so doing it here removes the ordering problem
 * entirely.
 */
async function enumerateMics(): Promise<MediaDeviceInfo[]> {
  // Device labels stay blank until microphone permission has been granted, so a
  // stream is opened and immediately closed to unlock them.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    // No device, or permission refused. Enumeration below still reports what it
    // can, and the empty case is handled by the caller.
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

async function populateMicrophones() {
  let inputs: MediaDeviceInfo[] = [];
  try {
    inputs = await enumerateMics();
  } catch (e) {
    showError(`Could not list microphones: ${errorMessage(e)}`);
  }

  micSelect.innerHTML = "";

  // Windows exposes "default" and "communications" as aliases for real devices.
  // The alias carries the resolved device name, which is worth surfacing so the
  // default entry says which microphone it actually is.
  const alias = inputs.find((d) => d.deviceId === "default");
  const aliasLabel = alias?.label?.replace(/^Default\s*-\s*/i, "").trim();

  const systemDefault = document.createElement("option");
  systemDefault.value = "default";
  systemDefault.textContent = aliasLabel
    ? `System default (${aliasLabel})`
    : "System default";
  micSelect.appendChild(systemDefault);

  const real = inputs.filter(
    (d) => d.deviceId !== "default" && d.deviceId !== "communications"
  );

  for (const device of real) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || "Microphone";
    micSelect.appendChild(option);
  }

  if (real.length === 0 && !alias) {
    showError(
      "No microphone was detected. Check that one is connected and that Windows " +
        "Settings > Privacy & security > Microphone allows desktop apps to use it."
    );
  }

  // A saved device that is no longer present falls back to the system default
  // rather than leaving the select blank.
  const known = Array.from(micSelect.options).some((o) => o.value === currentSettings.microphone);
  micSelect.value = known ? currentSettings.microphone : "default";
}

function setEngine(engine: string) {
  currentSettings.engine = engine;
  engineLocal.classList.toggle("active", engine === "local");
  engineCloud.classList.toggle("active", engine === "cloud");
  localSettings.classList.toggle("hidden", engine !== "local");
  whisperRuntimeRow.classList.toggle("hidden", engine !== "local");
  cloudSettings.classList.toggle("hidden", engine !== "cloud");
  cloudModelRow.classList.toggle("hidden", engine !== "cloud");
}

function setSaveHistory(enabled: boolean) {
  currentSettings.saveHistory = enabled;
  historyOn.classList.toggle("active", enabled);
  historyOff.classList.toggle("active", !enabled);
}

async function populateCloudModels() {
  try {
    const models = await api.getCloudModels();
    cloudModelSelect.innerHTML = "";
    for (const [id, info] of Object.entries(models)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = info.label;
      cloudModelSelect.appendChild(option);
    }
    const known = Object.keys(models).includes(currentSettings.cloudModel);
    cloudModelSelect.value = known ? currentSettings.cloudModel : "whisper-large-v3";
  } catch (e) {
    showError(`Could not load model list: ${errorMessage(e)}`);
  }
}

async function renderHistory() {
  try {
    const entries = await api.getHistory(100);
    historyList.innerHTML = "";

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = currentSettings.saveHistory
        ? "Nothing transcribed yet."
        : "History is off, so nothing is being recorded.";
      historyList.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const card = document.createElement("div");
      card.className = "history-entry";

      const meta = document.createElement("div");
      meta.className = "history-meta";
      const when = new Date(entry.at);
      meta.textContent = [
        Number.isNaN(when.getTime()) ? entry.at : when.toLocaleString(),
        entry.model,
        `${(entry.durationMs / 1000).toFixed(1)}s`,
      ].join("  ·  ");

      const text = document.createElement("div");
      text.className = "history-text";
      // textContent, not innerHTML: transcribed text is untrusted input.
      text.textContent = entry.text || "(empty)";

      card.append(meta, text);
      historyList.appendChild(card);
    }
  } catch (e) {
    showError(`Could not load history: ${errorMessage(e)}`);
  }
}

function setRecordingMode(mode: string) {
  currentSettings.recordingMode = mode;
  modeToggle.classList.toggle("active", mode === "toggle");
  modePtt.classList.toggle("active", mode === "push-to-talk");
}

async function checkModelStatus() {
  try {
    const downloaded = await api.checkModel(modelSelect.value);
    downloadBtn.textContent = downloaded ? "\u2713" : "Download";
    downloadBtn.disabled = downloaded;
  } catch (e) {
    showError(`Could not check model status: ${errorMessage(e)}`);
  }
}

async function checkRuntimeStatus() {
  try {
    const installed = await api.checkRuntime();
    runtimeStatus.textContent = installed ? "Installed" : "Not installed";
    runtimeStatus.className = `runtime-status ${installed ? "installed" : "missing"}`;
    runtimeBtn.textContent = installed ? "Reinstall" : "Install";
    runtimeBtn.disabled = false;
  } catch (e) {
    runtimeStatus.textContent = "Unknown";
    runtimeStatus.className = "runtime-status";
    showError(`Could not check the local runtime: ${errorMessage(e)}`);
  }
}

async function saveSettings() {
  currentSettings.microphone = micSelect.value;
  currentSettings.whisperModel = modelSelect.value;
  currentSettings.cloudModel = cloudModelSelect.value || currentSettings.cloudModel;
  currentSettings.groqApiKey = groqKey.value;
  currentSettings.prompt = promptInput.value;
  currentSettings.participantId = participantInput.value;
  try {
    currentSettings = await api.saveSettings(currentSettings);
  } catch (e) {
    showError(`Could not save settings: ${errorMessage(e)}`);
  }
}

function applyState(state: RecordingState) {
  statusDot.className = "";
  if (state === "recording") {
    statusDot.classList.add("recording");
    statusText.textContent = "Recording...";
    recordBtn.textContent = "Stop";
    recordBtn.disabled = false;
  } else if (state === "transcribing") {
    statusDot.classList.add("transcribing");
    statusText.textContent = "Transcribing...";
    recordBtn.textContent = "Transcribing…";
    recordBtn.disabled = true;
  } else {
    statusDot.classList.add("ready");
    statusText.textContent = "Ready";
    recordBtn.textContent = "Record";
    recordBtn.disabled = false;
  }
}

// Event listeners
engineLocal.addEventListener("click", () => {
  setEngine("local");
  saveSettings();
});

engineCloud.addEventListener("click", () => {
  setEngine("cloud");
  saveSettings();
});

micSelect.addEventListener("change", () => saveSettings());

modelSelect.addEventListener("change", async () => {
  await checkModelStatus();
  saveSettings();
});

recordBtn.addEventListener("click", async () => {
  hideError();
  try {
    await api.toggleRecording();
  } catch (e) {
    showError(errorMessage(e));
  }
});

downloadBtn.addEventListener("click", async () => {
  hideError();
  downloadBtn.disabled = true;
  downloadProgress.classList.remove("hidden");
  progressFill.style.width = "0%";

  try {
    await api.downloadModel(modelSelect.value);
    downloadBtn.textContent = "\u2713";
  } catch (e) {
    downloadBtn.textContent = "Retry";
    downloadBtn.disabled = false;
    showError(`Model download failed: ${errorMessage(e)}`);
  }
  downloadProgress.classList.add("hidden");
});

runtimeBtn.addEventListener("click", async () => {
  hideError();
  runtimeBtn.disabled = true;
  runtimeStatus.textContent = "Installing…";
  runtimeStatus.className = "runtime-status";
  downloadProgress.classList.remove("hidden");
  progressFill.style.width = "0%";

  try {
    await api.installRuntime();
  } catch (e) {
    showError(`Runtime install failed: ${errorMessage(e)}`);
  }

  downloadProgress.classList.add("hidden");
  await checkRuntimeStatus();
});

groqKey.addEventListener("change", () => saveSettings());

cloudModelSelect.addEventListener("change", () => saveSettings());

promptInput.addEventListener("change", () => saveSettings());

historyOn.addEventListener("click", () => {
  setSaveHistory(true);
  saveSettings().then(renderHistory);
});

historyOff.addEventListener("click", () => {
  setSaveHistory(false);
  saveSettings().then(renderHistory);
});

participantInput.addEventListener("change", () => saveSettings());

exportBtn.addEventListener("click", async () => {
  hideError();
  exportBtn.disabled = true;
  const original = exportBtn.textContent;
  exportBtn.textContent = "Exporting…";

  try {
    // Persist the name first so it lands in the exported file.
    await saveSettings();
    const dest = await api.exportCorpus();
    exportBtn.textContent = "Saved to Desktop";
    console.log(`Corpus exported to ${dest}`);
    setTimeout(() => {
      exportBtn.textContent = original;
      exportBtn.disabled = false;
    }, 2500);
  } catch (e) {
    exportBtn.textContent = original;
    exportBtn.disabled = false;
    showError(errorMessage(e));
  }
});

historyClear.addEventListener("click", async () => {
  try {
    await api.clearHistory();
  } catch (e) {
    showError(`Could not clear history: ${errorMessage(e)}`);
  }
  await renderHistory();
});

// Refresh the list when a transcription finishes, so it stays current without a
// manual reload.
api.onRecordingState((state) => {
  if (state === "ready") void renderHistory();
});

modeToggle.addEventListener("click", () => {
  setRecordingMode("toggle");
  saveSettings();
});

modePtt.addEventListener("click", () => {
  setRecordingMode("push-to-talk");
  saveSettings();
});

api.onRecordingState((state) => applyState(state));

api.onDownloadProgress((progress: DownloadProgress) => {
  progressFill.style.width = `${progress.percent}%`;
});

// Hotkey-driven failures have no UI call to reject, so they arrive as events.
api.onError((message) => showError(message));

// Keeps the dropdown current when a headset is plugged in or removed.
navigator.mediaDevices?.addEventListener("devicechange", () => {
  populateMicrophones().catch((e) => showError(errorMessage(e)));
});

loadSettings().catch((e) => {
  showError(`Failed to load settings: ${errorMessage(e)}`);
});
