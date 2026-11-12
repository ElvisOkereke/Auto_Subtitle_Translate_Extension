// ocr.worker.ts - PaddleOCR (PP-OCRv5) detection + recognition on subtitle crops.
// Hosted by ocr-frame.html (extension origin, so WebGPU and the extension CSP apply).
import * as ort from 'onnxruntime-web/webgpu';
import { ctcGreedyDecode } from './ctc';
import { detBoxes, detInputSize, filterSubtitleBoxes, groupLines, Box } from './detect';
import { modelFor } from './models';
import { ConsecutiveFailures, PromiseCache } from './sessionCache';
import { verifySha256 } from './integrity';
import type { SubtitleLanguage } from '../subtitle/types';

const ctx = self as unknown as Worker;

// ONNX Runtime's loader/wasm ship in dist/ort/ (same files the Whisper worker uses).
ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;
ort.env.logLevel = 'error';

const MODEL_CACHE = 'ast-ocr-models';
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 3200;

let device: 'webgpu' | 'wasm' = 'wasm';
// Failed loads are evicted (a download blip must not disable OCR until reload).
const detSessions = new PromiseCache<ort.InferenceSession>();
const recSessions = new PromiseCache<{ session: ort.InferenceSession; charset: string[] }>();
// Inference that keeps failing on the GPU (device lost, driver reset) moves OCR to wasm.
const GPU_RUN_FAILURE_LIMIT = 3;
const gpuRunFailures = new ConsecutiveFailures(GPU_RUN_FAILURE_LIMIT);

async function hasWebGpu(): Promise<boolean> {
  const gpu = (self.navigator as any)?.gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    (await adapter.requestDevice()).destroy();
    return true;
  } catch {
    return false;
  }
}

async function fetchModel(url: string, sha256: string): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE);
  const cached = await cache.match(url);
  if (cached) {
    const data = await cached.arrayBuffer();
    try {
      await verifySha256(data, sha256, url);
      return data;
    } catch {
      await cache.delete(url); // corrupted cache entry: download again
    }
  }
  const fresh = await fetch(url);
  if (!fresh.ok) throw new Error(`Model download failed (${fresh.status}): ${url}`);
  const data = await fresh.arrayBuffer();
  await verifySha256(data, sha256, url);
  await cache.put(url, new Response(data));
  return data;
}

/** Failure to create a session on the chosen device: the host may retry on wasm. */
class SessionCreateError extends Error {}

async function createSession(url: string, sha256: string): Promise<ort.InferenceSession> {
  const model = new Uint8Array(await fetchModel(url, sha256));
  try {
    // logSeverityLevel 3 = errors only (the exported models trigger harmless graph-cleanup warnings).
    return await ort.InferenceSession.create(model, { executionProviders: [device], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  } catch (error) {
    throw new SessionCreateError(error instanceof Error ? error.message : String(error));
  }
}

function getDet(lang: SubtitleLanguage) {
  const { det, detSha256 } = modelFor(lang);
  return detSessions.get(det, () => createSession(det, detSha256));
}

function getRec(lang: SubtitleLanguage) {
  const { rec, recSha256, charset } = modelFor(lang);
  return recSessions.get(rec, () =>
    Promise.all([
      createSession(rec, recSha256),
      fetch(new URL(charset, self.location.href).href).then(r => {
        if (!r.ok) throw new Error(`Charset load failed (${r.status})`);
        return r.json() as Promise<string[]>;
      }),
    ]).then(([session, chars]) => ({ session, charset: chars }))
  );
}

/** Draws (a region of) the bitmap at the given size and returns NCHW float data in BGR order. */
function toTensor(
  bitmap: ImageBitmap,
  region: Box,
  width: number,
  height: number,
  normalize: (v: number, channel: number) => number
): ort.Tensor {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bitmap, region.x1, region.y1, region.x2 - region.x1, region.y2 - region.y1, 0, 0, width, height);
  const { data } = g.getImageData(0, 0, width, height);
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    // BGR channel order, as PaddleOCR's preprocessing (DecodeImage img_mode: BGR).
    out[i] = normalize(data[i * 4 + 2], 0);
    out[plane + i] = normalize(data[i * 4 + 1], 1);
    out[2 * plane + i] = normalize(data[i * 4], 2);
  }
  return new ort.Tensor('float32', out, [1, 3, height, width]);
}

