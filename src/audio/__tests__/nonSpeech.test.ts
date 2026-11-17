import { isNonSpeech, isLikelyHallucination } from '../nonSpeech';

describe('isNonSpeech (Whisper annotations that are not words)', () => {
  it.each(['[音楽]', '(音楽)', '（拍手）', '【笑】', '[Music]', '(applause)', '♪', '♪～♪', ' [音楽] ', '[音楽] [拍手]', '(笑)'])('drops %p', text => {
    expect(isNonSpeech(text)).toBe(true);
  });

  it.each(['40分大宮は左サイド', 'Hello [laughs] there', '(그래서) 다음 경기', 'Goal!', '♪ la la love you'])('keeps %p', text => {
    expect(isNonSpeech(text)).toBe(false);
  });
});

describe('isLikelyHallucination (Whisper\'s stock phrases over music or silence)', () => {
  it.each([
    '다음 영상에서 만나요.',
    '시청해주셔서 감사합니다.',
    '-끝-',
    '-끝. -끝. -끝.',
    '구독과 좋아요 부탁드립니다',
    'ご視聴ありがとうございました',
    'Thanks for watching!',
    'Thank you for watching.',
    '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目',
    'Subtitles by the Amara.org community',
  ])('drops %p', t => expect(isLikelyHallucination(t)).toBe(true));

  it.each(['감사합니다 여러분 오늘은 정수약탈자를 가볼게요', '다음 영상에서 이 챔피언 써볼게요', 'Thanks, that was a great play'])('keeps %p', t =>
    expect(isLikelyHallucination(t)).toBe(false)
  );
});
