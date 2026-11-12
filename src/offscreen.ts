// offscreen.ts - Captures tab audio, segments speech via VAD, and relays segments to the Whisper worker.
import { ExtensionMessage } from './types';
import { SpeechSegmenter, DEFAULT_VAD_CONFIG } from './utils/vad';

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

function handleWorkerMessage(event: MessageEvent): void {
  const { type } = event.data;
  if (type === 'result') {
    if (event.data.text && event.data.text.trim()) {
      chrome.runtime.sendMessage({
        type: 'TRANSCRIPTION_RESULT',
        text: event.data.text,
        timing: {
          segmentId: event.data.segmentId,
          audioMs: event.data.audioMs,
          queueMs: event.data.queueMs,
          inferenceMs: event.data.inferenceMs
        }
      });
    }
  } else if (type === 'progress') {
    chrome.runtime.sendMessage({
      type: 'MODEL_LOADING_PROGRESS',
      status: event.data.status,
      percent: event.data.percent
    });
  } else if (type === 'error') {
    if (event.data.loadFailedOn === 'webgpu') {
      console.warn('WebGPU model load failed; restarting the worker on wasm:', event.data.message);
      restartWorkerOnCpu();
      return;
    }
    chrome.runtime.sendMessage({ type: 'TRANSCRIPTION_ERROR', message: event.data.message });
  }
}

async function startCapture(streamId: string, sourceLanguage: string): Promise<void> {
  stopCapture(); // restarting must never leave a second stream running
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
    const segment = segmenter?.pushFrame(frame);
    if (segment) {
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
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'START_OFFSCREEN_CAPTURE') {
    const { streamId, sourceLanguage } = message as unknown as { streamId: string; sourceLanguage: string };
    startCapture(streamId, sourceLanguage)
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
