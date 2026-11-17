// mseTap.main.ts - runs in the PAGE's main world at document_start (manifest
// "world": "MAIN"). Observes the fragmented-MP4 video appended to MSE
// SourceBuffers and, when subtitle mode asks for it, decodes those fragments
// ahead of playback with WebCodecs and posts crops of the subtitle box to the
// isolated-world content script. Decision record: docs/superpowers/decisions/2026-11-12-read-ahead.md
// Audio mode: the audio SourceBuffer (WebM/Opus) is decoded ahead the same way
// and posted as 16 kHz mono PCM chunks in video time (audio read-ahead).
import { TapTrack, TrackRegistry, audioCodecOf, codecOf, retypeTrack, tappedContainer, tappedKind } from './trackRegistry';
import { nextFragment } from './fragmentPicker';
import { Resampler16k, WHISPER_RATE, downmix } from '../../audio/readAhead/pcm';

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
/** Audio is decoded at most this far ahead of the playhead. */
const AUDIO_MAX_LEAD_SECONDS = 90;
/** PCM is posted in chunks of this many 16 kHz samples (1 s). */
const AUDIO_CHUNK_SAMPLES = WHISPER_RATE;

(() => {
  if ((window as any).__astMseTap) return;
  (window as any).__astMseTap = true;

  const registry = new TrackRegistry<MediaSource>();
  // Diagnostics, readable from the page (and E2E tests).
  const stats = ((window as any).__astTapStats = { fragments: 0, decoded: 0, posted: 0, maxDecoded: 0, resets: 0, nextTime: 0, queue: 0, unsupported: 0, fed: 0, sessions: 0, configures: 0 });
  const audioStats = ((window as any).__astAudioTapStats = { fragments: 0, decoded: 0, chunks: 0, resets: 0, nextTime: 0, sessions: 0, errors: 0 });
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
    const audio = track.kind === 'audio';
    if ((audio ? typeof AudioDecoder === 'undefined' : typeof VideoDecoder === 'undefined') || !track.codec) {
      disable(track);
      return;
    }
    const supported: Promise<{ supported?: boolean }> = audio
      ? AudioDecoder.isConfigSupported({ codec: track.codec, sampleRate: 48000, numberOfChannels: 2 })
      : VideoDecoder.isConfigSupported({ codec: track.codec });
    supported
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
    const kind = tappedKind(mime);
    if (kind) {
      const container = tappedContainer(mime) ?? 'webm';
      const codec = kind === 'audio' ? audioCodecOf(mime) : codecOf(mime);
      const track = registry.addTrack(this, codec, container, kind);
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
          if (tappedKind(type) !== track.kind) disable(track);
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
            if (track.kind === 'audio') audioStats.fragments++;
            else stats.fragments++;
            track.fragments.push(f);
            track.bytes += f.samples.reduce((n, s) => n + s.data.byteLength, 0);
          }
          trim(track);
          registry.releaseInactive(activeTrack(), activeAudioTrack());
          if (fragments.length) {
            if (track.kind === 'audio') void audioSession?.pump();
            else void session?.pump();
          }
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

  function activeAudioTrack(): Track | null {
    return registry.activeAudio(mainVideo()?.src);
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

  /**
   * Decodes the playing stream's audio ahead of the playhead (up to 90 s) and
   * posts it as 16 kHz mono PCM chunks in video time. A seek outside what was
   * decoded restarts at the new playhead.
   */
  class AudioSession {
    private decoder: AudioDecoder | null = null;
    private track: Track | null = null;
    private nextTime = -Infinity; // end of the last fragment fed
    private decodedFrom = Infinity; // start of this run of decoding
    private lastNow: number | null = null; // playhead at the previous pump (seek detection)
    private resampler: Resampler16k | null = null;
    private inputEnd = -Infinity; // video time where the last decoded audio ended
    private outTime = 0; // video time of the first pending sample
    private pending: Float32Array[] = [];
    private pendingLength = 0;
    private pumping = false;
    private readonly timer: number;
    stopped = false;

    constructor() {
      // Playback moves on without new appends (the player's buffer is full): keep the lead topped up.
      this.timer = window.setInterval(() => void this.pump(), 1000);
    }

    private configure(track: Track): void {
      try {
        this.decoder?.close();
      } catch {
        // already closed
      }
      this.track = track;
      this.nextTime = -Infinity;
      this.decodedFrom = Infinity;
      this.inputEnd = -Infinity;
      this.pending = [];
      this.pendingLength = 0;
      const audio = track.init!.audio!;
      this.decoder = new AudioDecoder({
        output: d => this.onData(d),
        error: e => {
          audioStats.errors++;
          console.debug('[ast] audio decoder error', e);
        },
      });
      this.decoder.configure({
        codec: audio.codec,
        sampleRate: audio.sampleRate,
        numberOfChannels: audio.channels,
        ...(track.init!.description ? { description: track.init!.description } : {}),
      });
      this.resampler = new Resampler16k(audio.sampleRate);
    }

    async pump(): Promise<void> {
      if (this.pumping || this.stopped) return;
      this.pumping = true;
      try {
        for (;;) {
          if (this.stopped) return;
          const track = activeAudioTrack();
          if (!track?.init?.audio) return;
          const now = mainVideo()?.currentTime ?? 0;
          // A jump of the playhead (natural playback moves at most ~2 s between pumps, even at 2x).
          const jumped = this.lastNow !== null && Math.abs(now - this.lastNow) > 3;
          this.lastNow = now;
          if (track !== this.track || this.decoder?.state === 'closed') this.configure(track);
          else if (jumped && this.nextTime !== -Infinity && (now < this.decodedFrom - 1 || now > this.nextTime + 1)) {
            // A seek outside what was decoded: start again at the playhead.
            this.configure(track);
            audioStats.resets++;
            window.postMessage({ astAudioReset: true, t: now }, '*');
          }
          const next = nextFragment(track.fragments, this.nextTime, now);
          if (!next || next.start > now + AUDIO_MAX_LEAD_SECONDS) return;
          if (this.nextTime !== -Infinity && next.start - this.nextTime > DISCONTINUITY_SECONDS) {
            this.configure(track);
            audioStats.resets++;
            window.postMessage({ astAudioReset: true, t: next.start }, '*');
            continue;
          }
          // A fresh start counts from the playhead (its first fragment may begin a little after it).
          this.decodedFrom = Math.min(this.decodedFrom, next.start, this.nextTime === -Infinity ? now : Infinity);
          for (const sample of next.samples) {
            while (this.decoder!.decodeQueueSize > 32 && !this.stopped) {
              await new Promise(r => this.decoder!.addEventListener('dequeue', r, { once: true }));
            }
            if (this.stopped) return;
            this.decoder!.decode(
              new EncodedAudioChunk({ type: 'key', timestamp: Math.round(sample.time * 1e6), duration: Math.round(sample.duration * 1e6), data: sample.data })
            );
          }
          const last = next.samples[next.samples.length - 1];
          this.nextTime = last.time + last.duration;
          audioStats.nextTime = this.nextTime;
        }
      } finally {
        this.pumping = false;
      }
    }

    private onData(data: AudioData): void {
      try {
        if (this.stopped || !this.resampler) return;
        audioStats.decoded++;
        const t = data.timestamp / 1e6;
        const planes: Float32Array[] = [];
        for (let c = 0; c < data.numberOfChannels; c++) {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          planes.push(plane);
        }
        if (Math.abs(t - this.inputEnd) > 0.05) {
          // Not continuous with what came before: post what is pending and start a new run.
          this.flush();
          this.resampler = new Resampler16k(data.sampleRate);
          this.outTime = t;
        }
        this.inputEnd = t + data.numberOfFrames / data.sampleRate;
        const pcm = this.resampler.push(downmix(planes));
        this.pending.push(pcm);
        this.pendingLength += pcm.length;
        if (this.pendingLength >= AUDIO_CHUNK_SAMPLES) this.flush();
      } finally {
        data.close();
      }
    }

    private flush(): void {
      if (!this.pendingLength) return;
      const pcm = new Float32Array(this.pendingLength);
      let o = 0;
      for (const p of this.pending) {
        pcm.set(p, o);
        o += p.length;
      }
      const t = this.outTime;
      this.outTime += pcm.length / WHISPER_RATE;
      this.pending = [];
      this.pendingLength = 0;
      const video = mainVideo();
      if (video?.closest('.html5-video-player')?.classList.contains('ad-showing')) return;
      audioStats.chunks++;
      window.postMessage({ astAudio: true, t, pcm }, '*', [pcm.buffer]);
    }

    stop(): void {
      this.stopped = true;
      window.clearInterval(this.timer);
      try {
        this.decoder?.close();
      } catch {
        // already closed
      }
    }
  }

  let audioSession: AudioSession | null = null;

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
    } else if (msg?.astAudioTap === 'start') {
      audioSession?.stop();
      audioSession = new AudioSession();
      audioStats.sessions++;
      void audioSession.pump();
    } else if (msg?.astAudioTap === 'stop') {
      audioSession?.stop();
      audioSession = null;
    }
  });
})();
