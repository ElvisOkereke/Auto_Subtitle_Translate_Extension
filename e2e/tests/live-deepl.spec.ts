import { test, expect } from '../helpers/extension';
import { readEnv } from '../helpers/env';
import type { Page } from '@playwright/test';

// Talks to the real DeepL API with DEEPL_API_KEY from .env. Skipped when no key
// is configured. Uses a handful of characters of the free quota per run.
const key = readEnv('DEEPL_API_KEY');

test.use({ mockTranslation: false });
test.skip(!key, 'DEEPL_API_KEY not set in .env');

async function dragOver(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 5 });
  await page.mouse.up();
}

test('Screen Translate with the real DeepL API', async ({ context, fixtureURL, openPopup, configure }) => {
  await configure({ translationProvider: 'deepl', deeplApiKey: key, targetLanguage: 'en', sourceLanguage: 'auto' });
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/screen-translate.html`);
  const popup = await openPopup(page);
  await popup.click('#screenTranslateButton');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');

  const started = Date.now();
  await dragOver(page, '#target');
  const translated = page.locator('[data-role="translated-text"]');
  // DeepL renders "Bonjour le monde" as "Hello world" or (since 2026-11) "Hello, everyone"; both are right.
  await expect(translated).toHaveText(/hello,? (the )?(world|everyone)/i, { timeout: 15_000 });
  // This goes popup -> content script -> background -> apiService -> DeepL, the
  // same translation path live captions use.
  console.log(`DeepL round trip (drag -> overlay): ${Date.now() - started}ms`);
});

test('an invalid DeepL key fails fast with a readable message', async ({ context, fixtureURL, openPopup, configure }) => {
  await configure({ translationProvider: 'deepl', deeplApiKey: 'definitely-not-valid:fx', targetLanguage: 'en' });
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/screen-translate.html`);
  const popup = await openPopup(page);
  await popup.click('#screenTranslateButton');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  const started = Date.now();
  await dragOver(page, '#target');
  await expect(page.getByText(/Translation request failed: 403/)).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(5000);
});
