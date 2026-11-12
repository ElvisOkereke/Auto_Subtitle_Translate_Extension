"""Fetch real subtitle lines of non-gaming videos for the cross-domain translation
benchmark (e2e/tests/domain-bench.spec.ts).

Usage (venv from `npm run fixtures:video`):
  e2e/.cache/venv/Scripts/python -I e2e/scripts/fetch_domain_lines.py

Downloads each video's subtitle track with yt-dlp into its own scratch directory
(e2e/.cache/domain-subs/<name>/), keeps ~35 consecutive lines, and writes
e2e/fixtures/domains/<name>.json with the page context the extension would read
(title, channel, description). Human-made tracks are used where the video has
one; otherwise YouTube's automatic captions (a transcript of the real speech -
what audio mode produces).
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRATCH = ROOT / 'e2e' / '.cache' / 'domain-subs'
OUT = ROOT / 'e2e' / 'fixtures' / 'domains'
YTDLP = pathlib.Path(sys.executable).parent / ('yt-dlp.exe' if sys.platform == 'win32' else 'yt-dlp')

VIDEOS = [
    # name, video id, subtitle language, automatic captions?, first second to use
    ('football-es', 'VzRr1zWFl8U', 'es-ES', False, 0),
    ('anime-ja', 'iHd7eWUXuLU', 'ja', False, 0),
    ('drama-ko', 'aZ9I0t39Qqg', 'ko-orig', True, 0),
]
MAX_LINES = 35
NOISE = re.compile(r'^[\[\(（【♪].*[\]\)）】♪]$|^♪+$')


def info(video_id: str) -> dict:
    out = subprocess.run([str(YTDLP), '-j', '--skip-download', f'https://www.youtube.com/watch?v={video_id}'], capture_output=True, text=True, encoding='utf-8', check=True)
    return json.loads(out.stdout)


def download(name: str, video_id: str, lang: str, auto: bool) -> pathlib.Path:
    folder = SCRATCH / name
    folder.mkdir(parents=True, exist_ok=True)
    args = [str(YTDLP), '--skip-download', '--sub-format', 'json3', '--sub-langs', lang, '-o', str(folder / '%(id)s.%(ext)s')]
    args.append('--write-auto-subs' if auto else '--write-subs')
    subprocess.run(args + [f'https://www.youtube.com/watch?v={video_id}'], check=True, capture_output=True)
    files = sorted(folder.glob(f'{video_id}*.json3'))
    if not files:
        raise SystemExit(f'{name}: no {lang} subtitle track downloaded')
    return files[0]


def lines_from_json3(path: pathlib.Path, start_s: float) -> list[str]:
    data = json.loads(path.read_text(encoding='utf-8'))
    lines: list[str] = []
    for event in data.get('events', []):
        if event.get('tStartMs', 0) < start_s * 1000 or 'segs' not in event:
            continue
        text = ''.join(seg.get('utf8', '') for seg in event['segs']).replace('\n', ' ').strip()
        text = re.sub(r'\s+', ' ', text)
        if not text or NOISE.match(text) or (lines and text == lines[-1]):
            continue
        lines.append(text)
        if len(lines) >= MAX_LINES:
            break
    return lines


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, video_id, lang, auto, start_s in VIDEOS:
        meta = info(video_id)
        lines = lines_from_json3(download(name, video_id, lang, auto), start_s)
        fixture = {
            'name': name,
            'url': f'https://www.youtube.com/watch?v={video_id}',
            'title': meta.get('title', ''),
            'channel': meta.get('channel', ''),
            'description': (meta.get('description') or '')[:1000],
            'sourceLang': lang.split('-')[0],
            'subtitles': 'automatic captions' if auto else 'human-made subtitles',
            'lines': lines,
        }
        (OUT / f'{name}.json').write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'{name}: {len(lines)} lines from {fixture["subtitles"]}')


if __name__ == '__main__':
    main()
