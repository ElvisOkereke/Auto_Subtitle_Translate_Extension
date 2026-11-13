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

# Diverse videos (2026-11-13). Line numbers refer to the candidates written with
# the final boxes in videos.json. Watermark/scene text (channel marks, match
# clocks, kit sponsors) is not subtitle text: removed or the line dropped.
FIXES.update({
    'IM-v1aW_AtI': {
        'drop': [],
        'merge': [(18, 20, 'Ты вовсе не выглядишь потухшим в связи с его переходом. Это очень здорово.'),
                  (30, 34, '«Интер» — большой клуб. И особенно в этом году нам нужна борьба\\конкуренция на каждой позиции.'),
                  (36, 37, 'Как я и сказал ранее: мы сделали всё, что могли, чтобы победить сегодня.')],
        'text': {4: 'До игры мы чувствовали, что сможем победить.',
                 5: 'Даже несмотря на то, что мы играли на выезде, мы хотели вернуться с тремя очками.',
                 8: 'И мы сохранили спокойствие даже после того, как они повели в счёте.',
                 14: 'Мы будем праздновать только тогда, когда математика точно скажет, что мы вышли в 1\\16-ую ЛЧ.',
                 28: 'Вы оба — красавчики.'},
    },
    'N5BAtJ2qMXo': {
        'drop': [], 'merge': [],
        'text': {11: "Quoi qu'il en soit, je trouve ça lâche!", 12: "Ne pas respecter délibérément l'heure convenue et...",
                 21: 'Si tu voulais gagner, pourquoi as-tu lâché le fourreau?', 22: "Le fourreau, c'est ta vie, et tu l'as jeté!",
                 25: 'Tu veux mourir?'},
    },
    'dcbt04jp7B8': {
        'drop': [14, 20, 23, 31, 35, 37, 40, 42, 44, 47],
        'merge': [(1, 2, 'Boa tarde a todos, é um prazer estar aqui'), (16, 17, 'Quando você está em um time e dá tudo por ele')],
        'text': {0: '[Ronaldo] : Olá, boa tarde', 4: '[Guti]: Você se lembra de quando nós estávamos aí?',
                 10: 'E como você se sente, que recordações tem num dia tão especial como de um Clássico?',
                 13: 'E eu já estive nos dois lados', 18: 'E tenta ganhar', 19: 'No entanto, se vive uma semana muito especial',
                 21: 'Guti, você que jogou com Ronaldo, o que pode dizer de Ronaldo Nazário?', 22: 'Sim, eu tive esse prazer',
                 24: 'De jogar com o Ronnie, a verdade é que...', 25: 'Que era magnífico!',
                 26: 'Nós sempre falávamos: "Não corra muito, não trabalhe defensivamente"', 27: '"Não roube bolas"',
                 28: 'Porque queremos você com gás para os últimos momentos', 29: 'E no final, nos dava o que ele nos dava',
                 30: 'Sua arrancadas e seus gols', 32: 'Decidiam as partidas, não é?', 33: 'A verdade é que foi um luxo',
                 34: 'E eu sempre disse a ele, eu acho que...', 36: 'Ronnie foi o melhor jogador com quem eu joguei no futebol',
                 38: 'Ronaldo, e Guti? Era especial? Tinha algo de especial?', 39: 'Era muito mais que especial',
                 41: 'Era tão inteligente em campo e também como pessoa', 43: 'Era incrível como ele entendia os movimentos',
                 45: 'Isso desde que eu cheguei, não é que tínhamos muito tempo que...', 46: 'Treinávamos ou falavamos de futebol',
                 48: 'Tinha uma inteligência dentro de campo', 49: 'Uma habilidade com a bola', 50: 'Era espetacular jogar com ele',
                 54: 'E para mim, eu sempre disse, como atacante central', 59: 'E bem, na véspera da partida...'},
    },
    'Ac-5H_Wgk7I': {
        'drop': [4, 5, 15, 17, 19, 21, 22, 25, 26, 30, 35, 49, 56, 87],
        'merge': [(11, 12, '我相信还有一颗特别闪亮的星星'), (40, 42, '失利者落寞的陪伴之下'), (45, 48, '在这样的情感交织当中'),
                  (59, 61, '处放在显微镜下去'), (65, 66, '却是主旋律'), (67, 75, '但是如何面对失败'), (77, 81, '有的人会被失败击垮')],
        'text': {1: '看似不经意的小事', 3: '一次看似普通的再见其实就是永别', 13: '我们也祝他能够', 14: '夜幕之下的马拉卡纳',
                 16: '迎来了他的第二次世界杯决赛', 18: '科科瓦多山顶的救世基督', 20: '在俯看着红尘俯看着众生',
                 23: '所有的悲欢离合都没有什么大不了', 31: '人的脆弱和坚强都超乎了自己的想象', 32: '有时候可能脆弱的一句话就泪流满面',
                 33: '有时候你发现自己咬着牙', 57: '充满野心', 63: '你说你守天下难不难', 83: '我想真正的成熟应该并不是追求完美',
                 84: '而是直面自己的缺憾', 85: '这才是生活的本质', 86: '罗曼罗兰说过的', 88: '这个世上只有一种真正的英雄主义',
                 89: '那就是认清生活的真相', 90: '并且仍然热爱他西班牙队从头再来吧'},
    },
})


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
