// trackRegistry.ts - bookkeeping for the MSE tap: which MediaSource each blob URL
// names, which fMP4 video tracks were seen, and pruning so a long session (or a
// page that churns players) never accumulates streams it no longer plays.
import { Fmp4Fragment, Fmp4Init, Fmp4Parser } from './fmp4';
import { MediaParser, WebmParser } from './webm';

export interface TapTrack<M> {
  mediaSource: M;
  codec: string;
  parser: MediaParser;
  init: Fmp4Init | null;
  fragments: Fmp4Fragment[];
  bytes: number;
}

export class TrackRegistry<M extends object> {
  private tracks: TapTrack<M>[] = [];
  private urls = new Map<string, M>();

  get trackCount(): number {
    return this.tracks.length;
  }

  get urlCount(): number {
    return this.urls.size;
  }

  get storedBytes(): number {
    return this.tracks.reduce((n, t) => n + t.bytes, 0);
  }

  registerUrl(url: string, mediaSource: M): void {
    this.urls.set(url, mediaSource);
  }

  /** URL.revokeObjectURL: players often revoke right after assigning src, so keep a URL still in use. */
  revokeUrl(url: string, inUse: boolean): void {
    if (!inUse) this.urls.delete(url);
  }

  addTrack(mediaSource: M, codec: string, container: 'mp4' | 'webm' = 'mp4'): TapTrack<M> {
    const parser = container === 'webm' ? new WebmParser() : new Fmp4Parser();
    const track: TapTrack<M> = { mediaSource, codec, parser, init: null, fragments: [], bytes: 0 };
    this.tracks.push(track);
    return track;
  }

  removeTrack(track: TapTrack<M>): void {
    this.tracks = this.tracks.filter(t => t !== track);
  }

  /** 'sourceclose': the MediaSource is detached for good. */
  closeMediaSource(mediaSource: M): void {
    this.tracks = this.tracks.filter(t => t.mediaSource !== mediaSource);
    for (const [url, m] of this.urls) if (m === mediaSource) this.urls.delete(url);
  }

  /** The newest initialised video track of the MediaSource the video element plays. */
  active(videoSrc: string | null | undefined): TapTrack<M> | null {
    const ms = videoSrc ? this.urls.get(videoSrc) : undefined;
    if (!ms) return null;
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      if (this.tracks[i].mediaSource === ms && this.tracks[i].init) return this.tracks[i];
    }
    return null;
  }

  /** Only the playing stream is read ahead; everything else drops its stored video. */
  releaseInactive(active: TapTrack<M> | null): void {
    for (const t of this.tracks) {
      if (t === active) continue;
      t.fragments = [];
      t.bytes = 0;
    }
  }
}
