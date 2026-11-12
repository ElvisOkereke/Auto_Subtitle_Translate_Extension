"""Extract PaddleOCR recognizer class lists into src/ocr/charsets/<family>.json.

Each JSON array is index-aligned with the model's output: ['' (CTC blank), *character_dict, ' '].
Run with the e2e venv (needs pyyaml): e2e/.cache/venv/Scripts/python -I scripts/extract_ocr_charsets.py
"""
import json
import os
import urllib.request

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'src', 'ocr', 'charsets')
FAMILIES = {
    'korean': 'korean_PP-OCRv5_mobile_rec_onnx',
    'cjk': 'PP-OCRv5_mobile_rec_onnx',
    'latin': 'latin_PP-OCRv5_mobile_rec_onnx',
    'cyrillic': 'cyrillic_PP-OCRv5_mobile_rec_onnx',
}

os.makedirs(OUT, exist_ok=True)
for family, repo in FAMILIES.items():
    url = f'https://huggingface.co/PaddlePaddle/{repo}/resolve/main/inference.yml'
    cfg = yaml.safe_load(urllib.request.urlopen(url).read().decode('utf-8'))
    classes = [''] + [str(c) for c in cfg['PostProcess']['character_dict']] + [' ']
    with open(os.path.join(OUT, f'{family}.json'), 'w', encoding='utf-8') as f:
        json.dump(classes, f, ensure_ascii=False, separators=(',', ':'))
    print(family, len(classes))
