import type { Page } from '@playwright/test';

/**
 * Calls a subtitle-mode test-bridge command in the page's content script
 * (see src/subtitle/testBridge.ts). A payload field `{ bitmapUrl }` is turned
 * into an ImageBitmap inside the page before sending.
 */
export async function astTest<T = any>(page: Page, command: string, payload: Record<string, unknown> = {}): Promise<T> {
  await page.waitForFunction(() => document.documentElement.dataset.astTestBridge === 'ready', null, { timeout: 15_000 });
  return page.evaluate(
    async ({ command, payload }) => {
      const resolved: Record<string, unknown> = { ...payload };
      if (typeof payload.bitmapUrl === 'string') {
        resolved.bitmap = await createImageBitmap(await (await fetch(payload.bitmapUrl)).blob());
        delete resolved.bitmapUrl;
      }
      const id = Math.random().toString(36).slice(2);
      return new Promise((resolve, reject) => {
        const onMessage = (event: MessageEvent) => {
          if (event.data?.astTestResult !== id) return;
          window.removeEventListener('message', onMessage);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.result);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ astTest: command, id, payload: resolved }, '*');
      });
    },
    { command, payload }
  ) as Promise<T>;
}
