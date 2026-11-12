import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { CACHE } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { clearTranslationState, openFixture, playUntil, shownRecords, startViaPopup } from '../helpers/subtitles';

// Subtitle mode with both tiers on the local fixture: mock DeepL ("[EN-US] …")
// first, then mock Claude ("[CLAUDE] …", 400 ms slower). Read-ahead off here;
// subtitle-readahead.spec.ts covers Claude with read-ahead.
test.use({ profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ configure, sw }) => {
  await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', anthropicApiKey: 'sk-test', targetLanguage: 'en', subtitleLanguage: 'ko', translationEngineMode: 'fast-then-best' });
  await sw.evaluate(() => chrome.storage.local.set({ devSubtitle: { readAhead: false } }));
  await clearTranslationState(sw);
});

test('overlay shows DeepL first, then the Claude version', async ({ context, fixtureURL, openPopup }) => {
  test.setTimeout(180_000);
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 13);
  const shown = await shownRecords(page);
  const byLine = new Map<number, string[]>();
  for (const s of shown) byLine.set(s.lineStart, [...(byLine.get(s.lineStart) ?? []), s.text]);
  const lines = [...byLine.values()];
  const swapped = lines.filter(texts => texts[0].startsWith('[EN-US]') && texts.at(-1)!.startsWith('[CLAUDE]'));
  const endedOnClaude = lines.filter(texts => texts.at(-1)!.startsWith('[CLAUDE]'));
  console.log(JSON.stringify([...byLine.entries()], null, 1));
  expect(swapped.length).toBeGreaterThanOrEqual(3);
  expect(endedOnClaude.length / lines.length).toBeGreaterThanOrEqual(0.8);
  // Swaps go one way only: never back from Claude to DeepL.
  for (const texts of lines) {
    const firstClaude = texts.findIndex(t => t.startsWith('[CLAUDE]'));
    if (firstClaude >= 0) expect(texts.slice(firstClaude).every(t => t.startsWith('[CLAUDE]'))).toBe(true);
  }
});

test('Claude requests carry the page title and the learned glossary', async ({ context, fixtureURL, openPopup, translationCalls }) => {
  test.setTimeout(180_000);
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 11);
  const claude = translationCalls.filter(c => c.provider === 'anthropic');
  expect(claude[0].kind).toBe('topic');
  const translate = claude.filter(c => c.kind === 'translate');
  expect(translate.length).toBeGreaterThanOrEqual(3);
  expect(translate[0].system).toContain('롤 솔랭 하이라이트'); // page title
  expect(translate[0].system).toContain('League of Legends Korean solo queue'); // page description
  // After the line with 뽀삐 (2.9 s), later requests carry the learned entry.
  const poppyAt = translate.findIndex(c => c.text.includes('뽀삐'));
  expect(poppyAt).toBeGreaterThanOrEqual(0);
  expect(translate.slice(poppyAt + 1).some(c => c.system!.includes('뽀삐 → Poppy'))).toBe(true);
});

test('Claude failing (429) keeps DeepL translations on screen', async ({ context, fixtureURL, openPopup, server }) => {
  test.setTimeout(180_000);
  server.setAnthropicFailure(429);
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 9);
  const shown = await shownRecords(page);
  expect(shown.length).toBeGreaterThanOrEqual(3);
  expect(shown.every(s => s.text.startsWith('[EN-US]'))).toBe(true);
});

test('the glossary editor lists learned terms, and a correction re-translates the line on screen', async ({ context, fixtureURL, openPopup, translationCalls }) => {
  test.setTimeout(180_000);
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  const popup = await startViaPopup(page, openPopup);
  await playUntil(page, 4); // line 2 (2.9-5.7 s) mentions 뽀삐; Claude learns "Poppy"
  await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
  await expect.poll(() => translationCalls.filter(c => c.provider === 'anthropic' && c.text.includes('뽀삐')).length).toBeGreaterThan(0);
  await popup.close();
  const editor = await openPopup(page);
  await editor.locator('#glossarySection summary').click();
  const row = editor.locator('.glossary-row[data-source="뽀삐"]');
  await expect(row.locator('input')).toHaveValue('Poppy');
  await expect(editor.locator('#glossaryTopic')).toContainText('League of Legends');
  await editor.screenshot({ path: test.info().outputPath('glossary.png'), fullPage: true });
  const before = translationCalls.length;
  await row.locator('input').fill('Poppy (champion)');
  await row.locator('input').blur();
  await expect
    .poll(() => translationCalls.slice(before).filter(c => c.provider === 'anthropic' && c.kind === 'translate' && c.system!.includes('뽀삐 → Poppy (champion)')).length)
    .toBeGreaterThan(0);
  await expect(editor.locator('.glossary-row[data-source="뽀삐"] input')).toHaveValue('Poppy (champion)');
});


test('a subscriber gets Claude subtitles through the hosted proxy with no API keys in the extension', async ({ context, fixtureURL, openPopup, proxy, sw, configure }) => {
  test.setTimeout(180_000);
  // No DeepL/Anthropic keys: subscription for both tiers.
  await configure({ translationProvider: 'subscription', claudeAccess: 'subscription', targetLanguage: 'en', subtitleLanguage: 'ko', translationEngineMode: 'fast-then-best', claudeModel: 'claude-sonnet-5-5' });
  await sw.evaluate(() => chrome.storage.local.remove(['deeplApiKey', 'googleTranslateApiKey', 'anthropicApiKey', 'claudeGatewayToken']));
  proxy.setPlan('sub@example.com', 'standard');
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  const login = await openPopup(page);
  await login.fill('#accountEmail', 'sub@example.com');
  await login.click('#accountSendCode');
  await expect(login.locator('#accountCodeRow')).toBeVisible();
  await login.fill('#accountCode', proxy.lastCode('sub@example.com'));
  await login.click('#accountSignIn');
  await expect(login.locator('#signedInView')).toBeVisible();
  await login.close();
  await startViaPopup(page, openPopup);
  await playUntil(page, 9);
  const shown = await shownRecords(page);
  expect(shown.some(s => s.text.startsWith('[CLAUDE]'))).toBe(true);
  const local = await sw.evaluate(() => chrome.storage.local.get(null));
  for (const key of ['deeplApiKey', 'anthropicApiKey', 'claudeGatewayToken', 'googleTranslateApiKey']) expect(local[key] ?? '').toBe('');
  expect(proxy.usageUsd('sub@example.com')).toBeGreaterThan(0);
});
