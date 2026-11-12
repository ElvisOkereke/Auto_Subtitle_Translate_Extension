// OCR model selection per subtitle language.
// See docs/superpowers/decisions/2026-11-12-ocr-engine.md.
import type { SubtitleLanguage } from '../subtitle/types';

export const SUBTITLE_LANGUAGES: readonly SubtitleLanguage[] = ['ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'pt', 'ru'];

// Each model is pinned to a Hugging Face commit and the SHA-256 of its file
// (verified after download), so a repo update can't change what users run.
interface PinnedModel {
  repo: string;
  commit: string;
  sha256: string;
}

const MODELS: Record<string, PinnedModel> = {
  det: { repo: 'PP-OCRv5_mobile_det_onnx', commit: 'e6f4fa85f00e168c862bc462aebca69eef9b3d3d', sha256: 'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d' },
  korean: { repo: 'korean_PP-OCRv5_mobile_rec_onnx', commit: '5c6f574b8e2230adf4287b33e736d71b9fabd28e', sha256: '92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08' },
  cjk: { repo: 'PP-OCRv5_mobile_rec_onnx', commit: 'ed152b8b495f84de93cda5709d768548a9127622', sha256: 'da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092' },
  latin: { repo: 'latin_PP-OCRv5_mobile_rec_onnx', commit: '89d3a50e2c27e2e7cceeab0e944c25c807d5db4f', sha256: '7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498' },
  cyrillic: { repo: 'cyrillic_PP-OCRv5_mobile_rec_onnx', commit: '2cef88145434beb8afa9dd82d77d799eb1ad7b29', sha256: '5371ee1ddaa7983cc62d0818d99e982b6804638c85e4f960d59a574094e172e5' },
};

const url = (m: PinnedModel) => `https://huggingface.co/PaddlePaddle/${m.repo}/resolve/${m.commit}/inference.onnx`;

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

export interface OcrModels {
  det: string;
  detSha256: string;
  rec: string;
  recSha256: string;
  /** Extension-relative path of the recognizer's class list ([blank, ...dict, ' ']). */
  charset: string;
}

/** Single tier for now (decision record); `tier` is accepted for the spec's two-tier option. */
export function modelFor(lang: SubtitleLanguage, _tier: 'fast' | 'accurate' = 'fast'): OcrModels {
  const family = FAMILY[lang];
  const rec = MODELS[family];
  return { det: url(MODELS.det), detSha256: MODELS.det.sha256, rec: url(rec), recSha256: rec.sha256, charset: `ocr/charsets/${family}.json` };
}
