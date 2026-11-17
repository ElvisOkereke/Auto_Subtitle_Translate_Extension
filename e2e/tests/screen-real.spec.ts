import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { readEnv } from '../helpers/env';
import { waitOutAds } from '../helpers/youtube';
import { dragBox, clearTranslationState } from '../helpers/subtitles';
import { recordCaptionsOnEveryLoad, waitForSpeechModel } from '../helpers/captions';
import { astTest } from '../helpers/bridge';
import { anthropicRelayAvailable } from '../helpers/server';
import { readFrames, alignLines, type CapturedSample } from '../bench/screenJudge';
import { lineTimeline, screenMetrics, type FrameSample } from '../bench/screenMetrics';

// What a viewer actually sees, judged from the screen. Real YouTube in installed
// Chrome (headed; E2E_WINDOW puts it on a chosen display), the extension started
// the way a person does (popup clicks; Subtitles mode's box drawn with the
// mouse), real DeepL and Claude. Every 0.5 s the test keeps a screenshot of the
// player as shown and the bare video frame; Claude reads the burned-in Korean
// subtitle (which is what is being said) and the English subtitle visible on
// screen, then matches each English line to the Korean line it translates.
// The score is per moment: the right subtitle on screen now, a late one, none,
// or a wrong one - and how many seconds each line came after its Korean.
// IRELKING's videos carry Korean subtitles burned in, so they judge both modes.

const DEEPL_KEY = readEnv('DEEPL_API_KEY');
test.use({ mockTranslation: false, profileDir: path.join(CACHE, 'profile-youtube'), headed: true });
test.skip(browserKind() !== 'chrome', 'screen runs use installed Chrome (E2E_BROWSER=chrome)');
test.skip(!DEEPL_KEY, 'DEEPL_API_KEY not set in .env');
test.skip(!anthropicRelayAvailable(), 'no Anthropic credentials (the judge reads the screen with Claude)');

const BOX = { x: 0.2, y: 0.75, w: 0.6, h: 0.14 }; // IRELKING's subtitle area
const VIDEOS = [
  { id: 'hrdfLfuHop4', start: 20 }, // dialogue-dense opening (10-13 lines a minute in YouTube's captions)
  { id: '_zIrbXw-SVs', start: 540 },
].filter(v => !process.env.SCREEN_VIDEOS || process.env.SCREEN_VIDEOS.split(',').includes(v.id));
const MODES = (process.env.SCREEN_MODES || 'subtitles,audio').split(',') as ('subtitles' | 'audio')[];
const PIECES = Number(process.env.SCREEN_PIECES || 3);
const PIECE_S = 30; // YouTube stops automated playback after ~40 s of a page's playback
const LEAD_IN_S = 6; // each piece starts a little earlier: the extension warms up before scoring starts
const SAMPLE_MS = 500;
const LABEL = process.env.SCREEN_LABEL || (process.env.SCREEN_STT_MODEL ? `screen-${process.env.SCREEN_STT_MODEL.split('/').pop()}` : 'screen');
const OUT = path.join(ROOT, 'e2e', '.perf', 'screen', LABEL);

async function park(page: Page, t: number): Promise<void> {
  await page.waitForSelector('video.html5-main-video', { timeout: 30_000 });
  await waitOutAds(page);
  await page.evaluate(at => {
    const player = document.getElementById('movie_player') as any;
    player?.unMute?.();
    player?.setVolume?.(100);
    // The original audio, never an auto-dubbed track.
    const tracks: any[] = player?.getAvailableAudioTracks?.() ?? [];
    const isOriginal = (tr: any) => Object.values(tr ?? {}).some((x: any) => x && typeof x === 'object' && x.isAutoDubbed === false && /original/i.test(String(x.name ?? '')));
    const original = tracks.find(isOriginal);
    if (original && !isOriginal(player.getAudioTrack?.())) player.setAudioTrack(original);
    const v = document.querySelector('video.html5-main-video') as HTMLVideoElement;
    v.pause();
    v.currentTime = at;
  }, t);
  await page.waitForTimeout(1500); // the page settles before anything is drawn on it
}

