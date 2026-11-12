import { modelFor, SUBTITLE_LANGUAGES } from '../models';

describe('modelFor', () => {
  it('returns detection, recognition and charset for every subtitle language', () => {
    for (const lang of SUBTITLE_LANGUAGES) {
      const m = modelFor(lang);
      // Pinned to a commit (a repo update can't change what users download) with the file's SHA-256.
      expect(m.det).toMatch(/^https:\/\/huggingface\.co\/PaddlePaddle\/PP-OCRv5_mobile_det_onnx\/resolve\/[0-9a-f]{40}\/inference\.onnx$/);
      expect(m.rec).toMatch(/^https:\/\/huggingface\.co\/PaddlePaddle\/.+_rec_onnx\/resolve\/[0-9a-f]{40}\/inference\.onnx$/);
      expect(m.detSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.recSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.charset).toMatch(/^ocr\/charsets\/[a-z]+\.json$/);
    }
  });

  it('maps language families to the decision record\'s recognizers', () => {
    expect(modelFor('ko').rec).toContain('/korean_PP-OCRv5_mobile_rec_onnx/');
    expect(modelFor('ja').rec).toContain('/PP-OCRv5_mobile_rec_onnx/');
    expect(modelFor('zh-Hant').rec).toContain('/PP-OCRv5_mobile_rec_onnx/');
    expect(modelFor('de').rec).toContain('/latin_PP-OCRv5_mobile_rec_onnx/');
    expect(modelFor('ru').rec).toContain('/cyrillic_PP-OCRv5_mobile_rec_onnx/');
  });

  it('covers exactly the nine spec languages', () => {
    expect([...SUBTITLE_LANGUAGES].sort()).toEqual(['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hans', 'zh-Hant']);
  });

  it('pins the Korean models to the hashes of the files the OCR benchmark measured', () => {
    expect(modelFor('ko').detSha256).toBe('a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d');
    expect(modelFor('ko').recSha256).toBe('92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08');
  });
});
