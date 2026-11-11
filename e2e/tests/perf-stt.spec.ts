import fs from 'node:fs';
import path from 'node:path';
import { test } from '../helpers/extension';
import { CACHE, ROOT } from '../helpers/paths';
import { wordErrorRate } from '../helpers/wer';
import { browserKind } from '../helpers/launch';

// Speech-to-text benchmark: runs the real whisper.worker.js inside an
// extension page and measures model load, inference latency, real-time factor
// and accuracy for several model/device/precision choices.
//
//   npm run perf:stt                      # full matrix
//   PERF_CONFIGS=base-wasm-q8 npm run perf:stt
//
// Results: e2e/.perf/perf-stt.json (+ a table on stdout).

test.use({ profileDir: path.join(CACHE, `profile-perf-${browserKind()}`) });

interface Config {
  id: string;
  overrides: Record<string, unknown>;
}

const CONFIGS: Config[] = [
  // Baseline: what the extension shipped with (whisper-small, default dtype -> fp32 on WebGPU).
  { id: 'baseline-small-webgpu-fp32', overrides: { model: 'Xenova/whisper-small', device: 'webgpu', dtype: 'fp32' } },
  { id: 'small-wasm-q8', overrides: { model: 'onnx-community/whisper-small', device: 'wasm', dtype: 'q8' } },
  { id: 'small-webgpu-mixed', overrides: { model: 'onnx-community/whisper-small', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } },
  { id: 'base-webgpu-mixed', overrides: { model: 'onnx-community/whisper-base', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } },
  { id: 'base-wasm-q8', overrides: { model: 'onnx-community/whisper-base', device: 'wasm', dtype: 'q8' } },
  { id: 'tiny-wasm-q8', overrides: { model: 'onnx-community/whisper-tiny', device: 'wasm', dtype: 'q8' } },
  { id: 'base-wasm-q8-1thread', overrides: { model: 'onnx-community/whisper-base', device: 'wasm', dtype: 'q8', numThreads: 1 } },
];

const CLIPS = [
  { file: 'hello.wav', reference: 'Hello world. The weather is very nice today.' },
  { file: 'sentences.wav', reference: 'Good morning everyone. Thank you for coming to the meeting. Please open your books to page ten.' },
];

const RUNS = 3;

test('speech-to-text benchmark', async ({ context, extensionId, fixtureURL }) => {
  const selected = process.env.PERF_CONFIGS?.split(',');
  const configs = selected ? CONFIGS.filter(c => selected.includes(c.id)) : CONFIGS;
  const page = await context.newPage();
  page.on('console', m => m.type() === 'error' && console.log('  page error:', m.text().slice(0, 200)));
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);

  const results: any[] = [];
  for (const config of configs) {
    console.log(`\n== ${config.id}`);
    const result = await page.evaluate(
      async ({ config, clips, runs, base }) => {
        async function decode(file: string): Promise<Float32Array> {
          const buf = await (await fetch(`${base}/audio/${file}`)).arrayBuffer();
          const ac = new OfflineAudioContext(1, 1, 16000);
          const audio = await ac.decodeAudioData(buf);
          return audio.getChannelData(0).slice();
        }
        function startWorker() {
          const w = new Worker(chrome.runtime.getURL('whisper.worker.js'));
          const call = (msg: any, until: (d: any) => boolean) =>
            new Promise<any>((resolve, reject) => {
              const t = setTimeout(() => reject(new Error('worker timeout')), 900_000);
              w.onmessage = e => {
                if (e.data.type === 'error') { clearTimeout(t); reject(new Error(e.data.message)); }
                else if (until(e.data)) { clearTimeout(t); resolve(e.data); }
              };
              w.postMessage(msg);
            });
          return { w, call };
        }
        const load = (call: any) => call({ type: 'load', overrides: config.overrides }, (d: any) => d.status === 'ready');

        // First load may download; second (fresh worker) measures load-from-cache.
        let worker = startWorker();
        const first = await load(worker.call);
        worker.w.terminate();
        worker = startWorker();
        const warm = await load(worker.call);

        const clipResults = [];
        for (const clip of clips) {
          const audio = await decode(clip.file);
          const timings: number[] = [];
          let text = '';
          for (let i = 0; i < runs; i++) {
            const copy = audio.slice();
            const r = await worker.call({ type: 'transcribe', audio: copy, language: 'en' }, (d: any) => d.type === 'result');
            timings.push(r.inferenceMs);
            text = r.text;
          }
          clipResults.push({ file: clip.file, audioMs: (audio.length / 16000) * 1000, timings, text });
        }
        worker.w.terminate();
        return {
          firstLoadMs: first.loadMs,
          warmLoadMs: warm.loadMs,
          downloadBytes: first.downloadBytes || warm.downloadBytes,
          device: warm.device,
          threads: warm.threads,
          crossOriginIsolated: warm.crossOriginIsolated,
          clips: clipResults,
        };
      },
      { config, clips: CLIPS, runs: RUNS, base: fixtureURL }
    ).catch((e: Error) => ({ error: e.message }));

    if ('error' in result) {
      console.log(`  FAILED: ${result.error}`);
      results.push({ id: config.id, error: result.error });
      continue;
    }
    const clips = result.clips.map((c: any, i: number) => {
      const sorted = [...c.timings].sort((a: number, b: number) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      // First run includes shader compilation / warm-up.
      return {
        file: c.file,
        audioMs: Math.round(c.audioMs),
        firstRunMs: Math.round(c.timings[0]),
        medianMs: Math.round(median),
        rtf: +(median / c.audioMs).toFixed(3),
        wer: +wordErrorRate(CLIPS[i].reference, c.text).toFixed(3),
        text: c.text.trim(),
      };
    });
    const row = { id: config.id, ...result, clips };
    results.push(row);
    console.log(
      `  load: first ${Math.round(result.firstLoadMs)}ms, cached ${Math.round(result.warmLoadMs)}ms, ` +
        `download ${(result.downloadBytes / 1e6).toFixed(0)}MB, device ${result.device}, threads ${result.threads}, COI ${result.crossOriginIsolated}`
    );
    for (const c of clips) {
      console.log(`  ${c.file}: median ${c.medianMs}ms (first ${c.firstRunMs}ms) for ${c.audioMs}ms audio, RTF ${c.rtf}, WER ${c.wer} :: "${c.text}"`);
    }
  }

  const out = path.join(ROOT, 'e2e/.perf/perf-stt.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const existing = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
  for (const r of results) existing[r.id] = { ...r, measuredAt: new Date().toISOString() };
  fs.writeFileSync(out, JSON.stringify(existing, null, 2));
});
