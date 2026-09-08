/**
 * Microphone capture, running in a hidden renderer window.
 *
 * Audio is captured with MediaRecorder (WebM/Opus), then decoded and re-encoded
 * to 16 kHz mono 16-bit WAV before being handed to the main process. Both
 * whisper.cpp and the Groq endpoint accept that format, and whisper.cpp requires
 * it, so converting once here keeps the engines interchangeable.
 */

import type { TypistApi } from "./typist-api";

declare global {
  interface Window {
    typist: TypistApi;
  }
}

const TARGET_SAMPLE_RATE = 16_000;

/** Recordings shorter than this are rejected rather than sent for transcription. */
const MIN_RECORDING_SECONDS = 0.25;

let mediaRecorder: MediaRecorder | null = null;
let activeStream: MediaStream | null = null;
let chunks: Blob[] = [];

/** Publishes the device list to the main process so the settings UI can read it. */
async function publishMicrophones(): Promise<void> {
  try {
    // Labels are only populated once microphone permission has been granted, so
    // a stream is opened and immediately closed to unlock them.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    // Permission denied or no device: fall through and report whatever we can.
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || "Microphone",
        isDefault: d.deviceId === "default",
      }));
    await window.typist.reportMicrophones(mics);
  } catch (e) {
    await window.typist.reportRecorderError(`Could not list microphones: ${String(e)}`);
  }
}

async function startCapture(deviceId: string): Promise<void> {
  stopTracks();
  chunks = [];

  const audio: MediaTrackConstraints =
    !deviceId || deviceId === "default" ? {} : { deviceId: { exact: deviceId } };

  // These defaults are tuned for speech recognition rather than voice calls.
  //
  // Echo cancellation exists to stop speaker output feeding back into the mic,
  // which is irrelevant when dictating, and it can attenuate the near-end voice.
  // Noise suppression is tuned for intelligibility to a human listener and is
  // known to chew into speech detail that Whisper uses. Automatic gain control
  // stays on, because consistent levels genuinely help.
  //
  // Judgment call rather than a measured result: if you dictate somewhere noisy,
  // re-enabling noiseSuppression may do better.
  audio.echoCancellation = false;
  audio.noiseSuppression = false;
  audio.autoGainControl = true;

  activeStream = await navigator.mediaDevices.getUserMedia({ audio });

  mediaRecorder = new MediaRecorder(activeStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.start();
}

function stopTracks(): void {
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
}

/** Waits for MediaRecorder to flush, then returns the recorded blob. */
function finishRecording(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      reject(new Error("Not currently recording"));
      return;
    }

    mediaRecorder.onstop = () => {
      const type = chunks[0]?.type || "audio/webm";
      resolve(new Blob(chunks, { type }));
    };
    mediaRecorder.onerror = (e) => reject(new Error(`Recording failed: ${String(e)}`));
    mediaRecorder.stop();
  });
}

/** Decodes compressed audio and resamples it to 16 kHz mono. */
async function toMono16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();

  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes.slice(0));
  } finally {
    await decodeCtx.close();
  }

  const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  if (frames <= 0) return new Float32Array(0);

  // OfflineAudioContext does the resampling and the channel downmix in one pass,
  // which is both simpler and better quality than hand-rolled interpolation.
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();

  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** Encodes float samples as a 16-bit PCM mono WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");

  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, Math.round(clamped * 32767), true);
    offset += bytesPerSample;
  }

  return buffer;
}

async function stopCaptureAndSubmit(): Promise<void> {
  try {
    const blob = await finishRecording();
    stopTracks();

    const samples = await toMono16k(blob);
    const seconds = samples.length / TARGET_SAMPLE_RATE;

    if (seconds < MIN_RECORDING_SECONDS) {
      throw new Error(
        `Recording too short (${seconds.toFixed(2)}s). Hold the hotkey a moment longer.`
      );
    }

    const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
    await window.typist.submitAudio(wav);
  } catch (e) {
    stopTracks();
    const message = e instanceof Error ? e.message : String(e);
    await window.typist.reportRecorderError(message);
  } finally {
    mediaRecorder = null;
    chunks = [];
  }
}

window.typist.onCaptureCommand(async (payload) => {
  if (payload.action === "start") {
    try {
      await startCapture(payload.deviceId ?? "default");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await window.typist.reportRecorderError(
        `Could not open the microphone: ${message}. Check Windows Settings > Privacy & security > Microphone.`
      );
    }
    return;
  }

  if (payload.action === "stop") {
    await stopCaptureAndSubmit();
  }
});

void publishMicrophones();

// Device list changes when a headset is plugged in or removed.
navigator.mediaDevices.addEventListener("devicechange", () => {
  void publishMicrophones();
});
