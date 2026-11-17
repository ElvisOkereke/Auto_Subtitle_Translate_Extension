"""Picks fresh YouTube videos for the screen test (a different set every run).

Usage: python -I e2e/scripts/pick_screen_videos.py [N]
Writes e2e/.cache/screen-videos.json: [{id, title, lang, start, duration, captions}]
and remembers every pick in e2e/.cache/screen-used.json so they aren't reused.
For each pick it saves YouTube's captions in the spoken language (the Audio mode
reference when a video has no burned-in subtitles) to e2e/.cache/captions/<id>.json3.
"""
import json
import os
import random
import subprocess
import sys
import urllib.parse

sys.stdout.reconfigure(encoding='utf-8')

N = int(sys.argv[1]) if len(sys.argv) > 1 else 3
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, 'e2e', '.cache')
USED = os.path.join(CACHE, 'screen-used.json')
OUT = os.path.join(CACHE, 'screen-videos.json')

# (query, spoken language). Korean variety and gaming videos usually carry burned-in subtitles.
QUERIES = [
    ('롤 하이라이트 자막', 'ko'), ('예능 하이라이트 자막', 'ko'), ('게임 방송 하이라이트', 'ko'), ('브이로그 일상', 'ko'),
    ('먹방 자막', 'ko'), ('발로란트 하이라이트', 'ko'), ('축구 하이라이트 해설', 'ko'),
    ('ゲーム実況 切り抜き', 'ja'), ('日常 vlog', 'ja'), ('サッカー ハイライト 実況', 'ja'),
    ('resumen partido comentarios', 'es'), ('vlog en español', 'es'),
    ('游戏 解说 精彩', 'zh-Hans'),
]
SUBTITLE_LANGS = {'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'pt', 'ru'}


def ytdlp(*args):
    return subprocess.run([sys.executable, '-m', 'yt_dlp', *args], capture_output=True, text=True, encoding='utf-8')


used = set(json.load(open(USED, encoding='utf-8'))) if os.path.exists(USED) else set()
random.shuffle(QUERIES)
picks = []
for query, lang in QUERIES:
    if len(picks) >= N:
        break
    # YouTube search sorted by upload date (sp=CAI%3D): recent uploads, a different set every day.
    url = 'https://www.youtube.com/results?search_query=' + urllib.parse.quote(query) + '&sp=CAI%253D'
    found = ytdlp('--flat-playlist', '--playlist-end', '30', '--print', '%(id)s\t%(duration)s', url).stdout.split('\n')
    candidates = []
    for line in found:
        parts = line.split('\t')
        if len(parts) != 2 or parts[0] in used:
            continue
        try:
            dur = float(parts[1])
        except ValueError:
            continue
        if 240 <= dur <= 2400:  # no shorts, no streams
            candidates.append((parts[0], dur))
    random.shuffle(candidates)
    for vid, dur in candidates[:4]:
        info_raw = ytdlp('-J', '--skip-download', f'https://youtu.be/{vid}').stdout
        try:
            info = json.loads(info_raw)
        except json.JSONDecodeError:
            continue
        if info.get('is_live') or any('dubbed' in f"{f.get('format_note') or ''}".lower() for f in info.get('formats') or []):
            continue
        start = int(random.uniform(60, max(61, dur - 150)))
        captions = None
        orig = f'{lang}-orig' if f'{lang}-orig' in (info.get('automatic_captions') or {}) else None
        manual = lang if lang in (info.get('subtitles') or {}) else None
        if manual or orig:
            os.makedirs(os.path.join(CACHE, 'captions'), exist_ok=True)
            dest = os.path.join(CACHE, 'captions', vid)
            r = ytdlp('--skip-download', '--write-subs' if manual else '--write-auto-subs', '--sub-langs', manual or orig, '--sub-format', 'json3', '-o', dest, f'https://youtu.be/{vid}')
            path = f'{dest}.{manual or orig}.json3'
            captions = os.path.relpath(path, ROOT).replace('\\', '/') if os.path.exists(path) else None
        picks.append({'id': vid, 'title': info.get('title'), 'channel': info.get('channel'), 'lang': lang, 'start': start, 'duration': dur, 'captions': captions})
        used.add(vid)
        break

json.dump(picks, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
json.dump(sorted(used), open(USED, 'w', encoding='utf-8'))
for p in picks:
    print(f"{p['id']} | {p['lang']} | start {p['start']} s | captions {'yes' if p['captions'] else 'no'} | {p['channel']} | {(p['title'] or '')[:60]}")
