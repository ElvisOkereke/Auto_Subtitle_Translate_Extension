import type { BrowserContext, Page } from '@playwright/test';

/**
 * Replaces Chrome's built-in Translator and LanguageDetector on a page (before
 * its scripts run) with fakes: `state` is what availability() answers. create()
 * records the pairs on window.__createdPairs and reports download progress.
 */
export async function fakeTranslator(page: Page | BrowserContext, state: 'available' | 'downloadable' | 'unavailable'): Promise<void> {
  await page.addInitScript(s => {
    const w = window as any;
    w.__createdPairs = [];
    const monitorOf = (o: any) => {
      const listeners: ((e: { loaded: number }) => void)[] = [];
      o?.monitor?.({ addEventListener: (_: string, fn: (e: { loaded: number }) => void) => listeners.push(fn) });
      return listeners;
    };
    w.Translator = {
      // Like Chrome: a pack downloaded here reports 'available' afterwards.
      availability: async (o: any) => (w.__createdPairs.includes(`${o.sourceLanguage}>${o.targetLanguage}`) ? 'available' : s),
      create: async (o: any) => {
        const listeners = monitorOf(o);
        for (const loaded of [0.25, 0.5, 1]) {
          await new Promise(r => setTimeout(r, 50));
          listeners.forEach(fn => fn({ loaded }));
        }
        w.__createdPairs.push(`${o.sourceLanguage}>${o.targetLanguage}`);
        return { translate: async (t: string) => `[fake] ${t}` };
      },
    };
    w.LanguageDetector = {
      availability: async () => (w.__createdPairs.includes('detector') ? 'available' : s),
      create: async (o: any) => {
        monitorOf(o).forEach(fn => fn({ loaded: 1 }));
        w.__createdPairs.push('detector');
        return { detect: async () => [{ detectedLanguage: 'ko', confidence: 1 }] };
      },
    };
  }, state);
}

/** Setup state with the speech model and the Korean subtitle reader prepared (so only translation is left). */
export const PREPARED_MODELS = {
  speech: { 'onnx-community/whisper-base|wasm': { at: 1 }, 'onnx-community/whisper-large-v3-turbo|webgpu': { at: 1 }, 'onnx-community/whisper-small|webgpu': { at: 1 } },
  ocr: { 'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/5c6f574b8e2230adf4287b33e736d71b9fabd28e/inference.onnx': { at: 1 } },
};
