// ocrFrame.ts - runs inside the hidden ocr-frame.html iframe (extension origin).
// Receives a MessagePort from the content script, relays OCR requests to the
// worker (restarting it on wasm if a WebGPU session fails), and serves the
// subtitle timeline store from the extension's own IndexedDB.
import { Timeline, TimelineLine, TimelineStore } from '../subtitle/timeline';

let store: Promise<TimelineStore> | null = null;
const getStore = () => (store ??= TimelineStore.open());

async function handleTimeline(msg: { type: string; videoId?: string; lines?: TimelineLine[] }): Promise<unknown> {
  const s = await getStore();
  if (msg.type === 'timeline.load') return (await s.load(msg.videoId!)).toJSON();
  if (msg.type === 'timeline.save') return s.save(msg.videoId!, new Timeline(msg.lines ?? []));
  return s.clear();
}

// The frame is web-accessible, so any website could embed it. Only accept a
// channel from our own content script: it sends a one-time nonce through
// chrome.runtime messaging (which web pages can neither use nor observe), and
// the port must arrive with that nonce from a script in this frame's own tab.
let expectedNonce: string | null = null;
const myTabId = new Promise<number | undefined>(resolve => chrome.tabs.getCurrent(tab => resolve(tab?.id)));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'AST_OCR_NONCE' || sender.id !== chrome.runtime.id || !sender.tab) return false;
  myTabId.then(tabId => {
    if (tabId !== undefined && sender.tab!.id === tabId && typeof msg.nonce === 'string') {
      expectedNonce = msg.nonce;
      sendResponse({ ok: true });
    }
  });
  return true;
});

let worker: Worker | null = null;
let forceWasm = false;
let port: MessagePort | null = null;
const inFlight = new Map<number, any>();

function startWorker(): Worker {
  const w = new Worker(chrome.runtime.getURL('ocr.worker.js'));
  w.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg.type === 'error' && msg.loadFailedOn === 'webgpu' && !forceWasm) {
      console.warn('OCR on WebGPU failed; restarting on wasm:', msg.message);
      forceWasm = true;
      w.terminate();
      worker = startWorker();
      // Requests in flight lost their bitmaps (transferred); report them so callers can retry.
      inFlight.forEach((_m, id) => port?.postMessage({ type: 'error', id, message: 'OCR restarted on CPU, please retry', retry: true }));
      inFlight.clear();
      return;
    }
    if (msg.id !== undefined) inFlight.delete(msg.id);
    port?.postMessage(msg);
  };
  w.postMessage({ type: 'init', device: forceWasm ? 'wasm' : undefined });
  return w;
}

window.addEventListener('message', event => {
  if (event.data?.type !== 'ast-ocr-port' || !event.ports[0]) return;
  if (!expectedNonce || event.data.nonce !== expectedNonce) return; // not our content script
  expectedNonce = null; // one-time
  port = event.ports[0];
  worker ??= startWorker();
  port.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (typeof msg.type === 'string' && msg.type.startsWith('timeline.')) {
      handleTimeline(msg).then(
        result => port?.postMessage({ type: 'result', id: msg.id, result }),
        error => port?.postMessage({ type: 'error', id: msg.id, message: String(error) })
      );
      return;
    }
    if (msg.id !== undefined) inFlight.set(msg.id, msg.type);
    worker!.postMessage(msg, msg.bitmap ? [msg.bitmap] : []);
  };
  port.postMessage({ type: 'attached' });
});
