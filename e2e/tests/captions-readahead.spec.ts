import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { recordCaptions, shownCaptions, waitForSpeechModel } from '../helpers/captions';
import { benchVideos, cutOffset } from '../bench/videos';

// Audio read-ahead end to end: the fixture page plays a real Japanese football
// commentary clip through MediaSource (one audio SourceBuffer of WebM/Opus, like
// YouTube). The tap decodes the buffered audio ahead of playback, Whisper
// transcribes it, and each caption appears when the video reaches its words.
test.use({ profileDir: path.join(CACHE, `profile-captions-${browserKind()}`) });
test.describe.configure({ mode: 'serial' });

const VIDEO = benchVideos.find(v => v.id === '5INsXNUaRdE')!;
const haveCopy = fs.existsSync(path.join(CACHE, 'videos', `${VIDEO.id}.b.audio.webm`));

const overlay = (page: Page) => page.locator('#subtitle-overlay-extension');
const videoTime = (page: Page) => page.evaluate(() => document.querySelector('video')!.currentTime);

test.beforeEach(async ({ configure }) => {
  await configure({ translationProvider: 'deepl', deeplApiKey: 'test-key:fx', sourceLanguage: 'ja', targetLanguage: 'en' });
});

test('read-ahead captions appear when the video reaches their words; pause freezes; a seek back shows them again', async ({ context, fixtureURL, openPopup }) => {
  test.skip(!haveCopy, 'local copy missing: npm run fixtures:video');
  const offset = cutOffset(VIDEO);
  const from = VIDEO.start - offset; // local time of the benchmark window's start
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/video-subs.html?v=${VIDEO.id}&file=${VIDEO.id}&stretch=b&container=webm`);
  await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 1);
  await recordCaptions(page);
  await page.evaluate(t => {
    const v = document.querySelector('video')!;
    v.muted = false; // a muted tab captures silence (the live path's input)
    v.volume = 1;
    v.pause();
    v.currentTime = t;
  }, from);

  const popup = await openPopup(page);
  await popup.click('#toggleButton');
  await expect(popup.locator('#toggleButton')).toHaveText('Stop live captions');
  await waitForSpeechModel(page);

  // Paused at the start, the buffered audio is already being read ahead.
  await expect(overlay(page)).toHaveAttribute('data-path', 'read-ahead', { timeout: 60_000 });
  await expect.poll(async () => Number(await overlay(page).getAttribute('data-ra-scheduled')), { timeout: 240_000 }).toBeGreaterThanOrEqual(3);
  // While paused, only a caption whose speech spans the paused frame may show (like YouTube's own
  // captions); nothing for speech the video hasn't reached or has passed.
  for (const c of await shownCaptions(page)) {
    expect(c.videoStart, `"${c.text}" shown while paused at ${from}`).not.toBeNull();
    expect(c.videoStart!).toBeLessThanOrEqual(from + 0.1);
    expect(c.lineStart).toBeGreaterThanOrEqual(from - 0.5);
  }

  await page.evaluate(() => document.querySelector('video')!.play());
  // Read-ahead stays in charge for the whole stretch (no holes in the audio it accepted).
  const paths: (string | null)[] = [];
  while ((await videoTime(page)) < from + 25) {
    paths.push(await overlay(page).getAttribute('data-path'));
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => document.querySelector('video')!.pause());
  expect(paths.filter(p => p !== 'read-ahead'), 'read-ahead stayed in charge while playing').toEqual([]);

  const shown = (await shownCaptions(page)).filter(c => typeof c.videoStart === 'number');
  console.log(JSON.stringify(shown.map(c => ({ start: c.videoStart, shownAt: c.shownAt, text: c.text.slice(0, 40) }))));
  expect(shown.length, 'read-ahead captions were shown').toBeGreaterThanOrEqual(3);
  // On time: each appears within 0.3 s of its speech start (video time), not when it was made.
  const onTime = shown.filter(c => c.videoStart! > from + 0.5);
  for (const c of onTime) expect(Math.abs(c.shownAt - c.videoStart!), `"${c.text}" shown at ${c.shownAt}, speech at ${c.videoStart}`).toBeLessThan(0.3);
  expect(onTime.every(c => !c.pausedAtShow), 'nothing new appeared over a paused frame').toBe(true);
  await page.screenshot({ path: test.info().outputPath('read-ahead.png') });

  // Paused: video time stands still, nothing new appears.
  const before = (await shownCaptions(page)).length;
  await page.waitForTimeout(3000);
  expect((await shownCaptions(page)).length).toBe(before);

  // Seek back into the stretch already captioned: its caption shows again without being made twice.
  const again = onTime[0] ?? shown[0];
  await page.evaluate(t => {
    document.querySelector('video')!.currentTime = t;
  }, again.videoStart! + 0.1);
  await expect(overlay(page).locator(`.subtitle-text[data-caption-id="${again.captionId}"]`)).toBeVisible({ timeout: 2000 });
  expect(await videoTime(page)).toBeCloseTo(again.videoStart! + 0.1, 1);
  // The tap decoded the stretch once: it restarts only for real jumps (the one seek back here).
  const tap = await page.evaluate(() => (window as any).__astAudioTapStats);
  expect(tap.resets, JSON.stringify(tap)).toBeLessThanOrEqual(2);

  // A seek beyond everything read ahead (into dense speech at 96-113 s of the video): read-ahead
  // starts again there and its captions land on their words, with nothing from the old position.
  const far = VIDEO.start + 66 - offset; // video time 96 s
  await page.evaluate(t => {
    const v = document.querySelector('video')!;
    v.currentTime = t;
    void v.play();
  }, far);
  await expect(overlay(page)).toHaveAttribute('data-path', 'read-ahead', { timeout: 90_000 });
  await page.waitForFunction(t => document.querySelector('video')!.currentTime >= t, far + 17, { timeout: 90_000, polling: 250 });
  await page.evaluate(() => document.querySelector('video')!.pause());
  const after = (await shownCaptions(page)).filter(c => typeof c.videoStart === 'number' && c.shownAt >= far);
  console.log(JSON.stringify(after.map(c => ({ start: c.videoStart, shownAt: c.shownAt, text: c.text.slice(0, 30) }))));
  expect(after.length, 'captions after the far seek').toBeGreaterThan(0);
  expect(after.every(c => c.videoStart! >= far - 1), 'nothing from the old position').toBe(true);
  for (const c of after.filter(c => c.videoStart! > far + 1)) expect(Math.abs(c.shownAt - c.videoStart!)).toBeLessThan(0.3);

  // And back to the start: the captions made there show again, once each.
  await page.evaluate(t => {
    document.querySelector('video')!.currentTime = t;
  }, again.videoStart! + 0.1);
  await expect(overlay(page).locator(`.subtitle-text[data-caption-id="${again.captionId}"]`)).toBeVisible({ timeout: 2000 });
  const texts = await overlay(page).locator('.subtitle-text').allTextContents();
  expect(new Set(texts).size, `no caption twice: ${JSON.stringify(texts)}`).toBe(texts.length);
});
