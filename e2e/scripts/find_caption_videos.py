"""Search YouTube and list which caption tracks candidates have (manual vs auto).

Usage: python -I e2e/scripts/find_caption_videos.py LANG "query" [N]
Prints: id | duration | manual langs (subset) | auto has LANG | title
"""
import json
import subprocess
import sys

lang = sys.argv[1]
query = sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 10
sys.stdout.reconfigure(encoding='utf-8')
ids = subprocess.run([sys.executable, '-m', 'yt_dlp', '--flat-playlist', '--print', '%(id)s', f'ytsearch{n}:{query}'],
                     capture_output=True, text=True).stdout.split()
for vid in ids:
    out = subprocess.run([sys.executable, '-m', 'yt_dlp', '-J', '--skip-download', f'https://youtu.be/{vid}'],
                         capture_output=True, text=True, encoding='utf-8')
    try:
        info = json.loads(out.stdout)
    except json.JSONDecodeError:
        continue
    manual = sorted(k for k in (info.get('subtitles') or {}) if k.split('-')[0] == lang)
    # Auto captions in the video's own spoken language are '<lang>-orig' (the rest are machine translations).
    auto = f'{lang}-orig' in (info.get('automatic_captions') or {})
    if not 120 < (info.get('duration') or 0) < 3600:
        continue
    print(f"{vid} | {info.get('duration')}s | manual={manual or '-'} | auto={auto} | {info.get('channel')} | {info.get('title')[:70]}")
