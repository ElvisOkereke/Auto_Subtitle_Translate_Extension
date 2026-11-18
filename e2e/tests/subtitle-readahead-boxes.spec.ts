import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, FIXTURES, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { astTest } from '../helpers/bridge';
import { charErrorRate } from '../helpers/cer';
import { clearTranslationState, falseLines } from '../helpers/subtitles';

// Robustness: people don't draw perfect boxes. The same 60 s of the hand-labelled
// fixture (stretch s2) is read with boxes a real user might draw - loose, tight,
// shifted, cutting the text, the whole lower half - and each must still get >= 90%
// of the subtitles read (before the fix, four of these read none). Offline, across
// 8 labelled videos: e2e/bench/box_robustness.py. BOXES=name1,name2 runs a subset.
test.use({ profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });

const WINDOW_S = 60;
const BOXES: Record<string, { x: number; y: number; w: number; h: number }> = {
  standard: { x: 0.2, y: 0.75, w: 0.6, h: 0.14 },
  loose: { x: 0.1, y: 0.65, w: 0.8, h: 0.3 },
  'lower half': { x: 0.0, y: 0.5, w: 1.0, h: 0.5 },
  'full width thin': { x: 0.0, y: 0.76, w: 1.0, h: 0.12 },
  'too small': { x: 0.32, y: 0.79, w: 0.36, h: 0.06 },
  'shifted up': { x: 0.2, y: 0.7, w: 0.6, h: 0.12 },
  'shifted down': { x: 0.2, y: 0.81, w: 0.6, h: 0.14 },
  'tall narrow': { x: 0.33, y: 0.55, w: 0.34, h: 0.42 },
};
const ONLY = process.env.BOXES?.split(',');

interface Line { stretch: string; start: number; end: number; ko: string }
const lines: Line[] = (JSON.parse(fs.readFileSync(path.join(FIXTURES, 'subtitles/_zIrbXw-SVs.timeline.json'), 'utf8')).lines as Line[]).filter(l => l.stretch === 's2');
interface TLine { start: number; end: number | null; source: string; translatedAt: number | null }

async function drawBox(page: Page, box: { x: number; y: number; w: number; h: number }) {
  const r = await page.evaluate(b => {
    const rect = (window as any).__fixture.video.getBoundingClientRect();
    return { x: rect.x + b.x * rect.width, y: rect.y + b.y * rect.height, w: b.w * rect.width, h: b.h * rect.height };
  }, box);
  await page.mouse.move(r.x + 1, r.y + 1);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w - 1, r.y + r.h - 1, { steps: 6 });
  await page.mouse.up();
}

for (const [name, box] of Object.entries(BOXES)) {
  if (ONLY && !ONLY.includes(name)) continue;
  test(`subtitles are read with a "${name}" box`, async ({ context, fixtureURL, openPopup, configure, sw }) => {
    test.setTimeout(480_000);
    await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', targetLanguage: 'en', subtitleLanguage: 'ko', translationEngineMode: 'fast' });
    await clearTranslationState(sw);
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s2&container=webm`);
    await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 1);
    await astTest(page, 'timeline.clear');
    const popup = await openPopup(page);
    await popup.click('#modeSubtitles');
    await popup.click('#drawSubtitleBox');
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
    await drawBox(page, box);
    await expect.poll(async () => (await astTest<{ state: string }>(page, 'mode.stats')).state, { timeout: 120_000 }).toBe('running');
    const from = await page.evaluate(() => (window as any).__fixture.video.currentTime as number);
    await page.evaluate(() => (window as any).__fixture.video.play());
    await page.waitForFunction(t => (window as any).__fixture.video.currentTime >= t, from + WINDOW_S, { timeout: 300_000, polling: 500 });
    const timeline = await astTest<TLine[]>(page, 'mode.timeline');

    const window = lines.filter(l => l.start >= from + 3 && l.end <= from + WINDOW_S);
    let read = 0;
    let readyBefore = 0;
    const missed: string[] = [];
    for (const line of window) {
      const match = timeline.find(tl => tl.start >= line.start - 0.6 && tl.start <= line.end && charErrorRate(line.ko, tl.source).errors / [...line.ko.replace(/\s+/g, '')].length <= 0.5);
      if (match) read++;
      if (match?.translatedAt != null && match.translatedAt < line.start + 0.3) readyBefore++;
      if (!match) missed.push(`${line.start.toFixed(1)} ${line.ko}`);
    }
    const wrong = falseLines(timeline, lines, from + 3, from + WINDOW_S);
    const report = { box: name, rect: box, browser: browserKind(), lines: window.length, read, readyBefore, readRatio: read / window.length, readyRatio: readyBefore / window.length, missed, falseLines: wrong };
    console.log(JSON.stringify(report));
    fs.mkdirSync(path.join(ROOT, 'e2e/.perf/boxes'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, `e2e/.perf/boxes/${browserKind()}-${name.replace(/\s+/g, '-')}.json`), JSON.stringify(report, null, 2));
    expect(window.length).toBeGreaterThanOrEqual(8);
    expect(report.readRatio, `missed: ${missed.join(' | ')}`).toBeGreaterThanOrEqual(0.9);
    expect(wrong.length, `not subtitles: ${wrong.join(' | ')}`).toBeLessThanOrEqual(Math.ceil(0.1 * window.length)); // game notices, chat, logos
  });
}
