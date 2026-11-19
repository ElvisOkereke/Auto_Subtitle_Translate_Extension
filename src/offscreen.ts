// offscreen.ts - Captures tab audio, segments speech via VAD, and relays segments to the Whisper worker.
import { ExtensionMessage } from './types';
import { SpeechSegmenter, DEFAULT_VAD_CONFIG } from './utils/vad';
import { ReadAheadPipeline } from './audio/readAheadPipeline';
import { fromInt16Base64 } from './audio/readAhead/pcm';
import { isLikelyHallucination, isNonSpeech } from './audio/nonSpeech';
import { ModelWatchdog } from './audio/modelWatchdog';
import { createBuiltinHost } from './translation/builtinHost';
import type { BuiltinHost } from './translation/engines/builtin';

// Chrome's built-in translator lives here: the API isn't available in the service worker.
const builtinHosts: { real?: BuiltinHost; stub?: BuiltinHost } = {};
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'BUILTIN_TRANSLATE') return false;
  if (sender.id !== chrome.runtime.id || sender.tab) return false; // the background only
  const host = message.stub ? (builtinHosts.stub ??= createBuiltinHost(undefined, { stub: true })) : (builtinHosts.real ??= createBuiltinHost());
  host({ text: String(message.text ?? ''), source: String(message.source ?? 'auto'), target: String(message.target ?? 'en') }).then(sendResponse, error =>
    sendResponse({ error: String(error) })
  );
  return true;
});

// 1024 samples = 64 ms per frame: fine-grained enough that end-of-speech is
// detected promptly (4096 = 256 ms added up to ~200 ms of caption latency).
const FRAME_SIZE = 1024;
const SAMPLE_RATE = 16000;
const FRAME_DURATION_MS = (FRAME_SIZE / SAMPLE_RATE) * 1000;

let playbackContext: AudioContext | null = null;
let captureContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let worker: Worker | null = null;
let segmenter: SpeechSegmenter | null = null;
let currentSourceLanguage = 'auto';
let segmentCounter = 0;
// Set after a WebGPU model load fails, so the replacement worker uses the CPU.
let workerOverrides: { device?: 'wasm'; model?: string; dtype?: unknown } = {};
/** Settings: Audio mode's speech model on a GPU ('turbo' or 'small'). */
let speechModel: string | undefined;

/** A model load that stalls (no progress, no error) is retried once, then reported. */
const watchdog = new ModelWatchdog();

function restartWorker(status: string): void {
  worker?.terminate();
  worker = null;
  chrome.runtime.sendMessage({ type: 'MODEL_LOADING_PROGRESS', status }).catch(() => undefined);
  getWorker();
}

function checkModelLoad(): void {
  const verdict = watchdog.check(Date.now());
  if (verdict === 'retry-fresh') {
    console.warn('Speech model download stalled; retrying with a fresh download');
    worker?.terminate();
    worker = null;
    // A partly downloaded or corrupted model in the cache can stall every later load.
    void caches
      .delete('transformers-cache')
      .catch(() => false)
      .then(() => restartWorker('retrying'));
  } else if (verdict === 'retry') {
    // Downloaded, but setting it up on the device took too long: try again, keeping the download.
    console.warn('Speech model setup took too long; retrying');
    restartWorker('retrying-prepare');
  } else if (verdict === 'fallback') {
    console.warn('Speech model did not start; using the smaller model');
    speechModel = 'small';
    restartWorker('fallback');
  } else if (verdict === 'fail') {
    diag.errors++;
    diag.lastError = 'The speech model did not finish loading, even the smaller one.';
    chrome.runtime
      .sendMessage({
        type: 'TRANSCRIPTION_ERROR',
        message: 'the speech model did not finish loading after two tries. Try "Smaller download" under Settings > Live captions, or reload the extension.'
      })
      .catch(() => undefined);
  }
}

function getWorker(): Worker {
  if (!worker) {
    watchdog.started(Date.now());
    worker = new Worker(chrome.runtime.getURL('whisper.worker.js'));
    worker.onmessage = handleWorkerMessage;
    worker.postMessage({ type: 'load', overrides: workerOverrides, speechModel });
  }
  return worker;
}

function restartWorkerOnCpu(): void {
  worker?.terminate();
  worker = null;
  workerOverrides = { device: 'wasm' };
  getWorker();
}

