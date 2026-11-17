// content.ts - Content script for the live subtitle overlay

import {
  ExtensionMessage,
  DisplaySubtitleMessage,
  UpgradeSubtitleMessage,
  UpdateStyleMessage,
  CaptionErrorMessage,
  CaptionStatusMessage,
  SubtitlePosition,
  FontSize
} from './types';
import { VideoClock } from './audio/videoClock';
import { CaptionPolicy } from './audio/captionPolicy';
import { ReadAheadSchedule } from './audio/readAheadSchedule';
import { AudioReadAhead, readAheadHost } from './audio/readAhead/audioReadAhead';
import { toInt16Base64 } from './audio/readAhead/pcm';

/** Playing media is heard only when not muted and with volume up. */
const isAudible = (m: HTMLMediaElement): boolean => !m.muted && m.volume > 0;

const STATUS_LINGER_MS = 2500;
const ERROR_LINGER_MS = 6000;
const TICK_MS = 100; // read-ahead captions land on their start within a tenth of a second
const RA_STATE_EVERY_MS = 1000;

const POSITION_STYLES: Record<SubtitlePosition, Partial<CSSStyleDeclaration>> = {
  top: { top: '8%', bottom: '', transform: 'translateX(-50%)' },
  center: { top: '50%', bottom: '', transform: 'translate(-50%, -50%)' },
  bottom: { top: '', bottom: '10%', transform: 'translateX(-50%)' }
};

const FONT_SIZES: FontSize[] = ['small', 'medium', 'large', 'x-large'];

export class SubtitleOverlay {
  private isActive = false;
  private overlay: HTMLDivElement | null = null;
  private captions: HTMLDivElement | null = null;
  private notices: HTMLDivElement | null = null;
  private position: SubtitlePosition = 'bottom';
  private fontSize: FontSize = 'medium';
  // Captions follow the playing media element's time: pause freezes them, seek
  // clears them, stale or out-of-order captions are dropped (CaptionPolicy).
  private policy = new CaptionPolicy();
  private clock: VideoClock | null = null;
  private media: HTMLMediaElement | null = null;
  private unobserve: (() => void) | null = null;
  private ticker: number | null = null;
  private captionSeq = 0;
  // Audio read-ahead: captions made before their words are spoken, shown by video time.
  private schedule = new ReadAheadSchedule();
  private readAhead: AudioReadAhead | null = null;
  private raHealthy = false;
  private raStateSentAt = 0;
  private raSources = new Map<string, string>();
  private raBetter = new Set<string>();
  private raDropped = { late: 0, liveWhileAhead: 0, liveCovered: 0, remade: 0 };

  constructor() {
    this.setupMessageListener();
    this.watchStyleSettings();
  }

