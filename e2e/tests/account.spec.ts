import { test, expect } from '../helpers/extension';

// Accounts and subscription against the real server code (server/) running
// locally: login code from its dev outbox, fake Stripe, mock upstreams.

test.describe('Account and subscription', () => {
  test('sign in with the emailed code, see the plan and usage, sign out', async ({ context, fixtureURL, openPopup, localProxy, sw }) => {
    localProxy.setPlan('fan@example.com', 'standard');
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.click('#openSettings'); // account lives in the settings view
    await expect(popup.locator('#signedOutView')).toBeVisible();
    await popup.fill('#accountEmail', 'fan@example.com');
    await popup.click('#accountSendCode');
    await expect(popup.locator('#accountCodeRow')).toBeVisible();
    await popup.fill('#accountCode', localProxy.lastCode('fan@example.com'));
    await popup.click('#accountSignIn');
    await expect(popup.locator('#signedInView')).toBeVisible();
    await expect(popup.locator('#accountEmailShown')).toHaveText('fan@example.com');
    await expect(popup.locator('#accountPlan')).toContainText('Standard');
    await expect(popup.locator('#accountUsage')).toContainText('$0.00 of $6.00');
    await expect(popup.locator('#accountManage')).toBeVisible();
    // The token is a secret: local storage only.
    expect(Object.keys(await sw.evaluate(() => chrome.storage.sync.get(null)))).not.toContain('accountToken');
    expect((await sw.evaluate(() => chrome.storage.local.get('accountToken'))).accountToken).toMatch(/^[\w-]{40,}$/);
    await popup.screenshot({ path: test.info().outputPath('account.png'), fullPage: true });

    await popup.close();
    const again = await openPopup(page); // stays signed in
    await again.click('#openSettings');
    await expect(again.locator('#accountEmailShown')).toHaveText('fan@example.com');
    await again.click('#accountSignOut');
    await expect(again.locator('#signedOutView')).toBeVisible();
    expect((await sw.evaluate(() => chrome.storage.local.get('accountToken'))).accountToken ?? '').toBe('');
  });

  test('a free account sees Subscribe, and translation through the subscription says why it is refused', async ({ context, extensionId, openPopup, localProxy, configure, fixtureURL }) => {
    await configure({ translationProvider: 'subscription', claudeAccess: 'subscription', targetLanguage: 'en' });
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.click('#openSettings'); // account lives in the settings view
    await popup.fill('#accountEmail', 'free@example.com');
    await popup.click('#accountSendCode');
    await expect(popup.locator('#accountCodeRow')).toBeVisible();
    await popup.fill('#accountCode', localProxy.lastCode('free@example.com'));
    await popup.click('#accountSignIn');
    await expect(popup.locator('#accountPlan')).toContainText('Free');
    await expect(popup.locator('#accountSubscribeStandard')).toBeVisible();
    await expect(popup.locator('#accountSubscribePro')).toBeVisible();
    await expect(popup.locator('#accountStatus')).toContainText(/Subscribe/i);

    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup.html`);
    const video = { videoId: 'v', url: 'https://www.youtube.com/watch?v=v', title: 't', channel: 'c', description: 'd' };
    const r = await ext.evaluate(
      video => chrome.runtime.sendMessage({ type: 'TRANSLATE_SUBTITLE_LINE', tier: 'fast', text: '안녕', sourceLang: 'ko', previousLines: [], nextLines: [], priority: 'live', video }),
      video
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Subscribe/i);
  });

  test('Subscribe opens Stripe Checkout in a new tab', async ({ context, fixtureURL, openPopup, localProxy }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.click('#openSettings'); // account lives in the settings view
    await popup.fill('#accountEmail', 'buyer@example.com');
    await popup.click('#accountSendCode');
    await expect(popup.locator('#accountCodeRow')).toBeVisible();
    await popup.fill('#accountCode', localProxy.lastCode('buyer@example.com'));
    await popup.click('#accountSignIn');
    const opened = context.waitForEvent('page');
    await popup.click('#accountSubscribePro');
    const checkout = await opened;
    await expect(checkout).toHaveURL(/fake-stripe-checkout\.html$/);
  });
});
