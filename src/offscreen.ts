// offscreen.ts - Captures tab audio, segments speech via VAD, and relays segments to the Whisper worker.
import { ExtensionMessage } from './types';
import { SpeechSegmenter, DEFAULT_VAD_CONFIG } from './utils/vad';

const FRAME_SIZE = 4096;
const SAMPLE_RATE = 16000;
const FRAME_DURATION_MS = (FRAME_SIZE / SAMPLE_RATE) * 1000;

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let worker: Worker | null = null;
let segmenter: SpeechSegmenter | null = null;
let currentSourceLanguage = 'auto';

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('whisper.worker.js'));
    worker.onmessage = handleWorkerMessage;
  }
  return worker;
}

function handleWorkerMessage(event: MessageEvent): void {
  const { type } = event.data;
  if (type === 'result') {
    if (event.data.text && event.data.text.trim()) {
      chrome.runtime.sendMessage({ type: 'TRANSCRIPTION_RESULT', text: event.data.text });
    }
  } else if (type === 'progress') {
    chrome.runtime.sendMessage({ type: 'MODEL_LOADING_PROGRESS', status: event.data.status });
  } else if (type === 'error') {
    chrome.runtime.sendMessage({ type: 'TRANSCRIPTION_ERROR', message: event.data.message });
  }
}

async function startCapture(streamId: string, sourceLanguage: string): Promise<void> {
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

  // Constructing the context at 16kHz makes the browser resample the tab's
  // (typically 48kHz) audio for us, matching what Whisper expects.
  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);

  scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
    const inputData = event.inputBuffer.getChannelData(0);
    // Passthrough so the user still hears the tab while we tap the signal.
    event.outputBuffer.getChannelData(0).set(inputData);

    const frame = new Float32Array(inputData);
    const segment = segmenter!.pushFrame(frame);
    if (segment) {
      getWorker().postMessage(
        { type: 'transcribe', audio: segment, language: currentSourceLanguage },
        [segment.buffer]
      );
    }
  };

  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  getWorker().postMessage({ type: 'load' });
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
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }
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
});
