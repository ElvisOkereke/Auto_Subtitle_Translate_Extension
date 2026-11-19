import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { CACHE } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { fakeTranslator } from '../helpers/builtin';

// Preparing for real from the setup page: the speech model this computer will
// use (loaded and run once) and the subtitle reader, recorded as ready, so the
// popup stops suggesting setup. Persistent profile: the models stay cached.
test.use({ profileDir: path.join(CACHE, `profile-captions-${browserKind()}`), keepWelcome: true });

test('the setup page prepares speech recognition and the subtitle reader ahead of use', async ({ context, extensionId, sw, configure, fixtureURL, openPopup }) => {
  test.setTimeout(900_000);
  await configure({ speechModel: 'turbo', subtitleLanguage: 'ko' });
  await sw.evaluate(() => chrome.storage.local.remove('setupState'));
  const page = await context.newPage();
  await fakeTranslator(page, 'available'); // this test is about the models; the free translator: free-tier specs
  await page.goto(`chrome-extension://${extensionId}/welcome.html`);
  await expect(page.locator('#prepare')).toBeEnabled();
  await page.click('#prepare');
  await expect(page.locator('#keepOpen')).toBeVisible();
  await expect(page.locator('#ocrState')).toHaveText('Ready', { timeout: 300_000 });
  await expect(page.locator('#speechState')).toHaveText('Ready', { timeout: 840_000 });
  await expect(page.locator('#allSet')).toBeVisible();
  await expect(page.locator('#keepOpen')).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('welcome-prepared.png'), fullPage: true });
  console.log('speech:', await page.locator('#speechNote').textContent());

  const state = await sw.evaluate(async () => (await chrome.storage.local.get('setupState')).setupState);
  expect(Object.keys(state.speech).length).toBeGreaterThan(0);
  expect(Object.keys(state.ocr).length).toBe(1);

  const video = await context.newPage();
  await video.goto(`${fixtureURL}/screen-translate.html`);
  const popup = await openPopup(video);
  await expect(popup.locator('#speechSetupNote')).toBeHidden();
  await popup.click('#modeSubtitles');
  await expect(popup.locator('#ocrSetupNote')).toBeHidden();
  await popup.click('#modeAudio'); // the popup remembers its mode: leave this profile in Audio mode for the captions tests
  await expect(popup.locator('#toggleButton')).toBeVisible();
});
