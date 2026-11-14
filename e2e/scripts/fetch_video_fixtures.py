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
  _zIrbXw-SVs.<s>.video.webm   the same video track as WebM (VP9 read-ahead tests)
  <id>.b.*   for every other subtitles video in e2e/bench/videos.json: its
      benchmark window (start-5 .. start+duration+5) cut the same way, plus
      <id>.b.json {"offset": <absolute start of the cut, seconds>}
Idempotent: existing files are kept.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
VIDEOS = os.path.join(ROOT, 'e2e', '.cache', 'videos')
VIDEO_ID = '_zIrbXw-SVs'
STRETCHES = {'s1': (0, 180), 's2': (540, 180)}  # id: (start seconds, duration seconds)


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def download(full_path: str, video_id: str = VIDEO_ID) -> None:
    if os.path.exists(full_path):
        return
    subprocess.run([
        sys.executable, '-m', 'yt_dlp',
        '--ffmpeg-location', ffmpeg_exe(),
        '-f', 'bestvideo[height<=1080][vcodec^=vp9]+bestaudio[acodec=opus]',
        '--merge-output-format', 'webm',
        '-o', full_path,
        f'https://youtu.be/{video_id}',
    ], check=True)


def cut_start(full_path: str, start: float) -> float:
    """Absolute time where a stream-copy cut at `start` really begins (it snaps to the video keyframe before it)."""
    out = subprocess.run([ffmpeg_exe(), '-loglevel', 'error', '-ss', str(start), '-i', full_path, '-map', '0:v',
                          '-c', 'copy', '-copyts', '-frames:v', '1', '-f', 'framecrc', '-'],
                         capture_output=True, text=True, check=True).stdout
    tb = re.search(r'#tb 0: (\d+)/(\d+)', out)
    pkt = re.search(r'^0,\s*(-?\d+),', out, re.M)
    if not tb or not pkt:
        raise RuntimeError('could not read the cut start time')
    return int(pkt.group(1)) * int(tb.group(1)) / int(tb.group(2))


def cut(full_path: str, stretch: str, start: float, duration: float, video_id: str = VIDEO_ID) -> None:
    out = os.path.join(VIDEOS, f'{video_id}.{stretch}.webm')
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


def split_tracks(stretch: str, video_id: str = VIDEO_ID) -> None:
    src = os.path.join(VIDEOS, f'{video_id}.{stretch}.webm')
    for kind, stream, ext, extra in (
        ('video', '0:v', 'mp4', ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']),
        ('video', '0:v', 'webm', []),
        ('audio', '0:a', 'webm', []),
    ):
        out = os.path.join(VIDEOS, f'{video_id}.{stretch}.{kind}.{ext}')
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
    with open(os.path.join(ROOT, 'e2e', 'bench', 'videos.json'), encoding='utf-8') as f:
        bench = json.load(f)['videos']
    for v in bench:
        if v['mode'] != 'subtitles' or v['id'] == VIDEO_ID:
            continue
        vid = v['id']
        full = os.path.join(VIDEOS, f'{vid}.webm')
        download(full, vid)
        start = max(0, v['start'] - 5)
        meta = os.path.join(VIDEOS, f'{vid}.b.json')
        if not os.path.exists(meta):
            offset = cut_start(full, start)
            with open(meta, 'w', encoding='utf-8') as f:
                json.dump({'offset': offset}, f)
        cut(full, 'b', start, v['duration'] + 10, vid)
        split_tracks('b', vid)
        print(f'{vid}.b: {os.path.join(VIDEOS, f"{vid}.b.webm")}')


if __name__ == '__main__':
    main()
