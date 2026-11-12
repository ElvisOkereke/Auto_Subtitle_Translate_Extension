import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/extension';
import { astTest } from '../helpers/bridge';

const BOX = { x: 0.2, y: 0.75, w: 0.6, h: 0.14 };

interface OverlayGeometry {
  overlay: { x: number; y: number; width: number; height: number };
  expected: { x: number; y: number; width: number; height: number };
  text: { x: number; y: number; width: number; height: number };
  fontSize: number;
  parentIsFullscreenElement: boolean;
}

async function geometry(page: Page): Promise<OverlayGeometry> {
  await page.waitForTimeout(150); // let ResizeObserver/fullscreenchange settle
  return astTest<OverlayGeometry>(page, 'overlay.rect');
}

function expectMatches(g: OverlayGeometry) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(g.overlay[k] - g.expected[k])).toBeLessThanOrEqual(1);
  }
  // text sits inside the tint box and fills most of it
  expect(g.text.x).toBeGreaterThanOrEqual(g.overlay.x - 1);
  expect(g.text.y).toBeGreaterThanOrEqual(g.overlay.y - 1);
  expect(g.text.x + g.text.width).toBeLessThanOrEqual(g.overlay.x + g.overlay.width + 1);
  expect(g.text.y + g.text.height).toBeLessThanOrEqual(g.overlay.y + g.overlay.height + 1);
  expect(g.text.width / g.overlay.width >= 0.7 || g.text.height / g.overlay.height >= 0.7).toBe(true);
}

test('overlay covers the drawn box and follows resize and fullscreen', async ({ context, fixtureURL }) => {
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
  await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 1);
  // Park on a frame with a real burned-in subtitle ("탑 카밀일 수도 있긴 한데", 7.23-8.57 s).
  await page.evaluate(async () => {
    const v = (window as any).__fixture.video as HTMLVideoElement;
    v.currentTime = 7.6;
    await new Promise(r => v.addEventListener('seeked', r, { once: true }));
  });
  await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 2);

  await astTest(page, 'overlay.show', { text: 'It could be top Camille though', box: BOX });
  const initial = await geometry(page);
  expectMatches(initial);
  await page.screenshot({ path: test.info().outputPath('overlay.png') });

  await page.setViewportSize({ width: 900, height: 600 });
  const resized = await geometry(page);
  expectMatches(resized);
  expect(resized.overlay.width).toBeLessThan(initial.overlay.width);

  await page.click('#fs-btn');
  await page.waitForFunction(() => !!document.fullscreenElement);
  const fullscreen = await geometry(page);
  expectMatches(fullscreen);
  expect(fullscreen.parentIsFullscreenElement).toBe(true);
  await page.screenshot({ path: test.info().outputPath('overlay-fullscreen.png') });

  await astTest(page, 'overlay.clear');
  expect(await page.locator('.ast-subtitle-overlay').isVisible()).toBe(false);
});

test('saved subtitle timelines live in the extension, not the website', async ({ context, fixtureURL }) => {
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
  await astTest(page, 'timeline.save', { videoId: 'vidX', lines: [{ start: 1, end: 2, source: '하나', translation: 'One', quality: 'fast' }] });
  expect(await astTest(page, 'timeline.load', { videoId: 'vidX' })).toEqual([{ start: 1, end: 2, source: '하나', translation: 'One', quality: 'fast' }]);
  // The page's own origin must not hold (or be able to read) the subtitle database.
  const pageDbs = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
  expect(pageDbs).not.toContain('ast-subtitles');
  await astTest(page, 'timeline.clear', {});
  expect(await astTest(page, 'timeline.load', { videoId: 'vidX' })).toEqual([]);
});

test('a website embedding the OCR frame cannot use it', async ({ context, fixtureURL, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
  await astTest(page, 'timeline.save', { videoId: 'secretVid', lines: [{ start: 1, end: 2, source: '비밀', translation: 'secret', quality: 'fast' }] });
  // Hostile page script: embed the web-accessible frame and try to talk to it directly.
  const reply = await page.evaluate(async id => {
    const f = document.createElement('iframe');
    f.src = `chrome-extension://${id}/ocr-frame.html`;
    document.body.appendChild(f);
    await new Promise(r => f.addEventListener('load', r, { once: true }));
    const ch = new MessageChannel();
    const got = new Promise(resolve => {
      ch.port1.onmessage = e => resolve(e.data);
      setTimeout(() => resolve('no reply'), 1500);
    });
    f.contentWindow!.postMessage({ type: 'ast-ocr-port', nonce: 'guess' }, '*', [ch.port2]);
    ch.port1.postMessage({ type: 'timeline.load', id: 1, videoId: 'secretVid' });
    return got;
  }, extensionId);
  expect(reply).toBe('no reply');
});
