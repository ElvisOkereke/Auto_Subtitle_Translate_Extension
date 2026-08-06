// whisper.worker.ts - Loads the Whisper model off the main thread and transcribes PCM segments.
import { pipeline } from '@huggingface/transformers';

const ctx = self as unknown as Worker;

let transcriberPromise: Promise<any> | null = null;

function hasWebGpu(): boolean {
  return typeof (self as any).navigator !== 'undefined' && !!(self as any).navigator.gpu;
}

async function getTranscriber(): Promise<any> {
  if (!transcriberPromise) {
    const device = hasWebGpu() ? 'webgpu' : 'wasm';
    if (device === 'wasm') {
      ctx.postMessage({ type: 'progress', status: 'cpu-fallback' });
    }
    ctx.postMessage({ type: 'progress', status: 'downloading' });

    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
      device
    }).then((transcriber: any) => {
      ctx.postMessage({ type: 'progress', status: 'ready' });
      return transcriber;
    });
  }
  return transcriberPromise;
}

ctx.onmessage = async (event: MessageEvent) => {
  const { type } = event.data;

  if (type === 'load') {
    try {
      await getTranscriber();
    } catch (error) {
      ctx.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (type === 'transcribe') {
    const { audio, language } = event.data as { audio: Float32Array; language: string };
    try {
      const transcriber = await getTranscriber();
      const result: any = await transcriber(audio, {
        language: language && language !== 'auto' ? language : undefined,
        task: 'transcribe'
      });
      const text = Array.isArray(result) ? (result[0]?.text ?? '') : (result.text ?? '');
      ctx.postMessage({ type: 'result', text });
    } catch (error) {
      ctx.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
};
