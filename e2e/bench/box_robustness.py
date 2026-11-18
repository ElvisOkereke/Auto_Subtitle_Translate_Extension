"""Box robustness of the OCR text filter (offline, CPU).

People don't draw perfect boxes. For every hand-labelled Subtitles-mode bench
video, frames at each subtitle's midpoint (and at gaps with no subtitle) are
cropped with boxes a real user might draw around that video's subtitle area -
loose, the whole lower half, too small, shifted - and run through PaddleOCR
detection. Candidate text-filter rules are then scored on the same detections:
subtitles read (CER <= 50%, like the E2E matcher) vs text "read" where there is
no subtitle (false positives).

  e2e/.cache/venv/Scripts/python -I e2e/bench/box_robustness.py [video ids...]
Inputs: e2e/bench/videos.json, e2e/fixtures/subtitles/*.timeline.json,
        e2e/.cache/videos/<id>.b.webm (npm run fixtures:video)
Output: e2e/.perf/box-robustness.json + table on stdout
"""
import hashlib
import json
import math
import os
import subprocess
import sys
import urllib.request

import numpy as np
import onnxruntime as ort
from PIL import Image

ort.set_default_logger_severity(3)
sys.stdout.reconfigure(encoding='utf-8')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODELS = os.path.join(ROOT, 'e2e', '.cache', 'ocr-models')
VIDEOS = os.path.join(ROOT, 'e2e', '.cache', 'videos')
CACHE = os.path.join(ROOT, 'e2e', '.cache', 'box-robustness')

# Same pins as src/ocr/models.ts.
PINS = {
    'det': ('PP-OCRv5_mobile_det_onnx', 'e6f4fa85f00e168c862bc462aebca69eef9b3d3d', 'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d'),
    'korean': ('korean_PP-OCRv5_mobile_rec_onnx', '5c6f574b8e2230adf4287b33e736d71b9fabd28e', '92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08'),
    'cjk': ('PP-OCRv5_mobile_rec_onnx', 'ed152b8b495f84de93cda5709d768548a9127622', 'da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092'),
    'latin': ('latin_PP-OCRv5_mobile_rec_onnx', '89d3a50e2c27e2e7cceeab0e944c25c807d5db4f', '7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498'),
    'cyrillic': ('cyrillic_PP-OCRv5_mobile_rec_onnx', '2cef88145434beb8afa9dd82d77d799eb1ad7b29', '5371ee1ddaa7983cc62d0818d99e982b6804638c85e4f960d59a574094e172e5'),
}
FAMILY = {'ko': 'korean', 'ja': 'cjk', 'zh-Hans': 'cjk', 'zh-Hant': 'cjk', 'es': 'latin', 'fr': 'latin', 'de': 'latin', 'pt': 'latin', 'ru': 'cyrillic'}
NO_SUB_PER_VIDEO = 12


