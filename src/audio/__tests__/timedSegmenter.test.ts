import { TimedSegmenter } from '../timedSegmenter';

const RATE = 16000;
const FRAME = 1024; // 64 ms
const FRAME_S = FRAME / RATE;

/** Feeds `seconds` of tone (speech) or silence starting at video time `t`; returns emitted segments. */
function feed(seg: TimedSegmenter, t: number, seconds: number, speech: boolean) {
  const out = [];
  const frames = Math.round((seconds * RATE) / FRAME);
  for (let i = 0; i < frames; i++) {
    const frame = new Float32Array(FRAME).fill(speech ? 0.2 : 0);
    const s = seg.push(frame, t + i * FRAME_S);
    if (s) out.push(s);
  }
  return out;
}

describe('TimedSegmenter (read-ahead speech segments in video time)', () => {
  it('a phrase becomes one segment with its video-time start and speech end', () => {
    const seg = new TimedSegmenter(RATE);
    expect(feed(seg, 0, 1, false)).toEqual([]);
    expect(feed(seg, 1, 1.5, true)).toEqual([]);
    const [s] = feed(seg, 2.5, 1, false);
    expect(s.start).toBeCloseTo(1, 1);
    expect(Math.abs(s.start - 1)).toBeLessThanOrEqual(FRAME_S);
    expect(Math.abs(s.end - 2.5)).toBeLessThanOrEqual(FRAME_S);
    expect(s.audio.length / RATE).toBeGreaterThan(1.5); // speech plus the trailing silence kept
  });

  it('long speech is cut at 10 s (Whisper splits it into timed sentences)', () => {
    const seg = new TimedSegmenter(RATE);
    const out = feed(seg, 10, 11, true);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBeCloseTo(10, 1);
    expect(out[0].end - out[0].start).toBeGreaterThan(9.9);
    expect(out[0].end - out[0].start).toBeLessThan(10.1);
  });

  it('a blip shorter than the minimum speech is discarded', () => {
    const seg = new TimedSegmenter(RATE);
    feed(seg, 0, 0.13, true);
    expect(feed(seg, 0.13, 1, false)).toEqual([]);
  });

  it('reset drops a half-built segment (a seek or gap)', () => {
    const seg = new TimedSegmenter(RATE);
    feed(seg, 0, 1, true);
    seg.reset();
    expect(feed(seg, 50, 1, false)).toEqual([]);
  });
});
