"""OCR engine benchmark on the subtitle-box crops (Task 2 of the subtitle-mode plan).

Accuracy is runtime-independent, so this runs on CPU (onnxruntime / Tesseract
CLI). Browser/WebGPU latency for the chosen engine is asserted in the E2E suite.

  e2e/.cache/venv/Scripts/python -I e2e/bench/ocr_bench.py
Inputs:  e2e/.cache/ocr-crops/index.json (scripts/export_crops.py)
Output:  e2e/.perf/perf-ocr.json + table on stdout
"""
import json
import math
import os
import statistics
import subprocess
import sys
import time

import numpy as np
import onnxruntime as ort
import yaml
from PIL import Image

ort.set_default_logger_severity(3)
sys.stdout.reconfigure(encoding='utf-8')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CROPS = os.path.join(ROOT, 'e2e', '.cache', 'ocr-crops')
MODELS = os.path.join(ROOT, 'e2e', '.cache', 'ocr-models')
TESS = os.path.join(os.path.dirname(ROOT), 'Tesseract-OCR', 'tesseract.exe')
TESSDATA = os.path.join(ROOT, 'e2e', '.cache', 'tessdata')
VIDEO_HEIGHT = 1080
MIN_TEXT_REL_HEIGHT = 0.025  # subtitle glyph boxes are >= 2.5% of video height; HUD text is ~1.5%


def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def norm(s: str) -> str:
    return ''.join(s.split())


