"""Draft subtitle line boundaries for the stretch files, for hand transcription.

Reads e2e/.cache/videos/_zIrbXw-SVs.<stretch>.webm at 30 fps, crops the
subtitle band, finds outlined white text (burned-in subtitle style), and
splits the stretch wherever that text appears, disappears or changes.

Writes to e2e/.cache/label/<stretch>/:
  draft.json          [{index, start, end}] seconds relative to the stretch file
  NNN.png             band crop at each draft line's midpoint
  sheet-NN.png        contact sheets (10 lines each) for transcription
"""
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
VIDEOS = os.path.join(ROOT, 'e2e', '.cache', 'videos')
OUT = os.path.join(ROOT, 'e2e', '.cache', 'label')
VIDEO_ID = '_zIrbXw-SVs'
FPS = 30
W, H, X, Y = 1152, 184, 384, 821  # band crop at 1080p
HUD_ROW = 110                      # band rows at/after this belong to the game HUD
MIN_TEXT_PIXELS = 2500
SAME_IOU = 0.5
MIN_FRAMES = 4                     # drop flickers shorter than ~130 ms


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def text_mask(frame: np.ndarray) -> np.ndarray:
    a = frame.astype(np.int16)
    white = a.min(axis=2) > 225
    dark = a.max(axis=2) < 60
    near_dark = np.zeros_like(dark)
    for dy in (-3, 0, 3):
        for dx in (-3, 0, 3):
            near_dark |= np.roll(np.roll(dark, dy, 0), dx, 1)
    m = white & near_dark
    m[HUD_ROW:, :] = False
    return m


def frames(path: str):
    proc = subprocess.Popen([
        ffmpeg_exe(), '-loglevel', 'error', '-i', path,
        '-vf', f'fps={FPS},crop={W}:{H}:{X}:{Y}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], stdout=subprocess.PIPE)
    size = W * H * 3
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        yield np.frombuffer(buf, np.uint8).reshape(H, W, 3)
    proc.wait()


def segment(stretch: str):
    path = os.path.join(VIDEOS, f'{VIDEO_ID}.{stretch}.webm')
    out_dir = os.path.join(OUT, stretch)
    os.makedirs(out_dir, exist_ok=True)
    segs, keep = [], {}
    cur = None  # (start_frame, mask, has_text)
    for i, f in enumerate(frames(path)):
        m = text_mask(f)
        has = bool(m.sum() > MIN_TEXT_PIXELS)
        if cur is None:
            cur = [i, m, has]
        else:
            same = (has == cur[2]) and (not has or (m & cur[1]).sum() / max((m | cur[1]).sum(), 1) > SAME_IOU)
            if not same:
                segs.append((cur[0], i - 1, cur[2]))
                cur = [i, m, has]
        keep[i] = f if i % 3 == 0 else keep.get(i)  # sparse frame cache for mid-crops
    segs.append((cur[0], i, cur[2]))
    lines = [s for s in segs if s[2] and s[1] - s[0] + 1 >= MIN_FRAMES]
    draft = []
    for n, (a, b, _) in enumerate(lines):
        mid = (a + b) // 2
        mid -= mid % 3
        Image.fromarray(keep[mid]).save(os.path.join(out_dir, f'{n:03d}.png'))
        draft.append({'index': n, 'start': round(a / FPS, 3), 'end': round((b + 1) / FPS, 3)})
    json.dump(draft, open(os.path.join(out_dir, 'draft.json'), 'w'), indent=1)
    for k in range(0, len(draft), 10):
        group = draft[k:k + 10]
        sheet = Image.new('RGB', (W // 2, (H // 2 + 16) * len(group)), 'white')
        dr = ImageDraw.Draw(sheet)
        for j, d in enumerate(group):
            y = j * (H // 2 + 16)
            dr.text((4, y + 2), f"#{d['index']}  {d['start']:.2f}-{d['end']:.2f}s", fill='black')
            sheet.paste(Image.open(os.path.join(out_dir, f"{d['index']:03d}.png")).resize((W // 2, H // 2)), (0, y + 16))
        sheet.save(os.path.join(out_dir, f'sheet-{k // 10:02d}.png'))
    print(f'{stretch}: {len(draft)} draft lines -> {out_dir}')


if __name__ == '__main__':
    for s in (sys.argv[1:] or ['s1', 's2']):
        segment(s)
