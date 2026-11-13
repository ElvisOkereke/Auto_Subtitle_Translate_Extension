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
  /** Frames accepted from the main world (the read-ahead path is active when this grows). */
  readonly framesAccepted: number;
}

export const READ_AHEAD_FPS = 8;

/**
 * Frames arrive from the page's main world over window.postMessage, which the
 * page itself can also post to (any handshake secret would be visible to it
 * too). Page-injected frames can only show text the page could draw anyway, so
 * the defence is to bound them to what real playback produces: frames must lie
 * inside the player's buffered range near the playhead, and at most one frame
 * per 1/READ_AHEAD_FPS slot is accepted - capping OCR and translation work.
 */
export class MseReadAhead implements ReadAheadSource {
  private readonly seenSlots = new Set<number>();
  private lastResetAt = -Infinity;
  private onFrame: ReadAheadFrame | null = null;
  private onReset: (() => void) | null = null;
  private latest = -Infinity;
  private canvas: OffscreenCanvas | null = null;
  framesAccepted = 0;
  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.astTapReset) {
      // Real resets follow seeks; rate-limit so a page can't keep re-opening slots.
      if (performance.now() - this.lastResetAt < 2000) return;
      this.lastResetAt = performance.now();
      this.latest = -Infinity;
      this.seenSlots.clear();
      this.onReset?.();
    } else if (msg?.astTapFrame && msg.bitmap instanceof ImageBitmap) {
      if (typeof msg.t !== 'number' || !this.plausible(msg.t)) {
        msg.bitmap.close();
        return;
      }
      this.latest = Math.max(this.latest, msg.t);
      this.framesAccepted++;
      this.deliver(msg.bitmap, msg.t);
    }
  };

  constructor(private readonly video: HTMLVideoElement, private box: NormalizedBox) {}

  /** Inside the buffered range (playhead - 1 s .. buffered end + 1 s) and the first frame of its slot. */
  private plausible(t: number): boolean {
    const b = this.video.buffered;
    let bufferedEnd = -Infinity;
    for (let i = 0; i < b.length; i++) bufferedEnd = Math.max(bufferedEnd, b.end(i));
    if (t < this.video.currentTime - 1 || t > bufferedEnd + 1) return false;
    const slot = Math.floor(t * READ_AHEAD_FPS);
    if (this.seenSlots.has(slot)) return false;
    this.seenSlots.add(slot);
    if (this.seenSlots.size > 20_000) this.seenSlots.clear(); // bounded memory on very long sessions
    return true;
  }

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
    this.seenSlots.clear();
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
