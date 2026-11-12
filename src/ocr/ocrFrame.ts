// ocrFrame.ts - runs inside the hidden ocr-frame.html iframe (extension origin).
// Receives a MessagePort from the content script and relays OCR requests to the
// worker. Restarts the worker on wasm if a WebGPU session fails.

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
  port = event.ports[0];
  worker ??= startWorker();
  port.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.id !== undefined) inFlight.set(msg.id, msg.type);
    worker!.postMessage(msg, msg.bitmap ? [msg.bitmap] : []);
  };
  port.postMessage({ type: 'attached' });
});
