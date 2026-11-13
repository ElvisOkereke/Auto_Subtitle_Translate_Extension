"""Hand-check corrections for the candidate reference timelines (2026-11-13).

Each video: drop (not subtitles: game kill feed, HUD numbers), merge (one
subtitle split by zoom/blink effects or a transition frame) and text fixes
(OCR slips), decided by looking at reference_sheet.py contact sheets.
Line numbers refer to the candidate files written by perf-reference.spec.ts.
Usage: python -I e2e/scripts/fix_references.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

FIXES = {
    'ug5IsDJ9bhs': {
        'drop': [], 'merge': [],
        'text': {1: '야 점멸을 왜..', 8: '플 있나?'},
    },
    'x8YWHt8giVY': {
        'drop': [],
        'merge': [(1, 2, '여러분들 제 목표 정했습니다!')],
        'text': {3: '저는 이제 200판 안에 챌린저 가기!', 9: '1렙 때도 블라디가..', 10: '웬만하면 1렙에는 못 이겨서!',
                 19: '아니..', 20: '아니.. 그렇게까지 한다고?', 22: '미띤놈이구만? 블라디?', 31: '난 이렇게.. 저 빅웨이브를',
                 33: '이.. 이게 에메랄드인 건 나도 좀 충격이긴 하다!'},
    },
    'w3RZwfzYEcs': {
        'drop': [16, 17, 18, 19, 20, 21, 22, 23, 24, 42, 44],
        'merge': [(1, 4, '창 아퍼'), (5, 6, '창 무지 아파'), (11, 12, '우와아아;;'), (27, 28, '으허허허허헝ㅎ헝'),
                  (47, 48, '판정..'), (50, 51, '어어ㅓ아!'), (61, 62, '야야ㅑ야ㅑ야')],
        'text': {0: '핵 창 맞았어', 7: '으아ㅏ아!!', 8: '무지 아퍼!', 9: '재네들 무지 아퍼!', 10: '아프긴 하다..', 13: '진짜 무지 아프다;',
                 14: '야 뭐야', 15: '뭔 딜이야? 도대체 재네들', 25: '아이 야발', 26: '이거 하는거 아니였어', 29: '아닝ㅎㅋㅋ', 30: '야발',
                 31: '이거 하는거 아니였어', 32: '개같은 챔프...', 34: '흐어어엉 재네들 무서워ㅠㅠㅠ', 35: '허아앙아악!!',
                 36: '개 짜증나...', 37: '야악!!!', 38: '재네 무지 쎄!', 39: '훙항하', 40: '미친듯이 털리는데?', 41: '봇 똥싼다~',
                 45: '와 저게 안 맞는다고?', 46: '뭐야? 판정 왜저래?', 49: '개.. 똥인데..?', 52: '아 개아파;;', 53: '창이잖아',
                 54: '당연히 아프지', 55: '내가 아무리 바보라도', 56: '이 창은 안맞는다', 57: '아 게임하기 매우 싫다..',
                 58: '가자 얼른..', 59: '그랭..', 60: '어어ㅓㅓ어', 63: '안되겠다 안되겠다', 65: '하하학ㅋㅋㅎ하황ㅋㅋㅋ학'},
    },
}


def main() -> None:
    for vid, fix in FIXES.items():
        path = ROOT / 'e2e' / 'fixtures' / 'subtitles' / f'{vid}.timeline.json'
        ref = json.loads(path.read_text(encoding='utf-8'))
        if ref.get('corrected'):
            print(f'{vid}: already corrected')
            continue
        lines = ref['lines']
        corrections = 0
        for n, text in fix['text'].items():
            if lines[n]['ko'] != text:
                lines[n]['ko'] = text
                corrections += 1
        merged_away = set()
        for a, b, text in fix['merge']:
            lines[a]['end'] = lines[b]['end']
            lines[a]['ko'] = text
            lines[a]['segments'] = [s for line in lines[a:b + 1] for s in line['segments']]
            merged_away.update(range(a + 1, b + 1))
            corrections += 1
        keep = [line for n, line in enumerate(lines) if n not in merged_away and n not in fix['drop']]
        corrections += len(fix['drop'])
        for line in keep:
            line['start'] = round(line['start'], 3)
            line['end'] = round(line['end'], 3)
        ref['lines'] = keep
        ref['corrected'] = True
        ref['labelledBy'] = f"extension OCR at 10 fps, hand-checked: {corrections} corrections (drops, merges, text fixes)"
        path.write_text(json.dumps(ref, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'{vid}: {len(keep)} lines, {corrections} corrections')


if __name__ == '__main__':
    main()
