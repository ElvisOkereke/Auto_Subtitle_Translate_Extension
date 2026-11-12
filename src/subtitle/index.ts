// subtitle/index.ts - content-script entry for subtitle mode (burned-in subtitle translation).
import { OcrClient } from './ocrClient';
import { installTestBridge } from './testBridge';
import { SubtitleOverlay } from './overlay';
import { boxToPage, contentRect } from './videoGeometry';
import type { NormalizedBox } from './types';

let ocr: Promise<OcrClient> | null = null;
export function getOcr(): Promise<OcrClient> {
  ocr ??= OcrClient.attach();
  return ocr;
}

let testOverlay: { overlay: SubtitleOverlay; box: NormalizedBox; video: HTMLVideoElement } | null = null;

installTestBridge({
  'overlay.show': async ({ text, box }) => {
    const video = document.querySelector('video')!;
    testOverlay?.overlay.destroy();
    testOverlay = { overlay: new SubtitleOverlay(video, box), box, video };
    testOverlay.overlay.show(text);
  },
  'overlay.clear': async () => testOverlay?.overlay.clear(),
  'overlay.rect': async () => {
    const { overlay, box, video } = testOverlay!;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const text = overlay.element.querySelector('.ast-subtitle-text')!;
    return {
      overlay: rect(overlay.element),
      expected: boxToPage(box, video.getBoundingClientRect(), contentRect(video)),
      text: rect(text),
      fontSize: parseFloat(getComputedStyle(text).fontSize),
      parentIsFullscreenElement: overlay.element.parentElement === document.fullscreenElement,
    };
  },
  ocr: async ({ bitmap, lang }) => (await getOcr()).recognize(bitmap, lang),
  'ocr.preload': async ({ lang }) => (await getOcr()).preload(lang),
});
