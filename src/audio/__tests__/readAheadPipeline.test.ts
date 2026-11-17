import { ReadAheadPipeline } from '../readAheadPipeline';

const pcm = (seconds: number) => new Float32Array(Math.round(seconds * 16000));

function setup() {
  const jobs: { segmentId: number; seconds: number }[] = [];
  const captions: { text: string; start: number; end: number }[] = [];
  let id = 0;
  const p = new ReadAheadPipeline({
    nextId: () => ++id,
    transcribe: (segmentId, audio) => jobs.push({ segmentId, seconds: audio.length / 16000 }),
    emit: c => captions.push(c),
  });
  return { p, jobs, captions };
}

describe('ReadAheadPipeline (offscreen read-ahead coordination)', () => {
  it('a result for the window in flight becomes captions in video time', () => {
    const { p, jobs, captions } = setup();
    p.state(true, 90);
    for (let t = 100; t < 160; t++) p.audio(t, pcm(1));
    expect(jobs).toHaveLength(1);
    expect(p.result(jobs[0].segmentId, [{ text: 'hola a todos.', start: 1, end: 3 }])).toBe(true);
    expect(captions).toEqual([{ text: 'hola a todos.', start: 101, end: 103 }]);
  });

  it('a seek while a window is in flight: the stale result is ignored, the new position is transcribed', () => {
    const { p, jobs, captions } = setup();
    p.state(true, 90);
    for (let t = 100; t < 160; t++) p.audio(t, pcm(1));
    const stale = jobs[0].segmentId;
    p.reset(); // the viewer seeks to 300
    p.state(true, 300);
    for (let t = 300; t < 340; t++) p.audio(t, pcm(1));
    // The old window's text comes back now: it belongs to the old position.
    expect(p.result(stale, [{ text: 'old position', start: 1, end: 9 }])).toBe(true); // read-ahead's, not live's
    expect(captions).toEqual([]);
    const fresh = jobs[jobs.length - 1];
    expect(fresh.segmentId).not.toBe(stale);
    p.result(fresh.segmentId, [{ text: 'new position', start: 0.5, end: 2 }]);
    expect(captions.map(c => [c.text, c.start])).toEqual([['new position', 300.5]]);
  });

  it('a result it does not know is not read-ahead (the live path handles it)', () => {
    const { p } = setup();
    expect(p.result(999, [{ text: 'live', start: 0, end: 1 }])).toBe(false);
  });

  it('a dropped window is sent again (its audio is not lost)', () => {
    const { p, jobs } = setup();
    p.state(true, 90);
    for (let t = 100; t < 160; t++) p.audio(t, pcm(1));
    p.dropped(jobs[0].segmentId);
    p.state(true, 90);
    expect(jobs).toHaveLength(2);
    expect(jobs[1].seconds).toBeCloseTo(jobs[0].seconds);
  });

  it('an error for another job leaves the window in flight alone; one for it frees it', () => {
    const { p, jobs } = setup();
    p.state(true, 90);
    for (let t = 100; t < 160; t++) p.audio(t, pcm(1));
    p.error(12345);
    p.state(true, 90);
    expect(jobs).toHaveLength(1);
    p.error(jobs[0].segmentId);
    p.state(true, 90);
    expect(jobs).toHaveLength(2);
  });

  it('health from the page expires when it stops reporting', () => {
    let now = 0;
    const p = new ReadAheadPipeline({ nextId: () => 1, transcribe: () => undefined, emit: () => undefined, now: () => now });
    p.state(true, 10);
    expect(p.healthy).toBe(true);
    now = 4000;
    expect(p.healthy).toBe(false);
  });
});
