/** Сжать/растянуть ряд уровней до `size` значений 0..1 (среднее по корзинам + нормализация). */
export function resampleWaveform(levels: number[], size: number): number[] {
  if (levels.length === 0) return new Array(size).fill(0);
  const out = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    const from = (i / size) * levels.length;
    const to = ((i + 1) / size) * levels.length;
    let sum = 0;
    let n = 0;
    for (let j = Math.floor(from); j < Math.max(Math.ceil(to), Math.floor(from) + 1) && j < levels.length; j++) {
      sum += levels[j];
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  const max = Math.max(...out);
  return max > 0 ? out.map((v) => v / max) : out;
}

/** Пики PCM → уровни для волны. */
export function peaksFromPcm(pcm: Float32Array, size: number): number[] {
  const bucket = Math.max(1, Math.floor(pcm.length / size));
  const levels: number[] = [];
  for (let i = 0; i < size; i++) {
    let sum = 0;
    const start = i * bucket;
    const end = Math.min(pcm.length, start + bucket);
    for (let j = start; j < end; j++) sum += pcm[j] * pcm[j];
    levels.push(end > start ? Math.sqrt(sum / (end - start)) : 0);
  }
  return resampleWaveform(levels, size);
}

/** Волна из события (0..1024) → 0..1 нужной длины. */
export function normalizeEventWaveform(raw: unknown, size: number): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const nums = raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0));
  return resampleWaveform(nums, size);
}
