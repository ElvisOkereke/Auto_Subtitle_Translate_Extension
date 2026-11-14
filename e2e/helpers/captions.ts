import type { BrowserContext, Page } from '@playwright/test';
import type { ShownRecord } from '../bench/metrics';

/** An audio caption as it appeared on the page (times in video seconds). */
export interface CaptionRecord extends ShownRecord {
  captionId: string;
  /** The transcribed text (data-source). */
  source: string;
}

/**
 * Records audio captions (.subtitle-text lines) in the page's main world:
 * when each appeared and left (video time), its text (the latest, e.g. after a
 * Claude upgrade), its source text, and whether the video was paused when it
 * appeared. lineStart is when its speech ended in video time (estimated from
 * data-speech-ended-at assuming playback since then; shownAt when unknown).
 */
const captionRecorder = () => {
  const w = window as any;
  if (w.__captions) return;
  w.__captions = [];
  const video = () => {
    const all = [...document.querySelectorAll('video')] as HTMLVideoElement[];
    return all.find(v => !v.paused) ?? all[0] ?? null;
  };
  const byId = new Map<string, any>();
  new MutationObserver(() => {
    const v = video();
    const now = v?.currentTime ?? 0;
    const present = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>('.subtitle-text')) {
      const id = el.dataset.captionId ?? el.textContent ?? '';
      present.add(id);
      let rec = byId.get(id);
      if (!rec) {
        const endedAt = Number(el.dataset.speechEndedAt);
        const rate = v?.playbackRate ?? 1;
        rec = {
          captionId: id,
          shownAt: now,
          hiddenAt: null,
          lineStart: Number.isFinite(endedAt) && endedAt > 0 ? now - ((Date.now() - endedAt) / 1000) * rate : now,
          text: el.textContent ?? '',
          source: el.dataset.source ?? '',
          quality: el.dataset.quality ?? 'fast',
          pausedAtShow: !!v?.paused,
          wallShownAt: performance.now(),
          wallHiddenAt: null,
        };
        byId.set(id, rec);
        w.__captions.push(rec);
      } else {
        rec.text = el.textContent ?? rec.text;
        rec.quality = el.dataset.quality ?? rec.quality;
      }
    }
    for (const [id, rec] of byId) {
      if (!present.has(id) && rec.hiddenAt === null) {
        rec.hiddenAt = now;
        rec.wallHiddenAt = performance.now();
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-quality'] });
};

export async function recordCaptions(page: Page): Promise<void> {
  await page.evaluate(captionRecorder);
}

/** The recorder on every page load of the context (survives reloads; real YouTube). */
export async function recordCaptionsOnEveryLoad(context: BrowserContext): Promise<void> {
  await context.addInitScript(captionRecorder);
}

export const shownCaptions = (page: Page) => page.evaluate(() => ((window as any).__captions ?? []) as CaptionRecord[]);
