// whisper.worker.ts - Loads the Whisper model off the main thread and transcribes PCM segments.
import { env, pipeline } from '@huggingface/transformers';
import { resolveModelConfig, ModelConfig, ModelOverrides } from './utils/modelConfig';
import { SerialQueue, QueuedJob } from './utils/serialQueue';

const ctx = self as unknown as Worker;

// The extension CSP only allows scripts from the extension itself, so ONNX
// Runtime's loader/wasm (copied to dist/ort/ at build time) must come from
// here rather than transformers.js's default CDN.
env.backends.onnx.wasm!.wasmPaths = new URL('ort/', self.location.href).href;
env.allowLocalModels = false;
env.useBrowserCache = true;

const SAMPLE_RATE = 16000;
// Segments waiting behind the one being transcribed. Beyond this the oldest
// are dropped so captions stay close to real time on slow machines.
const MAX_BACKLOG = 2;

interface TranscribeJob {
  audio: Float32Array;
  language: string;
  segmentId?: number;
}

let transcriberPromise: Promise<any> | null = null;
let activeConfig: ModelConfig | null = null;

async function hasWebGpu(): Promise<boolean> {
  const gpu = (self.navigator as any)?.gpu;
  if (!gpu) return false;
  try {
    // navigator.gpu can exist with no usable adapter, and an adapter can still
    // fail to create a device (driver/blocklist issues, missing D3D12 shader
    // compiler). Only a real device counts.
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    device.destroy();
    return true;
  } catch {
    return false;
  }
}

function loadPipeline(config: ModelConfig): Promise<any> {
  // Aggregate per-file download progress into one percentage.
  const files = new Map<string, { loaded: number; total: number }>();
  let lastReported = -1;
  const startedAt = performance.now();

  return pipeline('automatic-speech-recognition', config.model, {
    device: config.device,
    dtype: config.dtype as any,
    progress_callback: (p: any) => {
      if (p.status !== 'progress' || !p.file || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0;
      let total = 0;
      files.forEach(f => {
        loaded += f.loaded;
        total += f.total;
      });
      const percent = Math.floor((loaded / total) * 100);
      if (percent >= lastReported + 5) {
        lastReported = percent;
        ctx.postMessage({ type: 'progress', status: 'download-progress', percent });
      }
    }
  }).then((transcriber: any) => {
    let downloadBytes = 0;
    files.forEach(f => (downloadBytes += f.total));
    ctx.postMessage({
      type: 'progress',
      status: 'ready',
      model: config.model,
      device: config.device,
      loadMs: performance.now() - startedAt,
      downloadBytes,
      threads: env.backends.onnx.wasm!.numThreads,
      crossOriginIsolated: (self as any).crossOriginIsolated === true
    });
    return transcriber;
  });
}

/** Thrown when the model fails to load; carries the device so the host can retry on wasm. */
class ModelLoadError extends Error {
  constructor(message: string, readonly device: string) {
    super(message);
  }
}

async function loadModel(overrides: ModelOverrides): Promise<any> {
  const config = resolveModelConfig(await hasWebGpu(), overrides);
  activeConfig = config;
  if (overrides.numThreads) {
    env.backends.onnx.wasm!.numThreads = overrides.numThreads;
  }
  if (config.device === 'wasm') {
    ctx.postMessage({ type: 'progress', status: 'cpu-fallback' });
  }
  ctx.postMessage({ type: 'progress', status: 'downloading', model: config.model });

  try {
    return await loadPipeline(config);
  } catch (error) {
    // transformers.js caches the first session-creation promise for the life
    // of the worker, so a failed WebGPU load can't be retried on wasm here -
    // the host (offscreen.ts) restarts the worker with device: 'wasm' instead.
    throw new ModelLoadError(error instanceof Error ? error.message : String(error), config.device);
  }
}

async function getTranscriber(overrides: ModelOverrides = {}): Promise<any> {
  if (!transcriberPromise) {
    transcriberPromise = loadModel(overrides);
    // Let a failed load be retried on the next request instead of caching the rejection.
    transcriberPromise.catch(() => {
      transcriberPromise = null;
      activeConfig = null;
    });
  }
  return transcriberPromise;
}

ctx.onmessage = async (event: MessageEvent) => {
  const { type } = event.data;

  if (type === 'load') {
    try {
      await getTranscriber(event.data.overrides);
    } catch (error) {
      postError(error);
    }
    return;
  }

  if (type === 'transcribe') {
    const { audio, language, segmentId } = event.data as TranscribeJob;
    transcribeQueue.push({ audio, language, segmentId });
  }
};

const transcribeQueue = new SerialQueue<TranscribeJob>(
  transcribe,
  MAX_BACKLOG,
  job => ctx.postMessage({ type: 'dropped', segmentId: job.payload.segmentId }),
  () => performance.now()
);

async function transcribe(job: QueuedJob<TranscribeJob>): Promise<void> {
  const { audio, language, segmentId } = job.payload;
  try {
    const transcriber = await getTranscriber();
    // queueMs covers waiting behind earlier segments and for the model to load.
    const startedAt = performance.now();
    const result: any = await transcriber(audio, {
      // English-only checkpoints (*.en) reject language/task options.
      ...(activeConfig?.multilingual
        ? { language: language && language !== 'auto' ? language : undefined, task: 'transcribe' }
        : {})
    });
    const text = Array.isArray(result) ? (result[0]?.text ?? '') : (result.text ?? '');
    ctx.postMessage({
      type: 'result',
      text,
      segmentId,
      queueMs: startedAt - job.enqueuedAt,
      inferenceMs: performance.now() - startedAt,
      audioMs: (audio.length / SAMPLE_RATE) * 1000
    });
  } catch (error) {
    postError(error);
  }
}

function postError(error: unknown): void {
  ctx.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
    loadFailedOn: error instanceof ModelLoadError ? error.device : undefined
  });
}
