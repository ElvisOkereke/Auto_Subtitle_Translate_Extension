import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, FIXTURES, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { astTest } from '../helpers/bridge';
import { charErrorRate } from '../helpers/cer';

// Live path of subtitle mode on the local YouTube-like fixture with real OCR and
// mock DeepL ("[EN-US] <text>"). Read-ahead is disabled here (Task 9 covers it).
test.use({ profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });
test.describe.configure({ mode: 'serial' });

const BOX = { x: 0.2, y: 0.75, w: 0.6, h: 0.14 };
interface Line { stretch: string; start: number; end: number; ko: string }
const timeline: { lines: Line[] } = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'subtitles/_zIrbXw-SVs.timeline.json'), 'utf8'));
interface Shown { shownAt: number; lineStart: number; text: string }
interface Stats { state: string; ocrCalls: number; translateCalls: number; timelineSize: number; videoId: string | null }

async function openFixture(page: Page, fixtureURL: string, stretch = 's1', v = '_zIrbXw-SVs') {
  await page.goto(`${fixtureURL}/video-subs.html?v=${v}&stretch=${stretch}`);
  await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 1);
  // Records every overlay update in the page's main world (the DOM is shared with content scripts).
  await page.evaluate(() => {
    const w = window as any;
    w.__shown = [];
    new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>('.ast-subtitle-overlay');
      if (!el || el.style.display === 'none') return;
      const text = el.textContent ?? '';
      const last = w.__shown[w.__shown.length - 1];
      if (!last || last.text !== text || last.lineStart !== Number(el.dataset.lineStart)) {
        w.__shown.push({ shownAt: Number(el.dataset.shownAt), lineStart: Number(el.dataset.lineStart), text });
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'data-shown-at'] });
  });
}

async function dragBox(page: Page, box = BOX) {
  const r = await page.evaluate(b => {
    const v = (window as any).__fixture.video as HTMLVideoElement;
    const rect = v.getBoundingClientRect();
    return { x: rect.x + b.x * rect.width, y: rect.y + b.y * rect.height, w: b.w * rect.width, h: b.h * rect.height };
  }, box);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 4 });
  await page.mouse.move(r.x + r.w, r.y + r.h, { steps: 4 });
  await page.mouse.up();
}

async function startViaPopup(page: Page, openPopup: (p: Page) => Promise<Page>) {
  const popup = await openPopup(page);
  await popup.click('#modeSubtitles');
  await popup.selectOption('#subtitleLanguage', 'ko');
  await popup.click('#drawSubtitleBox');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  await dragBox(page);
  await expect.poll(async () => (await astTest<Stats>(page, 'mode.stats')).state, { timeout: 120_000 }).toBe('running');
  return popup;
}

const stats = (page: Page) => astTest<Stats>(page, 'mode.stats');
const shown = (page: Page) => page.evaluate(() => (window as any).__shown as Shown[]);
const strip = (t: string) => t.replace(/^\[EN-US\]\s*/, '');

async function playUntil(page: Page, t: number) {
  await page.evaluate(() => (window as any).__fixture.video.play());
  await page.waitForFunction(at => (window as any).__fixture.video.currentTime >= at, t, { timeout: (t + 30) * 1000, polling: 250 });
}

test.beforeEach(async ({ configure, sw }) => {
  await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', targetLanguage: 'en', subtitleLanguage: 'ko' });
  await sw.evaluate(() => chrome.storage.local.set({ devSubtitle: { readAhead: false } }));
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
  await expect.poll(async () => (await stats(page)).videoId).toBe('otherVideo01');
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
