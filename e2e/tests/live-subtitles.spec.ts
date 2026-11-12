import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { readEnv } from '../helpers/env';
import { astTest } from '../helpers/bridge';
import { charErrorRate } from '../helpers/cer';
import { containsTerm, openFixture, playUntil, shownRecords, startViaPopup, timelineFixture } from '../helpers/subtitles';

// Subtitle mode against the REAL DeepL API (DEEPL_API_KEY from .env; skipped
// without it). Two runs, each measuring what its configuration represents:
//  1. latency: live path only (read-ahead off), so translation time is inside
//     the measured latency;
//  2. quality: the default configuration (read-ahead on, next-line context).
// Uses ~3k characters of DeepL quota per run.
const key = readEnv('DEEPL_API_KEY');
test.use({ mockTranslation: false, profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });
test.skip(!key, 'DEEPL_API_KEY not set in .env');

test.describe.configure({ mode: 'serial' });

test('live subtitle translation with real DeepL meets the latency target', async ({ context, fixtureURL, openPopup, configure, sw }) => {
  test.setTimeout(420_000);
  await configure({ translationProvider: 'deepl', deeplApiKey: key, targetLanguage: 'en', subtitleLanguage: 'ko' });
  await sw.evaluate(() => chrome.storage.local.set({ devSubtitle: { readAhead: false } }));
  const page = await context.newPage();
  await openFixture(page, fixtureURL, 's1');
  await startViaPopup(page, openPopup);
  await playUntil(page, 179.5);

  const lines = timelineFixture.lines.filter(l => l.stretch === 's1');
  const records = await shownRecords(page);
  const latencies: number[] = [];
  const termLines = lines.filter(l => l.terms.length);
  const termMisses: string[] = [];
  let termHits = 0;
  const shown: { ko: string; en: string; reference: string }[] = [];
  for (const line of lines) {
    // The overlay shows English now, so match records by their line start instead of text.
    const match = records.find(r => r.lineStart >= line.start - 0.1 && r.lineStart <= line.end && r.shownAt <= line.end);
    if (!match) continue;
    latencies.push(match.shownAt - line.start);
    shown.push({ ko: line.ko, en: match.text, reference: line.en });
    if (line.terms.length) {
      if (line.terms.every(t => containsTerm(match.text, t))) termHits++;
      else termMisses.push(`${line.terms.join('/')} :: ${line.ko} -> ${match.text}`);
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    browser: browserKind(),
    engine: 'deepl',
    lines: lines.length,
    shownLines: latencies.length,
    liveLatencyP50: sorted[Math.floor(sorted.length / 2)],
    liveLatencyP90: sorted[Math.floor(sorted.length * 0.9)],
    termHitRate: termHits / termLines.length,
    termMisses,
    shown,
  };
  console.log(JSON.stringify({ ...report, shown: undefined }, null, 1));
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `e2e/.perf/subtitle-live-deepl-${browserKind()}.json`), JSON.stringify(report, null, 2));
  await page.screenshot({ path: test.info().outputPath('deepl.png') });

  // Latency including the real translation round trip (spec target).
  expect(report.liveLatencyP50).toBeLessThanOrEqual(0.7);
  // Everything displayed was actually translated (no Korean left).
  expect(shown.filter(s => /[가-힣]/.test(s.en))).toEqual([]);
});

interface TLine { start: number; end: number | null; source: string; translation: string | null; translatedAt: number | null }

test('default configuration translates every line with the key terms', async ({ context, fixtureURL, openPopup, configure, sw }) => {
  test.setTimeout(420_000);
  await configure({ translationProvider: 'deepl', deeplApiKey: key, targetLanguage: 'en', subtitleLanguage: 'ko' });
  await sw.evaluate(() => chrome.storage.local.remove('devSubtitle')); // product defaults: read-ahead on
  const page = await context.newPage();
  await openFixture(page, fixtureURL, 's1');
  await startViaPopup(page, openPopup);
  await playUntil(page, 179.5);
  const timeline = await astTest<TLine[]>(page, 'mode.timeline');

  const lines = timelineFixture.lines.filter(l => l.stretch === 's1');
  const untranslated: string[] = [];
  const termMisses: string[] = [];
  const termLines = lines.filter(l => l.terms.length);
  let termHits = 0;
  const pairs: { ko: string; en: string; reference: string }[] = [];
  for (const line of lines) {
    const match = timeline.find(
      tl => tl.start >= line.start - 0.6 && tl.start <= line.end && charErrorRate(line.ko, tl.source).errors / [...line.ko.replace(/\s+/g, '')].length <= 0.5
    );
    if (!match?.translation) {
      untranslated.push(line.ko);
      continue;
    }
    pairs.push({ ko: line.ko, en: match.translation, reference: line.en });
    if (line.terms.length) {
      if (line.terms.every(t => containsTerm(match.translation!, t))) termHits++;
      else termMisses.push(`${line.terms.join('/')} :: ${line.ko} -> ${match.translation}`);
    }
  }
  const report = { browser: browserKind(), engine: 'deepl', readAhead: true, untranslated, termHitRate: termHits / termLines.length, termMisses, pairs };
  console.log(JSON.stringify({ ...report, pairs: undefined }, null, 1));
  fs.writeFileSync(path.join(ROOT, `e2e/.perf/subtitle-quality-deepl-${browserKind()}.json`), JSON.stringify(report, null, 2));

  expect(untranslated).toEqual([]);
  expect(report.termHitRate).toBeGreaterThanOrEqual(0.8);
});
