import { AudioReadAhead } from '../readAhead/audioReadAhead';

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

  it('rejects audio outside the buffered range or behind the playhead', () => {
    post({ astAudio: true, t: 70, pcm: pcm(1) }); // beyond what the player buffered
    post({ astAudio: true, t: 5, pcm: pcm(1) }); // well behind the playhead
    expect(got).toEqual([]);
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
      (video as any).buffered = { length: 1, start: () => 0, end: () => 200 };
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
