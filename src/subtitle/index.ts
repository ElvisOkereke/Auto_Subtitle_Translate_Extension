// subtitle/index.ts - content-script entry for subtitle mode (burned-in subtitle translation).
import { OcrClient } from './ocrClient';
import { installTestBridge } from './testBridge';

let ocr: Promise<OcrClient> | null = null;
export function getOcr(): Promise<OcrClient> {
  ocr ??= OcrClient.attach();
  return ocr;
}

installTestBridge({
  ocr: async ({ bitmap, lang }) => (await getOcr()).recognize(bitmap, lang),
  'ocr.preload': async ({ lang }) => (await getOcr()).preload(lang),
});
