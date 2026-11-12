// readAheadSource.ts - isolated-world side of read-ahead: drives the main-world
// MSE tap (mseTap.main.ts) and turns its box crops into pipeline frames.
import { frameSignature } from '../frameSignature';
import type { NormalizedBox } from '../types';

export type ReadAheadFrame = (crop: ImageBitmap, sig: Uint8Array, videoTime: number) => void;

export interface ReadAheadSource {
  start(onFrame: ReadAheadFrame, onReset: () => void): void;
  /** Re-anchor at the playhead (after a seek). */
  restart(): void;
  setBox(box: NormalizedBox): void;
  stop(): void;
  /** Seconds of video decoded ahead of currentTime. */
  readonly lead: number;
}

export const READ_AHEAD_FPS = 8;

export class MseReadAhead implements ReadAheadSource {
  private onFrame: ReadAheadFrame | null = null;
  private onReset: (() => void) | null = null;
  private latest = -Infinity;
  private canvas: OffscreenCanvas | null = null;
  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.astTapReset) {
      this.latest = -Infinity;
      this.onReset?.();
    } else if (msg?.astTapFrame && msg.bitmap instanceof ImageBitmap) {
      this.latest = Math.max(this.latest, msg.t);
      this.deliver(msg.bitmap, msg.t);
    }
  };

  constructor(private readonly video: HTMLVideoElement, private box: NormalizedBox) {}

  get lead(): number {
    return this.latest === -Infinity ? 0 : Math.max(0, this.latest - this.video.currentTime);
  }

  start(onFrame: ReadAheadFrame, onReset: () => void): void {
    this.onFrame = onFrame;
    this.onReset = onReset;
    window.addEventListener('message', this.onMessage);
    this.post({ astTap: 'start', box: this.box, fps: READ_AHEAD_FPS });
  }

  restart(): void {
    this.latest = -Infinity;
    this.post({ astTap: 'start', box: this.box, fps: READ_AHEAD_FPS });
  }

  setBox(box: NormalizedBox): void {
    this.box = box;
    this.post({ astTap: 'box', box });
  }

  stop(): void {
    window.removeEventListener('message', this.onMessage);
    this.post({ astTap: 'stop' });
    this.onFrame = null;
  }

  private post(msg: Record<string, unknown>): void {
    window.postMessage(msg, '*');
  }

  private deliver(bitmap: ImageBitmap, t: number): void {
    if (!this.onFrame) {
      bitmap.close();
      return;
    }
    const { width, height } = bitmap;
    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) this.canvas = new OffscreenCanvas(width, height);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const sig = frameSignature(ctx.getImageData(0, 0, width, height).data, width, height);
    this.onFrame(bitmap, sig, t);
  }
}
