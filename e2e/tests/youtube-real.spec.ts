import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { charErrorRate } from '../helpers/cer';
import { dragBox, modeStats, recordOverlay, shownRecords, timelineFixture } from '../helpers/subtitles';
import { astTest } from '../helpers/bridge';

// Subtitle mode on REAL YouTube (opt-in: npm run e2e:youtube). Installed Chrome,
// dedicated test profile, headed window placed off-screen (YouTube stops
// automated playback in headless mode). Mock translation, so the overlay text
// ("[EN-US] <korean>") checks OCR on YouTube's real AV1 stream.
// Artifacts: e2e/.perf/youtube/ (report.json, frames, youtube-run.mp4).
test.use({
  profileDir: path.join(CACHE, 'profile-youtube'),
  headed: true,
  extraArgs: ['--window-position=-2400,-2400'],
});
test.skip(browserKind() !== 'chrome', 'real YouTube runs use installed Chrome (E2E_BROWSER=chrome)');

const START = 540;
const DURATION = 120;
const ART = path.join(ROOT, 'e2e/.perf/youtube');

async function waitOutAds(page: Page) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      ad: !!document.querySelector('#movie_player.ad-showing'),
      error: document.querySelector('.ytp-error')?.textContent?.trim() ?? null,
    }));
    if (state.error) throw new Error(`YouTube refused playback in the test browser: "${state.error}"`);
    if (!state.ad) return;
    await page.locator('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern').first().click({ timeout: 1000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
  }
  throw new Error('Ad did not finish within 90 s');
}

test('subtitle mode follows burned-in subtitles on real YouTube', async ({ context, openPopup, configure, sw }) => {
  await configure({ translationProvider: 'deepl', deeplApiKey: 'k:fx', targetLanguage: 'en', subtitleLanguage: 'ko' });
  await sw.evaluate(() => chrome.storage.local.remove('devSubtitle'));
  fs.rmSync(ART, { recursive: true, force: true });
  fs.mkdirSync(path.join(ART, 'frames'), { recursive: true });

  const page = await context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=_zIrbXw-SVs&t=${START}s`);
  await page.waitForSelector('video.html5-main-video', { timeout: 30_000 });
  await waitOutAds(page);
  // Full resolution for OCR, park at the start of the checked window.
  await page.evaluate(start => {
    const player = document.getElementById('movie_player') as any;
    player?.setPlaybackQualityRange?.('hd1080', 'hd1080');
    const v = document.querySelector('video.html5-main-video') as HTMLVideoElement;
    v.pause();
    v.currentTime = start;
  }, START);
  await recordOverlay(page);
  await astTest(page, 'timeline.clear'); // measure read-ahead itself, not subtitles saved by earlier runs

  const popup = await openPopup(page);
  await popup.click('#modeSubtitles');
  await popup.selectOption('#subtitleLanguage', 'ko');
  await popup.click('#drawSubtitleBox');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  await dragBox(page);
  await expect.poll(async () => (await modeStats(page)).state, { timeout: 120_000 }).toBe('running');

  await page.evaluate(() => (document.querySelector('video.html5-main-video') as HTMLVideoElement).play());
  let frame = 0;
  const leads: number[] = [];
  let blocked: { at: number; message: string } | null = null;
  let lastTime = START;
  for (;;) {
    await page.waitForTimeout(2000);
    const status = await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video') as HTMLVideoElement;
      return { t: v.currentTime, res: `${v.videoWidth}x${v.videoHeight}`, ad: !!document.querySelector('#movie_player.ad-showing'), error: document.querySelector('.ytp-error')?.textContent?.trim() ?? null };
    });
    if (status.error) {
      // YouTube refuses automated playback after a while; evaluate what played, then fail clearly.
      blocked = { at: lastTime, message: status.error };
      break;
    }
    lastTime = status.t;
    if (status.ad) await waitOutAds(page);
    leads.push((await modeStats(page)).readAheadLead);
    await page.screenshot({ path: path.join(ART, 'frames', `${String(frame++).padStart(4, '0')}.png`) });
    if (status.t >= START + DURATION) break;
  }

  // Reference lines (stretch s2 starts at 535.77 s of the source video) inside the checked window.
  const s2 = timelineFixture.stretches.find(s => s.id === 's2')!;
  const lines = timelineFixture.lines
    .filter(l => l.stretch === 's2')
    .map(l => ({ ...l, start: l.start + s2.start, end: l.end + s2.start }))
    .filter(l => l.start >= START + 1 && l.end <= (blocked ? blocked.at - 1 : START + DURATION));
  const records = await shownRecords(page);
  const strip = (t: string) => t.replace(/^\[EN-US\]\s*/, '');
  let errors = 0;
  let length = 0;
  const misses: string[] = [];
  for (const line of lines) {
    const candidates = records
      .filter(r => r.lineStart >= line.start - 0.6 && r.lineStart <= line.end)
      .map(r => ({ r, cer: charErrorRate(line.ko, strip(r.text)) }))
      .filter(c => c.cer.errors / c.cer.length <= 0.5);
    if (!candidates.length) {
      misses.push(`${line.start.toFixed(2)} ${line.ko}`);
      continue;
    }
    errors += candidates[0].cer.errors;
    length += candidates[0].cer.length;
  }
  const stats = await modeStats(page);
  const timeline = await astTest<{ start: number; translatedAt: number | null }[]>(page, 'mode.timeline');
  const report = {
    window: [START, blocked ? blocked.at : START + DURATION],
    blockedByYouTube: blocked,
    lines: lines.length,
    shown: lines.length - misses.length,
    coverage: (lines.length - misses.length) / lines.length,
    ocrCer: length ? errors / length : null,
    misses,
    medianReadAheadLead: [...leads].sort((a, b) => a - b)[Math.floor(leads.length / 2)],
    liveOcrCalls: stats.ocrCalls,
    readAheadOcrCalls: stats.raOcrCalls,
    readyBeforeShown: timeline.filter(t => t.translatedAt !== null && t.translatedAt <= t.start).length,
    timelineLines: timeline.length,
  };
  console.log(JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2));

  // Stitch the screenshots into a reviewable video (0.5 s per frame -> real-time-ish at 2 s spacing x4 speed).
  try {
    const ffmpeg = execFileSync(path.join(ROOT, 'e2e/.cache/venv/Scripts/python.exe'), ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
    execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-framerate', '2', '-i', path.join(ART, 'frames/%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(ART, 'youtube-run.mp4')]);
  } catch (error) {
    console.warn('Could not assemble the run video:', String(error).slice(0, 200));
  }

  expect(report.coverage).toBeGreaterThanOrEqual(0.9);
  expect(report.ocrCer!).toBeLessThanOrEqual(0.15);
  if (blocked) {
    throw new Error(
      `YouTube stopped automated playback after ${(blocked.at - START).toFixed(0)} s ("${blocked.message}"). ` +
        `Within that window: ${report.shown}/${report.lines} lines shown, OCR CER ${report.ocrCer?.toFixed(3)}. ` +
        `Artifacts: e2e/.perf/youtube/. The full ${DURATION} s run needs a browser YouTube doesn't flag as automated.`
    );
  }
});
