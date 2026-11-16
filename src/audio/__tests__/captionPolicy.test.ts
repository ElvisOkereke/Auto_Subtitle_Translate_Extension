import { CaptionPolicy } from '../captionPolicy';

const playing = (videoTime: number, over: Partial<{ paused: boolean; adShowing: boolean; seekedSinceSpeech: boolean }> = {}) => ({
  videoTime,
  paused: false,
  adShowing: false,
  seekedSinceSpeech: false,
  ...over,
});

describe('CaptionPolicy (live audio captions, video time)', () => {
  it('shows a fresh caption', () => {
    const p = new CaptionPolicy();
    expect(p.offer({ id: 'a', text: 'Hello there', speechEndVideo: 10 }, playing(11))).toBe('show');
  });

  it('drops a caption that arrives while paused or during an ad', () => {
    const p = new CaptionPolicy();
    expect(p.offer({ id: 'a', text: 'x', speechEndVideo: 10 }, playing(11, { paused: true }))).toBe('drop');
    expect(p.offer({ id: 'b', text: 'x', speechEndVideo: 10 }, playing(11, { adShowing: true }))).toBe('drop');
  });

  it('drops a caption whose speech came before a seek', () => {
    const p = new CaptionPolicy();
    expect(p.offer({ id: 'a', text: 'x', speechEndVideo: 10 }, playing(50, { seekedSinceSpeech: true }))).toBe('drop');
  });

  it('drops a caption whose speech ended more than 5 s ago (video time)', () => {
    const p = new CaptionPolicy();
    expect(p.offer({ id: 'a', text: 'x', speechEndVideo: 10 }, playing(15.5))).toBe('drop');
    expect(p.offer({ id: 'b', text: 'x', speechEndVideo: 10 }, playing(14.5))).toBe('show');
  });

  it('drops a caption that arrives out of order (its speech ended before the newest shown one)', () => {
    const p = new CaptionPolicy();
    p.offer({ id: 'new', text: 'later speech', speechEndVideo: 12 }, playing(12.5));
    expect(p.offer({ id: 'old', text: 'earlier speech', speechEndVideo: 11 }, playing(12.6))).toBe('drop');
  });

  it('keeps at most two lines: a third removes the oldest', () => {
    const p = new CaptionPolicy();
    p.offer({ id: 'a', text: 'one', speechEndVideo: 10 }, playing(10.5));
    p.offer({ id: 'b', text: 'two', speechEndVideo: 11 }, playing(11.5));
    expect(p.offer({ id: 'c', text: 'three', speechEndVideo: 12 }, playing(12.5))).toBe('show');
    expect(p.visible()).toEqual(['b', 'c']);
  });

  it('each line leaves after its reading time, counted in video time', () => {
    const p = new CaptionPolicy();
    p.offer({ id: 'a', text: 'Hi', speechEndVideo: 10 }, playing(10.5)); // 1.5 s minimum
    p.offer({ id: 'b', text: 'x'.repeat(60), speechEndVideo: 10.6 }, playing(11)); // 4 s
    expect(p.tick(11.9)).toEqual([]);
    expect(p.tick(12.0)).toEqual(['a']);
    expect(p.tick(14.9)).toEqual([]);
    expect(p.tick(15.0)).toEqual(['b']);
  });

  it('nothing advances while the video is paused (no ticks): a paused line stays', () => {
    const p = new CaptionPolicy();
    p.offer({ id: 'a', text: 'Hi', speechEndVideo: 10 }, playing(10.5));
    // paused at 11 for a long time: video time doesn't move, so no tick reaches 12
    expect(p.tick(11)).toEqual([]);
    expect(p.visible()).toEqual(['a']);
  });

  it('an upgrade replaces the text of a visible line and keeps its timing', () => {
    const p = new CaptionPolicy();
    p.offer({ id: 'a', text: 'Hi', speechEndVideo: 10 }, playing(10.5));
    expect(p.upgrade('a', 'Hello')).toBe(true);
    expect(p.upgrade('gone', 'x')).toBe(false);
    expect(p.tick(12.0)).toEqual(['a']); // still 10.5 + 1.5 (from the shown text)
  });

  it('a seek clears everything', () => {
    const p = new CaptionPolicy();
    p.offer({ id: 'a', text: 'Hi', speechEndVideo: 10 }, playing(10.5));
    expect(p.clear()).toEqual(['a']);
    expect(p.visible()).toEqual([]);
  });

  it('unknown speech time (no clock yet): shown, timed from now', () => {
    const p = new CaptionPolicy();
    expect(p.offer({ id: 'a', text: 'Hi', speechEndVideo: null }, playing(20))).toBe('show');
    expect(p.tick(21.5)).toEqual(['a']);
  });
});
