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

  test('engine and Claude settings persist (secrets to local, the rest to sync)', async ({ context, fixtureURL, openPopup, sw }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.selectOption('#engineMode', 'best');
    await popup.selectOption('#claudeModel', 'claude-sonnet-5-5');
    await popup.selectOption('#claudeAccess', 'gateway');
    await popup.fill('#claudeGatewayUrl', 'http://gateway.example.com');
    await popup.locator('#claudeGatewayUrl').blur();
    await expect(popup.locator('#claudeStatus')).toContainText('https://');
    await popup.fill('#claudeGatewayUrl', 'https://gateway.example.com/anthropic/');
    await popup.locator('#claudeGatewayUrl').blur();
    await popup.fill('#claudeGatewayToken', 'tok-123');
    await popup.locator('#claudeGatewayToken').blur();
    await expect(popup.locator('#claudeStatus')).toBeHidden();
    await expect
      .poll(() => sw.evaluate(() => chrome.storage.sync.get(['translationEngineMode', 'claudeModel', 'claudeAccess', 'claudeGatewayUrl'])))
      .toEqual({ translationEngineMode: 'best', claudeModel: 'claude-sonnet-5-5', claudeAccess: 'gateway', claudeGatewayUrl: 'https://gateway.example.com/anthropic' });
    await expect.poll(() => sw.evaluate(() => chrome.storage.local.get('claudeGatewayToken'))).toEqual({ claudeGatewayToken: 'tok-123' });
    expect(await sw.evaluate(() => chrome.storage.sync.get('claudeGatewayToken'))).toEqual({});
    await popup.screenshot({ path: test.info().outputPath('popup-engine.png'), fullPage: true });
    await popup.close();
    const again = await openPopup(page);
    await expect(again.locator('#claudeModel')).toHaveValue('claude-sonnet-5-5');
    await expect(again.locator('#claudeGatewayToken')).toHaveValue('tok-123');
    await expect(again.locator('#claudeGatewayGroup')).toBeVisible();
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
    expect(response).toEqual({ success: true, translatedText: '[EN-US] 탑 카밀일 수도 있긴 한데', quality: 'fast', engine: 'deepl' });
    expect(translationCalls[0]).toMatchObject({ source: 'KO', target: 'EN-US', context: '야이애나에다가 판테온\n웬만하면 탑 뽀삐겠지!' });
  });

  test('best tier translates with Claude (topic first, then the line) and falls back to DeepL when Claude fails', async ({ context, extensionId, configure, translationCalls, server }) => {
    await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', anthropicApiKey: 'sk-test', targetLanguage: 'en' });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_TRANSLATION_PLAN' }))).toEqual({ fast: true, best: true });
    const video = { videoId: 'vid1', url: 'https://www.youtube.com/watch?v=vid1', title: '뽀삐 장인 솔랭', channel: 'ch', description: 'League of Legends' };
    const send = (text: string) =>
      page.evaluate(
        ([text, video]) => chrome.runtime.sendMessage({ type: 'TRANSLATE_SUBTITLE_LINE', tier: 'best', text, sourceLang: 'ko', previousLines: [], nextLines: [], priority: 'live', video }),
        [text, video] as const
      );
    expect(await send('뽀삐 나왔네')).toEqual({ success: true, translatedText: '[CLAUDE] 뽀삐 나왔네', quality: 'better', engine: 'claude' });
    const claude = translationCalls.filter(c => c.provider === 'anthropic');
    expect(claude.map(c => c.kind)).toEqual(['topic', 'translate']);
    expect(claude[0].xApiKey).toBe('sk-test');
    expect(claude[1].system).toContain('뽀삐 장인 솔랭'); // video context
    expect(claude[1].system).toContain('렙차 → level gap'); // glossary from the topic step

    await send('렙차 난다');
    expect(translationCalls.filter(c => c.provider === 'anthropic').at(-1)!.system).toContain('뽀삐 → Poppy'); // learned from the reply

    server.setAnthropicFailure(429);
    expect(await send('또 뽀삐')).toMatchObject({ success: true, translatedText: '[EN-US] 또 뽀삐', quality: 'fast', engine: 'deepl' });
  });

  test('gateway mode sends the token with the chosen auth style to the gateway', async ({ context, extensionId, configure, translationCalls, server }) => {
    await configure({
      translationProvider: 'deepl',
      deeplApiKey: 'k:fx',
      targetLanguage: 'en',
      claudeAccess: 'gateway',
      claudeGatewayUrl: `${server.url}/mock/anthropic`,
      claudeGatewayToken: 'gw-token',
      claudeGatewayAuth: 'bearer',
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const video = { videoId: 'v2', url: 'https://www.youtube.com/watch?v=v2', title: 't', channel: 'c', description: 'd' };
    const r = await page.evaluate(
      video => chrome.runtime.sendMessage({ type: 'TRANSLATE_SUBTITLE_LINE', tier: 'best', text: '안녕', sourceLang: 'ko', previousLines: [], nextLines: [], priority: 'live', video }),
      video
    );
    expect(r).toMatchObject({ translatedText: '[CLAUDE] 안녕', engine: 'claude' });
    const call = translationCalls.find(c => c.provider === 'anthropic')!;
    expect(call.authorization).toBe('Bearer gw-token');
    expect(call.xApiKey).toBeUndefined();
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
