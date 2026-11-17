// Maps wall-clock time (Date.now(), shared by the offscreen document, the
// background and the page) to the video's time, so a caption knows where in
// the video its speech ended. Built from the video's own events: play, pause,
// seek, rate changes and periodic ticks; ads count as paused.

export type ClockEventType = 'play' | 'pause' | 'seek' | 'rate' | 'tick' | 'ad-start' | 'ad-end';

export interface ClockEvent {
  epochMs: number;
  type: ClockEventType;
  /** video.currentTime when the event happened */
  videoTime: number;
  /** playbackRate (rate events; others keep the previous rate) */
  rate?: number;
}

interface State {
  epochMs: number;
  videoTime: number;
  rate: number;
  paused: boolean;
  type: ClockEventType;
}

const KEEP_MS = 5 * 60_000;

export class VideoClock {
  private states: State[] = [];

  static fromEvents(events: ClockEvent[]): VideoClock {
    const clock = new VideoClock();
    for (const e of events) clock.record(e);
    return clock;
  }

  record(e: ClockEvent): void {
    const prev = this.states[this.states.length - 1];
    const paused =
      e.type === 'pause' || e.type === 'ad-start' ? true : e.type === 'play' || e.type === 'ad-end' ? false : (prev?.paused ?? false);
    this.states.push({ epochMs: e.epochMs, videoTime: e.videoTime, rate: e.rate ?? prev?.rate ?? 1, paused, type: e.type });
    // Bounded history: captions only ever look back a few seconds.
    while (this.states.length > 2 && this.states[1].epochMs < e.epochMs - KEEP_MS) this.states.shift();
  }

  get paused(): boolean {
    return this.states[this.states.length - 1]?.paused ?? true;
  }

  /** Video time at a wall time, or null before anything was observed. */
  videoTimeAt(epochMs: number): number | null {
    let at: State | undefined;
    for (const s of this.states) {
      if (s.epochMs <= epochMs) at = s;
      else break;
    }
    if (!at) return null;
    if (at.paused) return at.videoTime;
    return at.videoTime + ((epochMs - at.epochMs) / 1000) * at.rate;
  }

  seekedSince(epochMs: number): boolean {
    return this.states.some(s => s.type === 'seek' && s.epochMs > epochMs);
  }

  /** Paused (or an ad) at any moment from the given wall time until now. */
  pausedSince(epochMs: number): boolean {
    if (this.paused) return true;
    let atStart: State | undefined;
    for (const s of this.states) {
      if (s.epochMs <= epochMs) atStart = s;
      else if (s.paused) return true;
    }
    return !!atStart?.paused;
  }

  /** Follows a video element's events (and ad state, via a callback) from now on. */
  observe(video: HTMLVideoElement, adShowing: () => boolean = () => false, now: () => number = Date.now): () => void {
    const push = (type: ClockEventType) => this.record({ epochMs: now(), type, videoTime: video.currentTime, rate: video.playbackRate });
    let ad = adShowing();
    push(video.paused ? 'pause' : 'play');
    if (ad) push('ad-start');
    const handlers: [string, () => void][] = [
      ['play', () => push('play')],
      ['playing', () => push('play')],
      ['pause', () => push('pause')],
      ['seeking', () => push('seek')],
      // A new source (the next item in a playlist) is a jump like a seek.
      ['emptied', () => push('seek')],
      ['ratechange', () => push('rate')],
      [
        'timeupdate',
        () => {
          const nowAd = adShowing();
          if (nowAd !== ad) {
            ad = nowAd;
            push(ad ? 'ad-start' : 'ad-end');
          } else push('tick');
        },
      ],
    ];
    for (const [type, fn] of handlers) video.addEventListener(type, fn);
    return () => handlers.forEach(([type, fn]) => video.removeEventListener(type, fn));
  }
}