/** Capture health, reported to the background every 2 s while capturing (tests read it). */
const diag = { frames: 0, peakRms: 0, segments: 0, results: 0, emptyResults: 0, errors: 0, lastError: '', model: '', loadMs: 0, prepareMs: null as number | null, nonSpeech: 0, suppressed: 0, raChunks: 0, raSegments: 0, raResults: 0, raSkipped: 0 };
let diagTimer: number | null = null;
function reportDiag(): void {
  checkModelLoad();
  const ra = { windows: readAhead.windowsSent, resets: readAhead.resets, stale: readAhead.stale, healthy: readAhead.healthy };
  chrome.runtime.sendMessage({ type: 'AUDIO_DIAG', diag: { ...diag, ra, at: Date.now() } }).catch(() => undefined);
  diag.peakRms = 0;
}

/** Speech end per segment id (epoch ms), sent with the transcription so the page can place it in video time. */
const speechEndedAt = new Map<number, number>();
const SPEECH_END_HANGOVER_MS = 400; // the segmenter's silence hangover (vad.ts)

// ---- audio read-ahead (spec: Audio mode read-ahead) ----
// The page's buffered audio arrives ahead of playback as 16 kHz PCM in video
// time; ReadAheadPipeline transcribes it with a sliding window and Whisper's
// sentence timestamps, one job at a time, and turns the result into captions
// with their video-time start and end. While read-ahead is healthy the live
// path's segments are not transcribed (capture keeps the tab audible).
let readAheadTabId: number | null = null;
const readAhead = new ReadAheadPipeline({
  nextId: () => ++segmentCounter,
  transcribe: (segmentId, audio) =>
    getWorker().postMessage({ type: 'transcribe', audio, language: currentSourceLanguage, segmentId, timestamps: true }, [audio.buffer]),
  emit: c =>
    chrome.runtime.sendMessage({ type: 'TRANSCRIPTION_RESULT', text: c.text, timing: { videoStart: c.start, videoEnd: c.end, readAhead: 1 } }).catch(() => undefined),
});

function handleWorkerMessage(event: MessageEvent): void {
  const { type } = event.data;
  if (type === 'result') {
    if (event.data.text && event.data.text.trim()) diag.results++;
    else diag.emptyResults++;
    // Read-ahead's jobs (including stale ones from before a seek) never reach the live path.
    if (readAhead.result(event.data.segmentId, event.data.chunks)) diag.raResults++;
    // Sound annotations ("[音楽]", "(拍手)", "♪") are not words: no caption.
    else if (event.data.text && event.data.text.trim() && (isNonSpeech(event.data.text) || isLikelyHallucination(event.data.text))) diag.nonSpeech++;
    else if (event.data.text && event.data.text.trim()) {
      chrome.runtime.sendMessage({
        type: 'TRANSCRIPTION_RESULT',
        text: event.data.text,
        timing: {
          segmentId: event.data.segmentId,
          audioMs: event.data.audioMs,
          queueMs: event.data.queueMs,
          inferenceMs: event.data.inferenceMs,
          speechEndedAt: speechEndedAt.get(event.data.segmentId) ?? Date.now()
        }
      });
    }
  } else if (type === 'dropped') {
    readAhead.dropped(event.data.segmentId);
  } else if (type === 'progress') {
    watchdog.progress(Date.now());
    if (event.data.status === 'preparing') watchdog.preparing(Date.now());
    if (event.data.status === 'ready') {
      watchdog.ready();
      diag.model = `${event.data.model} (${event.data.device})`;
      diag.loadMs = Math.round(event.data.loadMs ?? 0);
      diag.prepareMs = event.data.prepareMs == null ? null : Math.round(event.data.prepareMs);
    }
    chrome.runtime.sendMessage({
      type: 'MODEL_LOADING_PROGRESS',
      status: event.data.status,
      percent: event.data.percent,
      ...(event.data.status === 'ready' ? { model: event.data.model, device: event.data.device } : {})
    });
  } else if (type === 'error') {
    readAhead.error(event.data.loadFailedOn ? undefined : event.data.segmentId);
    diag.errors++;
    diag.lastError = String(event.data.message ?? event.data.error ?? '').slice(0, 200);
    if (event.data.loadFailedOn === 'webgpu') {
      console.warn('WebGPU model load failed; restarting the worker on wasm:', event.data.message);
      restartWorkerOnCpu();
      return;
    }
    chrome.runtime.sendMessage({ type: 'TRANSCRIPTION_ERROR', message: event.data.message });
  }
}

