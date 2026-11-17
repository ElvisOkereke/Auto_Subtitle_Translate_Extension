// offscreen.ts - Captures tab audio, segments speech via VAD, and relays segments to the Whisper worker.
import { ExtensionMessage } from './types';
import { SpeechSegmenter, DEFAULT_VAD_CONFIG } from './utils/vad';
import { ReadAheadWindows } from './audio/readAheadWindows';
import { fromInt16Base64 } from './audio/readAhead/pcm';
import { isNonSpeech } from './audio/nonSpeech';

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
let workerOverrides: { device?: 'wasm' } = {};

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('whisper.worker.js'));
    worker.onmessage = handleWorkerMessage;
    worker.postMessage({ type: 'load', overrides: workerOverrides });
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
const diag = { frames: 0, peakRms: 0, segments: 0, results: 0, emptyResults: 0, errors: 0, lastError: '', nonSpeech: 0, suppressed: 0, raChunks: 0, raSegments: 0, raResults: 0, raSkipped: 0 };
let diagTimer: number | null = null;
function reportDiag(): void {
  chrome.runtime.sendMessage({ type: 'AUDIO_DIAG', diag: { ...diag, at: Date.now() } }).catch(() => undefined);
  diag.peakRms = 0;
}

/** Speech end per segment id (epoch ms), sent with the transcription so the page can place it in video time. */
const speechEndedAt = new Map<number, number>();
const SPEECH_END_HANGOVER_MS = 400; // the segmenter's silence hangover (vad.ts)

// ---- audio read-ahead (spec: Audio mode read-ahead) ----
// The page's buffered audio arrives ahead of playback as 16 kHz PCM in video
// time. It is transcribed with a sliding window (readAheadWindows.ts) and
// Whisper's sentence timestamps, one window at a time; each caption carries its
// video-time start and end. While read-ahead is healthy the live path's
// segments are not transcribed (capture keeps the tab audible); when it isn't,
// the live path carries on as before.
const readAhead = {
  tabId: null as number | null,
  windows: new ReadAheadWindows(),
  inFlight: null as number | null,
  healthy: false,
  playhead: 0,
  meta: new Map<number, { videoStart: number }>(),
};

function resetReadAhead(): void {
  readAhead.windows.reset();
  readAhead.inFlight = null;
}

function onReadAheadAudio(t: number, pcm: Float32Array): void {
  diag.raChunks++;
  readAhead.windows.push(t, pcm);
  pumpReadAhead();
}

/** Sends the next window to Whisper (one at a time). */
function pumpReadAhead(): void {
  if (readAhead.inFlight !== null) return;
  const win = readAhead.windows.next(readAhead.playhead);
  if (!win) return;
  diag.raSegments++;
  const segmentId = ++segmentCounter;
  readAhead.inFlight = segmentId;
  readAhead.meta.set(segmentId, { videoStart: win.start });
  if (readAhead.meta.size > 64) readAhead.meta.delete(readAhead.meta.keys().next().value!);
  getWorker().postMessage({ type: 'transcribe', audio: win.audio, language: currentSourceLanguage, segmentId, timestamps: true }, [win.audio.buffer]);
}

/** Whisper's sentences for the window in flight -> captions in video time (sound annotations dropped). */
function windowCaptions(chunks: { text: string; start: number; end: number | null }[] | undefined): { text: string; start: number; end: number }[] {
  const sentences = (Array.isArray(chunks) ? chunks : []).map(c => ({ text: c.text, start: c.start, end: c.end === null ? NaN : c.end }));
  const captions = readAhead.windows.complete(sentences);
  const speech = captions.filter(c => !isNonSpeech(c.text));
  diag.nonSpeech += captions.length - speech.length;
  return speech;
}

function readAheadDone(segmentId: number | undefined): void {
  if (segmentId !== undefined && segmentId === readAhead.inFlight) {
    readAhead.inFlight = null;
    pumpReadAhead();
  }
}

function handleWorkerMessage(event: MessageEvent): void {
  const { type } = event.data;
  if (type === 'result') {
    if (event.data.text && event.data.text.trim()) diag.results++;
    else diag.emptyResults++;
    const ahead = readAhead.meta.get(event.data.segmentId);
    if (ahead) diag.raResults++;
    // Read-ahead: each of Whisper's sentences is a caption timed to its words.
    if (ahead) {
      for (const s of windowCaptions(event.data.chunks)) {
        chrome.runtime.sendMessage({
          type: 'TRANSCRIPTION_RESULT',
          text: s.text,
          timing: { segmentId: event.data.segmentId, audioMs: event.data.audioMs, queueMs: event.data.queueMs, inferenceMs: event.data.inferenceMs, videoStart: s.start, videoEnd: s.end, readAhead: 1 }
        });
      }
    }
    // Sound annotations ("[音楽]", "(拍手)", "♪") are not words: no caption.
    else if (event.data.text && event.data.text.trim() && isNonSpeech(event.data.text)) diag.nonSpeech++;
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
    readAheadDone(event.data.segmentId);
  } else if (type === 'dropped') {
    if (event.data.segmentId === readAhead.inFlight) readAhead.windows.complete([]);
    readAheadDone(event.data.segmentId);
  } else if (type === 'progress') {
    chrome.runtime.sendMessage({
      type: 'MODEL_LOADING_PROGRESS',
      status: event.data.status,
      percent: event.data.percent
    });
  } else if (type === 'error') {
    if (readAhead.inFlight !== null) readAhead.windows.complete([]);
    readAhead.inFlight = null;
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
  readAhead.tabId = tabId;
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
  readAhead.tabId = null;
  readAhead.healthy = false;
  resetReadAhead();
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'READ_AHEAD_AUDIO' || message.type === 'READ_AHEAD_STATE' || message.type === 'READ_AHEAD_RESET') {
    // From the content script of the captured tab only.
    if (readAhead.tabId === null || _sender.tab?.id !== readAhead.tabId) return false;
    const m = message as unknown as { t?: number; pcm?: string; playhead?: number; healthy?: boolean };
    if (typeof m.playhead === 'number') readAhead.playhead = m.playhead;
    if (message.type === 'READ_AHEAD_AUDIO' && typeof m.t === 'number' && typeof m.pcm === 'string') {
      onReadAheadAudio(m.t, fromInt16Base64(m.pcm));
    } else if (message.type === 'READ_AHEAD_STATE') {
      readAhead.healthy = !!m.healthy;
      pumpReadAhead();
    } else if (message.type === 'READ_AHEAD_RESET') {
      resetReadAhead();
    }
    return false;
  }

  if (message.type === 'START_OFFSCREEN_CAPTURE') {
    const { streamId, sourceLanguage, tabId } = message as unknown as { streamId: string; sourceLanguage: string; tabId?: number };
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
