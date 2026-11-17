import { ReadAheadWindows, collapseRepeats, mergeShort } from '../readAheadWindows';

const RATE = 16000;
const pcm = (seconds: number) => new Float32Array(Math.round(seconds * RATE));

function feed(w: ReadAheadWindows, from: number, seconds: number, nowMs = 0) {
  for (let t = from; t < from + seconds - 1e-9; t += 1) w.push(t, pcm(Math.min(1, from + seconds - t)), nowMs);
}

describe('ReadAheadWindows (sliding-window read-ahead transcription)', () => {
  it('sends a 28 s window from the cursor once that much audio is buffered', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 20);
    expect(w.next(80, 0)).toBeNull(); // 20 s buffered and the playhead 20 s away: wait for a full window
  });

  it('keeps finished sentences, holds back the tail, and starts the next window at the last kept sentence', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 60);
    const win = w.next(90, 0)!; // playhead 10 s before the cursor
    expect(win.start).toBe(100);
    expect(win.audio.length / RATE).toBeCloseTo(28, 1);
    const captions = w.complete([
      { text: 'one sentence.', start: 0.5, end: 3 },
      { text: 'another one.', start: 3.2, end: 9 },
      { text: 'cut at the edge', start: 25, end: 28 },
    ]);
    expect(captions.map(c => [c.text, c.start, c.end])).toEqual([
      ['one sentence.', 100.5, 103],
      ['another one.', 103.2, 109],
    ]);
    expect(w.next(90, 0)!.start).toBeCloseTo(109); // the held-back tail is heard again
  });

  it('a window with no sentence moves the cursor on (silence or music)', () => {
    const w = new ReadAheadWindows();
    feed(w, 0, 60);
    w.next(-10, 0);
    expect(w.complete([])).toEqual([]);
    expect(w.next(-10, 0)!.start).toBeCloseTo(26.5);
  });

  it('one sentence filling the whole window is kept (no endless re-transcription)', () => {
    const w = new ReadAheadWindows();
    feed(w, 0, 60);
    w.next(-10, 0);
    expect(w.complete([{ text: 'a very long sentence', start: 0, end: 28 }])).toHaveLength(1);
    expect(w.next(-10, 0)!.start).toBeCloseTo(28);
  });

  it('when the playhead is about to reach the cursor, sends what it has (short window) and keeps everything', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 6);
    const win = w.next(98.5, 0)!; // 1.5 s to go: do not wait for 28 s
    expect(win.audio.length / RATE).toBeCloseTo(6, 1);
    expect(w.complete([{ text: 'all of it', start: 4, end: 5.9 }])).toHaveLength(1);
  });

  it('skips audio the playhead has already passed', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 60);
    expect(w.next(120, 0)!.start).toBeCloseTo(120);
  });

  it('a gap in the audio (seek) starts a new run at the new position', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 10);
    feed(w, 300, 40);
    expect(w.next(290, 0)!.start).toBe(300);
  });

  it('only one window in flight', () => {
    const w = new ReadAheadWindows();
    feed(w, 0, 90);
    expect(w.next(-10, 0)).not.toBeNull();
    expect(w.next(-10, 0)).toBeNull();
  });
});

describe('collapseRepeats (Whisper loops)', () => {
  it('a phrase repeated three or more times in a row is kept once', () => {
    expect(collapseRepeats('de la Cámara de la Cámara de la Cámara de la Cámara final')).toBe('de la Cámara final');
    expect(collapseRepeats('「新鮮大学生」の「新鮮大学生」の「新鮮大学生」の「新鮮大学生」の')).toBe('「新鮮大学生」の');
  });

  it('normal text and a single repeat are left alone', () => {
    expect(collapseRepeats('Gol, gol de España')).toBe('Gol, gol de España');
    expect(collapseRepeats('no no, wait')).toBe('no no, wait');
  });
});

describe('mergeShort (readable lines from tiny sentences)', () => {
  it('joins back-to-back short sentences into one line', () => {
    const merged = mergeShort([
      { text: '네.', start: 10, end: 10.4 },
      { text: '좋습니다.', start: 10.5, end: 11 },
      { text: '이제 한타가 시작됩니다.', start: 11.1, end: 12.5 },
    ]);
    expect(merged).toEqual([{ text: '네. 좋습니다. 이제 한타가 시작됩니다.', start: 10, end: 12.5 }]);
  });

  it('does not join across a pause, or beyond about 4 s or 42 characters', () => {
    const merged = mergeShort([
      { text: 'one.', start: 0, end: 1 },
      { text: 'after a pause.', start: 2.5, end: 3 },
      { text: 'x'.repeat(40), start: 3.1, end: 5 },
    ]);
    expect(merged.map(m => m.text)).toEqual(['one.', 'after a pause.', 'x'.repeat(40)]);
  });
});

describe('ReadAheadWindows: no lone 1 s windows (final review)', () => {
  it('at a run start it waits for about 6 s of audio unless the playhead is about to arrive', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 2);
    expect(w.next(97, 0)).toBeNull(); // 3 s away: wait for more
    feed(w, 102, 4);
    expect(w.next(97, 0)!.audio.length / RATE).toBeCloseTo(6, 1);
  });

  it('the playhead within 2 s of the cursor: sends what it has', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 1.5);
    expect(w.next(99, 0)).not.toBeNull();
  });

  it('no new audio for 1.5 s (the buffer stalled): sends what it has', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 3, 0);
    expect(w.next(95, 1000)).toBeNull();
    expect(w.next(95, 1600)).not.toBeNull();
  });

  it('a short window that is not final holds back its unfinished last sentence', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 7);
    w.next(95, 0);
    const kept = w.complete([
      { text: 'done.', start: 0.5, end: 3 },
      { text: 'still going', start: 5, end: 7 },
    ]);
    expect(kept.map(c => c.text)).toEqual(['done.']);
    expect(w.next(101.5, 0)!.start).toBeCloseTo(103); // the held-back sentence is heard again
  });

  it('abort sends the same window again (a dropped job loses no audio)', () => {
    const w = new ReadAheadWindows();
    feed(w, 100, 40);
    const a = w.next(90, 0)!;
    w.abort();
    const b = w.next(90, 0)!;
    expect(b.start).toBe(a.start);
    expect(b.audio.length).toBe(a.audio.length);
  });
});
