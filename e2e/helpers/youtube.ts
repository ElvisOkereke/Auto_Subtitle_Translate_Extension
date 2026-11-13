import type { Page } from '@playwright/test';

/** Waits for YouTube ads to finish (clicking Skip when offered); throws on a player error. */
export async function waitOutAds(page: Page): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      ad: !!document.querySelector('#movie_player.ad-showing'),
      error: document.querySelector('.ytp-error')?.textContent?.trim() ?? null,
    }));
    if (state.error) throw new Error(`YouTube refused playback in the test browser: "${state.error}"`);
    if (!state.ad) return;
    await page.locator('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern').first().click({ timeout: 1000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
  }
  throw new Error('Ad did not finish within 90 s');
}

/** Records the MIME type of every SourceBuffer the page creates (window.__astMimes). Call before navigating. */
export async function recordSourceBufferTypes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__astMimes = [];
    const original = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
      w.__astMimes.push(mime);
      return original.call(this, mime);
    };
  });
}

export const sourceBufferTypes = (page: Page) => page.evaluate(() => ((window as any).__astMimes ?? []) as string[]);
