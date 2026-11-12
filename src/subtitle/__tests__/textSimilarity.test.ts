import { isSameLine } from '../textSimilarity';

describe('isSameLine', () => {
  it('treats OCR jitter on the same subtitle as the same line', () => {
    expect(isSameLine('이판은 게임이 좀 빡이긴 한데..', '이판은 게임이 좀 빠이긴 한데.')).toBe(true);
    expect(isSameLine('아..귀찮은 챔피언 나왔네?', '아.. 귀찮은 챔피언 나왔네?')).toBe(true);
  });

  it('treats different subtitles as different lines', () => {
    expect(isSameLine('탑 카밀일 수도 있긴 한데', '웬만하면 탑 뽀삐겠지!')).toBe(false);
    expect(isSameLine('일로 와!', '좋아요!')).toBe(false);
  });

  it('never matches empty text', () => {
    expect(isSameLine('', '')).toBe(false);
    expect(isSameLine('a', '')).toBe(false);
  });
});
