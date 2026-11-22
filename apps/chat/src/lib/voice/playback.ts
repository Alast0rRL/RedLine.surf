import { peaksFromPcm } from './waveform';

/**
 * Воспроизведение голосовых. Ogg/Opus играет нативно почти везде; где нет
 * (старые Safari) — декодируем wasm-декодером в WAV. Он же даёт волну, если
 * в событии её нет (например, голосовое из другого клиента).
 */

const canPlayOgg = (() => {
  try {
    return document.createElement('audio').canPlayType('audio/ogg; codecs=opus') !== '';
  } catch {
    return false;
  }
})();

export interface DecodedVoice {
  pcm: Float32Array;
  sampleRate: number;
}

async function decodeOgg(bytes: ArrayBuffer): Promise<DecodedVoice> {
  // сначала встроенный декодер браузера, потом wasm
  try {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    return { pcm: buf.getChannelData(0), sampleRate: buf.sampleRate };
  } catch {
    const { OggOpusDecoder } = await import('ogg-opus-decoder');
    const dec = new OggOpusDecoder();
    await dec.ready;
    try {
      const out = await dec.decodeFile(new Uint8Array(bytes));
      return { pcm: out.channelData[0] ?? new Float32Array(), sampleRate: out.sampleRate };
    } finally {
      dec.free();
    }
  }
}

function encodeWav({ pcm, sampleRate }: DecodedVoice): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** URL, который точно сыграет этот браузер. */
export async function playableUrl(blobUrl: string, mimetype: string | undefined): Promise<string> {
  const isOgg = !mimetype || /ogg|opus/i.test(mimetype);
  if (!isOgg || canPlayOgg) return blobUrl;
  const bytes = await (await fetch(blobUrl)).arrayBuffer();
  return URL.createObjectURL(encodeWav(await decodeOgg(bytes)));
}

/** Волна и длительность из самого файла — когда в событии их нет. */
export async function analyseVoice(blobUrl: string, bars: number): Promise<{ waveform: number[]; durationMs: number }> {
  const bytes = await (await fetch(blobUrl)).arrayBuffer();
  const decoded = await decodeOgg(bytes);
  return {
    waveform: peaksFromPcm(decoded.pcm, bars),
    durationMs: Math.round((decoded.pcm.length / decoded.sampleRate) * 1000),
  };
}