# ---------------- PaddleOCR (PP-OCRv5 det + rec) ----------------
class Paddle:
    def __init__(self, det_dir: str, rec_dir: str, min_rel_height=MIN_TEXT_REL_HEIGHT, rel_to_tallest=0.0):
        self.det = ort.InferenceSession(os.path.join(MODELS, det_dir, 'inference.onnx'), providers=['CPUExecutionProvider'])
        self.rec = ort.InferenceSession(os.path.join(MODELS, rec_dir, 'inference.onnx'), providers=['CPUExecutionProvider'])
        cfg = yaml.safe_load(open(os.path.join(MODELS, rec_dir, 'inference.yml'), encoding='utf-8'))
        self.chars = ['<blank>'] + [str(c) for c in cfg['PostProcess']['character_dict']] + [' ']
        self.min_rel_height = min_rel_height
        self.rel_to_tallest = rel_to_tallest
        self.heights = []

    def detect(self, rgb: np.ndarray):
        h, w = rgb.shape[:2]
        scale = min(1.0, 960 / max(h, w))
        rh, rw = max(32, round(h * scale / 32) * 32), max(32, round(w * scale / 32) * 32)
        img = np.asarray(Image.fromarray(rgb).resize((rw, rh), Image.BILINEAR), np.float32)[:, :, ::-1] / 255.0
        img = (img - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        prob = self.det.run(None, {self.det.get_inputs()[0].name: img.transpose(2, 0, 1)[None]})[0][0, 0]
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
                    if 0 <= ny < rh and 0 <= nx < rw and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if len(pts) < 10:
                continue
            p = np.array(pts)
            y1, x1 = p.min(0)
            y2, x2 = p.max(0) + 1
            if prob[y1:y2, x1:x2][mask[y1:y2, x1:x2]].mean() < 0.6:
                continue
            bw, bh = x2 - x1, y2 - y1
            d = (bw * bh) * 1.5 / (2 * (bw + bh))  # DB unclip, rectangle approximation
            sx, sy = w / rw, h / rh
            box = (max(0, (x1 - d) * sx), max(0, (y1 - d) * sy), min(w, (x2 + d) * sx), min(h, (y2 + d) * sy))
            floor = self.min_rel_height * VIDEO_HEIGHT if self.min_rel_height > 0 else -self.min_rel_height * h
            if box[3] - box[1] >= floor:
                boxes.append(box)
        if boxes and self.rel_to_tallest:
            # Subtitles are the largest text in the box; smaller UI text (buttons, HUD notices) is dropped.
            tallest = max(b[3] - b[1] for b in boxes)
            boxes = [b for b in boxes if b[3] - b[1] >= self.rel_to_tallest * tallest]
        self.heights.append([round(b[3] - b[1]) for b in boxes])
        return boxes

    def recognize(self, rgb: np.ndarray, box):
        x1, y1, x2, y2 = (int(round(v)) for v in box)
        crop = rgb[y1:y2, x1:x2]
        h, w = crop.shape[:2]
        tw = min(3200, max(16, math.ceil(48 * w / h)))
        img = np.asarray(Image.fromarray(crop).resize((tw, 48), Image.BILINEAR), np.float32)[:, :, ::-1] / 255.0
        img = (img - 0.5) / 0.5
        out = self.rec.run(None, {self.rec.get_inputs()[0].name: img.transpose(2, 0, 1)[None]})[0][0]
        idx, probs = out.argmax(1), out.max(1)
        text, confs, last = [], [], -1
        for i, p in zip(idx, probs):
            if i != last and i != 0:
                text.append(self.chars[i])
                confs.append(p)
            last = i
        return ''.join(text), float(np.mean(confs)) if confs else 0.0

    def __call__(self, rgb: np.ndarray):
        boxes = sorted(self.detect(rgb), key=lambda b: ((b[1] + b[3]) / 2, b[0]))
        lines = []
        for b in boxes:  # group boxes into lines by vertical overlap
            if lines and min(b[3], lines[-1][-1][3]) - max(b[1], lines[-1][-1][1]) > 0.5 * (b[3] - b[1]):
                lines[-1].append(b)
            else:
                lines.append([b])
        texts, confs = [], []
        for line in lines:
            parts = [self.recognize(rgb, b) for b in sorted(line, key=lambda b: b[0])]
            texts.append(' '.join(t for t, _ in parts))
            confs += [c for _, c in parts]
        return ' '.join(texts).strip(), (float(np.mean(confs)) if confs else 0.0)


# ---------------- Tesseract (kor, tessdata_best) ----------------
def outlined_text_mask(rgb: np.ndarray) -> np.ndarray:
    a = rgb.astype(np.int16)
    white = a.min(axis=2) > 200
    return np.where(white, 0, 255).astype(np.uint8)  # black text on white


class Tesseract:
    def __init__(self, binarize: bool):
        self.binarize = binarize

    def __call__(self, rgb: np.ndarray):
        img = Image.fromarray(outlined_text_mask(rgb)) if self.binarize else Image.fromarray(rgb)
        path = os.path.join(ROOT, 'e2e', '.cache', '_tess.png')
        img.save(path)
        out = subprocess.run([TESS, path, 'stdout', '-l', 'kor', '--tessdata-dir', TESSDATA, '--psm', '6'],
                             capture_output=True, text=True, encoding='utf-8').stdout
        return out.strip(), 1.0


def run(name, engine, index, conf_threshold=0.5):
    errs = total = 0
    fps = 0
    times, samples = [], []
    for item in index:
        rgb = np.asarray(Image.open(os.path.join(CROPS, item['file'])).convert('RGB'))
        t = time.perf_counter()
        text, conf = engine(rgb)
        times.append((time.perf_counter() - t) * 1000)
        if item['ko'] is None:
            if norm(text) and conf >= conf_threshold:
                fps += 1
                samples.append(('FALSE+', item['file'], text))
            continue
        e = levenshtein(norm(text), norm(item['ko']))
        errs += e
        total += len(norm(item['ko']))
        if e:
            samples.append((f'{e}/{len(norm(item["ko"]))}', item['ko'], text))
    res = {
        'cer': round(errs / total, 4),
        'falsePositives': fps,
        'noSubtitleCrops': sum(1 for i in index if i['ko'] is None),
        'medianMsCpu': round(statistics.median(times), 1),
        'p90MsCpu': round(sorted(times)[int(len(times) * 0.9)], 1),
    }
    print(f"{name:28} CER {res['cer']:.3f}  false+ {fps}/{res['noSubtitleCrops']}  CPU median {res['medianMsCpu']}ms p90 {res['p90MsCpu']}ms")
    for s in samples[:12]:
        print('    ', *s)
    return res


def main():
    index = json.load(open(os.path.join(CROPS, 'index.json'), encoding='utf-8'))
    only = sys.argv[1:]
    engines = {
        'paddle-v5-mobile-korean': lambda: Paddle('PP-OCRv5_mobile_det_onnx', 'korean_PP-OCRv5_mobile_rec_onnx'),
        'paddle-korean-abs2.5-rel0.6': lambda: Paddle('PP-OCRv5_mobile_det_onnx', 'korean_PP-OCRv5_mobile_rec_onnx', 0.025, 0.6),
        'paddle-korean-abs3.5-rel0.6': lambda: Paddle('PP-OCRv5_mobile_det_onnx', 'korean_PP-OCRv5_mobile_rec_onnx', 0.035, 0.6),
        # negative min_rel_height = fraction of the drawn box's height (adapts to subtitle size)
        'paddle-korean-box0.35-rel0.6': lambda: Paddle('PP-OCRv5_mobile_det_onnx', 'korean_PP-OCRv5_mobile_rec_onnx', -0.35, 0.6),
        'paddle-v5-mobile-korean-nofilter': lambda: Paddle('PP-OCRv5_mobile_det_onnx', 'korean_PP-OCRv5_mobile_rec_onnx', 0),
        'tesseract-kor-raw': lambda: Tesseract(False),
        'tesseract-kor-binarized': lambda: Tesseract(True),
    }
    results = {}
    for name, make in engines.items():
        if only and name not in only:
            continue
        engine = make()
        results[name] = run(name, engine, index)
        if isinstance(engine, Paddle) and name.endswith('nofilter'):
            subs = [h for h, i in zip(engine.heights, index) if i['ko']]
            none = [h for h, i in zip(engine.heights, index) if not i['ko']]
            print('    box heights (subtitle crops, max per crop):', sorted(max(h) for h in subs if h))
            print('    box heights (no-subtitle crops):', [h for h in none if h])
    out = os.path.join(ROOT, 'e2e', '.perf', 'perf-ocr.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    prev = json.load(open(out)) if os.path.exists(out) else {}
    prev.update(results)
    json.dump(prev, open(out, 'w'), indent=2)


if __name__ == '__main__':
    main()
