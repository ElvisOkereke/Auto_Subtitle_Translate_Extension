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
  /** Crop geometry passed with each OCR request. */
  geometries: any[];
  /** Text size the live (fast) OCR reports with liveText. */
  liveSize: { textHeight?: number; offSize?: boolean };
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

  const h = { video, fastCalls: 0, liveText: '', held: [], sampleNow: null, saved: null, requests: [], heldBest: [], geometries: [], liveSize: {} } as unknown as Harness;
  const ocr: SubtitleModeDeps['ocr'] = {
    recognize(c, _lang, tier, geometry) {
      h.geometries.push(geometry);
      const result = (t: string): OcrResult => ({ text: t, confidence: t ? 1 : 0, ms: 1, tier: tier ?? 'fast' });
      if (tier !== 'accurate') {
        h.fastCalls++;
        return Promise.resolve({ ...result(h.liveText), ...h.liveSize });
      }
      const n = (c as any).n as number;
      // Crops tagged 90+ show a game notice: half the subtitles' height.
      const height = n >= 90 ? 0.034 : 0.068;
      const offSize = !!geometry?.textHeight && Math.abs(height - geometry.textHeight) > 0.3 * geometry.textHeight;
      const value = { ...result(n >= 0 ? text(n) : ''), ...(n >= 0 ? { textHeight: height, offSize } : {}) };
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

  it('when OCR falls behind, queued re-checks make way for subtitle changes (no gap, nothing re-read live)', async () => {
    const h = (current = await harness({ holdAccurate: true }));
    // A burst of decoded frames: 10 s with no change (re-checks queue up), then 24 subtitle changes.
    for (let t = 100; t < 110; t += 0.125) h.raFrame(crop(-1), SIG(0), t);
    for (let k = 0; k < 24; k++) {
      const sig = SIG(k % 2 ? 200 : 60);
      const t = 110 + k * 0.5;
      h.raFrame(crop(k), sig, t);
      h.raFrame(crop(k), sig, t + 0.125);
    }
    while (h.held.length) {
      h.held.shift()!();
      await flush(2);
    }
    await flush();
    for (let k = 0; k < 24; k++) expect(h.mode.timeline.at(110.3 + k * 0.5)?.source).toBe(text(k));
    // Read-ahead covered all of it: the live path doesn't read there.
    const before = h.fastCalls;
    await liveLine(h, SIG(90), 120.3, text(20));
    expect(h.fastCalls).toBe(before);
  });

  it('a game notice read ahead before the subtitle size was known is dropped once it is (it never shows)', async () => {
    const h = (current = await harness());
    const frames: [number, number][] = [[95, 100], [1, 101], [2, 102.5], [3, 104], [4, 105.5]];
    for (const [n, t0] of frames) {
      for (let t = t0; t < t0 + 1.5; t += 0.125) {
        h.raFrame(crop(n), SIG(40 + n * 2), t);
        await flush(2);
      }
    }
    await flush(10);
    expect(h.mode.timeline.at(100.5)).toBeNull();
    expect(h.mode.timeline.at(102.8)?.source).toBe(text(2));
  });

  it('read-ahead re-reads an open line, so a change the image signature misses is still caught', async () => {
    const h = (current = await harness());
    // Small text in a big box: the next subtitle barely changes the box image (same signature).
    // Frames arrive over time; OCR answers in between (as in a real stream).
    for (let t = 100; t < 103; t += 0.125) {
      h.raFrame(crop(t < 101.5 ? 1 : 2), SIG(200), t);
      await flush(2);
    }
    await flush(10);
    expect(h.mode.timeline.at(100.5)?.source).toBe(text(1));
    expect(h.mode.timeline.at(102.6)?.source).toBe(text(2));
  });

  it('read-ahead re-reads the box with no line open, so a subtitle the image signature misses is still found', async () => {
    const h = (current = await harness());
    // Small text appearing in a big box: the box image (signature) never changes.
    for (let t = 100; t < 103; t += 0.125) {
      h.raFrame(crop(t < 101 ? -1 : 5), SIG(200), t);
      await flush(2);
    }
    await flush(10);
    const line = h.mode.timeline.at(102.5);
    expect(line?.source).toBe(text(5));
    expect(line!.start).toBeLessThan(101.8); // found within a re-check interval of appearing
  });

  it('OCR is told which part of the video the crop shows and where the box is', async () => {
    const h = (current = await harness());
    await liveLine(h, SIG(200), 10, text(1));
    expect(h.geometries[0]).toEqual({ region: { x: 0, y: 0.645, w: 1, h: 0.35 }, box: { x: 0.2, y: 0.75, w: 0.6, h: 0.14 } });
  });

  it('once the subtitle size is learned, OCR is told it and text of another size is not a subtitle', async () => {
    const h = (current = await harness({ readAhead: false }));
    h.liveSize = { textHeight: 0.068, offSize: false };
    for (let k = 0; k < 3; k++) await liveLine(h, SIG(50 + 50 * k), 10 + 2 * k, text(k));
    await liveLine(h, SIG(250), 17, text(3)); // read with the learned size
    expect(h.geometries[h.geometries.length - 1].textHeight).toBeCloseTo(0.068, 6);
    // A game notice of another size, with no subtitle: not on the timeline, not on screen.
    h.liveSize = { textHeight: 0.034, offSize: true };
    await liveLine(h, SIG(10), 20, text(9));
    expect(h.mode.timeline.at(20.5)?.source).not.toBe(text(9));
    expect(h.overlayText() ?? '').not.toContain(text(9));
  });

  it('one blank read during a re-check does not end a line that is still there', async () => {
    const h = (current = await harness());
    // The box image never changes. Re-checks read at 100.875, 101.625, ...: the first OCRs blank, the next read the line again.
    for (let t = 100; t < 103; t += 0.125) {
      h.raFrame(crop(Math.abs(t - 100.875) < 0.01 ? -1 : 1), SIG(200), t);
      await flush(2);
    }
    await flush(10);
    const line = h.mode.timeline.at(100.2)!;
    expect(line.source).toBe(text(1));
    expect(h.mode.timeline.at(102.5)).toBe(line); // still the same, uninterrupted line
  });

  it('two blank re-checks in a row end the line at the first blank', async () => {
    const h = (current = await harness());
    for (let t = 100; t < 103; t += 0.125) {
      h.raFrame(crop(t >= 100.875 ? -1 : 1), SIG(200), t);
      await flush(2);
    }
    await flush(10);
    const line = h.mode.timeline.at(100.2)!;
    expect(line.end).toBeCloseTo(100.875, 2);
    expect(h.mode.timeline.at(102.5)).toBeNull();
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

    it('the next subtitle ends the line on screen even before its own translation arrives (live)', async () => {
      const h = (current = await harness({ readAhead: false, plan: { fast: false, best: true }, holdBest: true }));
      await liveLine(h, SIG(200), 20.0, text(1));
      h.heldBest.shift()!();
      await flush();
      expect(h.overlayText()).toBe(`CLAUDE ${text(1)}`);
      await liveLine(h, SIG(120), 20.6, text(2)); // B's translation is still pending
      expect(h.overlayText()).toBeNull();
    });

    it('the next subtitle ends the line on screen even before its own translation arrives (read-ahead)', async () => {
      const h = (current = await harness({ plan: { fast: false, best: true }, holdBest: true }));
      for (let t = 100; t < 101; t += 0.125) {
        h.raFrame(crop(1), SIG(200), t);
        await flush(2);
      }
      for (let t = 101; t < 102; t += 0.125) {
        h.raFrame(crop(2), SIG(120), t);
        await flush(2);
      }
      h.heldBest.shift()!(); // only A's translation arrives
      await flush();
      (h.video as any).currentTime = 100.5;
      h.onFrame(SIG(200), 100.5, async () => crop(-1));
      expect(h.overlayText()).toBe(`CLAUDE ${text(1)}`);
      (h.video as any).currentTime = 101.3;
      h.onFrame(SIG(120), 101.3, async () => crop(-1));
      expect(h.overlayText()).toBeNull(); // not A lingering over B's subtitle
      h.heldBest.shift()!(); // B arrives: shown
      await flush();
      expect(h.overlayText()).toBe(`CLAUDE ${text(2)}`);
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

describe('SubtitleMode: a box with no subtitles in it says so', () => {
  it('after 20 s of reading the box without finding any text, it suggests Audio mode where the subtitles would be', async () => {
    const h = (current = await harness({ readAhead: false }));
    for (let k = 0; k < 20; k++) await liveLine(h, SIG(k % 2 ? 200 : k * 7), 10 + k * 1.5, '');
    expect(h.overlayText()).toMatch(/No subtitles found in this box/);
    expect(h.overlayText()).toMatch(/Audio mode/);
  });

  it('no such message once text was found', async () => {
    const h = (current = await harness({ readAhead: false }));
    await liveLine(h, SIG(10), 10, '안녕하세요');
    for (let k = 0; k < 20; k++) await liveLine(h, SIG(k % 2 ? 200 : k * 7 + 20), 12 + k * 1.5, '');
    expect(h.overlayText() ?? '').not.toMatch(/No subtitles found/);
  });
});

describe('SubtitleMode live path with an empty box', () => {
  afterEach(() => jest.useRealTimers());

  it('re-reads the box now and then, so a subtitle the image signature misses still shows', async () => {
    jest.useFakeTimers();
    const h = (current = await harness({ readAhead: false }));
    // Nothing changes in the box image (small text in a big box), and nothing is on screen.
    h.liveText = text(7);
    h.sampleNow = { sig: SIG(200), videoTime: 5, grab: async () => crop(-1) };
    await jest.advanceTimersByTimeAsync(1500);
    expect(h.fastCalls).toBeGreaterThan(0);
    expect(h.mode.timeline.at(5.1)?.source).toBe(text(7));
  });
});