def model_path(key: str) -> str:
    repo, commit, sha = PINS[key]
    path = os.path.join(MODELS, repo, 'inference.onnx')
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        url = f'https://huggingface.co/PaddlePaddle/{repo}/resolve/{commit}/inference.onnx'
        print('downloading', url)
        data = urllib.request.urlopen(url).read()
        if hashlib.sha256(data).hexdigest() != sha:
            raise SystemExit(f'sha256 mismatch for {repo}')
        open(path, 'wb').write(data)
    return path


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def frame_at(path: str, t: float) -> np.ndarray:
    key = os.path.join(CACHE, f'{os.path.basename(path)}-{t:.3f}.png')
    if os.path.exists(key):
        return np.asarray(Image.open(key).convert('RGB'))
    raw = subprocess.run([ffmpeg_exe(), '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
                         capture_output=True, check=True).stdout
    os.makedirs(CACHE, exist_ok=True)
    open(key, 'wb').write(raw)
    return np.asarray(Image.open(key).convert('RGB'))


def norm(s: str) -> str:
    return ''.join(s.split())


def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


class Ocr:
    """Mirror of src/ocr/ocr.worker.ts (detection, box geometry, recognition)."""

    def __init__(self, family: str):
        self.det = ort.InferenceSession(model_path('det'), providers=['CPUExecutionProvider'])
        self.rec = ort.InferenceSession(model_path(family), providers=['CPUExecutionProvider'])
        self.chars = json.load(open(os.path.join(ROOT, 'src', 'ocr', 'charsets', f'{family}.json'), encoding='utf-8'))

    def detect(self, rgb: np.ndarray, max_side=960, upscale_to=0):
        """All text boxes (crop pixels), before any subtitle filter."""
        h, w = rgb.shape[:2]
        scale = min(1.0, max_side / max(h, w))
        if upscale_to and h * scale < upscale_to:
            scale = min(upscale_to / h, max_side / max(h, w) * 2)
        rh, rw = max(32, round(h * scale / 32) * 32), max(32, round(w * scale / 32) * 32)
        img = np.asarray(Image.fromarray(rgb).resize((rw, rh), Image.BILINEAR), np.float32)[:, :, ::-1] / 255.0
        img = (img - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        prob = self.det.run(None, {self.det.get_inputs()[0].name: img.transpose(2, 0, 1)[None].astype(np.float32)})[0][0, 0]
        mh, mw = prob.shape
        mask = prob > 0.3
        seen = np.zeros_like(mask)
        boxes = []
        ys, xs = np.nonzero(mask)
        for y0, x0 in zip(ys, xs):
            if seen[y0, x0]:
                continue
            stack, pts = [(y0, x0)], []
            seen[y0, x0] = True
            while stack:
                y, x = stack.pop()
                pts.append((y, x))
                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= ny < mh and 0 <= nx < mw and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if len(pts) < 10:
                continue
            p = np.array(pts)
            if prob[p[:, 0], p[:, 1]].mean() < 0.6:
                continue
            y1, x1 = p.min(0)
            y2, x2 = p.max(0) + 1
            bw, bh = x2 - x1, y2 - y1
            d = (bw * bh) * 1.5 / (2 * (bw + bh))
            sx, sy = w / mw, h / mh
            boxes.append((max(0, (x1 - d)) * sx, max(0, (y1 - d)) * sy, min(mw, x2 + d) * sx, min(mh, y2 + d) * sy))
        return boxes

    def recognize(self, rgb: np.ndarray, box):
        x1, y1, x2, y2 = (int(round(v)) for v in box)
        crop = rgb[y1:max(y2, y1 + 1), x1:max(x2, x1 + 1)]
        h, w = crop.shape[:2]
        tw = min(3200, max(16, math.ceil(48 * w / h)))
        img = np.asarray(Image.fromarray(crop).resize((tw, 48), Image.BILINEAR), np.float32)[:, :, ::-1] / 255.0
        img = (img - 0.5) / 0.5
        out = self.rec.run(None, {self.rec.get_inputs()[0].name: img.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
        idx, probs = out.argmax(1), out.max(1)
        text, confs, last = [], [], -1
        for i, p in zip(idx, probs):
            if i != last and i != 0:
                text.append(self.chars[i] if i < len(self.chars) else '')
                confs.append(float(p))
            last = i
        return ''.join(text), (float(np.mean(confs)) if confs else 0.0)


def group_lines(boxes):
    lines = []
    for b in sorted(boxes, key=lambda b: ((b[1] + b[3]) / 2, b[0])):
        if lines and min(b[3], lines[-1][-1][3]) - max(b[1], lines[-1][-1][1]) > 0.5 * (b[3] - b[1]):
            lines[-1].append(b)
        else:
            lines.append([b])
    return [sorted(l, key=lambda b: b[0]) for l in lines]


# ---- candidate filter rules: (boxes, crop_h, crop_w, frame_h) -> kept boxes ----
def tallest_rule(boxes, rel=0.6):
    if not boxes:
        return []
    tallest = max(b[3] - b[1] for b in boxes)
    return [b for b in boxes if b[3] - b[1] >= rel * tallest]


def rule_current(boxes, ch, cw, fh, **_):
    return tallest_rule([b for b in boxes if b[3] - b[1] >= 0.35 * ch])


def rule_frame(a):
    def f(boxes, ch, cw, fh, **_):
        return tallest_rule([b for b in boxes if b[3] - b[1] >= a * fh])
    return f


def rule_frame_or_box(a):
    """Subtitle-sized for the video OR filling the box (a snug box around small subtitles)."""
    def f(boxes, ch, cw, fh, **_):
        return tallest_rule([b for b in boxes if b[3] - b[1] >= min(a * fh, 0.35 * ch)])
    return f


def rule_spans(floor=0.022, gap=1.5, band=0.12, rel=0.7, tallest=0.0, inner=0.0, by='height', boxrel=0.0, floor_box=0.0):
    """Subtitle = the tallest text span over the middle of the video, plus similar centred lines next to it."""
    def f(boxes, ch, cw, fh, ox=0, oy=0, fw=1, user=None, **_):
        fl = min(floor * fh, floor_box * (user[3] - user[1])) if floor_box and user else floor * fh
        B = [(b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy) for b in boxes if b[3] - b[1] >= fl]
        if tallest:
            mid0 = fw / 2
            central = [b for b in B if b[0] < mid0 + band * fw and b[2] > mid0 - band * fw]
            if central:
                H = max(b[3] - b[1] for b in central)
                B = [b for b in B if b[3] - b[1] >= tallest * H]
        spans = []  # (x1, y1, x2, y2, h, boxes)
        for line in group_lines(B):
            cur = [line[0]]
            for b in line[1:]:
                hh = max(b[3] - b[1], cur[-1][3] - cur[-1][1])
                if b[0] - cur[-1][2] > gap * hh:
                    spans.append(cur)
                    cur = [b]
                else:
                    cur.append(b)
            spans.append(cur)
        S = []
        for sp in spans:
            x1, y1 = min(b[0] for b in sp), min(b[1] for b in sp)
            x2, y2 = max(b[2] for b in sp), max(b[3] for b in sp)
            h = float(np.median([b[3] - b[1] for b in sp]))
            S.append((x1, y1, x2, y2, h, sp))
        mid = fw / 2
        centred = [s for s in S if s[0] < mid + band * fw and s[2] > mid - band * fw]
        if inner and user:
            ux1, uy1, ux2, uy2 = user
            centred = [s for s in centred if min(s[3], uy2) - max(s[1], uy1) >= inner * (s[3] - s[1]) and min(s[2], ux2) > max(s[0], ux1)]
        if not centred:
            return []
        if by == 'area':
            anchor = max(centred, key=lambda s: (s[2] - s[0]) * max(b[3] - b[1] for b in s[5]))
        else:
            anchor = max(centred, key=lambda s: s[4])
        block = [anchor]
        pool = [s for s in centred if s is not anchor and s[4] >= rel * anchor[4] and s[4] <= anchor[4] / rel]
        grew = True
        while grew and len(block) < 3:
            grew = False
            top, bottom = min(s[1] for s in block), max(s[3] for s in block)
            for s in pool:
                if s in block:
                    continue
                if (s[3] <= top and top - s[3] <= 0.8 * anchor[4]) or (s[1] >= bottom and s[1] - bottom <= 0.8 * anchor[4]) or (s[1] < bottom and s[3] > top):
                    block.append(s)
                    grew = True
                    break
        kept = [b for s in block for b in s[5]]
        if boxrel:
            H = max(b[3] - b[1] for b in anchor[5])
            kept = [b for b in kept if b[3] - b[1] >= boxrel * H]
        return [(b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy) for b in kept]
    return f


RULES = {
    'final inner.25': rule_spans(floor=0.03, floor_box=0.35, inner=0.25, by='area', boxrel=0.7),
    'final (shipped)': rule_spans(floor=0.03, floor_box=0.35, inner=0.1, by='area', boxrel=0.7),
    'current (35% of box)': rule_current,
}


def variants(b):
    """Boxes a user might draw around the subtitle area `b` (normalized x, y, w, h)."""
    x, y, w, h = b['x'], b['y'], b['w'], b['h']
    cx, cy = x + w / 2, y + h / 2

    def clamp(nx, ny, nw, nh):
        nx, ny = max(0.0, nx), max(0.0, ny)
        return (nx, ny, min(nw, 1 - nx), min(nh, 1 - ny))

    return {
        'standard': clamp(x, y, w, h),
        'loose': clamp(x - 0.1, cy - h, w + 0.2, 2 * h),
        'lower half': (0.0, 0.5, 1.0, 0.5),
        'full width thin': clamp(0, y + 0.1 * h, 1.0, 0.8 * h),
        'too small': clamp(cx - 0.3 * w, cy - 0.22 * h, 0.6 * w, 0.44 * h),
        'shifted up': clamp(x, y - 0.35 * h, w, h),
        'shifted down': clamp(x, y + 0.35 * h, w, h),
        'tall narrow': clamp(cx - 0.17, 0.55, 0.34, 0.42),
    }


def crop(frame, v, margin=0.0):
    fh, fw = frame.shape[:2]
    x, y, w, h = v
    if margin:
        mx, my = margin * w, margin * h
        x, y, w, h = max(0, x - mx), max(0, y - my), min(1, x + w + mx) - max(0, x - mx), min(1, y + h + my) - max(0, y - my)
    sx, sy = round(x * fw), round(y * fh)
    return frame[sy:sy + max(1, round(h * fh)), sx:sx + max(1, round(w * fw))], sx, sy


def main():
    videos = [v for v in json.load(open(os.path.join(ROOT, 'e2e', 'bench', 'videos.json'), encoding='utf-8'))['videos'] if v.get('mode') == 'subtitles']
    only = sys.argv[1:]
    if only:
        videos = [v for v in videos if v['id'] in only]
    margins = [float(m) for m in os.environ.get('MARGINS', '0').split(',')]
    results = {}  # (margin, rule, variant) -> counters
    heights = {'subtitle': [], 'other': []}
    for video in videos:
        tl = json.load(open(os.path.join(ROOT, 'e2e', 'fixtures', 'subtitles', f"{video['id']}.timeline.json"), encoding='utf-8'))
        ocr = Ocr(FAMILY[video['lang']])
        samples = []
        for stretch in tl['stretches']:
            file = os.path.join(VIDEOS, stretch['file'])
            if not os.path.exists(file):
                print('missing', file)
                continue
            lines = sorted((l for l in tl['lines'] if l['stretch'] == stretch['id']), key=lambda l: l['start'])
            for l in lines:
                samples.append((file, (l['start'] + l['end']) / 2, l['ko']))
            gaps = [(a['end'] + b['start']) / 2 for a, b in zip(lines, lines[1:]) if b['start'] - a['end'] >= 1.0]
            for t in gaps[:: max(1, len(gaps) // NO_SUB_PER_VIDEO)][:NO_SUB_PER_VIDEO]:
                samples.append((file, t, None))
        vs = variants(video['box'])
        print(f"{video['id']} ({video['lang']}): {sum(1 for s in samples if s[2])} subtitles, {sum(1 for s in samples if not s[2])} gaps", flush=True)
        for file, t, ref in samples:
            frame = frame_at(file, t)
            fh = frame.shape[0]
            for margin in margins:
                for vname, v in vs.items():
                    c, ox, oy = crop(frame, v, margin)
                    boxes = ocr.detect(c)
                    rec_cache = {}

                    def read(kept):
                        texts, confs = [], []
                        for line in group_lines(kept):
                            parts = []
                            for b in line:
                                key = tuple(round(x) for x in b)
                                if key not in rec_cache:
                                    rec_cache[key] = ocr.recognize(c, b)
                                txt, conf = rec_cache[key]
                                if txt:
                                    parts.append(txt)
                                    confs.append(conf)
                            if parts:
                                texts.append(' '.join(parts))
                        text = ' '.join(texts).strip()
                        conf = float(np.mean(confs)) if confs else 0.0
                        return text if conf >= 0.5 else ''

                    if margin == margins[0] and vname == 'standard':
                        for b in boxes:
                            heights['subtitle' if ref else 'other'].append(round((b[3] - b[1]) / fh, 4))
                    for rname, rule in RULES.items():
                        fw_ = frame.shape[1]
                        user = (v[0] * fw_, v[1] * fh, (v[0] + v[2]) * fw_, (v[1] + v[3]) * fh)
                        text = read(rule(boxes, c.shape[0], c.shape[1], fh, ox=ox, oy=oy, fw=fw_, user=user))
                        if rname.startswith('final') and not any(ch.isalpha() for ch in text):
                            text = ''  # hasLetters (src/ocr/detect.ts)
                        r = results.setdefault((margin, rname, vname), {'subs': 0, 'read': 0, 'gaps': 0, 'falsePos': 0, 'perVideo': {}, 'misses': []})
                        pv = r['perVideo'].setdefault(video['id'], [0, 0])
                        if ref:
                            r['subs'] += 1
                            pv[1] += 1
                            n = norm(ref)
                            if text and levenshtein(n, norm(text)) / max(1, len(n)) <= 0.5:
                                r['read'] += 1
                                pv[0] += 1
                            else:
                                r['misses'].append([video['id'], round(t, 2), ref, text])
                        else:
                            r['gaps'] += 1
                            if norm(text):
                                r['falsePos'] += 1
                                r['misses'].append([video['id'], round(t, 2), None, text])
    vnames = list(variants({'x': 0.2, 'y': 0.75, 'w': 0.6, 'h': 0.14}).keys())
    out = []
    for margin in margins:
        print(f'\nmargin {margin:.2f}: % of subtitles read per box (false positives on no-subtitle frames)')
        print(f"{'rule':28}" + ''.join(f'{v[:12]:>14}' for v in vnames))
        for rname in RULES:
            row = f'{rname:28}'
            for v in vnames:
                r = results.get((margin, rname, v))
                if not r:
                    row += f"{'-':>14}"
                    continue
                row += f"{100 * r['read'] / max(1, r['subs']):>8.0f}% ({r['falsePos']:>2})"
                out.append({'margin': margin, 'rule': rname, 'box': v, **r})
            print(row)
    for k, hs in heights.items():
        if hs:
            hs = sorted(hs)
            print(f'{k} text heights (fraction of frame, standard box): p10 {hs[len(hs) // 10]:.3f} median {hs[len(hs) // 2]:.3f} p90 {hs[len(hs) * 9 // 10]:.3f} max {hs[-1]:.3f}')
    os.makedirs(os.path.join(ROOT, 'e2e', '.perf'), exist_ok=True)
    json.dump({'results': out, 'heights': heights}, open(os.path.join(ROOT, 'e2e', '.perf', 'box-robustness.json'), 'w', encoding='utf-8'), indent=1)


if __name__ == '__main__':
    main()
