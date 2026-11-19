import { test, expect } from '../helpers/extension';
import { browserKind } from '../helpers/launch';
import { PREPARED_MODELS } from '../helpers/builtin';
import { openFixture, playUntil, shownRecords, startViaPopup } from '../helpers/subtitles';

// The free tier for real, in installed Chrome (the only browser with the
// built-in translator's language packs): a fresh profile, the setup page's click
// downloads the Korean pack, then Subtitles mode translates with no key.
//   E2E_BROWSER=chrome npx playwright test --project=chrome
test.use({ keepWelcome: true, mockTranslation: false });

test('a new user with no key: the setup page downloads the free translator, then subtitles are translated', async ({ context, extensionId, sw, configure, fixtureURL, openPopup, translationCalls }) => {
  test.skip(browserKind() !== 'chrome', 'the built-in translator has language packs only in Google Chrome');
  test.setTimeout(600_000);
  await configure({ subtitleLanguage: 'ko', sourceLanguage: 'ko', targetLanguage: 'en', translationEngineMode: 'fast' });
  // Only the translator is left to prepare (the speech model's 1.6 GB is not this test's business).
  await sw.evaluate(m => chrome.storage.local.set({ setupState: m }), PREPARED_MODELS);

  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/welcome.html`);
  await expect(setup.locator('#translatorState')).toHaveText('Not prepared');
  await setup.click('#prepare');
  await expect(setup.locator('#translatorState')).toHaveText('Ready', { timeout: 300_000 });
  console.log('translator:', await setup.locator('#translatorNote').textContent());
  await setup.close();

  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 12);
  const records = await shownRecords(page);
  console.log(JSON.stringify(records.map(r => r.text)));
  expect(records.length).toBeGreaterThan(2);
  for (const r of records) {
    expect(r.text).not.toMatch(/[가-힣]/); // translated, not the Korean
    expect(r.text).not.toMatch(/^\[/); // not a stub or mock
  }
  expect(translationCalls).toEqual([]);
});
