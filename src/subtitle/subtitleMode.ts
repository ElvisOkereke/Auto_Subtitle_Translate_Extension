// subtitleMode.ts - live burned-in subtitle translation for one video and one box.
//
// Frames -> change detection -> OCR -> translation -> timeline -> overlay.
// Lines already on the timeline (seen before, or read ahead) are shown from it
// with no OCR or translation.
import { FrameSampler, adShowing } from './frameSampler';
import { LineTracker } from './lineTracker';
import { SubtitleOverlay } from './overlay';
import { Timeline, TimelineLine, TimelineStorage } from './timeline';
import { isSameLine } from './textSimilarity';
import type { NormalizedBox, OcrResult, SubtitleLanguage } from './types';
import type { ReadAheadSource } from './readAhead/readAheadSource';

export interface TranslateRequest {
  text: string;
  sourceLang: SubtitleLanguage;
  previousLines: string[];
  nextLines: string[];
  priority: 'live' | 'readahead';
}

export interface TranslateResponse {
  success: boolean;
  translatedText?: string;
  quality?: 'fast' | 'better';
  error?: string;
}

export interface SubtitleModeDeps {
  ocr: { recognize(crop: ImageBitmap, lang: SubtitleLanguage, tier?: 'fast' | 'accurate'): Promise<OcrResult> };
  translate(req: TranslateRequest): Promise<TranslateResponse>;
  store: TimelineStorage | null;
  /** Future frames decoded from the player's buffer (null = live path only). */
  readAhead?: ReadAheadSource | null;
}

export type SubtitleModeState = 'loading' | 'running' | 'paused-ad' | 'stopped';

const MIN_CONFIDENCE = 0.5;
const RECHECK_MS = 750; // re-read a displayed line if nothing triggered a read for this long
const SAVE_EVERY_MS = 10_000;
const MAX_READ_AHEAD_QUEUE = 32;

export class SubtitleMode {
  state: SubtitleModeState = 'loading';
  /** Live-path OCR calls (read-ahead OCR is counted in raOcrCalls). */
  ocrCalls = 0;
  raOcrCalls = 0;
  translateCalls = 0;
  /** Video time at which each line's translation arrived, keyed by line start. */
  readonly translatedAt = new Map<number, number>();

  // Read-ahead: frames decoded ahead of playback run through their own tracker.
  private readonly raTracker = new LineTracker({ changeThreshold: 0.04, stableFrames: 2 });
  private raQueue: { t: number; crop: ImageBitmap }[] = [];
  private raReadingAt: number | null = null;
  private raCurrent: TimelineLine | null = null;
  private raFrom = Infinity;
  private raTo = -Infinity;

  /** Seconds of video read ahead of the playhead. */
  get readAheadLead(): number {
    return this.deps.readAhead?.lead ?? 0;
  }

  private readonly tracker = new LineTracker({ changeThreshold: 0.04, stableFrames: 2 });
  private readonly overlay: SubtitleOverlay;
  private readonly sampler: FrameSampler;
  private current: TimelineLine | null = null;
  private reading = false;
  private pending: { t: number; crop: Promise<ImageBitmap> } | null = null;
  private lastReadAt = 0;
  private epoch = 0; // bumped on seek/ad so stale reads are discarded
  private timers: number[] = [];
  private playerObserver: MutationObserver | null = null;
  private readonly listeners: [string, EventListener][] = [];

  private constructor(
    readonly video: HTMLVideoElement,
    readonly videoId: string,
    private box: NormalizedBox,
    readonly lang: SubtitleLanguage,
    readonly timeline: Timeline,
    private readonly deps: SubtitleModeDeps
  ) {
    this.overlay = new SubtitleOverlay(video, box);
    this.sampler = new FrameSampler(video, box, (sig, t, grab) => this.onFrame(sig, t, grab));
  }

  static async start(opts: {
    video: HTMLVideoElement;
    videoId: string;
    box: NormalizedBox;
    lang: SubtitleLanguage;
    deps: SubtitleModeDeps;
  }): Promise<SubtitleMode> {
    const timeline = opts.deps.store ? await opts.deps.store.load(opts.videoId) : new Timeline();
    const mode = new SubtitleMode(opts.video, opts.videoId, opts.box, opts.lang, timeline, opts.deps);
    mode.run();
    return mode;
  }

  private run(): void {
    this.on('seeking', () => this.onSeeking());
    this.on('seeked', () => {
      this.showKnown(this.video.currentTime);
      this.resetReadAhead();
      this.deps.readAhead?.restart();
    });
    const player = this.video.closest('.html5-video-player');
    if (player) {
      this.playerObserver = new MutationObserver(() => this.syncAdState());
      this.playerObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    }
    this.timers.push(window.setInterval(() => this.recheck(), 250));
    this.timers.push(window.setInterval(() => void this.save(), SAVE_EVERY_MS));
    this.state = adShowing(this.video) ? 'paused-ad' : 'running';
    this.deps.readAhead?.start(
      (crop, sig, t) => this.onReadAheadFrame(crop, sig, t),
      () => this.resetReadAhead()
    );
    this.sampler.start();
    this.showKnown(this.video.currentTime);
  }

