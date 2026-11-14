"""Reference lines for an audio benchmark video from its YouTube captions.

Usage: python -I e2e/scripts/fetch_caption_reference.py VIDEO_ID LANG
(uses e2e/.cache/captions/<id>.json when the browser saved one)

Downloads captions in LANG (manual if the video has them, else YouTube's
automatic ones) as json3 and writes e2e/fixtures/subtitles/<id>.captions.json:
  { video, lang, kind: 'manual' | 'auto', lines: [{ start, end, text }] }
Times are absolute video seconds. Auto captions arrive as timed words; they are
joined into lines at pauses > 0.6 s or after ~40 characters. Bracketed cues
([음악], [Music], ...) are dropped.
"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[2]
GAP_S = 0.6
MAX_CHARS = 40
BRACKETED = re.compile(r'^\s*[\[\(（【].*[\]\)）】]\s*$')


def download(vid: str, lang: str, auto: bool, out_dir: str) -> str | None:
    flag = '--write-auto-subs' if auto else '--write-subs'
    subprocess.run([sys.executable, '-m', 'yt_dlp', '--skip-download', flag, '--sub-langs', f'{lang},{lang}-orig',
                    '--sub-format', 'json3', '--ffmpeg-location', imageio_ffmpeg.get_ffmpeg_exe(), '-q',
                    '-o', os.path.join(out_dir, '%(id)s.%(ext)s'), f'https://youtu.be/{vid}'], check=False)
    files = sorted(glob.glob(os.path.join(out_dir, f'{vid}*.json3')))
    return files[0] if files else None


def words_from(json3: dict) -> list[tuple[float, str]]:
    words: list[tuple[float, str]] = []
    for ev in json3.get('events', []):
        start = ev.get('tStartMs')
        if start is None:
            continue
        for seg in ev.get('segs') or []:
            text = seg.get('utf8', '')
            if not text.strip() or text == '\n':
                continue
            words.append(((start + seg.get('tOffsetMs', 0)) / 1000, text))
    return words


def lines_from(words: list[tuple[float, str]]) -> list[dict]:
    lines: list[dict] = []
    cur: dict | None = None
    for i, (t, w) in enumerate(words):
        nxt = words[i + 1][0] if i + 1 < len(words) else t + 0.5
        if cur and (t - cur['last'] > GAP_S or len(cur['text']) >= MAX_CHARS):
            lines.append(cur)
            cur = None
        if not cur:
            cur = {'start': t, 'text': '', 'last': t}
        cur['text'] += w
        cur['last'] = t
        cur['end'] = min(nxt, t + 0.8)
    if cur:
        lines.append(cur)
    out = []
    for line in lines:
        text = re.sub(r'\s+', ' ', line['text'].replace('>>', ' ')).strip()
        if text and not BRACKETED.match(text):
            out.append({'start': round(line['start'], 3), 'end': round(line['end'], 3), 'text': text})
    return out


def cues_from(json3: dict) -> list[dict]:
    """Manual captions: one line per cue, with the cue's own start and duration."""
    out = []
    for ev in json3.get('events', []):
        if ev.get('tStartMs') is None or not ev.get('segs'):
            continue
        text = re.sub(r'\s+', ' ', ''.join(seg.get('utf8', '') for seg in ev['segs']).replace('>>', ' ')).strip()
        if not text or BRACKETED.match(text):
            continue
        start = ev['tStartMs'] / 1000
        out.append({'start': round(start, 3), 'end': round(start + ev.get('dDurationMs', 0) / 1000, 3), 'text': text})
    return out


def main() -> None:
    vid, lang = sys.argv[1], sys.argv[2]
    # A json3 file saved by the browser (perf-captions.spec.ts) when yt-dlp is rate-limited.
    saved = ROOT / 'e2e' / '.cache' / 'captions' / f'{vid}.json'
    if saved.exists():
        meta = json.loads(saved.read_text(encoding='utf-8'))
        kind, data = meta['kind'], meta['json3']
    else:
        with tempfile.TemporaryDirectory() as tmp:
            kind = 'manual'
            path = download(vid, lang, False, tmp)
            if not path:
                kind = 'auto'
                path = download(vid, lang, True, tmp)
            if not path:
                raise SystemExit(f'{vid}: no {lang} captions (try: playwright test --project=perf perf-captions)')
            data = json.loads(Path(path).read_text(encoding='utf-8'))
    lines = cues_from(data) if kind == 'manual' else lines_from(words_from(data))
    out = ROOT / 'e2e' / 'fixtures' / 'subtitles' / f'{vid}.captions.json'
    out.write_text(json.dumps({'video': vid, 'lang': lang, 'kind': kind, 'lines': lines}, ensure_ascii=False, indent=1), encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    print(f'{vid}: {len(lines)} lines ({kind})')
    for line in lines[:8]:
        print(f"  {line['start']:7.2f}-{line['end']:7.2f} {line['text']}")


if __name__ == '__main__':
    main()
