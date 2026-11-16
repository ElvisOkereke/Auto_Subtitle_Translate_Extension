import { isNonSpeech } from '../nonSpeech';

describe('isNonSpeech (Whisper annotations that are not words)', () => {
  it.each(['[音楽]', '(音楽)', '（拍手）', '【笑】', '[Music]', '(applause)', '♪', '♪～♪', ' [音楽] ', '[音楽] [拍手]', '(笑)'])('drops %p', text => {
    expect(isNonSpeech(text)).toBe(true);
  });

  it.each(['40分大宮は左サイド', 'Hello [laughs] there', '(그래서) 다음 경기', 'Goal!', '♪ la la love you'])('keeps %p', text => {
    expect(isNonSpeech(text)).toBe(false);
  });
});
