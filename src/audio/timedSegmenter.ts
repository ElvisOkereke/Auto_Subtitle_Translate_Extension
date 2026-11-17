// timedSegmenter.ts - the live path's energy VAD (utils/vad.ts), for read-ahead
// audio: each segment also carries where its speech starts and ends in video
// time, so its caption can be shown when the words are spoken.
import { DEFAULT_VAD_CONFIG, VadConfig, isSpeech } from '../utils/vad';

export interface TimedSegment {
  audio: Float32Array;
  /** Video time of the first speech frame. */
  start: number;
  /** Video time where the speech ended (before the trailing silence kept for Whisper). */
  end: number;
}

/**
 * Read-ahead segments: long enough for Whisper to see whole sentences (it splits
 * them into timed sentences itself), short enough to come back quickly.
 */
export const READ_AHEAD_MAX_SEGMENT_MS = 10000;

export class TimedSegmenter {
  private frames: Float32Array[] = [];
  private start = 0;
  private speechEnd = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private readonly config: VadConfig;

  constructor(
    private readonly sampleRate: number,
    config: Partial<VadConfig> = {}
  ) {
    this.config = { ...DEFAULT_VAD_CONFIG, maxSegmentDurationMs: READ_AHEAD_MAX_SEGMENT_MS, ...config };
  }

  /** Feeds one frame that starts at `videoTime`; returns a segment when one closes. */
  push(frame: Float32Array, videoTime: number): TimedSegment | null {
    const frameMs = (frame.length / this.sampleRate) * 1000;
    if (isSpeech(frame, this.config)) {
      if (!this.frames.length) this.start = videoTime;
      this.frames.push(frame);
      this.speechMs += frameMs;
      this.silenceMs = 0;
      this.speechEnd = videoTime + frameMs / 1000;
      return this.speechMs >= this.config.maxSegmentDurationMs ? this.flush() : null;
    }
    if (!this.frames.length) return null; // leading silence
    this.frames.push(frame); // trailing silence keeps the last word whole
    this.silenceMs += frameMs;
    if (this.silenceMs < this.config.silenceHangoverMs) return null;
    if (this.speechMs >= this.config.minSpeechDurationMs) return this.flush();
    this.reset(); // too short to be speech
    return null;
  }

  /** A seek or a gap in the audio: whatever was half built is dropped. */
  reset(): void {
    this.frames = [];
    this.speechMs = 0;
    this.silenceMs = 0;
  }

  private flush(): TimedSegment {
    const audio = new Float32Array(this.frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of this.frames) {
      audio.set(f, o);
      o += f.length;
    }
    const segment = { audio, start: this.start, end: this.speechEnd };
    this.reset();
    return segment;
  }
}
