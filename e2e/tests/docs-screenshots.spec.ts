import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { readEnv } from '../helpers/env';
import { clearTranslationState, openFixture, startViaPopup } from '../helpers/subtitles';

// Screenshots of the real extension for the README and the portfolio
// (docs/images/). Real DeepL translates (DEEPL_API_KEY in .env). Opt-in:
//   npx playwright test --project=docs
const key = readEnv('DEEPL_API_KEY');
const OUT = path.join(ROOT, 'docs/images');
test.use({ mockTranslation: false, keepWelcome: true, profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });
test.skip(!key, 'DEEPL_API_KEY not set in .env');
test.describe.configure({ mode: 'serial' });

const shot = async (page: Page, name: string, opts: Parameters<Page['screenshot']>[0] = {}) => {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ ...opts, path: path.join(OUT, `${name}.png`) });
};

test('subtitles mode on a video, with the popup and the debug panel', async ({ context, fixtureURL, openPopup, configure, sw }) => {
  test.setTimeout(300_000);
  await configure({ translationProvider: 'deepl', deeplApiKey: key, targetLanguage: 'en', subtitleLanguage: 'ko', translationEngineMode: 'fast', theme: 'light' });
  await clearTranslationState(sw);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await openFixture(page, fixtureURL, 's1');
  const popup = await startViaPopup(page, openPopup);
  // Play into a line ("우리 팀 또 조합이.. 뽀삐한테 좀 취약하긴 한데!", 2.93-5.67 s) and pause on it once its English is up.
  await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime >= 4.2, null, { timeout: 60_000 });
  await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
  const overlay = page.locator('.ast-subtitle-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).not.toHaveText(/[가-힣]/);
  await page.mouse.move(1279, 1); // no cursor in the picture
  await page.waitForTimeout(600); // fade-in done
  await shot(page, 'subtitles-mode');

  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.reload();
  await expect(popup.locator('#captionBar')).toContainText(/Korean/i, { timeout: 10_000 });
  await shot(popup, 'popup-light');
  await configure({ theme: 'dark' });
  await popup.reload();
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot(popup, 'popup-dark');

  await sw.evaluate(() => chrome.storage.local.set({ debugPanel: true }));
  await page.bringToFront();
  await page.waitForTimeout(2500); // the panel appears and fills in
  await shot(page, 'debug-panel');
  await sw.evaluate(() => chrome.storage.local.set({ debugPanel: false }));
});

test('the setup page', async ({ context, extensionId, configure }) => {
  await configure({ theme: 'light', speechModel: 'turbo', subtitleLanguage: 'ko', targetLanguage: 'en' });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`chrome-extension://${extensionId}/welcome.html`);
  await expect(page.locator('#gpuStatus')).not.toHaveText('Checking your graphics card…');
  await shot(page, 'setup-page');
});
