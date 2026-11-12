// subtitle/index.ts - content-script entry for subtitle mode (burned-in subtitle translation).
import { OcrClient } from './ocrClient';
import { installTestBridge } from './testBridge';
import { SubtitleOverlay } from './overlay';
import { SubtitleMode, TranslateRequest, TranslateResponse } from './subtitleMode';
import { boxToPage, contentRect, pageToBox, Rect } from './videoGeometry';
import { videoIdFrom } from './videoId';
import { MseReadAhead } from './readAhead/readAheadSource';
import { ModeLauncher } from './modeLauncher';
import { readVideoContext } from './videoContext';
import type { NormalizedBox, SubtitleLanguage } from './types';

const MIN_BOX_WIDTH = 24;
const MIN_BOX_HEIGHT = 12;

let ocr: Promise<OcrClient> | null = null;
export function getOcr(): Promise<OcrClient> {
  ocr ??= OcrClient.attach();
  return ocr;
}


const launcher = new ModeLauncher<SubtitleMode>();
let starting: Promise<unknown> | null = null;
/** Subtitle mode stays on across in-page navigation until the user stops it. */
let enabled = false;
let lastVideoId: string | null = currentVideoId();

function currentVideoId(): string | null {
  return videoIdFrom(location.href);
}

const boxKey = (videoId: string) => `subtitleBox:${videoId}`;

async function storedBox(videoId: string): Promise<NormalizedBox | null> {
  const stored = await chrome.storage.local.get(boxKey(videoId));
  return (stored[boxKey(videoId)] as NormalizedBox | undefined) ?? null;
}

async function subtitleLanguage(): Promise<SubtitleLanguage> {
  const { subtitleLanguage: lang } = await chrome.storage.sync.get({ subtitleLanguage: 'ko' });
  return lang as SubtitleLanguage;
}

function translate(req: TranslateRequest): Promise<TranslateResponse> {
  return chrome.runtime.sendMessage({ type: 'TRANSLATE_SUBTITLE_LINE', ...req });
}

/** The <video> under a page point, if any. */
function videoAt(x: number, y: number): HTMLVideoElement | null {
  const hit = document.elementsFromPoint(x, y).find(el => el instanceof HTMLVideoElement) as HTMLVideoElement | undefined;
  if (hit) return hit;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
  }
  return null;
}

async function startMode(video: HTMLVideoElement, videoId: string, box: NormalizedBox): Promise<void> {
  // The launcher discards this start if a stop, navigation or newer start overtakes it.
  const started = await launcher.start(async () => {
    const lang = await subtitleLanguage();
    const client = await getOcr();
    await client.preload(lang); // first run downloads the OCR models
    const { devSubtitle } = await chrome.storage.local.get('devSubtitle');
    const readAhead = devSubtitle?.readAhead === false ? null : new MseReadAhead(video, box);
    const plan = await chrome.runtime.sendMessage({ type: 'GET_TRANSLATION_PLAN' }).catch(() => null);
    return SubtitleMode.start({
      video,
      videoId,
      box,
      lang,
      deps: {
        ocr: client,
        translate,
        store: client.timelineStorage(),
        readAhead,
        plan: plan && typeof plan.fast === 'boolean' ? plan : { fast: true, best: false },
        video: readVideoContext(document, location.href),
      },
    });
  });
  if (started) enabled = true;
}

function stopMode(): void {
  launcher.stop();
}

export type StartResult = 'started' | 'too-small' | 'not-over-video';

/** Called by the box selector (realTimeTranslate.ts) with the drawn rectangle in viewport coordinates. */
async function startFromRect(rect: Rect): Promise<StartResult> {
  const video = videoAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!video) return 'not-over-video';
  if (rect.width < MIN_BOX_WIDTH || rect.height < MIN_BOX_HEIGHT) return 'too-small';
  const box = pageToBox(rect, video.getBoundingClientRect(), contentRect(video));
  const videoId = currentVideoId() ?? location.href;
  await chrome.storage.local.set({ [boxKey(videoId)]: box });
  // A new box means lines read through the old one may be wrong: start this video afresh.
  await (await getOcr()).saveTimelineLines(videoId, []);
  starting = startMode(video, videoId, box);
  await starting;
  return 'started';
}

// Content scripts of one extension share an isolated world, so the box
// selector in realTimeTranslate.js can reach this directly (pages cannot).
(globalThis as any).__astSubtitleMode = { startFromRect };

