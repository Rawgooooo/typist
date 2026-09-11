"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * The renderer runs with contextIsolation on and no Node access, so this is the
 * only surface it gets. Each channel is listed explicitly rather than exposing
 * ipcRenderer wholesale.
 */
contextBridge.exposeInMainWorld("typist", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),

  checkModel: (modelSize) => ipcRenderer.invoke("model:check", modelSize),
  downloadModel: (modelSize) => ipcRenderer.invoke("model:download", modelSize),

  checkRuntime: () => ipcRenderer.invoke("runtime:check"),
  installRuntime: () => ipcRenderer.invoke("runtime:install"),

  getRecordingState: () => ipcRenderer.invoke("recording:state"),
  toggleRecording: () => ipcRenderer.invoke("recording:toggle"),

  // Recorder window only: hands captured audio back to the main process.
  submitAudio: (wavBuffer) => ipcRenderer.invoke("recording:audio", wavBuffer),
  reportRecorderError: (message) => ipcRenderer.invoke("recording:error", message),
  reportMicrophones: (mics) => ipcRenderer.invoke("recording:microphones", mics),

  listMicrophones: () => ipcRenderer.invoke("microphones:list"),

  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  isWindowMaximized: () => ipcRenderer.invoke("window:is-maximized"),

  getCloudModels: () => ipcRenderer.invoke("cloud:models"),
  getDataDir: () => ipcRenderer.invoke("paths:dataDir"),

  getHistory: (limit) => ipcRenderer.invoke("history:recent", limit),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  getHistoryPath: () => ipcRenderer.invoke("history:path"),
  getHistoryCount: () => ipcRenderer.invoke("history:count"),
  exportCorpus: () => ipcRenderer.invoke("history:export"),

  onRecordingState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on("recording-state", handler);
    return () => ipcRenderer.removeListener("recording-state", handler);
  },
  onDownloadProgress: (cb) => {
    const handler = (_e, progress) => cb(progress);
    ipcRenderer.on("download-progress", handler);
    return () => ipcRenderer.removeListener("download-progress", handler);
  },
  onError: (cb) => {
    const handler = (_e, message) => cb(message);
    ipcRenderer.on("typist-error", handler);
    return () => ipcRenderer.removeListener("typist-error", handler);
  },
  onWindowMaximized: (cb) => {
    const handler = (_e, isMaximized) => cb(isMaximized);
    ipcRenderer.on("window-maximized", handler);
    return () => ipcRenderer.removeListener("window-maximized", handler);
  },
  onCaptureCommand: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("capture-command", handler);
    return () => ipcRenderer.removeListener("capture-command", handler);
  },
});
