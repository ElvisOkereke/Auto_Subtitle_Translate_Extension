import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { astTest } from '../helpers/bridge';
import { charErrorRate } from '../helpers/cer';

// OCR through the real extension path: content script -> hidden extension iframe
// -> ocr.worker (PaddleOCR via ONNX Runtime Web). Crops: npm run fixtures:video,
// then e2e/scripts/export_crops.py.
test.use({ profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });

interface Crop { file: string; stretch: string; ko: string | null }
const crops: Crop[] = JSON.parse(fs.readFileSync(path.join(CACHE, 'ocr-crops/index.json'), 'utf8'));

test('recognizes the Korean subtitles of stretch s1', async ({ context, fixtureURL }) => {
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
  await astTest(page, 'ocr.preload', { lang: 'ko' }); // downloads models on the first run

  let errors = 0;
  let length = 0;
  let falsePositives = 0;
  const workerMs: number[] = [];
  const failures: string[] = [];
  for (const crop of crops.filter(c => c.stretch === 's1')) {
    const result = await astTest<{ text: string; confidence: number; ms: number }>(page, 'ocr', {
      bitmapUrl: `${fixtureURL}/crops/${crop.file}`,
      lang: 'ko',
    });
    workerMs.push(result.ms);
    if (crop.ko === null) {
      if (result.text) {
        falsePositives++;
        failures.push(`false positive ${crop.file}: ${result.text}`);
      }
      continue;
    }
    const cer = charErrorRate(crop.ko, result.text);
    errors += cer.errors;
    length += cer.length;
    if (cer.errors) failures.push(`${cer.errors}/${cer.length} "${crop.ko}" -> "${result.text}"`);
  }
  const sorted = [...workerMs].sort((a, b) => a - b);
  const report = {
    browser: browserKind(),
    cer: errors / length,
    falsePositives,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p90Ms: sorted[Math.floor(sorted.length * 0.9)],
    failures,
  };
  console.log(JSON.stringify(report, null, 1));
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `e2e/.perf/subtitle-ocr-${browserKind()}.json`), JSON.stringify(report, null, 2));

  expect(report.cer).toBeLessThanOrEqual(0.1);
  expect(falsePositives).toBe(0);
  // Latency target applies to real Chrome with WebGPU (Playwright's Chromium lacks the D3D12 compiler).
  if (browserKind() === 'chrome') expect(report.medianMs).toBeLessThanOrEqual(250);
});

test('concurrent OCR requests all succeed and keep the GPU path', async ({ context, fixtureURL }) => {
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
  await astTest(page, 'ocr.preload', { lang: 'ko' });
  const subs = crops.filter(c => c.stretch === 's1' && c.ko).slice(0, 6);
  // Live and read-ahead reads can overlap; the worker must serialize them itself.
  const results = await Promise.all(
    subs.map(c => astTest<{ text: string; device: string }>(page, 'ocr', { bitmapUrl: `${fixtureURL}/crops/${c.file}`, lang: 'ko' }))
  );
  results.forEach((r, i) => expect(charErrorRate(subs[i].ko!, r.text).errors).toBeLessThanOrEqual(3));
  const expectedDevice = browserKind() === 'chrome' ? 'webgpu' : 'wasm';
  expect(results.map(r => r.device)).toEqual(subs.map(() => expectedDevice));
});
