import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, FIXTURES } from '../helpers/paths';
import { speechEndSeconds } from '../helpers/audio';
import { browserKind } from '../helpers/launch';

// Real pipeline: tab audio -> tabCapture -> offscreen VAD -> Whisper (transformers.js)
// -> mock translation API -> subtitle overlay. The Whisper model is downloaded
// once into a persistent profile and reused across runs, so these run serially.
test.use({ profileDir: path.join(CACHE, `profile-captions-${browserKind()}`) });
test.describe.configure({ mode: 'serial' });

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

const overlay = (page: Page) => page.locator('#subtitle-overlay-extension');
const captionLines = (page: Page) => page.locator('#subtitle-overlay-extension .subtitle-text');

async function startCaptions(page: Page, openPopup: (p: Page) => Promise<Page>) {
  const popup = await openPopup(page);
  await popup.click('#toggleButton');
  await expect(popup.locator('#toggleButton')).toHaveText('Stop Subtitles');
  return popup;
}

/** Waits for the model to be ready (downloads on the very first run). */
async function waitForModel(page: Page) {
  await expect(overlay(page)).toContainText(/Speech model ready/i, { timeout: 540_000 });
}

async function play(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const media = document.getElementById('media') as HTMLAudioElement;
    media.currentTime = 0;
    await media.play();
    return Date.now();
  });
}

async function offscreenOpen(sw: Worker): Promise<boolean> {
  return sw.evaluate(() => chrome.offscreen.hasDocument());
}

async function stopServiceWorker(context: BrowserContext, extensionId: string) {
  // Simulates Chrome killing the idle MV3 worker (in-memory state is lost).
  const page = await context.newPage();
  await page.goto('chrome://serviceworker-internals/?devtools');
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const versions = await new Promise<any[]>(resolve => {
    cdp.on('ServiceWorker.workerVersionUpdated', e => resolve(e.versions));
  });
  const ours = versions.filter(v => v.scriptURL.startsWith(`chrome-extension://${extensionId}/`));
  for (const v of ours) await cdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
  await page.close();
  return ours.length;
}

test.beforeEach(async ({ configure }) => {
  await configure({
    translationProvider: 'deepl',
    deeplApiKey: 'test-key:fx',
    sourceLanguage: 'en',
    targetLanguage: 'fr',
  });
});

test('speech in a tab becomes translated subtitles', async ({ context, fixtureURL, openPopup, translationCalls, sw }) => {
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/captions.html?audio=hello.wav`);
  const popup = await startCaptions(page, openPopup);
  await waitForModel(page);

  const playedAt = await play(page);
  // The clip is two phrases; VAD splits them at the pause into two captions.
  const last = captionLines(page).filter({ hasText: /weather/i });
  await expect(last).toBeVisible({ timeout: 60_000 });

  const shown = (await captionLines(page).allTextContents()).join(' ');
  expect(shown).toMatch(/^\[FR\] /);
  expect(normalize(shown)).toContain('hello world');
  expect(normalize(shown)).toContain('the weather is very nice today');
  expect(translationCalls[0]).toMatchObject({ provider: 'deepl', target: 'FR', source: 'EN' });

  // Latency: from the end of the last phrase in the clip to its caption appearing.
  const timing = JSON.parse((await last.getAttribute('data-timing'))!);
  const speechEnd = playedAt + speechEndSeconds(fs.readFileSync(path.join(FIXTURES, 'audio/hello.wav'))) * 1000;
  const latencyMs = timing.displayedAt - speechEnd;
  console.log(`caption latency after speech end: ${latencyMs}ms`, timing);
  test.info().annotations.push({ type: 'latencyMs', description: String(latencyMs) });
  expect(latencyMs).toBeLessThan(5000);
  await page.screenshot({ path: test.info().outputPath('subtitle.png') });

  await popup.click('#toggleButton');
  await expect(popup.locator('#toggleButton')).toHaveText('Start Subtitles');
  await expect(overlay(page)).toHaveCount(0);
  await expect.poll(() => offscreenOpen(sw)).toBe(false);
});

test('a spoken caption is shown with DeepL, then upgraded to the Claude version', async ({ context, fixtureURL, openPopup, translationCalls, configure }) => {
  await configure({ translationProvider: 'deepl', deeplApiKey: 'test-key:fx', anthropicApiKey: 'sk-test', sourceLanguage: 'en', targetLanguage: 'fr', translationEngineMode: 'fast-then-best' });
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/captions.html?audio=hello.wav`);
  await startCaptions(page, openPopup);
  await waitForModel(page);
  await play(page);
  const upgraded = captionLines(page).filter({ hasText: /\[CLAUDE\].*weather/i });
  await expect(upgraded).toBeVisible({ timeout: 60_000 });
  await expect(upgraded).toHaveAttribute('data-quality', 'better');
  // DeepL answered first (the caption appeared with its text), Claude after.
  const order = translationCalls.filter(c => /weather/i.test(c.text)).map(c => c.provider);
  expect(order[0]).toBe('deepl');
  expect(order).toContain('anthropic');
  // Claude got the earlier caption as context.
  const claude = translationCalls.filter(c => c.provider === 'anthropic' && c.kind === 'translate' && /weather/i.test(c.text));
  expect(claude[0].text.toLowerCase()).toContain('hello world');
});

test('captions keep working after the service worker is restarted', async ({ context, fixtureURL, openPopup, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/captions.html?audio=hello.wav`);
  await startCaptions(page, openPopup);
  await waitForModel(page);

  expect(await stopServiceWorker(context, extensionId)).toBeGreaterThan(0);

  await play(page);
  await expect(captionLines(page).first()).toContainText(/\[FR\] .*hello/i, { timeout: 60_000 });
});

test('starting captions on another tab stops the first one', async ({ context, fixtureURL, openPopup, sw }) => {
  const first = await context.newPage();
  await first.goto(`${fixtureURL}/captions.html?audio=hello.wav`);
  await startCaptions(first, openPopup);

  const second = await context.newPage();
  await second.goto(`${fixtureURL}/captions.html?audio=sentences.wav`);
  await startCaptions(second, openPopup);

  await expect(overlay(first)).toContainText('Captions stopped');
  const popupForFirst = await openPopup(first);
  await expect(popupForFirst.locator('#toggleButton')).toHaveText('Start Subtitles');
  expect(await offscreenOpen(sw)).toBe(true);
});

test('no translation request when source and target language match', async ({ context, fixtureURL, openPopup, configure, translationCalls }) => {
  await configure({ sourceLanguage: 'en', targetLanguage: 'en' });
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/captions.html?audio=hello.wav`);
  await startCaptions(page, openPopup);
  await waitForModel(page);
  await play(page);
  await expect(captionLines(page).first()).toBeVisible({ timeout: 60_000 });
  expect(normalize((await captionLines(page).first().textContent())!)).toContain('hello world');
  expect(translationCalls).toEqual([]);
});
