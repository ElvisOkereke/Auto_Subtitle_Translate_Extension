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
    await expect(popup.locator('#screenTranslateButton')).toHaveText('Stop translating');
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
    await expect(popup2.locator('#screenTranslateButton')).toHaveText('Stop translating');
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
    await overlay(page).locator('button[title="Translate again"]').click();
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

  for (const theme of ['light', 'dark'] as const) {
    test(`the translation panel follows the ${theme} theme`, async ({ context, fixtureURL, openPopup, configure }) => {
      await configure({ theme });
      const page = await context.newPage();
      await page.goto(`${fixtureURL}/screen-translate.html`);
      const popup = await openPopup(page);
      await popup.click('#screenTranslateButton');
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
      await dragOver(page, '#target');
      const panel = overlay(page);
      await expect(panel.locator('[data-role="translated-text"]')).toContainText('[EN-US]');
      await expect(panel).toHaveAttribute('data-ast-theme', theme);
      const bg = await panel.evaluate(el => getComputedStyle(el).backgroundColor);
      expect(bg).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 36, 45)');
      // Translation first, original underneath.
      const order = await panel.evaluate(el => [...el.querySelectorAll('[data-role]')].map(n => (n as HTMLElement).dataset.role));
      expect(order).toEqual(['translated-text', 'original-text']);
      const box = (await panel.boundingBox())!;
      await page.screenshot({ path: test.info().outputPath(`screen-translate-${theme}.png`), clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 90), width: 420, height: box.height + 130 } });
    });
  }

  test('page styles cannot restyle the translation panel', async ({ context, fixtureURL, openPopup, configure }) => {
    await configure({ theme: 'light' });
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    // A site whose own rules hit every p/div/button (e.g. a dark site styling text near-white).
    await page.addStyleTag({ content: 'p, div, span, button { color: rgb(250, 250, 250); text-transform: uppercase; letter-spacing: 6px; box-shadow: 0 0 0 4px red; }' });
    const popup = await openPopup(page);
    await popup.click('#screenTranslateButton');
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
    await dragOver(page, '#target');
    const translated = overlay(page).locator('[data-role="translated-text"]');
    await expect(translated).toContainText('[EN-US]');
    const style = await translated.evaluate(el => {
      const cs = getComputedStyle(el);
      return { color: cs.color, transform: cs.textTransform, spacing: cs.letterSpacing };
    });
    expect(style).toEqual({ color: 'rgb(23, 26, 33)', transform: 'none', spacing: 'normal' });
    const closeShadow = await overlay(page).locator('button[id^="close-"]').evaluate(el => getComputedStyle(el).boxShadow);
    expect(closeShadow).toBe('none');
  });

  test('a selection near the bottom of the window keeps the whole panel on screen', async ({ context, fixtureURL, openPopup }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const target = (await page.locator('#target').boundingBox())!;
    const height = Math.ceil(target.y + target.height + 30);
    await page.setViewportSize({ width: 900, height });
    const popup = await openPopup(page);
    await popup.click('#screenTranslateButton');
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
    await dragOver(page, '#target');
    await expect(overlay(page).locator('[data-role="original-text"]')).toBeVisible();
    const box = (await overlay(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  });
});

