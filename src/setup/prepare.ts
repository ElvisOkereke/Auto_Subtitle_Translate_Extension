// prepare.ts - gets this computer ready before anyone needs it: downloads the
// models and, for the speech model on a GPU, does the one-time setup that takes
// minutes the first time (later loads take seconds). It drives the very workers
// the modes use, from an extension page (same origin, so the same model cache
// and the same GPU shader cache), and runs one warm-up job through each.
import type { SpeechModel, ModelOverrides } from '../utils/modelConfig';
import type { SubtitleLanguage } from '../subtitle/types';

export type SpeechProgress =
  | { phase: 'download'; percent: number }
  | { phase: 'gpu-setup' } // downloaded; setting up on the GPU (first time: minutes)
  | { phase: 'cpu-fallback' } // the GPU could not run it: the CPU model instead
  | { phase: 'warm-up' };

export interface SpeechReady {
  model: string;
  device: 'webgpu' | 'wasm';
  loadMs: number;
  /** The first transcription after loading (compiles the rest of the GPU work). */
  warmMs: number;
}

/** No download progress for this long: the download is stuck. */
const DOWNLOAD_STALL_MS = 180_000;

/** Two seconds of tone and noise: enough to run the encoder and a few decoder steps. */
function warmUpAudio(): Float32Array {
  const audio = new Float32Array(32_000);
  for (let i = 0; i < audio.length; i++) audio[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / 16_000) + 0.02 * (Math.random() - 0.5);
  return audio;
}

export function prepareSpeech(speechModel: SpeechModel, onProgress: (p: SpeechProgress) => void, overrides: ModelOverrides = {}): Promise<SpeechReady> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    let loaded: { model: string; device: 'webgpu' | 'wasm'; loadMs: number } | null = null;
    let warmStarted = 0;
    let phase: 'download' | 'setup' = 'download';
    let lastProgress = Date.now();
    const stallTimer = setInterval(() => {
      if (phase === 'download' && Date.now() - lastProgress > DOWNLOAD_STALL_MS) finish(new Error('The download stopped making progress. Check your connection and try again.'));
    }, 5000);
    const finish = (error: Error | null, result?: SpeechReady) => {
      clearInterval(stallTimer);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const start = (o: ModelOverrides) => {
      worker = new Worker(chrome.runtime.getURL('whisper.worker.js'));
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        lastProgress = Date.now();
        if (msg.type === 'progress') {
          if (msg.status === 'download-progress') onProgress({ phase: 'download', percent: msg.percent ?? 0 });
          else if (msg.status === 'cpu-fallback') onProgress({ phase: 'cpu-fallback' });
          else if (msg.status === 'preparing') {
            phase = 'setup';
            if (msg.device === 'webgpu') onProgress({ phase: 'gpu-setup' });
          } else if (msg.status === 'ready') {
            phase = 'setup';
            loaded = { model: msg.model, device: msg.device, loadMs: msg.loadMs ?? 0 };
            onProgress({ phase: 'warm-up' });
            warmStarted = performance.now();
            worker.postMessage({ type: 'transcribe', audio: warmUpAudio(), language: 'en', segmentId: 1 });
          }
        } else if (msg.type === 'result' && loaded) {
          finish(null, { ...loaded, warmMs: performance.now() - warmStarted });
        } else if (msg.type === 'error') {
          if (msg.loadFailedOn === 'webgpu' && o.device !== 'wasm') {
            // Same recovery as Audio mode: a failed GPU load poisons the worker; start over on the CPU.
            worker.terminate();
            onProgress({ phase: 'cpu-fallback' });
            start({ ...o, device: 'wasm' });
            return;
          }
          finish(new Error(msg.message || 'The speech model could not be prepared.'));
        }
      };
      worker.postMessage({ type: 'load', overrides: o, speechModel });
    };
    start(overrides);
  });
}

const SAMPLE_TEXT: Record<string, string> = {
  ko: '자막을 읽을 준비가 됐어요',
  ja: '字幕を読む準備ができました',
  'zh-Hans': '字幕准备好了',
  'zh-Hant': '字幕準備好了',
  ru: 'Субтитры готовы',
};

/** A dark frame with a light subtitle line, so the warm-up runs detection and recognition. */
async function sampleSubtitle(lang: SubtitleLanguage): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(960, 120);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#202020';
  g.fillRect(0, 0, 960, 120);
  g.fillStyle = '#ffffff';
  g.font = 'bold 56px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(SAMPLE_TEXT[lang] ?? 'Subtitles are ready', 480, 60);
  return createImageBitmap(canvas);
}

/** Downloads and loads the subtitle reader (OCR) for `lang`, then reads one sample line. */
export function prepareOcr(lang: SubtitleLanguage): Promise<{ device: string; ms: number }> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    const start = (device?: 'wasm') => {
      worker = new Worker(chrome.runtime.getURL('ocr.worker.js'));
      worker.onmessage = async (event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === 'ready') worker.postMessage({ type: 'preload', id: 1, lang });
        else if (msg.type === 'preloaded') {
          const bitmap = await sampleSubtitle(lang);
          worker.postMessage({ type: 'recognize', id: 2, lang, bitmap }, [bitmap]);
        }
        else if (msg.type === 'result') {
          worker.terminate();
          resolve({ device: msg.device, ms: performance.now() - startedAt });
        } else if (msg.type === 'error') {
          worker.terminate();
          if (msg.loadFailedOn === 'webgpu' && !device) start('wasm');
          else reject(new Error(msg.message || 'The subtitle reader could not be prepared.'));
        }
      };
      worker.postMessage({ type: 'init', device });
    };
    start();
  });
}
