import Recorder from 'opus-recorder';
import encoderPath from 'opus-recorder/dist/encoderWorker.min.js?url';
import { resampleWaveform } from './waveform';

/**
 * Запись голосовых в Ogg/Opus на любом браузере (включая Safari, где MediaRecorder
 * умеет только mp4): кодирует opus-recorder (wasm, тот же, что в Element).
 * Параллельно снимаем уровень громкости для волны.
 */

export interface VoiceRecording {
  blob: Blob;
  durationMs: number;
  /** 0..1024, как требует org.matrix.msc1767.audio */
  waveform: number[];
}

const LEVEL_INTERVAL_MS = 50;
export const MAX_RECORDING_MS = 15 * 60 * 1000;

export function isVoiceRecordingSupported(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.AudioContext === 'function' && window.isSecureContext;
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private rec: Recorder | null = null;
  private timer = 0;
  private levels: number[] = [];
  private startedAt = 0;
  private result: Promise<Uint8Array> | null = null;

  /** Текущий уровень 0..1 — для живой индикации. */
  onLevel: ((level: number) => void) | null = null;
  /** Достигнут лимит длительности — запись надо отправить. */
  onLimit: (() => void) | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    this.rec = new Recorder({
      sourceNode: source,
      encoderPath,
      encoderSampleRate: 48000,
      numberOfChannels: 1,
      encoderApplication: 2048, // голос
      encoderBitRate: 32000,
      streamPages: false,
    });
    this.result = new Promise((resolve) => {
      this.rec!.ondataavailable = (data) => resolve(data);
    });
    await this.rec.start();
    this.startedAt = performance.now();

    const buf = new Float32Array(analyser.fftSize);
    this.timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      // речь редко выше 0.3 RMS — растягиваем, чтобы волна была выразительной
      const level = Math.min(1, rms * 3.5);
      this.levels.push(level);
      this.onLevel?.(level);
      if (this.elapsedMs() >= MAX_RECORDING_MS) this.onLimit?.();
    }, LEVEL_INTERVAL_MS);
  }

  elapsedMs(): number {
    return this.startedAt ? performance.now() - this.startedAt : 0;
  }

  async stop(): Promise<VoiceRecording> {
    if (!this.rec || !this.result) throw new Error('Запись не начата');
    const durationMs = Math.round(this.elapsedMs());
    await this.rec.stop();
    const data = await this.result;
    const waveform = resampleWaveform(this.levels, 100).map((v) => Math.round(v * 1024));
    await this.cleanup();
    return { blob: new Blob([data as Uint8Array<ArrayBuffer>], { type: 'audio/ogg' }), durationMs, waveform };
  }

  async cancel(): Promise<void> {
    try {
      await this.rec?.stop();
    } catch {
      /* уже остановлен */
    }
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    clearInterval(this.timer);
    this.timer = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      await this.rec?.close();
    } catch {
      /* sourceNode наш — контекст закрываем сами ниже */
    }
    this.rec = null;
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.levels = [];
    this.startedAt = 0;
  }
}