  stop(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.epoch++;
    this.sampler.stop();
    this.deps.readAhead?.stop();
    this.raQueue.forEach(q => q.crop.close());
    this.raQueue = [];
    this.timers.forEach(t => window.clearInterval(t));
    this.playerObserver?.disconnect();
    this.listeners.forEach(([type, fn]) => this.video.removeEventListener(type, fn));
    this.overlay.destroy();
    void this.save();
  }

  setBox(box: NormalizedBox): void {
    this.box = box;
    this.overlay.setBox(box);
    this.sampler.setBox(box);
    this.deps.readAhead?.setBox(box);
    this.tracker.reset();
    this.resetReadAhead();
  }

  private on(type: string, fn: EventListener) {
    this.video.addEventListener(type, fn);
    this.listeners.push([type, fn]);
  }

  private async save(): Promise<void> {
    try {
      await this.deps.store?.save(this.videoId, this.timeline);
    } catch {
      // persistence is best-effort
    }
  }

  private syncAdState(): void {
    if (this.state === 'stopped') return;
    const ad = adShowing(this.video);
    if (ad && this.state === 'running') {
      this.state = 'paused-ad';
      this.epoch++;
      this.pending = null;
      this.current = null;
      this.overlay.clear();
    } else if (!ad && this.state === 'paused-ad') {
      this.state = 'running';
      this.tracker.reset();
    }
  }

  private onSeeking(): void {
    this.epoch++;
    this.pending = null;
    this.tracker.reset();
    this.current = null;
    this.overlay.clear();
  }

  /** Shows a line the timeline already knows (seek back, rewatch, read-ahead). */
  private showKnown(t: number): boolean {
    const known = this.timeline.at(t);
    if (!known || known.end === null || !known.translation) return false;
    if (this.current !== known) {
      this.current = known;
      this.overlay.show(known.translation, { lineStart: known.start, quality: known.quality === 'better' ? 'better' : 'fast' });
    }
    return true;
  }

  private onFrame(sig: Uint8Array, t: number, grab: () => Promise<ImageBitmap>): void {
    if (this.state !== 'running') return;
    // A closed, translated line on the timeline covers this moment: no OCR needed.
    if (this.showKnown(t)) return;
    if (this.readAheadCovers(t)) {
      // Read-ahead already read this moment: the timeline is the truth (no line = no subtitle).
      const line = this.timeline.at(t);
      if (line?.translation) {
        if (this.current !== line) {
          this.current = line;
          this.overlay.show(line.translation, { lineStart: line.start, quality: line.quality === 'better' ? 'better' : 'fast' });
        }
      } else if (!line && this.current) {
        this.current = null;
        this.overlay.clear();
      }
      return;
    }
    if (this.current && this.current.end !== null && t >= this.current.end) {
      this.current = null;
      this.overlay.clear();
    }
    const event = this.tracker.push(sig, t);
    if (event) this.requestRead(event.at, grab());
  }

  private recheck(): void {
    if (this.state !== 'running' || this.video.paused || !this.current || this.reading || this.current.end !== null) return;
    if (performance.now() - this.lastReadAt < RECHECK_MS) return;
    const frame = this.sampler.sampleNow();
    if (frame) this.requestRead(frame.videoTime, frame.grab());
  }

  private requestRead(t: number, crop: Promise<ImageBitmap>): void {
    if (this.reading) {
      // Latest wins: a newer change supersedes one that hasn't been read yet.
      this.pending?.crop.then(b => b.close()).catch(() => undefined);
      this.pending = { t, crop };
      return;
    }
    void this.read(t, crop);
  }

  private async read(t: number, cropPromise: Promise<ImageBitmap>): Promise<void> {
    this.reading = true;
    const epoch = this.epoch;
    try {
      const crop = await cropPromise;
      this.ocrCalls++;
      this.lastReadAt = performance.now();
      const result = await this.deps.ocr.recognize(crop, this.lang, 'fast');
      if (epoch === this.epoch && this.state === 'running') this.handleText(t, result.confidence >= MIN_CONFIDENCE ? result.text : '');
    } catch (error) {
      console.warn('Subtitle OCR failed:', error);
    } finally {
      this.reading = false;
      const next = this.pending;
      this.pending = null;
      if (next && this.state === 'running') void this.read(next.t, next.crop);
      else void this.pumpReadAhead();
    }
  }

  // ---- read-ahead -----------------------------------------------------------

