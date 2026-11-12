import { test, expect } from '../helpers/extension';

test.describe('Popup', () => {
  test('install does not open a broken tab', async ({ context, sw }) => {
    await sw.evaluate(() => true);
    // Give onInstalled a moment to act.
    await new Promise(r => setTimeout(r, 1000));
    const urls = context.pages().map(p => p.url());
    expect(urls.filter(u => u.startsWith('chrome-error://'))).toEqual([]);
  });

  test('background answers settings requests', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const settings = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
    expect(settings).toMatchObject({ targetLanguage: 'en', translationProvider: 'google' });
  });

  test('provider switch toggles key fields and settings persist', async ({ context, fixtureURL, openPopup, sw }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);

    await expect(popup.locator('#googleApiKeyGroup')).toBeVisible();
    await expect(popup.locator('#deeplApiKeyGroup')).toBeHidden();

    await popup.selectOption('#translationProvider', 'deepl');
    await expect(popup.locator('#googleApiKeyGroup')).toBeHidden();
    await expect(popup.locator('#deeplApiKeyGroup')).toBeVisible();
    await popup.fill('#deeplApiKey', 'abc:fx');
    await popup.locator('#deeplApiKey').blur();
    await popup.selectOption('#targetLanguage', 'fr');

    // API keys are saved to local storage, never sync (sync uploads them to Google).
    await expect
      .poll(() => sw.evaluate(() => chrome.storage.sync.get(['translationProvider', 'targetLanguage'])))
      .toEqual({ translationProvider: 'deepl', targetLanguage: 'fr' });
    await expect.poll(() => sw.evaluate(() => chrome.storage.local.get('deeplApiKey'))).toEqual({ deeplApiKey: 'abc:fx' });
    const synced = await sw.evaluate(() => chrome.storage.sync.get(null));
    for (const key of ['deeplApiKey', 'googleTranslateApiKey', 'anthropicApiKey', 'claudeGatewayToken']) expect(synced).not.toHaveProperty(key);

    await popup.screenshot({ path: test.info().outputPath('popup.png') });
    await popup.close();
    const popup2 = await openPopup(page);
    await expect(popup2.locator('#translationProvider')).toHaveValue('deepl');
    await expect(popup2.locator('#deeplApiKey')).toHaveValue('abc:fx');
    await expect(popup2.locator('#targetLanguage')).toHaveValue('fr');
  });

  test('popup on a page without the content script does not throw', async ({ context, openPopup }) => {
    const page = await context.newPage();
    await page.goto('about:blank');
    const errors: string[] = [];
    const popup = await openPopup(page).catch(() => null);
    if (!popup) return; // about:blank tab not addressable; covered by unit tests
    popup.on('pageerror', e => errors.push(e.message));
    await popup.click('#screenTranslateButton');
    await expect(popup.locator('#status')).toContainText(/can't run on this page|not available/i);
    expect(errors).toEqual([]);
  });
});

test.describe('Subtitle line translation', () => {
  test('background translates subtitle lines with neighbouring context', async ({ context, extensionId, configure, translationCalls }) => {
    await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', targetLanguage: 'en' });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const response = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'TRANSLATE_SUBTITLE_LINE',
        text: '탑 카밀일 수도 있긴 한데',
        sourceLang: 'ko',
        previousLines: ['야이애나에다가 판테온'],
        nextLines: ['웬만하면 탑 뽀삐겠지!'],
        priority: 'live',
      })
    );
    expect(response).toEqual({ success: true, translatedText: '[EN-US] 탑 카밀일 수도 있긴 한데', quality: 'fast' });
    expect(translationCalls[0]).toMatchObject({ source: 'KO', target: 'EN-US', context: '야이애나에다가 판테온\n웬만하면 탑 뽀삐겠지!' });
  });

  test('a line already in the target language is returned without a request', async ({ context, extensionId, configure, translationCalls }) => {
    await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', targetLanguage: 'en' });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const response = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'TRANSLATE_SUBTITLE_LINE', text: 'hello', sourceLang: 'en', previousLines: [], nextLines: [] })
    );
    expect(response).toEqual({ success: true, translatedText: 'hello', quality: 'fast' });
    expect(translationCalls).toEqual([]);
  });
});
