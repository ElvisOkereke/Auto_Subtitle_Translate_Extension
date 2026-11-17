import { AudioReadAhead, readAheadHost } from '../readAhead/audioReadAhead';

function fakeVideo(currentTime: number, bufferedEnd: number) {
  return { currentTime, buffered: { length: 1, start: () => 0, end: () => bufferedEnd } } as unknown as HTMLVideoElement & { currentTime: number };
}

const pcm = (seconds: number) => new Float32Array(Math.round(seconds * 16000));

function post(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

describe('AudioReadAhead (untrusted main-world audio)', () => {
  let got: number[];
  let resets: number[];
  let clock: number;
  let video: ReturnType<typeof fakeVideo>;
  let source: AudioReadAhead;

  beforeEach(() => {
    got = [];
    resets = [];
    clock = 0;
    video = fakeVideo(10, 60);
    source = new AudioReadAhead(video, () => clock);
    source.start(
      t => got.push(t),
      t => resets.push(t)
    );
  });
  afterEach(() => source.stop());

  it('accepts 1 s chunks inside the buffered range near the playhead', () => {
    post({ astAudio: true, t: 10, pcm: pcm(1) });
    post({ astAudio: true, t: 11, pcm: pcm(1) });
    expect(got).toEqual([10, 11]);
  });

  it('rejects audio far ahead of the playhead (beyond what the tap decodes) or behind it', () => {
    post({ astAudio: true, t: 115, pcm: pcm(1) }); // more than 100 s ahead
    post({ astAudio: true, t: 5, pcm: pcm(1) }); // well behind the playhead
    expect(got).toEqual([]);
  });

  it('accepts audio beyond the buffered end of the video element (on YouTube: the shorter video buffer)', () => {
    post({ astAudio: true, t: 70, pcm: pcm(1) }); // bufferedEnd is 60: audio is buffered further than video
    expect(got).toEqual([70]);
  });

  it('rejects oversized chunks and anything that is not Float32 PCM', () => {
    post({ astAudio: true, t: 10, pcm: pcm(3) });
    post({ astAudio: true, t: 10, pcm: [0, 0, 0] });
    post({ astAudio: true, t: 'x', pcm: pcm(1) });
    expect(got).toEqual([]);
  });

  it('rejects audio overlapping what was already accepted (no double transcription after a seek back)', () => {
    post({ astAudio: true, t: 10, pcm: pcm(1) });
    post({ astAudio: true, t: 10.5, pcm: pcm(1) });
    expect(got).toEqual([10]);
  });

  it('caps the total accepted audio to what playback could produce', () => {
    video.currentTime = 0;
    for (let t = 0; t < 130; t++) {
      video.currentTime = Math.max(0, t - 50); // stays within the 100 s window: only the budget limits
      post({ astAudio: true, t, pcm: pcm(1) });
    }
    expect(got.length).toBe(120); // 120 s at once, then 4 s per wall second
    clock = 1000;
    post({ astAudio: true, t: 130, pcm: pcm(1) });
    expect(got.length).toBe(121);
  });

  it('lead is the covered audio ahead of the playhead; healthy from 2 s', () => {
    expect(source.healthy).toBe(false);
    post({ astAudio: true, t: 10, pcm: pcm(1) });
    expect(source.lead).toBeCloseTo(1);
    expect(source.healthy).toBe(false);
    post({ astAudio: true, t: 11, pcm: pcm(1) });
    post({ astAudio: true, t: 12, pcm: pcm(1) });
    expect(source.lead).toBeCloseTo(3);
    expect(source.healthy).toBe(true);
    video.currentTime = 40; // a seek past what was covered
    expect(source.lead).toBe(0);
  });

  it('passes decoder resets on, rate-limited', () => {
    post({ astAudioReset: true, t: 30 });
    post({ astAudioReset: true, t: 31 });
    expect(resets).toEqual([30]);
    clock = 3000;
    post({ astAudioReset: true, t: 50 });
    expect(resets).toEqual([30, 50]);
  });

  it('ignores messages from other windows and after stop', () => {
    window.dispatchEvent(new MessageEvent('message', { data: { astAudio: true, t: 10, pcm: pcm(1) }, source: null }));
    source.stop();
    post({ astAudio: true, t: 10, pcm: pcm(1) });
    expect(got).toEqual([]);
  });
});

describe('AudioReadAhead hardening (final review)', () => {
  let got: number[];
  let clock: number;
  let video: { currentTime: number; duration: number; buffered: unknown };
  let source: AudioReadAhead;
  const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data, source: window }));
  const pcm = (seconds: number) => new Float32Array(Math.round(seconds * 16000));

  beforeEach(() => {
    got = [];
    clock = 0;
    video = { currentTime: 0, duration: Infinity, buffered: { length: 0 } };
    source = new AudioReadAhead(video as unknown as HTMLVideoElement, () => clock);
    source.start(t => got.push(t), () => undefined);
  });
  afterEach(() => source.stop());

  it('an idle hour does not save up a burst: at most 120 s at once, ever', () => {
    clock = 3_600_000;
    for (let t = 0; t < 200; t++) {
      video.currentTime = Math.max(0, t - 50);
      post({ astAudio: true, t, pcm: pcm(1) });
    }
    expect(got.length).toBe(120);
  });

  it('rejects slivers; tiny chunks each cost a quarter second, so they cannot flood the pipeline', () => {
    post({ astAudio: true, t: 0, pcm: pcm(0.01) });
    expect(got).toEqual([]);
    for (let i = 0; i < 500; i++) post({ astAudio: true, t: 1 + i * 0.05, pcm: pcm(0.05) });
    expect(got.length).toBe(480); // 120 s bucket / 0.25 s per message
  });

  it('health has hysteresis: on at 3 s of lead, off below 1 s', () => {
    for (let t = 0; t < 3; t++) post({ astAudio: true, t, pcm: pcm(1) });
    expect(source.healthy).toBe(true);
    video.currentTime = 1.5; // 1.5 s left: still on
    expect(source.healthy).toBe(true);
    video.currentTime = 2.2; // 0.8 s left: off
    expect(source.healthy).toBe(false);
  });

  it('near the end of the video, covering what is left is enough', () => {
    video.duration = 2.5;
    post({ astAudio: true, t: 0, pcm: pcm(1) });
    post({ astAudio: true, t: 1, pcm: pcm(1) });
    post({ astAudio: true, t: 2, pcm: pcm(0.5) });
    expect(source.healthy).toBe(true);
  });

  it('captions arriving too late twice in 10 s mean read-ahead is not keeping up', () => {
    for (let t = 0; t < 5; t++) post({ astAudio: true, t, pcm: pcm(1) });
    expect(source.healthy).toBe(true);
    source.noteLate();
    source.noteLate();
    expect(source.healthy).toBe(false);
    clock = 11_000;
    expect(source.healthy).toBe(true);
  });

  it('forget drops what was accepted (a seek outside it, a new source): the same audio is accepted again', () => {
    post({ astAudio: true, t: 0, pcm: pcm(1) });
    expect(source.covers(0.5)).toBe(true);
    source.forget();
    expect(source.covers(0.5)).toBe(false);
    clock = 100; // past the per-second cap window
    post({ astAudio: true, t: 0, pcm: pcm(1) });
    expect(got).toEqual([0, 0]);
  });
});

describe('readAheadHost: read-ahead runs only where the audio tap runs', () => {
  it.each(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'localhost', '127.0.0.1'])('%s: yes', h => expect(readAheadHost(h)).toBe(true));
  it.each(['example.com', 'notyoutube.com', 'youtube.com.evil.test', 'vimeo.com'])('%s: no', h => expect(readAheadHost(h)).toBe(false));
});