  get active(): boolean {
    return this.isActive;
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (message: ExtensionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
        switch (message.type) {
          case 'TOGGLE_SUBTITLES':
            this.toggleSubtitles().then(() => sendResponse({ active: this.isActive }));
            return true;

          case 'GET_SUBTITLE_STATE':
            sendResponse({ active: this.isActive });
            return false;

          case 'CAPTURE_STARTED':
            this.showStatus('Listening for audio...');
            break;

          case 'CAPTURE_STOPPED':
            this.onCaptureStopped();
            break;

          case 'DISPLAY_SUBTITLE': {
            const displayMsg = message as DisplaySubtitleMessage;
            this.displaySubtitle(displayMsg.text, displayMsg.timing, displayMsg.captionId, displayMsg.source, displayMsg.speechEndedAt, displayMsg.videoStart, displayMsg.videoEnd);
            break;
          }

          case 'UPGRADE_SUBTITLE': {
            // Claude's context-aware version of a caption: swap it in only while it is still shown.
            const upgrade = message as UpgradeSubtitleMessage;
            this.upgradeSubtitle(upgrade.captionId, upgrade.text);
            break;
          }

          case 'CAPTION_ERROR':
            this.showError((message as CaptionErrorMessage).message);
            break;

          case 'CAPTION_STATUS': {
            const statusMsg = message as CaptionStatusMessage;
            this.showStatus(statusMsg.message, statusMsg.replace === true);
            break;
          }

          case 'UPDATE_STYLE': {
            const style = (message as UpdateStyleMessage).style;
            this.applyStyle(style.position, style.fontSize);
            break;
          }
        }
        return false;
      }
    );
  }

  private watchStyleSettings(): void {
    chrome.storage.sync
      .get({ subtitleStyle: 'bottom', fontSize: 'medium' })
      .then(s => this.applyStyle(s.subtitleStyle, s.fontSize))
      .catch(() => undefined);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.subtitleStyle || changes.fontSize) {
        this.applyStyle(changes.subtitleStyle?.newValue, changes.fontSize?.newValue);
      }
    });
  }

  applyStyle(position?: SubtitlePosition, fontSize?: FontSize): void {
    if (position && position in POSITION_STYLES) this.position = position;
    if (fontSize && FONT_SIZES.includes(fontSize)) this.fontSize = fontSize;
    if (!this.overlay) return;
    Object.assign(this.overlay.style, POSITION_STYLES[this.position]);
    this.overlay.dataset.position = this.position;
    this.overlay.querySelectorAll('.subtitle-text').forEach(el => {
      FONT_SIZES.forEach(size => el.classList.toggle(size, size === this.fontSize));
    });
  }

  async toggleSubtitles(): Promise<void> {
    if (this.isActive) {
      this.isActive = false;
      this.stopFollowing();
      this.removeOverlay();
      await this.sendSafely({ type: 'STOP_CAPTURE' });
      return;
    }

    this.isActive = true;
    this.createOverlay();
    this.startFollowing();
    const response = await this.sendSafely({ type: 'START_CAPTURE' });
    if (!response?.success) {
      this.isActive = false;
      this.showError(response?.error || 'Failed to start audio capture');
    }
  }

  private async sendSafely(message: ExtensionMessage): Promise<any> {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private onCaptureStopped(): void {
    if (!this.isActive) return;
    // Capture was stopped from elsewhere (e.g. captions started on another tab).
    this.isActive = false;
    this.stopFollowing();
    this.showStatus('Captions stopped');
  }

  createOverlay(): void {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.id = 'subtitle-overlay-extension';
    this.overlay.className = 'subtitle-overlay';
    this.overlay.style.cssText = `
      position: fixed;
      left: 50%;
      z-index: 2147483647;
      pointer-events: none;
      max-width: 80%;
      text-align: center;
    `;

    this.notices = document.createElement('div');
    this.notices.className = 'subtitle-notices';
    this.captions = document.createElement('div');
    this.captions.className = 'subtitle-captions';
    this.overlay.append(this.notices, this.captions);

    document.body.appendChild(this.overlay);
    this.applyStyle();
  }

  removeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.captions = null;
    this.notices = null;
  }

  // ---- following the media element ----

  /**
   * The media element captions follow: the largest one playing with sound, else
   * the largest with sound. Muted media (hover previews, background loops) is
   * never followed: it isn't what is being heard.
   */
  private pickMedia(): HTMLMediaElement | null {
    const audible = [...document.querySelectorAll<HTMLMediaElement>('video, audio')].filter(isAudible);
    const area = (m: HTMLMediaElement) => {
      const r = m.getBoundingClientRect();
      return r.width * r.height;
    };
    const largest = (ms: HTMLMediaElement[]) => ms.sort((a, b) => area(b) - area(a))[0] ?? null;
    return largest(audible.filter(m => !m.paused)) ?? largest(audible);
  }

  private follow(media: HTMLMediaElement | null): void {
    if (media === this.media) return;
    this.unobserve?.();
    this.unobserve = null;
    this.media = media;
    this.clock = null;
    // Another video's times mean nothing for this one: start from a clean slate.
    this.removeCaptions(this.policy.clear());
    this.stopReadAhead();
    if (!media) return;
    this.startReadAhead(media);
    const clock = new VideoClock();
    this.clock = clock;
    const unobserveClock = clock.observe(media as HTMLVideoElement, () => !!media.closest('.html5-video-player')?.classList.contains('ad-showing'));
    const onJump = () => {
      this.removeCaptions(this.policy.clear());
      // Outside the audio read ahead: the tap starts again there, and so does the pipeline.
      if (this.readAhead && !this.readAhead.covers(media.currentTime)) this.restartReadAhead(media.currentTime);
      this.renderReadAhead(); // read-ahead captions for the new position, if made already
    };
    const onNewSource = () => {
      this.removeCaptions(this.policy.clear());
      this.schedule.clear(); // another item: its captions are not this one's
      if (this.readAhead) this.restartReadAhead(media.currentTime);
      this.renderReadAhead();
    };
    media.addEventListener('seeking', onJump);
    media.addEventListener('seeked', onJump);
    media.addEventListener('emptied', onNewSource);
    this.unobserve = () => {
      unobserveClock();
      media.removeEventListener('seeking', onJump);
      media.removeEventListener('seeked', onJump);
      media.removeEventListener('emptied', onNewSource);
    };
  }

  private readonly onAnyPlay = (event: Event) => {
    if (event.target instanceof HTMLMediaElement && isAudible(event.target)) this.follow(event.target);
  };

  private startFollowing(): void {
    this.follow(this.pickMedia());
    document.addEventListener('play', this.onAnyPlay, true);
    this.ticker = window.setInterval(() => this.tick(), TICK_MS);
  }

  private stopFollowing(): void {
    document.removeEventListener('play', this.onAnyPlay, true);
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
    this.follow(null);
    this.removeCaptions(this.policy.clear()); // also on pages without media (wall clock)
  }

  /** Current position: the media element's time, or the wall clock on pages without one. */
  private now(): { videoTime: number; paused: boolean; adShowing: boolean; rate: number } {
    const m = this.media;
    if (!m) return { videoTime: Date.now() / 1000, paused: false, adShowing: false, rate: 1 };
    return { videoTime: m.currentTime, paused: m.paused, adShowing: !!m.closest('.html5-video-player')?.classList.contains('ad-showing'), rate: m.playbackRate || 1 };
  }

  private tick(): void {
    this.renderReadAhead(); // a pause freezes video time, so the read-ahead lines too
    this.reportReadAhead();
    const now = this.now();
    if (now.paused) return; // video time stands still: lines stay
    this.removeCaptions(this.policy.tick(now.videoTime));
  }

  // ---- audio read-ahead ----

  private startReadAhead(media: HTMLMediaElement): void {
    // Only where the main-world audio tap runs; elsewhere no page can pose as it.
    if (!(media instanceof HTMLVideoElement) || !readAheadHost(location.hostname)) return;
    const ra = new AudioReadAhead(media);
    this.readAhead = ra;
    ra.start(
      (t, pcm) => void this.sendSafely({ type: 'READ_AHEAD_AUDIO', t, pcm: toInt16Base64(pcm), playhead: media.currentTime } as unknown as ExtensionMessage),
      t => void this.sendSafely({ type: 'READ_AHEAD_RESET', t, playhead: media.currentTime } as unknown as ExtensionMessage)
    );
  }

  /** What was read ahead no longer applies (a seek outside it, a new source): forget it, tell the pipeline. */
  private restartReadAhead(playhead: number): void {
    this.readAhead?.forget();
    void this.sendSafely({ type: 'READ_AHEAD_RESET', t: playhead, playhead } as unknown as ExtensionMessage);
  }

  private stopReadAhead(): void {
    if (this.readAhead) void this.sendSafely({ type: 'READ_AHEAD_RESET', t: 0, playhead: 0 } as unknown as ExtensionMessage);
    this.readAhead?.stop();
    this.readAhead = null;
    this.schedule.clear();
    this.raSources.clear();
    this.raBetter.clear();
    this.renderReadAhead();
    this.reportReadAhead(true);
  }

  /** Tells the pipeline whether read-ahead covers the playhead (it then skips the live path). */
  private reportReadAhead(force = false): void {
    const healthy = !!this.readAhead?.healthy;
    if (this.overlay) {
      this.overlay.dataset.path = healthy ? 'read-ahead' : 'live';
      this.overlay.dataset.raDropped = JSON.stringify(this.raDropped);
      this.overlay.dataset.raScheduled = String(this.schedule.size);
    }
    const now = Date.now();
    if (!force && healthy === this.raHealthy && now - this.raStateSentAt < RA_STATE_EVERY_MS) return;
    if (!force && !this.readAhead) return;
    this.raHealthy = healthy;
    this.raStateSentAt = now;
    void this.sendSafely({ type: 'READ_AHEAD_STATE', healthy, playhead: this.media?.currentTime ?? 0 } as unknown as ExtensionMessage);
  }

  /** Puts on screen the read-ahead captions due at the current video time. */
  private renderReadAhead(): void {
    if (!this.captions) return;
    const visible = this.media ? this.schedule.visibleAt(this.media.currentTime) : [];
    const keep = new Set(visible.map(c => c.id));
    const existing = new Map<string, HTMLElement>();
    for (const el of [...this.captions.querySelectorAll<HTMLElement>('.subtitle-text[data-video-start]')]) {
      const id = el.dataset.captionId ?? '';
      if (keep.has(id)) existing.set(id, el);
      else el.remove();
    }
    for (const c of visible) {
      let el = existing.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.className = `subtitle-text ${this.fontSize}`;
        el.dataset.captionId = c.id;
        el.dataset.videoStart = String(c.start);
        el.dataset.videoEnd = String(c.end);
        const source = this.raSources.get(c.id);
        if (source) el.dataset.source = source;
        el.dataset.shownAtVideo = String(this.media?.currentTime ?? c.start);
      }
      if (el.textContent !== c.text) el.textContent = c.text;
      if (this.raBetter.has(c.id)) el.dataset.quality = 'better';
      this.captions.appendChild(el); // keeps the newer line below
    }
  }

  private removeCaptions(ids: string[]): void {
    if (!this.captions || !ids.length) return;
    for (const el of [...this.captions.querySelectorAll<HTMLElement>('.subtitle-text')]) {
      if (ids.includes(el.dataset.captionId ?? '')) el.remove();
    }
  }

  displaySubtitle(
    text: string,
    timing?: Record<string, number>,
    captionId?: string,
    source?: string,
    speechEndedAt?: number,
    videoStart?: number,
    videoEnd?: number
  ): void {
    if (!this.isActive || !text) return;
    if (!this.captions) this.createOverlay();
    if (typeof videoStart === 'number' && typeof videoEnd === 'number') {
      // Read-ahead: made before its words are spoken; shown when the video gets there.
      const id = captionId ?? `ra-${++this.captionSeq}`;
      const caption = { id, text, start: videoStart, end: videoEnd };
      const now = this.now();
      if (this.media && this.schedule.isOver(caption, now.videoTime, now.rate)) {
        this.raDropped.late++;
        this.readAhead?.noteLate(); // not keeping up: the live path will help
        return;
      }
      if (!this.schedule.add(caption, now.rate)) {
        this.raDropped.remade++;
        return;
      }
      if (source) this.raSources.set(id, source);
      this.renderReadAhead();
      return;
    }
    if (this.readAhead?.healthy) {
      // Read-ahead already covers this speech (one may still be in flight from before it took over).
      this.raDropped.liveWhileAhead++;
      return;
    }
    if (typeof speechEndedAt === 'number' && this.clock) {
      // Around a hand-over: a read-ahead caption may already show this speech.
      const endVideo = this.clock.videoTimeAt(speechEndedAt);
      if (endVideo !== null && this.schedule.covering(endVideo)) {
        this.raDropped.liveCovered++;
        return;
      }
    }
    if (!this.media || !document.contains(this.media) || this.media.paused) {
      // Gone, or paused while another audible element plays: follow what is heard now.
      const pick = this.pickMedia();
      if (!this.media || !document.contains(this.media) || (pick && !pick.paused)) this.follow(pick);
    }
    const id = captionId ?? `local-${++this.captionSeq}`;

    const now = this.now();
    const ended = typeof speechEndedAt === 'number' ? speechEndedAt : Date.now();
    const speechEndVideo = this.clock ? this.clock.videoTimeAt(ended) : this.media ? null : ended / 1000;
    const decision = this.policy.offer(
      { id, text, speechEndVideo },
      { ...now, paused: now.paused || (this.clock?.pausedSince(ended) ?? false), seekedSinceSpeech: this.clock?.seekedSince(ended) ?? false }
    );
    if (decision === 'drop') {
      // Lets the benchmark see why captions didn't appear.
      if (this.overlay) this.overlay.dataset.dropped = JSON.stringify(this.policy.drops);
      return;
    }

    const line = document.createElement('div');
    line.className = `subtitle-text ${this.fontSize}`;
    line.textContent = text;
    line.dataset.captionId = id;
    if (source) line.dataset.source = source;
    if (typeof speechEndedAt === 'number') line.dataset.speechEndedAt = String(speechEndedAt);
    if (timing) {
      // Lets the E2E/perf harness measure pipeline latency.
      line.dataset.timing = JSON.stringify({ ...timing, displayedAt: Date.now() });
    }
    this.captions!.appendChild(line);
    // The roll: lines the policy no longer keeps (a third pushed the oldest out).
    const keep = new Set(this.policy.visible());
    for (const el of [...this.captions!.querySelectorAll<HTMLElement>('.subtitle-text')]) {
      if (!keep.has(el.dataset.captionId ?? '')) el.remove();
    }
  }

  upgradeSubtitle(captionId: string, text: string): void {
    if (!text) return;
    if (this.schedule.upgrade(captionId, text)) {
      // Read-ahead: replaced before display where possible, in place if already shown.
      this.raBetter.add(captionId);
      this.renderReadAhead();
      return;
    }
    if (!this.captions) return;
    const line = [...this.captions.querySelectorAll<HTMLElement>('.subtitle-text')].find(el => el.dataset.captionId === captionId);
    if (line) {
      line.textContent = text;
      line.dataset.quality = 'better';
      const now = this.now();
      this.policy.upgrade(captionId, text, now.videoTime, now.rate);
    }
  }

  showError(message: string): void {
    this.addNotice('subtitle-error', `Error: ${message}`, ERROR_LINGER_MS, false);
  }

  showStatus(message: string, replace = false): void {
    this.addNotice('subtitle-status', message, STATUS_LINGER_MS, replace);
  }

  private addNotice(className: string, text: string, lingerMs: number, replace: boolean): void {
    if (!this.notices) this.createOverlay();

    let notice: HTMLDivElement | null = replace
      ? this.notices!.querySelector<HTMLDivElement>(`.${className}[data-replaceable]`)
      : null;
    if (!notice) {
      notice = document.createElement('div');
      notice.className = className;
      if (replace) notice.dataset.replaceable = '';
      this.notices!.appendChild(notice);
    }
    notice.textContent = text;

    const el = notice;
    window.clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(
      window.setTimeout(() => {
        el.remove();
        // Once captions are off and the last notice fades, take the overlay down too.
        if (!this.isActive && this.notices && !this.notices.children.length && !this.captions?.children.length) {
          this.removeOverlay();
        }
      }, lingerMs)
    );
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SubtitleOverlay();
  });
} else {
  new SubtitleOverlay();
}
