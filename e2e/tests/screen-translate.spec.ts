import { test, expect } from '../helpers/extension';
import type { Page } from '@playwright/test';

async function dragOver(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 5 });
  await page.mouse.up();
}

const overlay = (page: Page) => page.locator('[id^="translation-"][data-rtt-owned]');

test.describe('Screen Translate', () => {
  test.beforeEach(async ({ configure }) => {
    await configure({ translationProvider: 'deepl', deeplApiKey: 'test-key:fx', targetLanguage: 'en' });
  });

  test('drag a box over text shows a translated overlay', async ({ context, fixtureURL, openPopup, translationCalls }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);

    const popup = await openPopup(page);
    await popup.click('#screenTranslateButton');
    await expect(popup.locator('#screenTranslateButton')).toHaveText('Stop Translation');
    await expect(popup.locator('#screenTranslateStatus')).toHaveText('Drag a box around text to translate.');

    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
    await dragOver(page, '#target');

    await expect(overlay(page)).toHaveCount(1);
    await expect(overlay(page).locator('[data-role="translated-text"]')).toHaveText('[EN-US] Bonjour le monde');
    expect(translationCalls).toEqual([
      { provider: 'deepl', text: 'Bonjour le monde', target: 'EN-US', source: undefined, authorization: 'DeepL-Auth-Key test-key:fx' },
    ]);
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('');
    await page.screenshot({ path: test.info().outputPath('overlay.png') });

    // A freshly opened popup reflects the content script's real state.
    await popup.close();
    const popup2 = await openPopup(page);
    await expect(popup2.locator('#screenTranslateButton')).toHaveText('Stop Translation');
    await expect(popup2.locator('#drawNewBoxButton')).toBeVisible();

    // Draw New Box re-arms selection; a second drag translates again.
    await popup2.click('#drawNewBoxButton');
    await expect(popup2.locator('#drawNewBoxButton')).toBeHidden();
    await page.bringToFront();
    await dragOver(page, '#video-caption');
    await expect(overlay(page).locator('[data-role="translated-text"]')).toHaveText('[EN-US] Premier sous-titre');
  });

  test('drawing over a video does not trigger the page click handler', async ({ context, fixtureURL, openPopup }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.click('#screenTranslateButton');
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');

    await dragOver(page, '#video-box');
    await expect(overlay(page)).toHaveCount(1);
    await expect(page.locator('#click-count')).toHaveText('0');
  });

  test('refresh re-reads the text at the same spot', async ({ context, fixtureURL, openPopup }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.click('#screenTranslateButton');
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
    await dragOver(page, '#video-caption');
    const translated = overlay(page).locator('[data-role="translated-text"]');
    await expect(translated).toHaveText('[EN-US] Premier sous-titre');

    await page.evaluate(() => (document.getElementById('video-caption')!.textContent = 'Deuxieme sous-titre'));
    await overlay(page).locator('button[title="Refresh"]').click();
    await expect(translated).toHaveText('[EN-US] Deuxieme sous-titre');
    await expect(overlay(page)).toHaveCount(1);

    await overlay(page).locator('button[id^="close-"]').click();
    await expect(overlay(page)).toHaveCount(0);
  });

  test('Escape turns Screen Translate off and the popup reflects it', async ({ context, fixtureURL, openPopup }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.click('#screenTranslateButton');
    await popup.close();
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('');

    const popup2 = await openPopup(page);
    await expect(popup2.locator('#screenTranslateButton')).toHaveText('Screen Translate');
    await expect(popup2.locator('#screenTranslateStatus')).toBeHidden();
  });

  test('missing API key shows a readable error on the page', async ({ context, fixtureURL, openPopup, configure }) => {
    await configure({ deeplApiKey: '' });
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await popup.click('#screenTranslateButton');
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
    const started = Date.now();
    await dragOver(page, '#target');
    await expect(page.getByText(/No DeepL API key/)).toBeVisible();
    // Auth errors must not be retried with backoff.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
