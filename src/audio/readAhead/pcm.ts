// pcm.ts - turning decoded audio into what Whisper takes (16 kHz mono) and
// moving it between extension contexts compactly. Pure: no DOM or Web Audio,
// so it runs in the page's main world and in tests alike.

export const WHISPER_RATE = 16000;

const TAPS = 63;
const CUTOFF_HZ = 7000; // below Nyquist at 16 kHz (8 kHz), with room for the filter's transition

/** Averages channels into one. */
export function downmix(planes: Float32Array[]): Float32Array {
  if (planes.length === 1) return planes[0];
  const out = new Float32Array(planes[0].length);
  for (const p of planes) for (let i = 0; i < out.length; i++) out[i] += p[i] / planes.length;
  return out;
}

function lowPass(inRate: number): Float32Array {
  const h = new Float32Array(TAPS);
  const m = (TAPS - 1) / 2;
  const fc = CUTOFF_HZ / inRate;
  let sum = 0;
  for (let k = 0; k < TAPS; k++) {
    const x = k - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (TAPS - 1));
    h[k] = sinc * blackman;
    sum += h[k];
  }
  for (let k = 0; k < TAPS; k++) h[k] /= sum;
  return h;
}

/**
 * Streaming resampler to 16 kHz: low-pass (so nothing above 8 kHz folds down),
 * then a fractional step with linear interpolation. State carries across
 * pushes, so chunk joins are seamless.
 */
export class Resampler16k {
  private readonly h: Float32Array;
  private readonly step: number;
  private hist: Float32Array;
  private pos: number;

  constructor(private readonly inRate: number) {
    this.h = lowPass(inRate);
    this.step = inRate / WHISPER_RATE;
    this.hist = new Float32Array(TAPS);
    this.pos = TAPS - 1; // the first output lines up with the first input sample
  }

  private filtered(buf: Float32Array, j: number): number {
    let y = 0;
    for (let k = 0; k < TAPS; k++) y += this.h[k] * buf[j - k];
    return y;
  }

  push(input: Float32Array): Float32Array {
    if (this.inRate === WHISPER_RATE) return input.slice();
    const buf = new Float32Array(this.hist.length + input.length);
    buf.set(this.hist, 0);
    buf.set(input, this.hist.length);
    const out: number[] = [];
    while (Math.floor(this.pos) + 1 < buf.length) {
      const j = Math.floor(this.pos);
      const frac = this.pos - j;
      const a = this.filtered(buf, j);
      const b = frac ? this.filtered(buf, j + 1) : a;
      out.push(a + (b - a) * frac);
      this.pos += this.step;
    }
    const keepFrom = buf.length - TAPS;
    this.hist = buf.slice(keepFrom);
    this.pos -= keepFrom;
    return Float32Array.from(out);
  }
}

/** Float PCM -> Int16 little-endian -> base64 (extension messages are JSON). */
export function toInt16Base64(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(i * 2, Math.round(v * 32767), true);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromInt16Base64(b64: string): Float32Array {
  const s = atob(b64);
  const view = new DataView(new ArrayBuffer(s.length - (s.length % 2)));
  for (let i = 0; i < view.byteLength; i++) view.setUint8(i, s.charCodeAt(i));
  const out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32767;
  return out;
}
