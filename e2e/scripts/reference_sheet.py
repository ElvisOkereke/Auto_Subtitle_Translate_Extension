"""Contact sheet of a candidate reference's lines (one crop per line, labelled by line number) for hand-checking.

Usage: python -I e2e/scripts/reference_sheet.py VIDEO_ID [FIRST [COUNT]]
Prints the candidate text per line number; writes e2e/.cache/ocr-crops/ref/<id>/lines-<FIRST>.png
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
vid = sys.argv[1]
first = int(sys.argv[2]) if len(sys.argv) > 2 else 0
count = int(sys.argv[3]) if len(sys.argv) > 3 else 24
ref = json.loads((ROOT / 'e2e' / 'fixtures' / 'subtitles' / f'{vid}.timeline.json').read_text(encoding='utf-8'))
crops = ROOT / 'e2e' / '.cache' / 'ocr-crops' / 'ref' / vid
lines = ref['lines'][first:first + count]
rows = []
sys.stdout.reconfigure(encoding='utf-8')
for n, line in enumerate(lines, start=first):
    seg = line['segments'][len(line['segments']) // 2]
    im = Image.open(crops / f'{seg:04d}.png')
    rows.append((n, im.resize((560, round(im.height * 560 / im.width)))))
    print(n, f"{line['start']:.1f}-{line['end']:.1f}", line['ko'])
sheet = Image.new('RGB', (560, sum(im.height + 14 for _, im in rows)), 'white')
draw = ImageDraw.Draw(sheet)
y = 0
for n, im in rows:
    draw.text((4, y + 1), f'line {n}', fill='black')
    sheet.paste(im, (0, y + 14))
    y += im.height + 14
sheet.save(crops / f'lines-{first:03d}.png')
