import { Resampler16k, downmix, fromInt16Base64, toInt16Base64 } from '../readAhead/pcm';

const sine = (freq: number, rate: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

const rms = (x: Float32Array) => Math.sqrt(x.reduce((n, v) => n + v * v, 0) / x.length);

/** Zero crossings per second (2 per cycle). */
const crossingsPerSecond = (x: Float32Array, rate: number) => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 !== x[i] < 0) n++;
  return n / (x.length / rate);
};

describe('Resampler16k', () => {
  it('48 kHz -> 16 kHz keeps a 1 kHz tone (amplitude and frequency)', () => {
    const out = new Resampler16k(48000).push(sine(1000, 48000, 1));
    const body = out.subarray(200, out.length - 200);
    expect(rms(body)).toBeGreaterThan(0.5 / Math.SQRT2 * 0.9);
    expect(rms(body)).toBeLessThan(0.5 / Math.SQRT2 * 1.1);
    expect(crossingsPerSecond(body, 16000)).toBeGreaterThan(1900);
    expect(crossingsPerSecond(body, 16000)).toBeLessThan(2100);
  });

  it('streams: many small pushes give the same length and no jump at the joins', () => {
    const input = sine(440, 48000, 2);
    const r = new Resampler16k(48000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 960) parts.push(r.push(input.subarray(i, i + 960)));
    const out = Float32Array.from(parts.flatMap(p => Array.from(p)));
    expect(Math.abs(out.length - input.length / 3)).toBeLessThanOrEqual(2);
    const whole = new Resampler16k(48000).push(input);
    for (let i = 0; i < Math.min(out.length, whole.length); i++) expect(out[i]).toBeCloseTo(whole[i], 4);
  });

  it('removes content above 8 kHz instead of folding it down', () => {
    const out = new Resampler16k(48000).push(sine(12000, 48000, 1));
    expect(rms(out.subarray(200, out.length - 200))).toBeLessThan(0.1 * (0.5 / Math.SQRT2));
  });

  it('44.1 kHz input works too (fractional step)', () => {
    const out = new Resampler16k(44100).push(sine(1000, 44100, 1));
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2);
    expect(crossingsPerSecond(out.subarray(200, out.length - 200), 16000)).toBeGreaterThan(1900);
  });
});

describe('downmix and transport', () => {
  it('averages channels', () => {
    expect(Array.from(downmix([Float32Array.from([1, 0]), Float32Array.from([0, 0])]))).toEqual([0.5, 0]);
  });

  it('Int16 base64 round trip within one step', () => {
    const pcm = Float32Array.from([0, 0.5, -0.5, 0.999, -1, 0.123]);
    const back = fromInt16Base64(toInt16Base64(pcm));
    expect(back.length).toBe(pcm.length);
    pcm.forEach((v, i) => expect(Math.abs(back[i] - v)).toBeLessThan(1 / 32000));
  });
});
