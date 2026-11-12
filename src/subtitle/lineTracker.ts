import { signatureDistance } from './frameSignature';

export type LineEvent = { type: 'changed'; at: number };

/**
 * Decides when the subtitle box shows a new image worth OCR-ing: the frame
 * must differ from the last accepted image by more than `changeThreshold` and
 * then stay put for `stableFrames` consecutive frames (so subtitles fading in
 * and one-frame glitches don't trigger reads).
 */
export class LineTracker {
  private readonly changeThreshold: number;
  private readonly stableFrames: number;
  private accepted: Uint8Array | null = null;
  private candidate: Uint8Array | null = null;
  private candidateFrames = 0;

  constructor(opts: { changeThreshold?: number; stableFrames?: number } = {}) {
    this.changeThreshold = opts.changeThreshold ?? 0.06;
    this.stableFrames = opts.stableFrames ?? 2;
  }

  push(sig: Uint8Array, videoTime: number): LineEvent | null {
    if (this.accepted && signatureDistance(sig, this.accepted) <= this.changeThreshold) {
      this.candidate = null;
      this.candidateFrames = 0;
      return null;
    }
    if (this.candidate && signatureDistance(sig, this.candidate) <= this.changeThreshold) {
      this.candidateFrames++;
    } else {
      this.candidate = sig;
      this.candidateFrames = 1;
    }
    if (this.candidateFrames >= this.stableFrames) {
      this.accepted = this.candidate;
      this.candidate = null;
      this.candidateFrames = 0;
      return { type: 'changed', at: videoTime };
    }
    return null;
  }

  reset(): void {
    this.accepted = null;
    this.candidate = null;
    this.candidateFrames = 0;
  }
}