async function recognize(bitmap: ImageBitmap, lang: SubtitleLanguage): Promise<{ text: string; confidence: number }> {
  const full: Box = { x1: 0, y1: 0, x2: bitmap.width, y2: bitmap.height };
  const det = await getDet(lang);
  const size = detInputSize(bitmap.width, bitmap.height);
  const detIn = toTensor(bitmap, full, size.width, size.height, (v, c) => (v / 255 - DET_MEAN[c]) / DET_STD[c]);
  const detOut = (await det.run({ [det.inputNames[0]]: detIn }))[det.outputNames[0]];
  const [, , mh, mw] = detOut.dims as number[];
  const sx = bitmap.width / mw;
  const sy = bitmap.height / mh;
  const boxes = detBoxes(detOut.data as Float32Array, mw, mh).map(b => ({
    x1: b.x1 * sx,
    y1: b.y1 * sy,
    x2: b.x2 * sx,
    y2: b.y2 * sy,
  }));
  const lines = groupLines(filterSubtitleBoxes(boxes, bitmap.height));
  if (!lines.length) return { text: '', confidence: 0 };

  const { session, charset } = await getRec(lang);
  const texts: string[] = [];
  const confidences: number[] = [];
  for (const line of lines) {
    const parts: string[] = [];
    for (const box of line) {
      const w = box.x2 - box.x1;
      const h = box.y2 - box.y1;
      const targetW = Math.min(REC_MAX_WIDTH, Math.max(16, Math.ceil((REC_HEIGHT * w) / h)));
      const recIn = toTensor(bitmap, box, targetW, REC_HEIGHT, v => (v / 255 - 0.5) / 0.5);
      const recOut = (await session.run({ [session.inputNames[0]]: recIn }))[session.outputNames[0]];
      const [, steps, classes] = recOut.dims as number[];
      const decoded = ctcGreedyDecode(recOut.data as Float32Array, steps, classes, charset);
      if (decoded.text) {
        parts.push(decoded.text);
        confidences.push(decoded.confidence);
      }
    }
    if (parts.length) texts.push(parts.join(' '));
  }
  const text = texts.join(' ').replace(/\s+/g, ' ').trim();
  return { text, confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0 };
}

let ready: Promise<void> | null = null;
function init(forceDevice?: 'wasm'): Promise<void> {
  ready ??= (async () => {
    device = forceDevice ?? ((await hasWebGpu()) ? 'webgpu' : 'wasm');
  })();
  return ready;
}

// ORT sessions can't run concurrently ("Session already started"), and live and
// read-ahead reads can overlap: run every request strictly one after another.
let chain: Promise<void> = Promise.resolve();

ctx.onmessage = (event: MessageEvent) => {
  chain = chain.then(() => handle(event.data));
};

async function handle(msg: any): Promise<void> {
  try {
    if (msg.type === 'init') {
      await init(msg.device);
      ctx.postMessage({ type: 'ready', device });
    } else if (msg.type === 'preload') {
      await init();
      await Promise.all([getDet(msg.lang), getRec(msg.lang)]);
      ctx.postMessage({ type: 'preloaded', id: msg.id, device });
    } else if (msg.type === 'recognize') {
      await init();
      const started = performance.now();
      const result = await recognize(msg.bitmap, msg.lang);
      msg.bitmap.close();
      gpuRunFailures.success();
      ctx.postMessage({ type: 'result', id: msg.id, ...result, ms: performance.now() - started, device });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only a failure to create a WebGPU session means the GPU path is unusable
    // (it also poisons this worker's ORT state); the host then restarts us on wasm.
    // So does inference failing repeatedly on the GPU.
    const runFailed = msg.type === 'recognize' && !(error instanceof SessionCreateError);
    const gpuUnusable = device === 'webgpu' && (error instanceof SessionCreateError || (runFailed && gpuRunFailures.failure()));
    ctx.postMessage({ type: 'error', id: msg.id, message, loadFailedOn: gpuUnusable ? 'webgpu' : undefined });
  }
}
