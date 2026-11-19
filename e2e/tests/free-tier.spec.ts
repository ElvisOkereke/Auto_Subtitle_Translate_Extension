import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { fakeTranslator, PREPARED_MODELS } from '../helpers/builtin';

// The free tier: Chrome's built-in translator, with no key. Playwright's Chromium
// has the API but its language packs aren't relied on here: the translation path
// runs with the dev stub (devBuiltinTranslator), the setup page with a fake
// Translator. Real translations: free-tier-chrome.spec.ts (installed Chrome).
test.use({ keepWelcome: true });

async function dragOver(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 8 });
  await page.mouse.up();
}

test('with no key, Screen Translate translates with the built-in translator (no translation service is called)', async ({ context, fixtureURL, openPopup, sw, configure, translationCalls }) => {
  await configure({ targetLanguage: 'en', translationProvider: 'builtin' });
  await sw.evaluate(() => chrome.storage.local.set({ devBuiltinTranslator: 'stub' }));
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/screen-translate.html`);
  const popup = await openPopup(page);
  await popup.click('#screenTranslateButton');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  await dragOver(page, '#target');
  await expect(page.locator('[id^="translation-"][data-rtt-owned] [data-role="translated-text"]')).toHaveText('[built-in] Bonjour le monde');
  expect(translationCalls).toEqual([]);
  await sw.evaluate(() => chrome.storage.local.remove('devBuiltinTranslator'));
});

test('with a provider chosen but no key, the built-in translator still translates', async ({ context, fixtureURL, openPopup, sw, configure, translationCalls }) => {
  await configure({ targetLanguage: 'en', translationProvider: 'google' }); // no Google key
  await sw.evaluate(() => chrome.storage.local.set({ devBuiltinTranslator: 'stub' }));
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/screen-translate.html`);
  const popup = await openPopup(page);
  await popup.click('#screenTranslateButton');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  await dragOver(page, '#target');
  await expect(page.locator('[id^="translation-"][data-rtt-owned] [data-role="translated-text"]')).toHaveText('[built-in] Bonjour le monde');
  expect(translationCalls).toEqual([]);
  await sw.evaluate(() => chrome.storage.local.remove('devBuiltinTranslator'));
});

test('the popup names the free translator as the engine when there is no key', async ({ context, fixtureURL, openPopup, configure }) => {
  await configure({ targetLanguage: 'en', translationProvider: 'builtin' });
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/screen-translate.html`);
  const popup = await openPopup(page);
  await expect(popup.locator('#engineSummaryValue')).toHaveText('Built-in translator (free)');
  await popup.click('#openSettings');
  await expect(popup.locator('#translationProvider')).toHaveValue('builtin');
  await expect(popup.locator('#googleApiKeyGroup')).toBeHidden();
  await expect(popup.locator('#deeplApiKeyGroup')).toBeHidden();
});

test.describe('setup page: free translation', () => {
  test('downloads the language packs at the click and shows them ready', async ({ context, extensionId, sw, configure }) => {
    await configure({ subtitleLanguage: 'ko', sourceLanguage: 'auto', targetLanguage: 'en', speechModel: 'turbo' });
    await sw.evaluate(m => chrome.storage.local.set({ setupState: m }), PREPARED_MODELS);
    const page = await context.newPage();
    await fakeTranslator(page, 'downloadable');
    await page.goto(`chrome-extension://${extensionId}/welcome.html`);
    await expect(page.locator('#translatorState')).toHaveText('Not prepared');
    await expect(page.locator('#prepare')).toHaveText('Download and prepare (language packs)');
    await page.click('#prepare');
    await expect(page.locator('#translatorState')).toHaveText('Ready');
    // Korean subtitles into English, and the detector for "Detect automatically".
    expect((await page.evaluate(() => (window as any).__createdPairs)).sort()).toEqual(['detector', 'ko>en']);
    await expect(page.locator('#allSet')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('setup-translator-ready.png'), fullPage: true });
  });

  test('a browser without language packs (Opera GX, Edge, Brave) is told to use a key; setup is still complete', async ({ context, extensionId, sw, configure }) => {
    await configure({ subtitleLanguage: 'ko', sourceLanguage: 'auto', targetLanguage: 'en', speechModel: 'turbo' });
    await sw.evaluate(m => chrome.storage.local.set({ setupState: m }), PREPARED_MODELS);
    const page = await context.newPage();
    await fakeTranslator(page, 'unavailable');
    await page.goto(`chrome-extension://${extensionId}/welcome.html`);
    await expect(page.locator('#translatorState')).toHaveText('Needs Google Chrome');
    await expect(page.locator('#translatorNote')).toContainText('add a DeepL or Google key, or subscribe');
    await expect(page.locator('#prepare')).toBeDisabled();
    await expect(page.locator('#allSet')).toBeVisible();
  });
});

test.describe('popup: free translation not downloaded for the chosen language', () => {
  test('says so, with a button to the setup page; quiet once downloaded', async ({ context, fixtureURL, openPopup, configure }) => {
    await configure({ subtitleLanguage: 'ko', sourceLanguage: 'auto', targetLanguage: 'en', translationProvider: 'builtin' });
    await fakeTranslator(context, 'downloadable');
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await expect(popup.locator('#translatorSetupNote')).toBeVisible();
    const opened = context.waitForEvent('page', p => p.url().endsWith('/welcome.html'));
    await popup.click('#translatorSetupButton');
    expect((await opened).url()).toContain('/welcome.html');
  });

  test('not shown with a translation key (the free translator is not used)', async ({ context, fixtureURL, openPopup, configure }) => {
    await configure({ subtitleLanguage: 'ko', targetLanguage: 'en', translationProvider: 'deepl', deeplApiKey: 'k:fx' });
    await fakeTranslator(context, 'downloadable');
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.waitForTimeout(800);
    await expect(popup.locator('#translatorSetupNote')).toBeHidden();
  });

  test('not shown when the packs are downloaded', async ({ context, fixtureURL, openPopup, configure }) => {
    await configure({ subtitleLanguage: 'ko', targetLanguage: 'en', translationProvider: 'builtin' });
    await fakeTranslator(context, 'available');
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.waitForTimeout(800);
    await expect(popup.locator('#translatorSetupNote')).toBeHidden();
  });
});
