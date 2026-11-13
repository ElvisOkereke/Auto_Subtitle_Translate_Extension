import { SubtitleMode, SubtitleModeDeps } from '../subtitleMode';
import { Timeline, TimelineLine } from '../timeline';
import type { FrameHandler } from '../frameSampler';
import type { ReadAheadFrame, ReadAheadSource } from '../readAhead/readAheadSource';
import type { OcrResult } from '../types';

// Unit harness: fake sampler, read-ahead source, OCR and translation drive the
// real controller, timeline and overlay.

const SIG = (v: number) => new Uint8Array(64 * 16).fill(v);
/** A crop tagged with the subtitle it shows (-1 = none); the fake OCR reads the tag. */
const crop = (n: number) => ({ n, close: jest.fn() }) as unknown as ImageBitmap;
const text = (n: number) => String.fromCharCode(0xac00 + n * 37).repeat(6);
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
};

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

interface Harness {
  mode: SubtitleMode;
  video: HTMLVideoElement;
  onFrame: FrameHandler;
  raFrame: ReadAheadFrame;
  fastCalls: number;
  /** Text the live (fast) OCR reads. */
  liveText: string;
  /** Held read-ahead OCR completions (holdAccurate). */
  held: (() => void)[];
  sampleNow: { sig: Uint8Array; videoTime: number; grab: () => Promise<ImageBitmap> } | null;
  saved: TimelineLine[] | null;
  overlayText(): string | null;
  /** Translation requests seen (tier + text). */
  requests: { tier: string; text: string; video: unknown; noFallback?: boolean }[];
  /** Held best-tier answers (holdBest). */
  heldBest: (() => void)[];
}

async function harness(
  opts: { holdAccurate?: boolean; readAhead?: boolean; stored?: TimelineLine[]; plan?: { fast: boolean; best: boolean }; holdBest?: boolean } = {}
): Promise<Harness> {
  const player = document.createElement('div');
  player.className = 'html5-video-player';
  const video = document.createElement('video');
  Object.defineProperty(video, 'videoWidth', { value: 1920 });
  Object.defineProperty(video, 'videoHeight', { value: 1080 });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true });
  Object.defineProperty(video, 'paused', { value: false, writable: true });
  player.appendChild(video);
  document.body.appendChild(player);

  const h = { video, fastCalls: 0, liveText: '', held: [], sampleNow: null, saved: null, requests: [], heldBest: [] } as unknown as Harness;
  const ocr: SubtitleModeDeps['ocr'] = {
    recognize(c, _lang, tier) {
      const result = (t: string): OcrResult => ({ text: t, confidence: t ? 1 : 0, ms: 1, tier: tier ?? 'fast' });
      if (tier !== 'accurate') {
        h.fastCalls++;
        return Promise.resolve(result(h.liveText));
      }
      const n = (c as any).n as number;
      const value = result(n >= 0 ? text(n) : '');
      if (!opts.holdAccurate) return Promise.resolve(value);
      return new Promise(resolve => h.held.push(() => resolve(value)));
    },
  };
  const readAhead: ReadAheadSource = {
    start: onFrame => (h.raFrame = onFrame),
    restart: () => undefined,
    setBox: () => undefined,
    stop: () => undefined,
    lead: 0,
    framesAccepted: 0,
  };
  h.mode = await SubtitleMode.start({
    video,
    videoId: 'vid',
    box: { x: 0.2, y: 0.75, w: 0.6, h: 0.14 },
    lang: 'ko',
    deps: {
      ocr,
      translate: async req => {
        h.requests.push({ tier: req.tier, text: req.text, video: req.video, noFallback: req.noFallback });
        if (req.tier !== 'best') return { success: true, translatedText: `EN ${req.text}`, quality: 'fast' };
        if (opts.holdBest) await new Promise<void>(r => h.heldBest.push(r));
        return { success: true, translatedText: `CLAUDE ${req.text}`, quality: 'better' };
      },
      plan: opts.plan,
      video: { videoId: 'vid', url: 'https://www.youtube.com/watch?v=vid', title: 'LoL', channel: 'c', description: 'd' },
      store: {
        load: async () => new Timeline(opts.stored ?? []),
        save: async (_id, timeline) => {
          h.saved = timeline.toJSON();
        },
      },
      readAhead: opts.readAhead === false ? null : readAhead,
      createSampler: (_v, _b, onFrame) => {
        h.onFrame = onFrame;
        return { start: () => undefined, stop: () => undefined, setBox: () => undefined, sampleNow: () => h.sampleNow };
      },
    },
  });
  h.overlayText = () => {
    const el = document.querySelector<HTMLElement>('.ast-subtitle-overlay');
    return el && el.style.display !== 'none' ? el.textContent : null;
  };
  return h;
}

