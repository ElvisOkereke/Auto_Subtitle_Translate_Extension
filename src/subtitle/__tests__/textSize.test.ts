import { TextSizeModel, similarText } from '../textSize';

const SUBS = ['리신 궁도 뺐다!', '일단 이번 턴도 궁도 안 써서..', '상대 피오라도 노점화고', '지금 1대1인데?', '이거는 그냥 궁 쓰지 말고', '집 가자! 할 게 없다'];
const HUD = '스킬이 아직 준비되지 않았습니다';

describe('TextSizeModel (learns the subtitle size of this video; other text is game/stream UI)', () => {
  it('knows nothing until three different texts were seen', () => {
    const m = new TextSizeModel();
    expect(m.accept(SUBS[0], 0.065)).toBe(true);
    expect(m.accept(SUBS[1], 0.07)).toBe(true);
    expect(m.expected()).toBeNull();
    expect(m.accept(SUBS[2], 0.068)).toBe(true);
    expect(m.expected()).toBeCloseTo(0.068, 6);
  });

  it('re-reads of one text (and a notice repeating, cut off) count once', () => {
    const m = new TextSizeModel();
    for (let i = 0; i < 5; i++) m.accept(HUD, 0.034);
    m.accept('스킬이아직', 0.034);
    m.accept('길이 아직 준비', 0.034);
    m.accept(SUBS[0], 0.066);
    m.accept(SUBS[1], 0.068);
    expect(m.expected()).toBeCloseTo(0.067, 6); // two different subtitles beat one notice read many ways
  });

  it('text of another size is rejected once the size is known', () => {
    const m = new TextSizeModel();
    SUBS.slice(0, 3).forEach(t => m.accept(t, 0.068));
    expect(m.accept(HUD, 0.034)).toBe(false);
    expect(m.accept('지금은 사용할 수 없습니다', 0.033)).toBe(false);
    expect(m.accept(SUBS[3], 0.07)).toBe(true);
  });

  it('game UI read first does not lock the size in: the subtitles outvote it within a few lines', () => {
    const m = new TextSizeModel();
    // Seen in Chrome: read-ahead's first reads were HUD text (a notice, a spell label, cooldowns).
    for (const t of [HUD, '[D]점화', 'F57', 'B', 'F-49']) m.accept(t, 0.032);
    m.accept('지금은 사용할 수 없습니다', 0.033);
    const accepted = SUBS.map(t => m.accept(t, 0.068));
    expect(accepted.slice(3)).toEqual([true, true, true]);
    expect(m.expected()).toBeCloseTo(0.068, 6);
    expect(m.accept(HUD, 0.034)).toBe(false);
  });

  it('text with fewer than two letters is no evidence (HUD keys, timers)', () => {
    const m = new TextSizeModel();
    for (const t of ['B', 'F57', 'F-49', 'T', '신']) m.accept(t, 0.03);
    expect(m.expected()).toBeNull();
  });

  it('the subtitle style changes: once the new size has more different lines, it is the size', () => {
    const m = new TextSizeModel();
    SUBS.slice(0, 3).forEach(t => m.accept(t, 0.068));
    const bigger = ['완전히 다른 자막 하나', '두 번째 새로운 줄입니다', '세 번째 문장도 크다', '네 번째로 확인합니다'];
    bigger.forEach(t => m.accept(t, 0.1));
    expect(m.expected()).toBeCloseTo(0.1, 6);
    expect(m.accept('다섯 번째 큰 자막', 0.1)).toBe(true);
  });

  it('equal evidence: the taller text is the subtitle (UI text is usually smaller)', () => {
    const m = new TextSizeModel();
    m.accept(HUD, 0.034);
    m.accept('지금은 사용할 수 없습니다', 0.033);
    m.accept(SUBS[0], 0.068);
    m.accept(SUBS[1], 0.068);
    expect(m.expected()).toBeCloseTo(0.068, 6);
  });

  it('reset forgets everything (new box)', () => {
    const m = new TextSizeModel();
    SUBS.slice(0, 3).forEach(t => m.accept(t, 0.068));
    m.reset();
    expect(m.expected()).toBeNull();
  });
});

describe('similarText (OCR of the same text: jitter, cut off, partly faded)', () => {
  it('matches the same text with OCR slips and when one is a cut-off part of the other', () => {
    expect(similarText(HUD, '스킬이 아직준비되지 않았습니대')).toBe(true);
    expect(similarText(HUD, '길이 아직 준비')).toBe(true);
    expect(similarText('스킬이아직', HUD)).toBe(true);
  });
  it('different lines are different, also short ones', () => {
    expect(similarText(SUBS[0], SUBS[1])).toBe(false);
    expect(similarText('AR', HUD)).toBe(false);
    expect(similarText('제발!', '제발 반절 교환만 해줘!')).toBe(false);
  });
});
