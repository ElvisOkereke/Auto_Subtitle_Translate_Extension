import fs from 'fs';
import path from 'path';
import { WebmParser, webCodecsVideoCodec } from '../webm';
import type { Fmp4Fragment, Fmp4Init } from '../fmp4';

// 2 s, 160x90, VP9 at 10 fps, keyframe every 10 frames, clusters of 1 s (ffmpeg testsrc).
const FILE = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/tiny-vp9.webm')));

function pushAll(parser: WebmParser, chunks: Uint8Array[], offset = 0) {
  let init: Fmp4Init | undefined;
  const fragments: Fmp4Fragment[] = [];
  for (const c of chunks) {
    const r = parser.push(c, offset);
    if (r.init) init = r.init;
    fragments.push(...r.fragments);
  }
  return { init, fragments };
}

describe('WebmParser', () => {
  it('parses tracks and clusters from a VP9 file', () => {
    const { init, fragments } = pushAll(new WebmParser(), [FILE]);
    expect(init).toMatchObject({ width: 160, height: 90 });
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    const samples = fragments.flatMap(f => f.samples);
    expect(samples).toHaveLength(20);
    expect(samples[0].key).toBe(true);
    expect(samples[0].time).toBeCloseTo(0, 3);
    expect(samples[10].key).toBe(true);
    expect(samples[1].key).toBe(false);
    for (let i = 1; i < samples.length; i++) expect(samples[i].time).toBeGreaterThan(samples[i - 1].time);
    expect(samples[1].time).toBeCloseTo(0.1, 3);
    expect(samples.every(s => s.duration > 0 && s.data.byteLength > 0)).toBe(true);
    expect(fragments[0].start).toBeCloseTo(0, 3);
  });

  it('handles elements split at every byte boundary', () => {
    const whole = pushAll(new WebmParser(), [FILE]);
    const bytes = Array.from(FILE, (_, i) => FILE.subarray(i, i + 1));
    const split = pushAll(new WebmParser(), bytes);
    expect(split.init).toEqual(whole.init);
    expect(split.fragments.length).toBe(whole.fragments.length);
    expect(split.fragments.flatMap(f => f.samples).map(s => [s.time, s.key, s.data.byteLength])).toEqual(
      whole.fragments.flatMap(f => f.samples).map(s => [s.time, s.key, s.data.byteLength])
    );
  });

  it('applies timestampOffset', () => {
    const { fragments } = pushAll(new WebmParser(), [FILE], 100);
    expect(fragments[0].samples[0].time).toBeCloseTo(100, 3);
  });

  it('reset drops a half-parsed element so the next segment parses cleanly', () => {
    const parser = new WebmParser();
    parser.push(FILE.subarray(0, 700), 0);
    parser.reset();
    const { init, fragments } = pushAll(parser, [FILE]);
    expect(init).toMatchObject({ width: 160, height: 90 });
    expect(fragments.flatMap(f => f.samples)).toHaveLength(20);
  });
});

describe('webCodecsVideoCodec', () => {
  it('maps short codec names to WebCodecs strings', () => {
    expect(webCodecsVideoCodec('vp9')).toBe('vp09.00.10.08');
    expect(webCodecsVideoCodec('vp8')).toBe('vp8');
    expect(webCodecsVideoCodec('vp09.00.51.08')).toBe('vp09.00.51.08');
    expect(webCodecsVideoCodec('av01.0.04M.08')).toBe('av01.0.04M.08');
  });
});

// 2 s, 440 Hz sine, Opus 48 kHz mono (ffmpeg lavfi), clusters of ~1 s.
const OPUS = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/tiny-opus.webm')));

describe('WebmParser (audio track)', () => {
  it('reads the Opus track: codec, sample rate, channels and the OpusHead description', () => {
    const { init, fragments } = pushAll(new WebmParser('audio'), [OPUS]);
    expect(init?.audio).toEqual({ codec: 'opus', sampleRate: 48000, channels: 1 });
    expect(String.fromCharCode(...init!.description!.subarray(0, 8))).toBe('OpusHead');
    const samples = fragments.flatMap(f => f.samples);
    expect(samples.length).toBeGreaterThan(50); // 20 ms Opus frames
    expect(samples.every(s => s.key)).toBe(true);
    for (let i = 1; i < samples.length; i++) expect(samples[i].time).toBeGreaterThan(samples[i - 1].time);
    const last = samples[samples.length - 1];
    expect(last.time + last.duration).toBeGreaterThan(1.9);
    expect(last.time + last.duration).toBeLessThan(2.2);
  });

  it('the video parser ignores an audio-only file', () => {
    const { init, fragments } = pushAll(new WebmParser(), [OPUS]);
    expect(init).toBeUndefined();
    expect(fragments).toEqual([]);
  });

  it('audio parses the same split at every byte boundary', () => {
    const whole = pushAll(new WebmParser('audio'), [OPUS]);
    const split = pushAll(new WebmParser('audio'), Array.from(OPUS, (_, i) => OPUS.subarray(i, i + 1)));
    expect(split.fragments.flatMap(f => f.samples).map(s => s.time)).toEqual(whole.fragments.flatMap(f => f.samples).map(s => s.time));
  });
});
