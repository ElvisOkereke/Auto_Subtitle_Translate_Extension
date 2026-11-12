import { modelFor, SUBTITLE_LANGUAGES } from '../models';

describe('modelFor', () => {
  it('returns detection, recognition and charset for every subtitle language', () => {
    for (const lang of SUBTITLE_LANGUAGES) {
      const m = modelFor(lang);
      expect(m.det).toMatch(/^https:\/\/huggingface\.co\/PaddlePaddle\/PP-OCRv5_mobile_det_onnx\/resolve\/main\/inference\.onnx$/);
      expect(m.rec).toMatch(/^https:\/\/huggingface\.co\/PaddlePaddle\/.+_rec_onnx\/resolve\/main\/inference\.onnx$/);
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
});
