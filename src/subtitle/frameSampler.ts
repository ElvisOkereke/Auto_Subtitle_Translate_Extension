// frameSampler.ts - samples the user's box from presented video frames.
import { frameSignature } from './frameSignature';
import { boxToSource } from './videoGeometry';
import type { NormalizedBox } from './types';

export type FrameHandler = (sig: Uint8Array, videoTime: number, grab: () => Promise<ImageBitmap>) => void;

/** True while YouTube (or the fixture) shows an ad in this player. */
export function adShowing(video: HTMLVideoElement): boolean {
  return !!video.closest('.html5-video-player')?.classList.contains('ad-showing');
}

/**
 * Calls `onFrame` for presented frames (requestVideoFrameCallback), at most
 * `maxFps` per second of media time, with the box's luminance signature and a
 * `grab()` that snapshots the box as an ImageBitmap. `grab` must be called
 * synchronously inside `onFrame` (the canvas is reused for the next frame).
 * Frames are only presented while playing or after a seek, so a paused video
 * produces no work. Skipped during ads and while the tab is hidden.
 */
export class FrameSampler {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private handle: number | null = null;
  private lastMediaTime = -Infinity;
  private running = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private box: NormalizedBox,
    private readonly onFrame: FrameHandler,
    private readonly maxFps = 12
  ) {}

  setBox(box: NormalizedBox): void {
    this.box = box;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) this.video.cancelVideoFrameCallback(this.handle);
    this.handle = null;
  }

  /** Draws the box from the current frame now (used for periodic re-checks). */
  sampleNow(): { sig: Uint8Array; videoTime: number; grab: () => Promise<ImageBitmap> } | null {
    return this.capture(this.video.currentTime);
  }

  private schedule(): void {
    if (!this.running) return;
    this.handle = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.handle = null;
      const t = metadata.mediaTime;
      const jumped = t < this.lastMediaTime || t - this.lastMediaTime > 1;
      if ((jumped || t - this.lastMediaTime >= 1 / this.maxFps) && !adShowing(this.video) && !document.hidden) {
        this.lastMediaTime = t;
        const frame = this.capture(t);
        if (frame) this.onFrame(frame.sig, frame.videoTime, frame.grab);
      }
      this.schedule();
    });
  }

  private capture(videoTime: number) {
    const { videoWidth, videoHeight } = this.video;
    if (!videoWidth || !videoHeight) return null;
    const { sx, sy, sw, sh } = boxToSource(this.box, videoWidth, videoHeight);
    if (!this.canvas || this.canvas.width !== sw || this.canvas.height !== sh) {
      this.canvas = new OffscreenCanvas(sw, sh);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = this.ctx!;
    ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, sw, sh);
    const sig = frameSignature(ctx.getImageData(0, 0, sw, sh).data, sw, sh);
    const canvas = this.canvas;
    return { sig, videoTime, grab: () => createImageBitmap(canvas) };
  }
}
