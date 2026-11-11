/** Parses a 16-bit PCM mono WAV and returns its samples as floats in [-1, 1]. */
export function readWavMono16(buffer: Buffer): { sampleRate: number; samples: Float32Array } {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let offset = 12;
  let sampleRate = 0;
  while (offset < buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      sampleRate = buffer.readUInt32LE(offset + 12);
    } else if (id === 'data') {
      const count = size / 2;
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = buffer.readInt16LE(offset + 8 + i * 2) / 32768;
      return { sampleRate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** Time (s) at which the last speech in the clip ends, via a simple energy gate. */
export function speechEndSeconds(buffer: Buffer, threshold = 0.01, windowMs = 20): number {
  const { sampleRate, samples } = readWavMono16(buffer);
  const win = Math.round((sampleRate * windowMs) / 1000);
  let lastLoud = 0;
  for (let start = 0; start + win <= samples.length; start += win) {
    let sum = 0;
    for (let i = start; i < start + win; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / win) > threshold) lastLoud = start + win;
  }
  return lastLoud / sampleRate;
}
