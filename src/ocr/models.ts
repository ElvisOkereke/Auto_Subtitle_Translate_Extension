// OCR model selection per subtitle language.
// See docs/superpowers/decisions/2026-11-12-ocr-engine.md.
import type { SubtitleLanguage } from '../subtitle/types';

export const SUBTITLE_LANGUAGES: readonly SubtitleLanguage[] = ['ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'pt', 'ru'];

const HF = (repo: string) => `https://huggingface.co/PaddlePaddle/${repo}/resolve/main/inference.onnx`;

const DETECTOR = HF('PP-OCRv5_mobile_det_onnx');

type Family = 'korean' | 'cjk' | 'latin' | 'cyrillic';

const FAMILY: Record<SubtitleLanguage, Family> = {
  ko: 'korean',
  ja: 'cjk',
  'zh-Hans': 'cjk',
  'zh-Hant': 'cjk',
  es: 'latin',
  fr: 'latin',
  de: 'latin',
  pt: 'latin',
  ru: 'cyrillic',
};

const RECOGNIZER: Record<Family, string> = {
  korean: 'korean_PP-OCRv5_mobile_rec_onnx',
  cjk: 'PP-OCRv5_mobile_rec_onnx',
  latin: 'latin_PP-OCRv5_mobile_rec_onnx',
  cyrillic: 'cyrillic_PP-OCRv5_mobile_rec_onnx',
};

export interface OcrModels {
  det: string;
  rec: string;
  /** Extension-relative path of the recognizer's class list ([blank, ...dict, ' ']). */
  charset: string;
}

/** Single tier for now (decision record); `tier` is accepted for the spec's two-tier option. */
export function modelFor(lang: SubtitleLanguage, _tier: 'fast' | 'accurate' = 'fast'): OcrModels {
  const family = FAMILY[lang];
  return { det: DETECTOR, rec: HF(RECOGNIZER[family]), charset: `ocr/charsets/${family}.json` };
}
