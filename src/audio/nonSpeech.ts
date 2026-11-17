// nonSpeech.ts - Whisper writes sound annotations for music, applause or
// laughter ("[音楽]", "(拍手)", "[Music]", "♪"). They are not words: a caption
// made only of them is not shown (or translated).

const TAG = /[[(（【［][^\])）】］]{1,24}[\])）】］]/g;

export function isNonSpeech(text: string): boolean {
  const rest = text.replace(TAG, '').replace(/[♪♫～~\s.,、。!?！？…-]/g, '');
  return rest.length === 0;
}

// Whisper learned these from countless video outros and subtitle credits; over
// music, game sound or silence it produces them although nobody says them. A
// caption that is only such a phrase (repeated or not) is not shown.
const STOCK_PHRASES = [
  /^다음\s*영상에서\s*만나요$/,
  /^(시청|구독)?\s*(해\s*)?주셔서\s*감사합니다$/,
  /^시청해\s*주셔서\s*감사합니다$/,
  /^구독과\s*좋아요(\s*(부탁|눌러).*)?$/,
  /^-?\s*끝\s*-?$/,
  /^ご視聴(いただき)?ありがとうございました$/,
  /^チャンネル登録(よろしくお願いします)?$/,
  /^(thanks|thank you)( so much)? for watching$/i,
  /^please (like and )?subscribe$/i,
  /^subtitles by .*$/i,
  /^.*amara\.org.*$/i,
  /^请不吝点赞.*$/,
  /^字幕(由|制作).*$/,
];

/** A Whisper stock phrase (outro, credits) with nothing else in the caption. */
export function isLikelyHallucination(text: string): boolean {
  const whole = text.trim().replace(/[.!?。！？]+$/u, '');
  if (STOCK_PHRASES.some(re => re.test(whole))) return true;
  const parts = text
    .split(/[.!?。！？\n]+|\s-\s|(?<=^|\s)-/u)
    .map(p => p.replace(/[\s,~…"'「」]+/g, ' ').trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every(p => STOCK_PHRASES.some(re => re.test(p)));
}
