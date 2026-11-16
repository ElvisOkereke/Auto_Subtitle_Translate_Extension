// nonSpeech.ts - Whisper writes sound annotations for music, applause or
// laughter ("[音楽]", "(拍手)", "[Music]", "♪"). They are not words: a caption
// made only of them is not shown (or translated).

const TAG = /[[(（【［][^\])）】］]{1,24}[\])）】］]/g;

export function isNonSpeech(text: string): boolean {
  const rest = text.replace(TAG, '').replace(/[♪♫～~\s.,、。!?！？…-]/g, '');
  return rest.length === 0;
}
