import fs from 'node:fs';
import path from 'node:path';
import { test } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';

// Read-ahead spike (Task 8): facts about real YouTube in installed Chrome.
// Run: E2E_BROWSER=chrome npx playwright test --project=perf e2e/tests/spike-readahead.spec.ts
test.use({ profileDir: path.join(CACHE, 'profile-youtube-spike') });

test('YouTube MSE facts', async ({ context }) => {
  test.setTimeout(240_000);
  await context.addInitScript(() => {
    const w = window as any;
    w.__mse = { buffers: [] as any[] };
    const origAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime: string) {
      const sb = origAdd.call(this, mime);
      const rec = { mime, appends: 0, bytes: 0 };
      w.__mse.buffers.push(rec);
      const origAppend = sb.appendBuffer.bind(sb);
      sb.appendBuffer = (data: BufferSource) => {
        rec.appends++;
        rec.bytes += (data as ArrayBuffer).byteLength ?? (data as ArrayBufferView).byteLength;
        return origAppend(data);
      };
      return sb;
    };
  });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=_zIrbXw-SVs&t=540s');
  await page.waitForSelector('video', { timeout: 30_000 });
  const samples: any[] = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    samples.push(
      await page.evaluate(() => {
        const v = document.querySelector('video') as HTMLVideoElement;
        if (v.paused) v.play().catch(() => undefined);
        const b = v.buffered;
        return {
          t: +v.currentTime.toFixed(1),
          ahead: b.length ? +(b.end(b.length - 1) - v.currentTime).toFixed(1) : 0,
          res: `${v.videoWidth}x${v.videoHeight}`,
          ad: !!document.querySelector('.ad-showing'),
          error: !!document.querySelector('.ytp-error'),
          buffers: (window as any).__mse.buffers,
        };
      })
    );
    console.log(JSON.stringify(samples[samples.length - 1]));
  }
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'e2e/.perf/readahead-spike-youtube.json'), JSON.stringify(samples, null, 2));
  await page.screenshot({ path: test.info().outputPath('youtube.png') });
});

test('approach b: tap + decode MSE segments ahead (YouTube)', async ({ context }) => {
  test.setTimeout(180_000);
  await context.addInitScript({ path: path.join(ROOT, 'e2e/fixtures/spike/mse-tap.js') });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=_zIrbXw-SVs&t=540s');
  await page.waitForSelector('video', { timeout: 30_000 });
  const rows: any[] = [];
  const start = Date.now();
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(3000);
    const row = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      if (v.paused) v.play().catch(() => undefined);
      const tap = (window as any).__tap;
      return { t: +v.currentTime.toFixed(1), decodedUpTo: +tap.maxDecodedTime.toFixed(1), lead: +(tap.maxDecodedTime - v.currentTime).toFixed(1), decoded: tap.decoded, sampledFrames: tap.sampledFrames, decodeCallMs: +tap.decodeMs.toFixed(0), codec: tap.codec, errors: tap.errors.slice(0, 2), ytError: !!document.querySelector('.ytp-error') };
    });
    rows.push({ wall: (Date.now() - start) / 1000, ...row });
    console.log(JSON.stringify(rows[rows.length - 1]));
    if (row.ytError) break;
  }
  fs.writeFileSync(path.join(ROOT, 'e2e/.perf/readahead-spike-tap.json'), JSON.stringify(rows, null, 2));
});

test('approach a: hidden second player (YouTube embed) feasibility', async ({ context }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=_zIrbXw-SVs&t=540s');
  await page.waitForSelector('video', { timeout: 30_000 });
  // Shadow player 30 s ahead in an off-screen 1920x1080 iframe (same origin as the watch page).
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.id = 'shadow';
    f.src = 'https://www.youtube.com/embed/_zIrbXw-SVs?start=570&autoplay=1&mute=1&controls=0&playsinline=1';
    f.allow = 'autoplay';
    f.style.cssText = 'position:fixed;left:-3000px;top:0;width:1920px;height:1080px;';
    document.body.appendChild(f);
  });
  const rows: any[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(3000);
    const frame = page.frame({ url: /youtube\.com\/embed/ });
    const shadow = frame
      ? await frame.evaluate(() => {
          const v = document.querySelector('video') as HTMLVideoElement | null;
          if (v?.paused) v.play().catch(() => undefined);
          return v ? { t: +v.currentTime.toFixed(1), res: `${v.videoWidth}x${v.videoHeight}`, paused: v.paused, error: !!document.querySelector('.ytp-error'), ad: !!document.querySelector('.ad-showing') } : null;
        }).catch(e => ({ evalError: String(e).slice(0, 80) }))
      : null;
    const main = await page.evaluate(() => +(document.querySelector('video') as HTMLVideoElement).currentTime.toFixed(1));
    rows.push({ main, shadow });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
  fs.writeFileSync(path.join(ROOT, 'e2e/.perf/readahead-spike-shadow.json'), JSON.stringify(rows, null, 2));
});
