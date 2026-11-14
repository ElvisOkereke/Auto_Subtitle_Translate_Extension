"""Download short sections of candidate videos and write a contact sheet per video.

Usage: python -I e2e/scripts/preview_frames.py OUT_DIR ID[@START] [ID[@START] ...]
Each video: 4 frames, 10 s apart, from START (default 120 s), 640 px wide.
"""
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
from PIL import Image

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for arg in sys.argv[2:]:
        vid, _, start = arg.partition('@')
        start_s = int(start or 120)
        clip = out / f'{vid}.webm'
        if not clip.exists():
            subprocess.run([sys.executable, '-m', 'yt_dlp', '--ffmpeg-location', FFMPEG, '-q',
                            '-f', 'bestvideo[height<=720][vcodec^=vp9]/bestvideo[height<=720]',
                            '--download-sections', f'*{start_s}-{start_s + 40}',
                            '-o', str(clip), f'https://youtu.be/{vid}'], check=True)
        frames = []
        for k in range(4):
            png = out / f'{vid}-{k}.png'
            subprocess.run([FFMPEG, '-v', 'error', '-y', '-ss', str(k * 10 + 1), '-i', str(clip), '-frames:v', '1',
                            '-vf', 'scale=640:-2', str(png)], check=True)
            frames.append(Image.open(png))
        w, h = frames[0].size
        sheet = Image.new('RGB', (w * 2, h * 2))
        for k, f in enumerate(frames):
            sheet.paste(f, ((k % 2) * w, (k // 2) * h))
        sheet.save(out / f'{vid}-sheet.png')
        print(out / f'{vid}-sheet.png')


if __name__ == '__main__':
    main()
