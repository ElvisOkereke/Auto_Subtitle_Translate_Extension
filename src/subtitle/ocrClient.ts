// ocrClient.ts - content-script side of OCR. Injects the hidden extension
// iframe that hosts the OCR worker and talks to it over a MessageChannel;
// ImageBitmaps are transferred, not copied.
import type { OcrResult, SubtitleLanguage } from './types';

const REQUEST_TIMEOUT_MS = 30_000;

export class OcrClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: number }>();

  private constructor(private iframe: HTMLIFrameElement, private port: MessagePort) {
    port.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      const entry = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!entry) return;
      this.pending.delete(msg.id);
      window.clearTimeout(entry.timer);
      if (msg.type === 'error') entry.reject(Object.assign(new Error(msg.message), { retry: !!msg.retry }));
      else entry.resolve(msg);
    };
  }

  static async attach(): Promise<OcrClient> {
    const src = chrome.runtime.getURL('ocr-frame.html');
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('data-ast-owned', '');
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none;';
    await new Promise<void>((resolve, reject) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
      iframe.addEventListener('error', () => reject(new Error('OCR frame failed to load')), { once: true });
      (document.body ?? document.documentElement).appendChild(iframe);
    });
    const channel = new MessageChannel();
    const attached = new Promise<void>(resolve => {
      channel.port1.onmessage = e => e.data?.type === 'attached' && resolve();
    });
    iframe.contentWindow!.postMessage({ type: 'ast-ocr-port' }, new URL(src).origin, [channel.port2]);
    await attached;
    return new OcrClient(iframe, channel.port1);
  }

  private request<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('OCR request timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ ...msg, id }, transfer);
    });
  }

  async recognize(crop: ImageBitmap, lang: SubtitleLanguage, tier: 'fast' | 'accurate' = 'fast'): Promise<OcrResult> {
    const r = await this.request<{ text: string; confidence: number; ms: number }>({ type: 'recognize', bitmap: crop, lang }, [crop]);
    return { text: r.text, confidence: r.confidence, ms: r.ms, tier };
  }

  async preload(lang: SubtitleLanguage): Promise<void> {
    await this.request({ type: 'preload', lang });
  }

  detach(): void {
    this.pending.forEach(p => {
      window.clearTimeout(p.timer);
      p.reject(new Error('OCR client detached'));
    });
    this.pending.clear();
    this.port.close();
    this.iframe.remove();
  }
}