async function startCapture(streamId: string, sourceLanguage: string, tabId: number | null): Promise<void> {
  stopCapture(); // restarting must never leave a second stream running
  readAheadTabId = tabId;
  diagTimer = window.setInterval(reportDiag, 2000);
  currentSourceLanguage = sourceLanguage;
  segmenter = new SpeechSegmenter(FRAME_DURATION_MS, DEFAULT_VAD_CONFIG);

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    } as unknown as MediaTrackConstraints,
    video: false
  });

  // Capturing a tab mutes it, so play the stream back at full quality on a
  // context running at the device's native rate.
  playbackContext = new AudioContext();
  playbackContext.createMediaStreamSource(mediaStream).connect(playbackContext.destination);

  // Separate 16 kHz analysis context: the browser resamples the tab's audio to
  // what Whisper expects. Its output goes through a muted gain - the node only
  // needs to be pulled by the graph, not heard.
  captureContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = captureContext.createMediaStreamSource(mediaStream);
  scriptProcessor = captureContext.createScriptProcessor(FRAME_SIZE, 1, 1);
  const mute = captureContext.createGain();
  mute.gain.value = 0;

  scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    diag.frames++;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    diag.peakRms = Math.max(diag.peakRms, Math.sqrt(sum / frame.length));
    const segment = segmenter?.pushFrame(frame);
    if (segment && readAhead.healthy) {
      diag.suppressed++; // read-ahead already has this speech
    } else if (segment) {
      diag.segments++;
      // The segment closed after the silence hangover (or at the length cap): speech ended about then.
      speechEndedAt.set(segmentCounter + 1, Date.now() - SPEECH_END_HANGOVER_MS);
      if (speechEndedAt.size > 64) speechEndedAt.delete(speechEndedAt.keys().next().value!);
      getWorker().postMessage(
        { type: 'transcribe', audio: segment, language: currentSourceLanguage, segmentId: ++segmentCounter },
        [segment.buffer]
      );
    }
  };

  source.connect(scriptProcessor);
  scriptProcessor.connect(mute);
  mute.connect(captureContext.destination);

  getWorker(); // starts loading the model right away
}

function stopCapture(): void {
  if (diagTimer !== null) window.clearInterval(diagTimer);
  diagTimer = null;
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor.onaudioprocess = null;
    scriptProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  for (const context of [playbackContext, captureContext]) {
    if (context && context.state !== 'closed') {
      context.close();
    }
  }
  playbackContext = null;
  captureContext = null;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  segmenter = null;
  readAheadTabId = null;
  readAhead.reset();
  readAhead.state(false, 0);
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'READ_AHEAD_AUDIO' || message.type === 'READ_AHEAD_STATE' || message.type === 'READ_AHEAD_RESET') {
    // From the content script of the captured tab only.
    if (readAheadTabId === null || _sender.tab?.id !== readAheadTabId) return false;
    const m = message as unknown as { t?: number; pcm?: string; playhead?: number; healthy?: boolean };
    if (message.type === 'READ_AHEAD_AUDIO' && typeof m.t === 'number' && typeof m.pcm === 'string') {
      diag.raChunks++;
      readAhead.audio(m.t, fromInt16Base64(m.pcm));
    } else if (message.type === 'READ_AHEAD_STATE' && typeof m.playhead === 'number') {
      readAhead.state(!!m.healthy, m.playhead);
    } else if (message.type === 'READ_AHEAD_RESET') {
      readAhead.reset();
    }
    return false;
  }

  if (message.type === 'START_OFFSCREEN_CAPTURE') {
    const { streamId, sourceLanguage, tabId, sttOverrides, speechModel: chosen } = message as unknown as { streamId: string; sourceLanguage: string; tabId?: number; sttOverrides?: { model?: string; dtype?: unknown }; speechModel?: string };
    if (chosen !== speechModel) {
      speechModel = chosen;
      worker?.terminate(); // a different model: the next capture loads it
      worker = null;
    }
    if (sttOverrides?.model) workerOverrides = { ...workerOverrides, model: sttOverrides.model, ...(sttOverrides.dtype ? { dtype: sttOverrides.dtype } : {}) } as typeof workerOverrides;
    startCapture(streamId, sourceLanguage, typeof tabId === 'number' ? tabId : null)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === 'STOP_OFFSCREEN_CAPTURE') {
    stopCapture();
    sendResponse({ success: true });
  }
  return false;
});
