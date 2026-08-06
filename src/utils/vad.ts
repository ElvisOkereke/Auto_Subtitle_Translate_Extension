// vad.ts - Pure energy-based voice-activity detection and speech segmentation.
// No DOM/Web Audio dependency so this is directly unit-testable.

export interface VadConfig {
  silenceThreshold: number;
  minSpeechDurationMs: number;
  maxSegmentDurationMs: number;
  silenceHangoverMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  silenceThreshold: 0.01,
  minSpeechDurationMs: 250,
  maxSegmentDurationMs: 8000,
  silenceHangoverMs: 400
};

export function computeRmsAmplitude(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function isSpeech(samples: Float32Array, config: VadConfig = DEFAULT_VAD_CONFIG): boolean {
  return computeRmsAmplitude(samples) > config.silenceThreshold;
}

/**
 * Buffers incoming fixed-size audio frames and emits a merged segment once a
 * natural pause (or a max-duration safety cut) is reached, so transcription
 * happens on word/sentence boundaries instead of arbitrary time-slices.
 */
export class SpeechSegmenter {
  private buffer: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;

  constructor(private frameDurationMs: number, private config: VadConfig = DEFAULT_VAD_CONFIG) {}

  pushFrame(frame: Float32Array): Float32Array | null {
    const speech = isSpeech(frame, this.config);

    if (speech) {
      this.buffer.push(frame);
      this.speechMs += this.frameDurationMs;
      this.silenceMs = 0;

      if (this.speechMs >= this.config.maxSegmentDurationMs) {
        return this.flush();
      }
      return null;
    }

    if (this.buffer.length === 0) {
      return null; // leading silence, nothing buffered yet
    }

    this.buffer.push(frame); // keep trailing silence so words aren't clipped
    this.silenceMs += this.frameDurationMs;

    if (this.silenceMs >= this.config.silenceHangoverMs) {
      if (this.speechMs >= this.config.minSpeechDurationMs) {
        return this.flush();
      }
      this.reset(); // too short to count as real speech - discard
      return null;
    }

    return null;
  }

  private reset(): void {
    this.buffer = [];
    this.speechMs = 0;
    this.silenceMs = 0;
  }

  private flush(): Float32Array {
    const totalLength = this.buffer.reduce((sum, f) => sum + f.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const frame of this.buffer) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    this.reset();
    return merged;
  }
}
