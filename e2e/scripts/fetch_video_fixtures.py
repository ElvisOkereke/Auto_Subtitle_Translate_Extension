"""Download the subtitle-mode test video and cut the stretches the E2E tests play.

Usage: npm run fixtures:video   (or: e2e/.cache/venv/Scripts/python -I e2e/scripts/fetch_video_fixtures.py)

Outputs (gitignored) in e2e/.cache/videos/:
  _zIrbXw-SVs.webm      full video, VP9 <=1080p + Opus
  _zIrbXw-SVs.s1.webm   0-180 s
  _zIrbXw-SVs.s2.webm   540-720 s
  _zIrbXw-SVs.<s>.video.mp4 / .audio.webm   the same stretch split into one
      track per file - the fixture page feeds them to two SourceBuffers like
      YouTube does: video as fragmented MP4 (YouTube's container; the VP9
      frames are stream-copied so OCR ground truth stays exact), audio WebM.
Idempotent: existing files are kept.
"""
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
VIDEOS = os.path.join(ROOT, 'e2e', '.cache', 'videos')
VIDEO_ID = '_zIrbXw-SVs'
STRETCHES = {'s1': (0, 180), 's2': (540, 180)}  # id: (start seconds, duration seconds)


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def download(full_path: str) -> None:
    if os.path.exists(full_path):
        return
    subprocess.run([
        sys.executable, '-m', 'yt_dlp',
        '--ffmpeg-location', ffmpeg_exe(),
        '-f', 'bestvideo[height<=1080][vcodec^=vp9]+bestaudio[acodec=opus]',
        '--merge-output-format', 'webm',
        '-o', full_path,
        f'https://youtu.be/{VIDEO_ID}',
    ], check=True)


def cut(full_path: str, stretch: str, start: int, duration: int) -> None:
    out = os.path.join(VIDEOS, f'{VIDEO_ID}.{stretch}.webm')
    if os.path.exists(out):
        return
    # Stream copy keeps the original pixels (OCR ground truth is labelled from
    # these exact files). Cuts snap to keyframes, which is fine because all
    # timeline times are relative to the cut file itself.
    subprocess.run([
        ffmpeg_exe(), '-loglevel', 'error', '-y',
        '-ss', str(start), '-i', full_path, '-t', str(duration),
        '-c', 'copy', '-avoid_negative_ts', 'make_zero',
        out,
    ], check=True)


def split_tracks(stretch: str) -> None:
    src = os.path.join(VIDEOS, f'{VIDEO_ID}.{stretch}.webm')
    for kind, stream, ext, extra in (
        ('video', '0:v', 'mp4', ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']),
        ('audio', '0:a', 'webm', []),
    ):
        out = os.path.join(VIDEOS, f'{VIDEO_ID}.{stretch}.{kind}.{ext}')
        if not os.path.exists(out):
            subprocess.run([ffmpeg_exe(), '-loglevel', 'error', '-y', '-i', src, '-map', stream, '-c', 'copy', *extra, out], check=True)


def main() -> None:
    os.makedirs(VIDEOS, exist_ok=True)
    full = os.path.join(VIDEOS, f'{VIDEO_ID}.webm')
    download(full)
    for stretch, (start, duration) in STRETCHES.items():
        cut(full, stretch, start, duration)
        split_tracks(stretch)
        print(f'{stretch}: {os.path.join(VIDEOS, f"{VIDEO_ID}.{stretch}.webm")}')


if __name__ == '__main__':
    main()
