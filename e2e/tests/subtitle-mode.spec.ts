import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { astTest } from '../helpers/bridge';
import { charErrorRate } from '../helpers/cer';
import { timelineFixture, modeStats, shownRecords, openFixture, startViaPopup, playUntil } from '../helpers/subtitles';
import { minDisplaySeconds, shownWhilePaused, timeOnScreen } from '../bench/metrics';

// Live path of subtitle mode on the local YouTube-like fixture with real OCR and
// mock DeepL ("[EN-US] <text>"). Read-ahead is disabled here (Task 9 covers it).
test.use({ profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });
test.describe.configure({ mode: 'serial' });

interface Line { stretch: string; start: number; end: number; ko: string }
const timeline: { lines: Line[] } = timelineFixture;
const stats = modeStats;
const shown = shownRecords;
const strip = (t: string) => t.replace(/^\[EN-US\]\s*/, '');

test.beforeEach(async ({ configure, sw }) => {
  await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', targetLanguage: 'en', subtitleLanguage: 'ko' });
  await sw.evaluate(() => chrome.storage.local.set({ devSubtitle: { readAhead: false } }));
});

test('short subtitles stay on screen for their reading time; nothing appears while paused', async ({ context, fixtureURL, openPopup }) => {
  test.setTimeout(300_000);
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 30);
  await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
  await page.waitForTimeout(2000);
  await playUntil(page, 75);

  const records = await shown(page);
  const onScreen = timeOnScreen(records);
  const tooShort = records
    .filter((r, i) => r.hiddenAt !== null && !(records[i + 1] && Math.abs(records[i + 1].shownAt - r.hiddenAt) <= 0.05))
    .filter(r => r.hiddenAt! - r.shownAt < minDisplaySeconds(strip(r.text)) - 0.05)
    .map(r => `${r.shownAt.toFixed(2)}-${r.hiddenAt!.toFixed(2)} ${strip(r.text)}`);
  console.log(JSON.stringify({ records: records.length, onScreen, tooShort }, null, 1));
  expect(records.length).toBeGreaterThan(5);
  expect(tooShort).toEqual([]);
  expect(onScreen.tooShort).toBe(0);
  expect(shownWhilePaused(records)).toBe(0);
});

test('live path translates every line of stretch s1', async ({ context, fixtureURL, openPopup, translationCalls }) => {
  test.setTimeout(420_000);
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 179.5);

  const lines = timeline.lines.filter(l => l.stretch === 's1');
  const records = await shown(page);
  const latencies: number[] = [];
  const misses: string[] = [];
  const ocrSlips: string[] = [];
  let errors = 0;
  let length = 0;
  for (const line of lines) {
    // Coverage: the line is shown inside its on-screen window with text recognizably that line.
    const candidates = records
      .filter(r => r.shownAt >= line.start - 0.1 && r.shownAt <= line.end)
      .map(r => ({ r, cer: charErrorRate(line.ko, strip(r.text)) }))
      .filter(c => c.cer.errors / c.cer.length <= 0.5);
    const match = candidates[0];
    if (!match) {
      misses.push(`${line.start.toFixed(2)} ${line.ko}`);
      continue;
    }
    latencies.push(match.r.shownAt - line.start);
    errors += match.cer.errors;
    length += match.cer.length;
    if (match.cer.errors / match.cer.length > 0.15) ocrSlips.push(`${line.ko} -> ${strip(match.r.text)}`);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const s = await stats(page);
  const report = {
    browser: browserKind(),
    lines: lines.length,
    matched: latencies.length,
    misses,
    ocrCer: errors / length,
    ocrSlips,
    liveLatencyP50: sorted[Math.floor(sorted.length / 2)],
    liveLatencyP90: sorted[Math.floor(sorted.length * 0.9)],
    ocrCalls: s.ocrCalls,
    translationRequests: translationCalls.length,
  };
  console.log(JSON.stringify(report, null, 1));
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `e2e/.perf/subtitle-live-${browserKind()}.json`), JSON.stringify(report, null, 2));
  await page.screenshot({ path: test.info().outputPath('live.png') });

  expect(misses).toEqual([]);
  expect(report.ocrCer).toBeLessThanOrEqual(0.1); // OCR accuracy across all lines (same gate as subtitle-ocr.spec)
  expect(report.liveLatencyP50).toBeLessThanOrEqual(0.7);
  expect(translationCalls.length).toBeLessThanOrEqual(Math.ceil(lines.length * 1.2)); // never re-translate a line
  expect(s.ocrCalls).toBeLessThanOrEqual(180 * 4); // bounded OCR rate
});

