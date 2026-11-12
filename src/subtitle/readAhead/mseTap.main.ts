// mseTap.main.ts - runs in the PAGE's main world at document_start (manifest
// "world": "MAIN"). Observes the fragmented-MP4 video appended to MSE
// SourceBuffers and, when subtitle mode asks for it, decodes those fragments
// ahead of playback with WebCodecs and posts crops of the subtitle box to the
// isolated-world content script. Decision record: docs/superpowers/decisions/2026-11-12-read-ahead.md
import { Fmp4Fragment, Fmp4Init, Fmp4Parser } from './fmp4';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Track {
  mediaSource: MediaSource;
  codec: string;
  parser: Fmp4Parser;
  init: Fmp4Init | null;
  fragments: Fmp4Fragment[];
  bytes: number;
}

const RETAIN_BYTES = 48 * 1024 * 1024;
const PAST_SECONDS = 5;
const DISCONTINUITY_SECONDS = 0.5;

(() => {
  if ((window as any).__astMseTap) return;
  (window as any).__astMseTap = true;

  const tracks: Track[] = [];
  // Diagnostics, readable from the page (and E2E tests).
  const stats = ((window as any).__astTapStats = { fragments: 0, decoded: 0, posted: 0, maxDecoded: 0, resets: 0, nextTime: 0, queue: 0 });
  const mediaSourceUrls = new Map<string, MediaSource>();

  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj: Blob | MediaSource) {
    const url = origCreateObjectURL.call(URL, obj);
    if (obj instanceof MediaSource) mediaSourceUrls.set(url, obj);
    return url;
  } as typeof URL.createObjectURL;

  const origAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
    const sb = origAdd.call(this, mime);
    if (/^video\/mp4/i.test(mime)) {
      const codec = mime.match(/codecs="?([^",]+)/i)?.[1] ?? '';
      const track: Track = { mediaSource: this, codec, parser: new Fmp4Parser(), init: null, fragments: [], bytes: 0 };
      tracks.push(track);
      const append = sb.appendBuffer.bind(sb);
      sb.appendBuffer = (data: BufferSource) => {
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
    const video = mainVideo();
    const ms = video && mediaSourceUrls.get(video.src);
    return (ms && [...tracks].reverse().find(t => t.mediaSource === ms && t.init)) || null;
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
          const track = activeTrack();
          if (!track) return;
          if (track !== this.track || this.decoder?.state === 'closed') this.configure(track);
          const now = mainVideo()?.currentTime ?? 0;
          const fresh = this.nextTime === -Infinity;
          // Fresh start: the fragment containing the playhead (fragments begin at
          // keyframes in practice). Otherwise: the first fragment starting where the
          // previous one ended - never the one just decoded.
          const next = fresh
            ? track.fragments.find(f => {
                const last = f.samples[f.samples.length - 1];
                return last.time + last.duration > now - 0.5;
              })
            : track.fragments.find(f => f.start >= this.nextTime - 0.05);
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
      void session.pump();
    } else if (msg?.astTap === 'box' && session) {
      session.setBox(msg.box);
    } else if (msg?.astTap === 'stop') {
      session?.stop();
      session = null;
    }
  });
})();
