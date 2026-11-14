"""Candidate reference timeline for a benchmark video: segments of the subtitle box.

Usage: python -I e2e/scripts/make_reference.py VIDEO_ID

Reads the video's entry in e2e/bench/videos.json and its benchmark cut
e2e/.cache/videos/<id>.b.webm (from fetch_video_fixtures.py). Crops the
subtitle box at 10 fps, splits it where the box image changes (mean absolute
difference of a 64x16 grey thumbnail > 0.04, the extension's LineTracker
threshold), and writes to e2e/.cache/ocr-crops/ref/<id>/:
  NNNN.png         the middle frame of each segment (served at /crops/ref/<id>/)
  segments.json    [{index, start, end, file, h}] - times relative to the cut;
                   h = estimated text height in px at the source resolution
  sheet-KK.png     contact sheets of 20 segments each, for hand-checking
perf-reference.spec.ts OCRs the frames into the candidate timeline.
"""
import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
VIDEOS = ROOT / 'e2e' / '.cache' / 'videos'
FPS = 10
THRESHOLD = 0.04


def text_height(img: Image.Image) -> int:
    """Rows with bright (subtitle-white) pixels, longest contiguous run."""
    grey = np.asarray(img.convert('L'), dtype=np.uint8)
    rows = (grey > 225).sum(axis=1) >= max(3, grey.shape[1] // 200)
    best = run = 0
    for r in rows:
        run = run + 1 if r else 0
        best = max(best, run)
    return int(best)


def main() -> None:
    vid = sys.argv[1]
    entry = next(v for v in json.loads((ROOT / 'e2e' / 'bench' / 'videos.json').read_text(encoding='utf-8'))['videos'] if v['id'] == vid)
    box = entry['box']
    out = ROOT / 'e2e' / '.cache' / 'ocr-crops' / 'ref' / vid
    frames_dir = out / 'frames'
    frames_dir.mkdir(parents=True, exist_ok=True)
    src = VIDEOS / f'{vid}.b.webm'
    if not any(frames_dir.iterdir()):
        crop = f"crop=iw*{box['w']}:ih*{box['h']}:iw*{box['x']}:ih*{box['y']},fps={FPS}"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-loglevel', 'error', '-i', str(src), '-vf', crop,
                        str(frames_dir / '%05d.png')], check=True)
    files = sorted(frames_dir.glob('*.png'))

    def thumb(path: Path) -> np.ndarray:
        return np.asarray(Image.open(path).convert('L').resize((64, 16)), dtype=np.float32) / 255

    segments = []
    seg_start = 0
    accepted = thumb(files[0])
    for i in range(1, len(files) + 1):
        changed = i == len(files) or float(np.abs(thumb(files[i]) - accepted).mean()) > THRESHOLD
        if not changed:
            continue
        mid = files[(seg_start + i - 1) // 2]
        segments.append({'start': round(seg_start / FPS, 3), 'end': round(i / FPS, 3), 'mid': mid})
        if i < len(files):
            seg_start = i
            accepted = thumb(files[i])

    records = []
    for k, seg in enumerate(segments):
        img = Image.open(seg['mid'])
        name = f'{k:04d}.png'
        img.save(out / name)
        records.append({'index': k, 'start': seg['start'], 'end': seg['end'], 'file': name, 'h': text_height(img)})
    (out / 'segments.json').write_text(json.dumps(records, indent=1), encoding='utf-8')

    # Contact sheets: 20 segments per sheet, each labelled with its index and time.
    for sheet_no in range(0, len(records), 20):
        chunk = records[sheet_no:sheet_no + 20]
        imgs = [Image.open(out / r['file']) for r in chunk]
        w = 720
        scaled = [im.resize((w, max(1, round(im.height * w / im.width)))) for im in imgs]
        label_h = 18
        sheet = Image.new('RGB', (w, sum(s.height + label_h for s in scaled)), 'white')
        draw = ImageDraw.Draw(sheet)
        y = 0
        for r, s in zip(chunk, scaled):
            draw.text((4, y + 2), f"#{r['index']}  {r['start']:.1f}-{r['end']:.1f}s  h={r['h']}", fill='black')
            sheet.paste(s, (0, y + label_h))
            y += s.height + label_h
        sheet.save(out / f'sheet-{sheet_no // 20:02d}.png')
    print(f'{vid}: {len(records)} segments -> {out}')


if __name__ == '__main__':
    main()
