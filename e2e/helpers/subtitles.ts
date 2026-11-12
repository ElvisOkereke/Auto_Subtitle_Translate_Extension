// Shared helpers for subtitle-mode E2E tests.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from './extension';
import { FIXTURES } from './paths';
import { astTest } from './bridge';

export const BOX = { x: 0.2, y: 0.75, w: 0.6, h: 0.14 };

export interface TimelineFixtureLine {
  stretch: 's1' | 's2';
  start: number;
  end: number;
  ko: string;
  en: string;
  terms: string[];
}

export const timelineFixture: { stretches: { id: string; start: number; end: number }[]; lines: TimelineFixtureLine[] } = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'subtitles/_zIrbXw-SVs.timeline.json'), 'utf8')
);

export interface Shown {
  shownAt: number;
  lineStart: number;
  text: string;
}

export interface ModeStats {
  state: string;
  ocrCalls: number;
  raOcrCalls: number;
  translateCalls: number;
  timelineSize: number;
  readAheadLead: number;
  videoId: string | null;
}

/** Records every overlay update in the page's main world (the DOM is shared with content scripts). */
export async function recordOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__shown = [];
    new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>('.ast-subtitle-overlay');
      if (!el || el.style.display === 'none') return;
      const text = el.textContent ?? '';
      const last = w.__shown[w.__shown.length - 1];
      if (!last || last.text !== text || last.lineStart !== Number(el.dataset.lineStart)) {
        w.__shown.push({ shownAt: Number(el.dataset.shownAt), lineStart: Number(el.dataset.lineStart), text });
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'data-shown-at'] });
  });
}

export async function openFixture(page: Page, fixtureURL: string, stretch = 's1', v = '_zIrbXw-SVs'): Promise<void> {
  await page.goto(`${fixtureURL}/video-subs.html?v=${v}&stretch=${stretch}`);
  await page.waitForFunction(() => (window as any).__fixture.video.readyState >= 1);
  await recordOverlay(page);
}

/** Drags the subtitle box over the first <video> on the page (normalized to its rect). */
export async function dragBox(page: Page, box = BOX): Promise<void> {
  const r = await page.evaluate(b => {
    const v = document.querySelector('video') as HTMLVideoElement;
    const rect = v.getBoundingClientRect();
    return { x: rect.x + b.x * rect.width, y: rect.y + b.y * rect.height, w: b.w * rect.width, h: b.h * rect.height };
  }, box);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 4 });
  await page.mouse.move(r.x + r.w, r.y + r.h, { steps: 4 });
  await page.mouse.up();
}

/** Popup -> Subtitles -> Korean -> Draw subtitle box -> drag; waits until subtitle mode runs. */
export async function startViaPopup(page: Page, openPopup: (p: Page) => Promise<Page>): Promise<Page> {
  const popup = await openPopup(page);
  await popup.click('#modeSubtitles');
  await popup.selectOption('#subtitleLanguage', 'ko');
  await popup.click('#drawSubtitleBox');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('crosshair');
  await dragBox(page);
  await expect.poll(async () => (await astTest<ModeStats>(page, 'mode.stats')).state, { timeout: 120_000 }).toBe('running');
  return popup;
}

export const modeStats = (page: Page) => astTest<ModeStats>(page, 'mode.stats');
export const shownRecords = (page: Page) => page.evaluate(() => (window as any).__shown as Shown[]);

export async function playUntil(page: Page, t: number): Promise<void> {
  await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
  await page.waitForFunction(at => (document.querySelector('video') as HTMLVideoElement).currentTime >= at, t, { timeout: (t + 30) * 1000, polling: 250 });
}

/** Case-insensitive containment with spaces and hyphens ignored (timeline fixture's term rule). */
export function containsTerm(text: string, term: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, '');
  return norm(text).includes(norm(term));
}
