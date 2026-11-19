import { test, expect } from '../helpers/extension';

// First-run setup: the page the extension opens on install, and the popup's
// "needs a one-time setup" notes. Preparing for real (downloads, warm-up) runs
// in captions-setup.spec.ts (persistent profile with the models cached).

// These tests open the setup page themselves: keep every welcome tab (the harness closes the install one otherwise).
test.use({ keepWelcome: true });

const KOREAN_READER = 'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/5c6f574b8e2230adf4287b33e736d71b9fabd28e/inference.onnx';

test.describe('installing', () => {
  test('opens the setup page once, and it downloads nothing before the click', async ({ context, sw }) => {
    await sw.evaluate(() => true);
    await expect.poll(() => context.pages().filter(p => p.url().endsWith('/welcome.html')).length, { timeout: 15_000 }).toBe(1);
    const page = context.pages().find(p => p.url().endsWith('/welcome.html'))!;
    await expect(page.locator('h1')).toHaveText("Let's get this computer ready");
    await expect(page.locator('#speechState')).toHaveText('Not prepared');
    await expect(page.locator('#ocrState')).toHaveText('Not prepared');
    const prepared = await sw.evaluate(async () => (await chrome.storage.local.get('setupState')).setupState ?? null);
    expect(prepared).toBeNull();
  });
});

test.describe('setup page', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`languages are saved, the graphics card is checked, and sizes are shown (${theme})`, async ({ context, extensionId, sw, configure }) => {
      await configure({ theme, speechModel: 'turbo', subtitleLanguage: 'ko' });
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/welcome.html`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('#gpuStatus')).not.toHaveText('Checking your graphics card…');

      await page.selectOption('#subtitleLanguage', 'ja');
      await page.selectOption('#targetLanguage', 'de');
      await expect
        .poll(() => sw.evaluate(() => chrome.storage.sync.get(['subtitleLanguage', 'targetLanguage'])))
        .toEqual({ subtitleLanguage: 'ja', targetLanguage: 'de' });

      // Playwright's Chromium on Windows has no usable WebGPU: the CPU model, and how to turn acceleration on.
      const gpu = await page.evaluate(async () => {
        try {
          const adapter = await (navigator as any).gpu?.requestAdapter();
          if (!adapter) return false;
          (await adapter.requestDevice()).destroy();
          return true;
        } catch {
          return false;
        }
      });
      if (!gpu) {
        await expect(page.locator('#gpuHelp')).toBeVisible();
        await expect(page.locator('#speechChoice')).toBeHidden();
        await expect(page.locator('#prepare')).toHaveText('Download and prepare (80 MB + 20 MB)');
      } else {
        await expect(page.locator('#speechChoice')).toBeVisible();
      }
      await page.screenshot({ path: test.info().outputPath(`welcome-${theme}.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0); // no sideways scrolling at phone width
      await page.screenshot({ path: test.info().outputPath(`welcome-${theme}-narrow.png`), fullPage: true });
    });
  }

  test('what is already prepared shows as ready, and the button says so', async ({ context, extensionId, sw, configure }) => {
    await configure({ speechModel: 'turbo', subtitleLanguage: 'ko' });
    await sw.evaluate(
      reader =>
        chrome.storage.local.set({
          setupState: {
            speech: { 'onnx-community/whisper-base|wasm': { at: 1 }, 'onnx-community/whisper-large-v3-turbo|webgpu': { at: 1 }, 'onnx-community/whisper-small|webgpu': { at: 1 } },
            ocr: { [reader]: { at: 1 } },
          },
        }),
      KOREAN_READER
    );
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/welcome.html`);
    await expect(page.locator('#speechState')).toHaveText('Ready');
    await expect(page.locator('#ocrState')).toHaveText('Ready');
    await expect(page.locator('#prepare')).toBeDisabled();
    await expect(page.locator('#allSet')).toBeVisible();
    // Another subtitle language needs its own reader.
    await page.selectOption('#subtitleLanguage', 'ru');
    await expect(page.locator('#ocrState')).toHaveText('Not prepared');
    await expect(page.locator('#prepare')).toHaveText('Download and prepare (20 MB)');
  });
});

test.describe('popup', () => {
  test('says when a mode still needs its one-time setup, and opens the setup page', async ({ context, fixtureURL, openPopup, sw, configure }) => {
    await configure({ speechModel: 'turbo', subtitleLanguage: 'ko' });
    await sw.evaluate(() => chrome.storage.local.remove('setupState'));
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/screen-translate.html`);
    const popup = await openPopup(page);
    await expect(popup.locator('#speechSetupNote')).toBeVisible();
    await expect(popup.locator('#speechSetupText')).toContainText('one-time setup');
    await popup.click('#modeSubtitles');
    await expect(popup.locator('#ocrSetupNote')).toBeVisible();
    await popup.screenshot({ path: test.info().outputPath('popup-setup-note.png') });

    const opened = context.waitForEvent('page', p => p.url().endsWith('/welcome.html'));
    await popup.click('#ocrSetupButton');
    expect((await opened).url()).toContain('/welcome.html');

    // Prepared (by the setup page or by a first use): the notes go away.
    await sw.evaluate(
      reader =>
        chrome.storage.local.set({
          setupState: {
            speech: { 'onnx-community/whisper-base|wasm': { at: 1 }, 'onnx-community/whisper-large-v3-turbo|webgpu': { at: 1 }, 'onnx-community/whisper-small|webgpu': { at: 1 } },
            ocr: { [reader]: { at: 1 } },
          },
        }),
      KOREAN_READER
    );
    await expect(popup.locator('#ocrSetupNote')).toBeHidden();
    await popup.click('#modeAudio');
    await expect(popup.locator('#speechSetupNote')).toBeHidden();
  });
});