/** The popup, as a person uses it. */
async function startMode(page: Page, openPopup: (p: Page) => Promise<Page>, mode: 'subtitles' | 'audio', first: boolean): Promise<void> {
  const popup = await openPopup(page);
  if (mode === 'subtitles') {
    await popup.click('#modeSubtitles');
    await popup.selectOption('#subtitleLanguage', 'ko');
    await popup.click('#drawSubtitleBox');
    const said = await popup.locator('#status').innerText().catch(() => '');
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.body.style.cursor), { timeout: 15_000, message: `box drawing did not start (popup said: ${said})` }).toBe('crosshair');
    await dragBox(page, BOX);
    await expect.poll(async () => (await astTest<{ state: string }>(page, 'mode.stats')).state, { timeout: 120_000 }).toBe('running');
  } else {
    await popup.click('#modeAudio');
    await popup.click('#toggleButton');
    // What the popup and the page said, if starting failed (the popup's message only shows for 3 s).
    let said = '';
    for (let i = 0; i < 60 && (await popup.locator('#toggleButton').innerText()) !== 'Stop live captions'; i++) {
      said = [await popup.locator('#status').innerText().catch(() => ''), await page.locator('#subtitle-overlay-extension').innerText().catch(() => '')].filter(Boolean).join(' | ') || said;
      await page.waitForTimeout(500);
    }
    await expect(popup.locator('#toggleButton'), `live captions did not start: ${said}`).toHaveText('Stop live captions', { timeout: 1000 });
    await page.bringToFront();
    if (first) await waitForSpeechModel(page, 1_200_000);
  }
  await popup.close();
  await page.bringToFront();
}

/** The player as the viewer sees it, and the bare video frame's lower part (the burned-in subtitle). */
async function capture(page: Page): Promise<{ t: number; screen: string; frame: string; dom: string } | null> {
  const info = await page.evaluate(() => {
    const v = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
    const player = document.getElementById('movie_player');
    if (!v || !player || !v.videoWidth) return null;
    const r = player.getBoundingClientRect();
    const w = 960;
    const h = Math.round((v.videoHeight / v.videoWidth) * w);
    const top = Math.round(h * 0.55);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h - top;
    c.getContext('2d')!.drawImage(v, 0, (top / h) * v.videoHeight, v.videoWidth, v.videoHeight - (top / h) * v.videoHeight, 0, 0, w, h - top);
    const dom = [...document.querySelectorAll('.ast-subtitle-text, #subtitle-overlay-extension .subtitle-text')].map(e => (e as HTMLElement).innerText.trim()).filter(Boolean).join(' / ');
    return { t: v.currentTime, frame: c.toDataURL('image/jpeg', 0.7).split(',')[1], rect: { x: r.x, y: r.y, width: r.width, height: r.height }, dom };
  });
  if (!info) return null;
  const screen = (await page.screenshot({ clip: info.rect, type: 'jpeg', quality: 60 })).toString('base64');
  return { t: info.t, screen, frame: info.frame, dom: info.dom };
}

function ffmpeg(): string | null {
  const dir = path.join(CACHE, 'venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
  const exe = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.startsWith('ffmpeg') && f.endsWith('.exe')) : undefined;
  return exe ? path.join(dir, exe) : null;
}