test('seek mid-line shows the right line', async ({ context, fixtureURL, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 9.5); // lines at 1.37, 2.93, 5.67, 7.23, 8.57 seen
  await page.evaluate(() => (window as any).__fixture.video.pause());
  const before = (await stats(page)).ocrCalls;
  await page.evaluate(async () => {
    const v = (window as any).__fixture.video as HTMLVideoElement;
    v.currentTime = 4.0; // "우리 팀 또 조합이.. 뽀삐한테 좀 취약하긴 한데!" (2.93-5.67)
    await new Promise(r => v.addEventListener('seeked', r, { once: true }));
  });
  await expect(page.locator('.ast-subtitle-overlay')).toContainText('취약하긴', { timeout: 200 + 500 });
  await page.waitForTimeout(500);
  expect((await stats(page)).ocrCalls - before).toBeLessThanOrEqual(1); // known line: from the timeline (at most one confirming read)
});

test('ads pause the pipeline', async ({ context, fixtureURL, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 3);
  await page.evaluate(() => (window as any).__fixture.setAd(true));
  await expect.poll(async () => (await stats(page)).state).toBe('paused-ad');
  const during = await stats(page);
  await playUntil(page, 12); // two subtitle lines go by during the "ad"
  const after = await stats(page);
  expect(after.ocrCalls).toBe(during.ocrCalls);
  expect(after.timelineSize).toBe(during.timelineSize);
  await page.evaluate(() => (window as any).__fixture.setAd(false));
  await expect.poll(async () => (await stats(page)).state).toBe('running');
});

test('navigation switches videos and restores the stored box', async ({ context, fixtureURL, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 3);
  await expect(page.locator('.ast-subtitle-overlay')).toBeVisible();

  await page.evaluate(() => (window as any).__fixture.navigate('otherVideo01', 's2'));
  await expect.poll(async () => (await stats(page)).videoId).toMatch(/\/video-subs\.html\?v=otherVideo01$/); // site-scoped id
  expect((await stats(page)).state).toBe('stopped'); // no box stored for this video
  await expect(page.locator('.ast-subtitle-overlay')).toHaveCount(0);

  await page.evaluate(() => (window as any).__fixture.navigate('_zIrbXw-SVs', 's1'));
  await expect.poll(async () => (await stats(page)).state, { timeout: 30_000 }).toBe('running');
  await playUntil(page, 3);
  await expect(page.locator('.ast-subtitle-overlay')).toBeVisible();
});

test('paused video is not re-read', async ({ context, fixtureURL, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  await startViaPopup(page, openPopup);
  await playUntil(page, 3.5);
  await page.evaluate(() => (window as any).__fixture.video.pause());
  await page.waitForTimeout(1000);
  const before = (await stats(page)).ocrCalls;
  await page.waitForTimeout(3000);
  expect((await stats(page)).ocrCalls).toBe(before);
  await expect(page.locator('.ast-subtitle-overlay')).toContainText('취약하긴');
});

test('box placement rules', async ({ context, fixtureURL, openPopup, translationCalls }) => {
  const page = await context.newPage();
  await openFixture(page, fixtureURL);

  // Over page text: one-shot Screen Translate as before.
  let popup = await openPopup(page);
  await popup.click('#screenTranslateButton');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  const t = (await page.locator('#page-text').boundingBox())!;
  await page.mouse.move(t.x + 2, t.y + 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width - 2, t.y + t.height - 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-role="translated-text"]')).toContainText('[EN-US]');
  expect((await stats(page)).state).toBe('stopped');
  expect(translationCalls.length).toBe(1);

  // Tiny box over the video: rejected with a message, no subtitle mode.
  await popup.close();
  popup = await openPopup(page);
  await popup.click('#modeSubtitles');
  await popup.click('#drawSubtitleBox');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  const v = await page.evaluate(() => {
    const r = (window as any).__fixture.video.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(v.x, v.y);
  await page.mouse.down();
  await page.mouse.move(v.x + 20, v.y + 10, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByText('Box too small')).toBeVisible();
  expect((await stats(page)).state).toBe('stopped');
});

test('drawing a new box discards lines read with the old one', async ({ context, fixtureURL, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, fixtureURL);
  // Lines saved from an earlier box (e.g. one drawn over the wrong region).
  const { videoId } = await stats(page);
  expect(videoId).toBeTruthy();
  await astTest(page, 'timeline.save', {
    videoId,
    lines: [{ start: 0, end: 600, source: '엉뚱한 영역', translation: 'STALE LINE', quality: 'fast' }],
  });
  await startViaPopup(page, openPopup);
  const lines = await astTest<{ translation: string | null }[]>(page, 'mode.timeline');
  expect(lines.filter(l => l.translation === 'STALE LINE')).toEqual([]);
  await expect(page.locator('.ast-subtitle-overlay')).not.toContainText('STALE LINE');
});
