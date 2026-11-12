"""Export the test box crop for every timeline line (and some no-subtitle frames).

Writes e2e/.cache/ocr-crops/<stretch>/<n>.png and index.json:
  [{file, stretch, t, ko | null}]   ko = null for no-subtitle crops
The box is the one the E2E tests draw: NormalizedBox {x: .2, y: .75, w: .6, h: .14}.
"""
import json
import os
import subprocess

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
VIDEOS = os.path.join(ROOT, 'e2e', '.cache', 'videos')
OUT = os.path.join(ROOT, 'e2e', '.cache', 'ocr-crops')
TIMELINE = os.path.join(ROOT, 'e2e', 'fixtures', 'subtitles', '_zIrbXw-SVs.timeline.json')
BOX = {'x': 0.2, 'y': 0.75, 'w': 0.6, 'h': 0.14}
NO_SUB_PER_STRETCH = 10


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def frame_at(path: str, t: float) -> Image.Image:
    sx, sy = round(BOX['x'] * 1920), round(BOX['y'] * 1080)
    sw, sh = round(BOX['w'] * 1920), round(BOX['h'] * 1080)
    raw = subprocess.run([
        ffmpeg_exe(), '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', path, '-frames:v', '1',
        '-vf', f'format=rgb24,crop={sw}:{sh}:{sx}:{sy}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], capture_output=True, check=True).stdout
    return Image.fromarray(np.frombuffer(raw, np.uint8).reshape(sh, sw, 3))


def main() -> None:
    tl = json.load(open(TIMELINE, encoding='utf-8'))
    index = []
    for stretch in tl['stretches']:
        sid = stretch['id']
        path = os.path.join(VIDEOS, stretch['file'])
        out_dir = os.path.join(OUT, sid)
        os.makedirs(out_dir, exist_ok=True)
        lines = [l for l in tl['lines'] if l['stretch'] == sid]
        for n, line in enumerate(lines):
            t = (line['start'] + line['end']) / 2
            name = f'{n:03d}.png'
            frame_at(path, t).save(os.path.join(out_dir, name))
            index.append({'file': f'{sid}/{name}', 'stretch': sid, 't': round(t, 3), 'ko': line['ko']})
        # gaps of >= 3 s between lines hold no subtitle: sample their middles
        gaps = [(a['end'], b['start']) for a, b in zip(lines, lines[1:]) if b['start'] - a['end'] >= 3]
        for k, (a, b) in enumerate(gaps[:NO_SUB_PER_STRETCH]):
            t = (a + b) / 2
            name = f'none-{k:02d}.png'
            frame_at(path, t).save(os.path.join(out_dir, name))
            index.append({'file': f'{sid}/{name}', 'stretch': sid, 't': round(t, 3), 'ko': None})
    json.dump(index, open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(len(index), 'crops')


if __name__ == '__main__':
    main()