for (const mode of MODES) for (const video of VIDEOS) {
  test(`screen: ${mode} on ${video.id}`, async ({ context, openPopup, configure, sw, server }) => {
    test.setTimeout(2_400_000);
    await configure({
      translationProvider: 'deepl',
      deeplApiKey: DEEPL_KEY,
      translationEngineMode: 'fast-then-best',
      claudeAccess: 'gateway',
      claudeGatewayUrl: `${server.url}/relay/anthropic`,
      claudeGatewayToken: 'relay',
      claudeGatewayAuth: 'bearer',
      sourceLanguage: 'ko',
      subtitleLanguage: 'ko',
      targetLanguage: 'en',
    });
    await clearTranslationState(sw);
    // SCREEN_STT_MODEL="onnx-community/whisper-small" (and SCREEN_STT_DTYPE as JSON) tries another speech model.
    await sw.evaluate(
      o => (o ? chrome.storage.local.set({ devSttModel: o }) : chrome.storage.local.remove('devSttModel')),
      process.env.SCREEN_STT_MODEL ? { model: process.env.SCREEN_STT_MODEL, ...(process.env.SCREEN_STT_DTYPE ? { dtype: JSON.parse(process.env.SCREEN_STT_DTYPE) } : {}) } : null
    );
    // SCREEN_DEBUG=1: the debug panel on screen (and its report per piece in the results).
    await sw.evaluate(on => chrome.storage.local.set({ debugPanel: on }), process.env.SCREEN_DEBUG === '1');
    await recordCaptionsOnEveryLoad(context); // YouTube navigates again right after loading
    const dir = path.join(OUT, `${mode}-${video.id}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const captured: (CapturedSample & { dom: string })[] = [];
    const paths: (string | null)[] = [];
    const health: unknown[] = [];
    let previous: Page | null = null;
    for (let k = 0; k < PIECES; k++) {
      const from = video.start + k * PIECE_S;
      console.log(`piece ${k}: ${mode} from ${from} s`);
      const page = await context.newPage(); // a new tab in the same window
      await page.goto(`https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(from - LEAD_IN_S)}s`);
      await park(page, from - LEAD_IN_S);
      await startMode(page, openPopup, mode, k === 0);
      // Starting in the new tab takes over from the old one (the supported flow); only then close it.
      await previous?.close();
      previous = null;
      await page.evaluate(() => void (document.querySelector('video.html5-main-video') as HTMLVideoElement).play());
      let last = -1;
      let stillSince = Date.now();
      for (;;) {
        const started = Date.now();
        const c = await capture(page);
        if (c) {
          if (c.t > last + 0.05) stillSince = Date.now();
          last = c.t;
          if (c.t >= from && c.t < from + PIECE_S) captured.push(c);
          if (c.t >= from + PIECE_S) break;
          if (mode === 'audio') paths.push(await page.evaluate(() => document.getElementById('subtitle-overlay-extension')?.dataset.path ?? null));
        }
        if (Date.now() - stillSince > 20_000) break; // YouTube stopped playing
        await page.waitForTimeout(Math.max(0, SAMPLE_MS - (Date.now() - started)));
      }
      await page.evaluate(() => (document.querySelector('video.html5-main-video') as HTMLVideoElement | null)?.pause()).catch(() => undefined);
      // Pipeline health for this piece: what Whisper returned and what the page did with it.
      health.push({
        piece: k,
        diag: await sw.evaluate(() => (self as any).__astAudioDiag?.() ?? null),
        transcripts: await sw.evaluate(() => ((self as any).__astTranscripts?.() ?? []).slice(-40)),
        overlay: await page.evaluate(() => {
          const o = document.getElementById('subtitle-overlay-extension');
          return o ? { path: o.dataset.path, raDropped: o.dataset.raDropped, raScheduled: o.dataset.raScheduled, raStats: o.dataset.raStats, dropped: o.dataset.dropped } : null;
        }),
        tap: await page.evaluate(() => (window as any).__astAudioTapStats ?? null),
        debugPanel: await page.evaluate(() => document.getElementById('ast-debug-panel')?.shadowRoot?.textContent ?? null),
      });
      previous = page;
    }
    await previous?.close();
    expect(captured.length, 'moments captured').toBeGreaterThan(20);

    // Keep the screenshots (and a video of them) for a person to look at.
    captured.forEach((c, i) => {
      fs.writeFileSync(path.join(dir, `screen-${String(i).padStart(4, '0')}.jpg`), Buffer.from(c.screen, 'base64'));
      fs.writeFileSync(path.join(dir, `frame-${String(i).padStart(4, '0')}.jpg`), Buffer.from(c.frame, 'base64'));
    });
    const ff = ffmpeg();
    if (ff) spawnSync(ff, ['-y', '-loglevel', 'error', '-framerate', '2', '-i', path.join(dir, 'screen-%04d.jpg'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', path.join(dir, 'screen.mp4')]);

    const samples: FrameSample[] = await readFrames(captured);
    const korean = lineTimeline(samples, 'burned');
    const overlay = lineTimeline(samples, 'overlay');
    const alignment = await alignLines(korean, overlay);
    const metrics = screenMetrics(samples, korean, overlay, alignment);
    // The page said a subtitle was shown, but none was visible on screen (or the reverse).
    const invisible = samples.filter((s, i) => captured[i].dom && !s.overlay).length / samples.length;
    const unexplained = samples.filter((s, i) => !captured[i].dom && s.overlay).length / samples.length;
    const report = {
      mode,
      video: video.id,
      window: [video.start, video.start + PIECES * PIECE_S],
      moments: samples.length,
      ...metrics,
      shownButNotVisible: invisible,
      visibleButNotInPage: unexplained,
      readAheadShare: paths.length ? paths.filter(p => p === 'read-ahead').length / paths.length : null,
      health,
      korean,
      overlay,
      alignment,
      samples: samples.map((s, i) => ({ ...s, dom: captured[i].dom || null })),
    };
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ mode, video: video.id, moments: samples.length, ...metrics, shownButNotVisible: invisible, readAheadShare: report.readAheadShare }));
  });
}