async function onNavigate(): Promise<void> {
  const videoId = currentVideoId();
  if (videoId === lastVideoId) return;
  lastVideoId = videoId;
  stopMode();
  if (!enabled || !videoId) return;
  const box = await storedBox(videoId);
  if (!box) return;
  const video = document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
  if (!video) return;
  if (video.readyState < 1) await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
  if (currentVideoId() === videoId) await startMode(video, videoId, box);
}

document.addEventListener('yt-navigate-finish', () => void onNavigate());
window.addEventListener('popstate', () => void onNavigate());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'GET_SUBTITLE_MODE_STATE': {
      const videoId = currentVideoId();
      (videoId ? storedBox(videoId) : Promise.resolve(null)).then(box =>
        sendResponse({ mode: launcher.current ? 'subtitles' : 'off', state: launcher.current?.state ?? 'stopped', videoId, hasBox: !!box })
      );
      return true;
    }
    case 'START_SUBTITLE_MODE': {
      // Start with the box saved for this video (no redraw needed).
      const videoId = currentVideoId();
      const video = document.querySelector<HTMLVideoElement>('video');
      (async () => {
        const box = videoId ? await storedBox(videoId) : null;
        if (!box || !video || !videoId) return { success: false, error: 'No saved box for this video' };
        await startMode(video, videoId, box);
        return { success: true };
      })().then(sendResponse, e => sendResponse({ success: false, error: String(e) }));
      return true;
    }
    case 'GET_VIDEO_CONTEXT':
      // Audio mode asks what the video is about (translator context).
      sendResponse(readVideoContext(document, location.href));
      return false;
    case 'GLOSSARY_CHANGED':
      // A glossary entry was corrected in the popup: re-translate lines using it.
      launcher.current?.onGlossaryChanged(Array.isArray(message.terms) ? message.terms : []);
      return false;
    case 'STOP_SUBTITLE_MODE':
      enabled = false;
      stopMode();
      sendResponse({ success: true });
      return false;
  }
  return false;
});

let testOverlay: { overlay: SubtitleOverlay; box: NormalizedBox; video: HTMLVideoElement } | null = null;

installTestBridge({
  'overlay.show': async ({ text, box }) => {
    const video = document.querySelector('video')!;
    testOverlay?.overlay.destroy();
    testOverlay = { overlay: new SubtitleOverlay(video, box), box, video };
    testOverlay.overlay.show(text);
  },
  'overlay.clear': async () => testOverlay?.overlay.clear(),
  'overlay.rect': async () => {
    const { overlay, box, video } = testOverlay!;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const text = overlay.element.querySelector('.ast-subtitle-text')!;
    return {
      overlay: rect(overlay.element),
      expected: boxToPage(box, video.getBoundingClientRect(), contentRect(video)),
      text: rect(text),
      fontSize: parseFloat(getComputedStyle(text).fontSize),
      parentIsFullscreenElement: overlay.element.parentElement === document.fullscreenElement,
    };
  },
  ocr: async ({ bitmap, lang }) => (await getOcr()).recognize(bitmap, lang),
  'ocr.preload': async ({ lang }) => (await getOcr()).preload(lang),
  'timeline.save': async ({ videoId, lines }) => (await getOcr()).saveTimelineLines(videoId, lines),
  'timeline.load': async ({ videoId }) => (await getOcr()).loadTimelineLines(videoId),
  'timeline.clear': async () => (await getOcr()).clearTimelines(),
  'mode.timeline': async () => {
    const mode = launcher.current;
    return mode
      ? mode.timeline
          .toJSON()
          .map(l => ({
            start: l.start,
            end: l.end,
            source: l.source,
            translation: l.translation,
            quality: l.quality,
            translatedAt: mode.translatedAt.get(l.start) ?? null,
            betterAt: mode.betterAt.get(l.start) ?? null,
          }))
      : [];
  },
  'mode.stats': async () => {
    const mode = launcher.current;
    return {
    state: mode?.state ?? 'stopped',
    ocrCalls: mode?.ocrCalls ?? 0,
    translateCalls: mode?.translateCalls ?? 0,
    raOcrCalls: mode?.raOcrCalls ?? 0,
    readAheadLead: mode?.readAheadLead ?? 0,
    timelineSize: mode?.timeline.size ?? 0,
    videoId: currentVideoId(),
    };
  },
});
