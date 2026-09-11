/** Shape of the API exposed by electron/preload.js via contextBridge. */

export interface Settings {
  microphone: string;
  engine: string;
  whisperModel: string;
  cloudModel: string;
  groqApiKey: string;
  recordingMode: string;
  hotkey: string;
  prompt: string;
  saveHistory: boolean;
  participantId: string;
}

export interface CloudModel {
  label: string;
  wer: number;
}

export interface HistoryEntry {
  at: string;
  engine: string;
  model: string;
  durationMs: number;
  raw: string;
  text: string;
}

export interface MicDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

export type RecordingState = "ready" | "recording" | "transcribing";

export interface CaptureCommand {
  action: "start" | "stop";
  deviceId?: string;
}

export interface TypistApi {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;

  checkModel(modelSize: string): Promise<boolean>;
  downloadModel(modelSize: string): Promise<void>;

  checkRuntime(): Promise<boolean>;
  installRuntime(): Promise<void>;

  getRecordingState(): Promise<RecordingState>;
  toggleRecording(): Promise<string>;

  submitAudio(wav: ArrayBuffer): Promise<void>;
  reportRecorderError(message: string): Promise<void>;
  reportMicrophones(mics: MicDevice[]): Promise<void>;

  listMicrophones(): Promise<MicDevice[]>;

  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;

  getCloudModels(): Promise<Record<string, CloudModel>>;
  getDataDir(): Promise<string>;

  getHistory(limit?: number): Promise<HistoryEntry[]>;
  clearHistory(): Promise<void>;
  getHistoryPath(): Promise<string>;
  getHistoryCount(): Promise<number>;
  exportCorpus(): Promise<string>;

  onRecordingState(cb: (state: RecordingState) => void): () => void;
  onDownloadProgress(cb: (progress: DownloadProgress) => void): () => void;
  onError(cb: (message: string) => void): () => void;
  onWindowMaximized(cb: (isMaximized: boolean) => void): () => void;
  onCaptureCommand(cb: (payload: CaptureCommand) => void): () => void;
}