  private resetReadAhead(): void {
    this.raTracker.reset();
    this.raQueue.forEach(q => q.crop.close());
    this.raQueue = [];
    this.raCurrent = null;
    this.raFrom = Infinity;
    this.raTo = -Infinity;
  }

  /** True when read-ahead has fully processed time t (frames seen and every change before t read). */
  private readAheadCovers(t: number): boolean {
    if (!this.deps.readAhead || this.raFrom === Infinity) return false;
    const safeUntil = Math.min(this.raTo, this.raQueue[0]?.t ?? Infinity, this.raReadingAt ?? Infinity);
    return t >= this.raFrom && t < safeUntil;
  }

  private onReadAheadFrame(crop: ImageBitmap, sig: Uint8Array, t: number): void {
    if (this.state !== 'running') {
      crop.close();
      return;
    }
    if (t < this.raTo - 0.05 || t > this.raTo + 1) {
      // Discontinuity (first frame, seek, gap): start a new covered range here.
      this.raTracker.reset();
      this.raCurrent = null;
      this.raFrom = t;
    }
    this.raTo = t;
    const event = this.raTracker.push(sig, t);
    if (event) {
      if (this.raQueue.length >= MAX_READ_AHEAD_QUEUE) this.raQueue.shift()?.crop.close(); // bounded (frames come from the page's world)
      this.raQueue.push({ t: event.since, crop });
      void this.pumpReadAhead();
    } else {
      crop.close();
    }
  }

  /** Read-ahead OCR runs one at a time, in order, and only while the live path isn't reading. */
  private async pumpReadAhead(): Promise<void> {
    while (this.raQueue.length && this.raReadingAt === null && !this.reading && this.state === 'running') {
      const { t, crop } = this.raQueue.shift()!;
      this.raReadingAt = t;
      const epoch = this.epoch;
      try {
        this.raOcrCalls++;
        const result = await this.deps.ocr.recognize(crop, this.lang, 'accurate');
        if (epoch === this.epoch && this.state === 'running') {
          this.handleReadAheadText(t, result.confidence >= MIN_CONFIDENCE ? result.text : '');
        }
      } catch (error) {
        console.warn('Read-ahead OCR failed:', error);
      } finally {
        this.raReadingAt = null;
      }
    }
  }

  private handleReadAheadText(t: number, text: string): void {
    if (!text) {
      if (this.raCurrent && this.raCurrent.end === null) this.timeline.close(this.raCurrent.start, t);
      this.raCurrent = null;
      return;
    }
    if (this.raCurrent && isSameLine(text, this.raCurrent.source)) return;
    if (this.raCurrent && this.raCurrent.end === null) this.timeline.close(this.raCurrent.start, t);
    const existing = this.timeline.at(t);
    if (existing && isSameLine(text, existing.source)) {
      this.raCurrent = existing; // the live path already has this line
      return;
    }
    const line = this.timeline.upsert({ start: t, end: null, source: text });
    this.raCurrent = line;
    void this.translate(line, 'readahead');
  }

  private handleText(t: number, text: string): void {
    if (!text) {
      if (this.current) {
        if (this.current.end === null) this.timeline.close(this.current.start, t);
        this.current = null;
      }
      this.overlay.clear();
      return;
    }
    if (this.current && isSameLine(text, this.current.source)) return; // same subtitle still on screen
    const known = this.timeline.at(t);
    if (known && isSameLine(text, known.source)) {
      // Read ahead (or seen before): reuse it instead of creating a duplicate line.
      this.current = known;
      if (known.translation) this.overlay.show(known.translation, { lineStart: known.start, quality: known.quality === 'better' ? 'better' : 'fast' });
      return;
    }

    if (this.current && this.current.end === null) this.timeline.close(this.current.start, t);
    const line = this.timeline.upsert({ start: t, end: null, source: text });
    this.current = line;
    void this.translate(line, 'live');
  }

  private async translate(line: TimelineLine, priority: 'live' | 'readahead'): Promise<void> {
    const { previous, next } = this.timeline.neighbours(line.start, 2);
    this.translateCalls++;
    const response = await this.deps
      .translate({ text: line.source, sourceLang: this.lang, previousLines: previous, nextLines: next, priority })
      .catch(error => ({ success: false, error: String(error) }) as TranslateResponse);
    if (!response.success || !response.translatedText) {
      console.warn('Subtitle translation failed:', response.error);
      return;
    }
    this.timeline.setTranslation(line.start, response.translatedText, response.quality ?? 'fast');
    if (!this.translatedAt.has(line.start)) this.translatedAt.set(line.start, this.video.currentTime);
    if (this.current === line && this.state === 'running') {
      this.overlay.show(line.translation!, { lineStart: line.start, quality: line.quality === 'better' ? 'better' : 'fast' });
    }
  }
}