/** Live frames: two identical frames confirm a change (stableFrames 2). */
async function liveLine(h: Harness, sig: Uint8Array, t: number, ocrText: string) {
  h.liveText = ocrText;
  (h.video as any).currentTime = t;
  h.onFrame(sig, t, async () => crop(-1));
  h.onFrame(sig, t + 0.1, async () => crop(-1));
  await flush();
}

let current: Harness | null = null;
afterEach(() => {
  current?.mode.stop();
  current = null;
  document.body.innerHTML = '';
});

describe('SubtitleMode', () => {
  it('a read-ahead queue overflow never leaves unread subtitles marked as covered', async () => {
    const h = (current = await harness({ holdAccurate: true }));
    // 40 subtitle changes decoded ahead of playback, faster than OCR reads them.
    for (let k = 0; k < 40; k++) {
      const sig = SIG(k % 2 ? 200 : 0);
      const t = 100 + k * 0.25;
      h.raFrame(crop(k), sig, t);
      h.raFrame(crop(k), sig, t + 0.125);
    }
    while (h.held.length) {
      h.held.shift()!();
      await flush(2);
    }
    await flush();

    // Every line that was queued is on the timeline with its own text...
    (h.video as any).currentTime = 101.05;
    h.onFrame(SIG(50), 101.05, async () => crop(-1));
    expect(h.overlayText()).toBe(`EN ${text(4)}`);

    // ...and where changes were dropped, the live path reads instead of trusting the timeline.
    const before = h.fastCalls;
    await liveLine(h, SIG(90), 108.8, text(35));
    expect(h.fastCalls).toBeGreaterThan(before);
  });

  it('stats say which path showed each line', async () => {
    const h = (current = await harness());
    // Read ahead: a subtitle at 30..31, then an empty box.
    for (let t = 30; t < 31; t += 0.125) h.raFrame(crop(3), SIG(200), t);
    for (let t = 31; t < 32; t += 0.125) h.raFrame(crop(-1), SIG(0), t);
    await flush();
    (h.video as any).currentTime = 30.2;
    h.onFrame(SIG(200), 30.2, async () => crop(-1));
    expect(h.overlayText()).toBe(`EN ${text(3)}`);
    // Live: a line read ahead of nothing (before the read-ahead range).
    await liveLine(h, SIG(120), 10, text(1));
    expect(h.overlayText()).toBe(`EN ${text(1)}`);
    expect({ readAhead: h.mode.linesFromReadAhead, live: h.mode.linesFromLive }).toEqual({ readAhead: 1, live: 1 });
  });

  describe('reading time', () => {
    /** A subtitle at 20.0 (confirmed 20.1) whose source disappears at 20.4 (confirmed 20.5). */
    async function flashLine(h: Harness) {
      await liveLine(h, SIG(200), 20.0, text(1));
      expect(h.overlayText()).toBe(`EN ${text(1)}`);
      h.liveText = '';
      (h.video as any).currentTime = 20.4;
      h.onFrame(SIG(0), 20.4, async () => crop(-1));
      h.onFrame(SIG(0), 20.5, async () => crop(-1));
      await flush();
    }
    const frame = (h: Harness, t: number) => {
      (h.video as any).currentTime = t;
      h.onFrame(SIG(0), t, async () => crop(-1));
    };

    it('a short subtitle lingers for its reading time, in video time', async () => {
      const h = (current = await harness({ readAhead: false }));
      await flashLine(h);
      expect(h.overlayText()).toBe(`EN ${text(1)}`); // source gone, translation stays
      // Paused: no frames for a while, the line stays.
      (h.video as any).paused = true;
      await new Promise(r => setTimeout(r, 300));
      expect(h.overlayText()).toBe(`EN ${text(1)}`);
      (h.video as any).paused = false;
      for (let t = 20.6; t < 21.55; t += 0.1) frame(h, t);
      expect(h.overlayText()).toBe(`EN ${text(1)}`); // shown 20.1, minimum 1.5 s -> until 21.6
      frame(h, 21.65);
      expect(h.overlayText()).toBeNull();
    });

    it('a newer subtitle replaces a lingering one at once', async () => {
      const h = (current = await harness({ readAhead: false }));
      await flashLine(h);
      await liveLine(h, SIG(120), 20.7, text(2));
      expect(h.overlayText()).toBe(`EN ${text(2)}`);
    });

    it('seek clears a lingering line', async () => {
      const h = (current = await harness({ readAhead: false }));
      await flashLine(h);
      (h.video as any).currentTime = 50;
      h.video.dispatchEvent(new Event('seeking'));
      expect(h.overlayText()).toBeNull();
    });

    it('an ad clears a lingering line', async () => {
      const h = (current = await harness({ readAhead: false }));
      await flashLine(h);
      h.video.closest('.html5-video-player')!.classList.add('ad-showing');
      await flush();
      expect(h.overlayText()).toBeNull();
    });
  });

  it('seeking closes the line that was on screen (it must not stretch over the rest of the video)', async () => {
    const h = (current = await harness({ readAhead: false }));
    await liveLine(h, SIG(200), 10, text(1));
    h.onFrame(SIG(200), 10.5, async () => crop(-1));
    (h.video as any).currentTime = 50;
    h.video.dispatchEvent(new Event('seeking'));
    expect(h.mode.timeline.at(60)).toBeNull();
    expect(h.mode.timeline.at(10.2)?.end).toBeCloseTo(10.5);
  });

  it('an ad starting closes the line that was on screen', async () => {
    const h = (current = await harness({ readAhead: false }));
    await liveLine(h, SIG(200), 10, text(1));
    h.video.closest('.html5-video-player')!.classList.add('ad-showing');
    await flush();
    expect(h.mode.timeline.at(60)).toBeNull();
  });

  it('stopping closes open lines before saving', async () => {
    const h = await harness({ readAhead: false });
    await liveLine(h, SIG(200), 10, text(1));
    h.mode.stop();
    await flush();
    expect(h.saved?.length).toBe(1);
    expect(h.saved!.every(l => l.end !== null)).toBe(true);
  });

  it('where read-ahead saw no subtitle, a stale open live line is not shown', async () => {
    const h = (current = await harness());
    await liveLine(h, SIG(200), 10, text(1));
    expect(h.overlayText()).toBe(`EN ${text(1)}`);
    for (let t = 11; t < 20; t += 0.125) h.raFrame(crop(-1), SIG(0), t); // read ahead: empty box
    await flush();
    (h.video as any).currentTime = 15;
    h.onFrame(SIG(0), 15, async () => crop(-1));
    expect(h.overlayText()).toBeNull();
  });

  it('open lines in a saved timeline are closed on load', async () => {
    const h = (current = await harness({
      readAhead: false,
      stored: [{ start: 10, end: null, source: text(1), translation: 'EN', quality: 'fast' }],
    }));
    expect(h.mode.timeline.at(100)).toBeNull();
  });

  it('seeking while paused reads the frame at the new position', async () => {
    const h = (current = await harness({ readAhead: false }));
    (h.video as any).paused = true;
    (h.video as any).currentTime = 30;
    h.liveText = text(7);
    h.sampleNow = { sig: SIG(120), videoTime: 30, grab: async () => crop(-1) };
    h.video.dispatchEvent(new Event('seeked'));
    await flush();
    expect(h.fastCalls).toBe(1);
    expect(h.overlayText()).toBe(`EN ${text(7)}`);
  });

  describe('fast then best', () => {
    it('the fast translation shows first, then the Claude version replaces it once', async () => {
      const h = (current = await harness({ readAhead: false, plan: { fast: true, best: true }, holdBest: true }));
      await liveLine(h, SIG(200), 10, text(1));
      expect(h.overlayText()).toBe(`EN ${text(1)}`);
      expect(h.requests.map(r => r.tier).sort()).toEqual(['best', 'fast']);
      expect(h.requests[0].video).toMatchObject({ title: 'LoL' });
      h.heldBest.shift()!();
      await flush();
      expect(h.overlayText()).toBe(`CLAUDE ${text(1)}`);
      expect(h.mode.timeline.at(10.2)).toMatchObject({ translation: `CLAUDE ${text(1)}`, quality: 'better' });
    });

    it('a Claude answer identical to the fast text still counts as the better version', async () => {
      const h = (current = await harness({ readAhead: false, plan: { fast: true, best: true } }));
      (h.mode as any).deps.translate = async (req: any) => ({ success: true, translatedText: 'same', quality: req.tier === 'best' ? 'better' : 'fast' });
      await liveLine(h, SIG(200), 10, text(1));
      const line = h.mode.timeline.toJSON()[0];
      expect(line.quality).toBe('better');
      expect(h.mode.betterAt.has(line.start)).toBe(true);
    });

    it('with both tiers the Claude request asks for no fast fallback (the fast tier is already requested)', async () => {
      const h = (current = await harness({ readAhead: false, plan: { fast: true, best: true } }));
      await liveLine(h, SIG(200), 10, text(1));
      expect(h.requests.find(r => r.tier === 'best')!.noFallback).toBe(true);
      const solo = await harness({ readAhead: false, plan: { fast: false, best: true } });
      await liveLine(solo, SIG(200), 10, text(2));
      expect(solo.requests.find(r => r.tier === 'best')!.noFallback).toBeFalsy();
      solo.mode.stop();
    });

    it('best only shows nothing until Claude answers', async () => {
      const h = (current = await harness({ readAhead: false, plan: { fast: false, best: true }, holdBest: true }));
      await liveLine(h, SIG(200), 10, text(1));
      expect(h.requests.map(r => r.tier)).toEqual(['best']);
      expect(h.overlayText()).toBeNull();
      h.heldBest.shift()!();
      await flush();
      expect(h.overlayText()).toBe(`CLAUDE ${text(1)}`);
    });

    it('a best answer arriving after stop() is dropped', async () => {
      const h = await harness({ readAhead: false, plan: { fast: true, best: true }, holdBest: true });
      await liveLine(h, SIG(200), 10, text(1));
      h.mode.stop();
      await flush();
      h.heldBest.shift()!();
      await flush();
      expect(h.mode.timeline.toJSON()[0].translation).toBe(`EN ${text(1)}`); // (stop closed the line at the last frame)
      expect(document.querySelector('.ast-subtitle-overlay')).toBeNull();
    });

    it('a read-ahead line due within 10 s goes out with live priority (not held for a batch)', async () => {
      const h = (current = await harness({ plan: { fast: false, best: true } }));
      (h.video as any).currentTime = 100;
      const priorities = () => (h as any).priorities as string[];
      (h as any).priorities = [];
      const orig = (h.mode as any).deps.translate;
      (h.mode as any).deps.translate = (req: any) => {
        (h as any).priorities.push(`${req.text}:${req.priority}`);
        return orig(req);
      };
      // Read ahead: a change at 102 s (due in 2 s) and one at 130 s (due in 30 s).
      for (const [k, t0] of [[1, 102], [2, 130]] as const) {
        h.raFrame(crop(k), SIG(k % 2 ? 200 : 0), t0 - 0.25);
        h.raFrame(crop(k), SIG(k % 2 ? 200 : 0), t0);
        h.raFrame(crop(k), SIG(k % 2 ? 200 : 0), t0 + 0.125);
      }
      await flush();
      expect(priorities()).toContain(`${text(1)}:live`);
      expect(priorities()).toContain(`${text(2)}:readahead`);
    });

    it('a glossary correction re-translates matching lines and swaps the one on screen once', async () => {
      const h = (current = await harness({ readAhead: false, plan: { fast: true, best: true } }));
      await liveLine(h, SIG(200), 10, text(1));
      expect(h.overlayText()).toBe(`CLAUDE ${text(1)}`);
      const before = h.requests.length;
      h.mode.onGlossaryChanged([text(1).slice(0, 2), 'not-in-any-line']);
      await flush();
      expect(h.requests.slice(before).map(r => r.tier)).toEqual(['best']);
      h.mode.onGlossaryChanged(['nothing matches']);
      await flush();
      expect(h.requests.length).toBe(before + 1);
    });
  });
});
