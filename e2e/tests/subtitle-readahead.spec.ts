import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, FIXTURES, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { astTest } from '../helpers/bridge';
import { charErrorRate } from '../helpers/cer';

// Read-ahead: the fixture plays stretch s2 through MSE with ~30 s buffered ahead
// (like YouTube); the extension decodes that buffer and translates subtitles
// before they appear. READAHEAD_OFF=1 runs the same test with read-ahead
// disabled (used to show the test fails without it).
test.use({ profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });

const BOX = { x: 0.2, y: 0.75, w: 0.6, h: 0.14 };
interface Line { stretch: string; start: number; end: number; ko: string }
const lines: Line[] = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'subtitles/_zIrbXw-SVs.timeline.json'), 'utf8')).lines.filter(
  (l: Line) => l.stretch === 's2'
);
interface TLine { start: number; end: number | null; source: string; translation: string | null; translatedAt: number | null }
interface Stats { state: string; ocrCalls: number; raOcrCalls: number; readAheadLead: number }

async function drawBox(page: Page) {
  const r = await page.evaluate(b => {
    const rect = (window as any).__fixture.video.getBoundingClientRect();
    return { x: rect.x + b.x * rect.width, y: rect.y + b.y * rect.height, w: b.w * rect.width, h: b.h * rect.height };
  }, BOX);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w, r.y + r.h, { steps: 6 });
  await page.mouse.up();
}

test('subtitles are translated before they appear', async ({ context, fixtureURL, openPopup, configure, sw }) => {
  test.setTimeout(420_000);
  await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', targetLanguage: 'en', subtitleLanguage: 'ko' });
  await sw.evaluate(off => chrome.storage.local.set({ devSubtitle: { readAhead: !off } }), !!process.env.READAHEAD_OFF);

  const page = await context.newPage();
  await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s2`);
  await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 1);
  const popup = await openPopup(page);
  await popup.click('#modeSubtitles');
  await popup.click('#drawSubtitleBox');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  await drawBox(page);
  await expect.poll(async () => (await astTest<Stats>(page, 'mode.stats')).state, { timeout: 120_000 }).toBe('running');

  await page.evaluate(() => (window as any).__fixture.video.play());
  const leads: number[] = [];
  let atSteady: Stats | null = null;
  for (;;) {
    await page.waitForTimeout(2000);
    const t = await page.evaluate(() => (window as any).__fixture.video.currentTime as number);
    const s = await astTest<Stats>(page, 'mode.stats');
    if (t > 5) leads.push(s.readAheadLead);
    if (!atSteady && t >= 20) atSteady = s;
    if (t >= 183.5) break;
  }
  const end = await astTest<Stats>(page, 'mode.stats');
  const timeline = await astTest<TLine[]>(page, 'mode.timeline');

  const notReady: string[] = [];
  let ready = 0;
  for (const line of lines) {
    const match = timeline.find(
      tl => tl.start >= line.start - 0.6 && tl.start <= line.end && charErrorRate(line.ko, tl.source).errors / [...line.ko.replace(/\s+/g, '')].length <= 0.5
    );
    if (match?.translatedAt !== null && match?.translatedAt !== undefined && match.translatedAt < line.start) ready++;
    else notReady.push(`${line.start.toFixed(2)} ${line.ko} (translatedAt ${match?.translatedAt?.toFixed(2) ?? 'never'})`);
  }
  const steadyLines = lines.filter(l => l.start >= 20).length;
  const report = {
    browser: browserKind(),
    readAhead: !process.env.READAHEAD_OFF,
    lines: lines.length,
    readyBeforeShown: ready,
    readyBeforeShownRatio: ready / lines.length,
    notReady,
    medianLead: [...leads].sort((a, b) => a - b)[Math.floor(leads.length / 2)] ?? 0,
    liveOcrCallsSteady: end.ocrCalls - (atSteady?.ocrCalls ?? 0),
    steadyLines,
    readAheadOcrCalls: end.raOcrCalls,
  };
  console.log(JSON.stringify(report, null, 1));
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `e2e/.perf/subtitle-readahead-${browserKind()}.json`), JSON.stringify(report, null, 2));

  expect(report.readyBeforeShownRatio).toBeGreaterThanOrEqual(0.9);
  expect(report.liveOcrCallsSteady).toBeLessThanOrEqual(Math.ceil(0.1 * steadyLines));
});
