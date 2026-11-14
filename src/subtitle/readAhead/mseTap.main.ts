// mseTap.main.ts - runs in the PAGE's main world at document_start (manifest
// "world": "MAIN"). Observes the fragmented-MP4 video appended to MSE
// SourceBuffers and, when subtitle mode asks for it, decodes those fragments
// ahead of playback with WebCodecs and posts crops of the subtitle box to the
// isolated-world content script. Decision record: docs/superpowers/decisions/2026-11-12-read-ahead.md
import { TapTrack, TrackRegistry, codecOf, retypeTrack, tappedContainer } from './trackRegistry';
import { nextFragment } from './fragmentPicker';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Track = TapTrack<MediaSource>;

const RETAIN_BYTES = 48 * 1024 * 1024;
const PAST_SECONDS = 5;
const DISCONTINUITY_SECONDS = 0.5;

(() => {
  if ((window as any).__astMseTap) return;
  (window as any).__astMseTap = true;

  const registry = new TrackRegistry<MediaSource>();
  // Diagnostics, readable from the page (and E2E tests).
  const stats = ((window as any).__astTapStats = { fragments: 0, decoded: 0, posted: 0, maxDecoded: 0, resets: 0, nextTime: 0, queue: 0, unsupported: 0, fed: 0, sessions: 0, configures: 0 });
  (window as any).__astTapRegistry = registry; // diagnostics (E2E)

  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj: Blob | MediaSource) {
    const url = origCreateObjectURL.call(URL, obj);
    if (obj instanceof MediaSource) registry.registerUrl(url, obj);
    return url;
  } as typeof URL.createObjectURL;

  const origRevokeObjectURL = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url: string) {
    registry.revokeUrl(url, [...document.querySelectorAll('video')].some(v => v.src === url));
    return origRevokeObjectURL.call(URL, url);
  };

  const sbTracks = new WeakMap<SourceBuffer, Track>();
  const disabled = new WeakSet<Track>();
  function disable(track: Track): void {
    if (disabled.has(track)) return;
    disabled.add(track);
    registry.removeTrack(track);
    stats.unsupported++;
  }

  /** (Re)checks that WebCodecs can decode the track's codec; turns read-ahead off or back on for it. */
  function checkSupport(ms: MediaSource, track: Track): void {
    if (typeof VideoDecoder === 'undefined' || !track.codec) {
      disable(track);
      return;
    }
    VideoDecoder.isConfigSupported({ codec: track.codec })
      .then(r => {
        if (!r.supported) disable(track);
        else if (disabled.has(track)) {
          disabled.delete(track);
          registry.restoreTrack(ms, track);
        }
      })
      .catch(() => disable(track));
  }
  const watched = new WeakSet<MediaSource>();

  const origRemove = MediaSource.prototype.removeSourceBuffer;
  MediaSource.prototype.removeSourceBuffer = function (this: MediaSource, sb: SourceBuffer) {
    const track = sbTracks.get(sb);
    if (track) registry.removeTrack(track);
    return origRemove.call(this, sb);
  };

  const origAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
    const sb = origAdd.call(this, mime);
    const container = tappedContainer(mime);
    if (container) {
      const codec = codecOf(mime);
      const track = registry.addTrack(this, codec, container);
      sbTracks.set(sb, track);
      // A codec WebCodecs can't decode here leaves read-ahead off for this track
      // (the live path carries the experience); nothing is thrown into the page.
      checkSupport(this, track);
      if (!watched.has(this)) {
        watched.add(this);
        this.addEventListener('sourceclose', event => registry.closeMediaSource(event.target as MediaSource));
      }
      // abort()/changeType() reset the browser's segment parser; ours must follow
      // or a half-parsed segment desyncs every later append.
      const abort = sb.abort.bind(sb);
      sb.abort = () => {
        track.parser.reset();
        return abort();
      };
      if (typeof sb.changeType === 'function') {
        const changeType = sb.changeType.bind(sb);
        sb.changeType = (type: string) => {
          // The next segments may be another container/codec: new parser, old data dropped, support re-checked.
          retypeTrack(track, type);
          if (!tappedContainer(type)) disable(track);
          else checkSupport(this, track);
          return changeType(type);
        };
      }
      const append = sb.appendBuffer.bind(sb);
      sb.appendBuffer = (data: BufferSource) => {
        if (disabled.has(track)) return append(data);
        try {
          const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const { init, fragments } = track.parser.push(view.slice(), sb.timestampOffset);
          if (init) track.init = init;
          for (const f of fragments) {
            stats.fragments++;
            track.fragments.push(f);
            track.bytes += f.samples.reduce((n, s) => n + s.data.byteLength, 0);
          }
          trim(track);
          registry.releaseInactive(activeTrack());
          if (fragments.length) session?.pump();
        } catch (error) {
          console.debug('[ast] mse tap parse error', error);
        }
        return append(data);
      };
    }
    return sb;
  };

  function mainVideo(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>('video.html5-main-video') ?? document.querySelector('video');
  }

  function activeTrack(): Track | null {
    return registry.active(mainVideo()?.src);
  }

  function trim(track: Track): void {
    const now = mainVideo()?.currentTime ?? 0;
    while (track.fragments.length > 1) {
      const first = track.fragments[0];
      const last = first.samples[first.samples.length - 1];
      if (track.bytes <= RETAIN_BYTES && last.time + last.duration >= now - PAST_SECONDS) break;
      track.bytes -= first.samples.reduce((n, s) => n + s.data.byteLength, 0);
      track.fragments.shift();
    }
  }

  class Session {
    private decoder: VideoDecoder | null = null;
    private track: Track | null = null;
    private nextTime = -Infinity; // end of the last fragment fed to the decoder
    private needKey = true;
    private lastSlot = -1;
    private canvas: OffscreenCanvas | null = null;
    private pumping = false;
    stopped = false;

    constructor(private box: Box, private fps: number) {}

    setBox(box: Box): void {
      this.box = box;
    }

    private configure(track: Track): void {
      stats.configures++;
      this.decoder?.close();
      this.track = track;
      this.needKey = true;
      this.nextTime = -Infinity;
      this.decoder = new VideoDecoder({ output: f => this.onFrame(f), error: e => console.debug('[ast] decoder error', e) });
      const describe = track.init?.configBox && ['av1C', 'avcC', 'hvcC'].includes(track.init.configBox);
      this.decoder.configure({
        codec: track.codec,
        ...(describe && track.init?.description ? { description: track.init.description } : {}),
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: false,
      });
    }

    /** Feeds stored fragments from the playhead onward, in order, with backpressure. */
    async pump(): Promise<void> {
      if (this.pumping || this.stopped) return;
      this.pumping = true;
      try {
        for (;;) {
          if (this.stopped) return;
          const track = activeTrack();
          if (!track) return;
          if (track !== this.track || this.decoder?.state === 'closed') this.configure(track);
          const now = mainVideo()?.currentTime ?? 0;
          const fresh = this.nextTime === -Infinity;
          const next = nextFragment(track.fragments, this.nextTime, now);
          if (!next) return;
          if (!fresh && next.start - this.nextTime > DISCONTINUITY_SECONDS) {
            // Seek or gap: restart decoding at a keyframe.
            this.decoder!.reset();
            this.configure(track);
            stats.resets++;
            window.postMessage({ astTapReset: true, t: next.start }, '*');
          }
          for (const sample of next.samples) {
            if (this.needKey && !sample.key) continue;
            this.needKey = false;
            while (this.decoder!.decodeQueueSize > 16 && !this.stopped) {
              await new Promise(r => this.decoder!.addEventListener('dequeue', r, { once: true }));
            }
            if (this.stopped) return;
            stats.fed++;
            this.decoder!.decode(
              new EncodedVideoChunk({ type: sample.key ? 'key' : 'delta', timestamp: Math.round(sample.time * 1e6), duration: Math.round(sample.duration * 1e6), data: sample.data })
            );
          }
          const last = next.samples[next.samples.length - 1];
          this.nextTime = last.time + last.duration;
          stats.nextTime = this.nextTime;
          stats.queue = this.decoder!.decodeQueueSize;
        }
      } finally {
        this.pumping = false;
      }
    }

    private onFrame(frame: VideoFrame): void {
      try {
        const t = frame.timestamp / 1e6;
        stats.decoded++;
        stats.maxDecoded = Math.max(stats.maxDecoded, t);
        const video = mainVideo();
        const slot = Math.floor(t * this.fps);
        if (this.stopped || slot === this.lastSlot || !video || t < video.currentTime - 0.5) return;
        if (video.closest('.html5-video-player')?.classList.contains('ad-showing')) return;
        this.lastSlot = slot;
        const w = frame.displayWidth;
        const h = frame.displayHeight;
        const sx = Math.round(this.box.x * w);
        const sy = Math.round(this.box.y * h);
        const sw = Math.max(1, Math.round(this.box.w * w));
        const sh = Math.max(1, Math.round(this.box.h * h));
        if (!this.canvas || this.canvas.width !== sw || this.canvas.height !== sh) this.canvas = new OffscreenCanvas(sw, sh);
        this.canvas.getContext('2d')!.drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh);
        const bitmap = this.canvas.transferToImageBitmap();
        stats.posted++;
        window.postMessage({ astTapFrame: true, t, bitmap }, '*', [bitmap]);
      } finally {
        frame.close();
      }
    }

    stop(): void {
      this.stopped = true;
      try {
        this.decoder?.close();
      } catch {
        // already closed
      }
    }
  }

  let session: Session | null = null;

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.astTap === 'start') {
      session?.stop();
      session = new Session(msg.box, msg.fps ?? 8);
      stats.sessions++;
      void session.pump();
    } else if (msg?.astTap === 'box' && session) {
      session.setBox(msg.box);
    } else if (msg?.astTap === 'stop') {
      session?.stop();
      session = null;
    }
  });
})();
