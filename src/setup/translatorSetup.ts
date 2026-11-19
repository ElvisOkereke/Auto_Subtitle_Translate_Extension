// translatorSetup.ts - the free translator's part of the setup page: which
// language packs Chrome's built-in translator needs for the chosen languages,
// whether this browser has them, and downloading them. A download needs a
// click, and a click only counts for a moment, so every download starts at once.
import { builtinLanguage } from '../translation/fastProvider';

export interface Pair {
  source: string;
  target: string;
}

export interface TranslatorNeed {
  pairs: Pair[];
  /** "Detect automatically": Chrome's built-in language detector too. */
  detector: boolean;
}

interface Monitor {
  addEventListener(type: 'downloadprogress', fn: (e: { loaded: number }) => void): void;
}

export interface ChromeAi {
  Translator?: {
    availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
    create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: Monitor) => void }): Promise<unknown>;
  };
  LanguageDetector?: {
    availability(): Promise<string>;
    create(o?: { monitor?: (m: Monitor) => void }): Promise<unknown>;
  };
}

/** The packs for the subtitle language and the spoken language into the target language. */
export function translatorPlan(subtitleLanguage: string, spokenLanguage: string, targetLanguage: string): TranslatorNeed {
  const target = builtinLanguage(targetLanguage);
  const pairs: Pair[] = [];
  for (const code of [subtitleLanguage, spokenLanguage]) {
    if (code === 'auto') continue;
    const source = builtinLanguage(code);
    if (source !== target && !pairs.some(p => p.source === source)) pairs.push({ source, target });
  }
  return { pairs, detector: spokenLanguage === 'auto' };
}

/** 'unsupported': no built-in translator, or no language packs in this browser (Opera GX, Edge, Brave). */
export async function translatorStatus(g: ChromeAi, plan: TranslatorNeed): Promise<'unsupported' | 'ready' | TranslatorNeed> {
  if (!g.Translator) return 'unsupported';
  const states = await Promise.all(plan.pairs.map(p => g.Translator!.availability({ sourceLanguage: p.source, targetLanguage: p.target }).catch(() => 'unavailable')));
  if (states.some(s => s === 'unavailable')) return 'unsupported';
  const pairs = plan.pairs.filter((_, i) => states[i] !== 'available');
  const detector = plan.detector && (await g.LanguageDetector?.availability().catch(() => 'unavailable')) !== 'available';
  return pairs.length || detector ? { pairs, detector } : 'ready';
}

/** Starts every download now (call it straight from the click handler); `onProgress` gets 0-100. */
export function startTranslatorDownloads(g: ChromeAi, need: TranslatorNeed, onProgress: (percent: number) => void): Promise<void> {
  const parts = need.pairs.length + (need.detector ? 1 : 0);
  const loaded = new Array(parts).fill(0);
  const monitor = (i: number) => (m: Monitor) =>
    m.addEventListener('downloadprogress', e => {
      loaded[i] = e.loaded;
      onProgress(Math.round((loaded.reduce((a, b) => a + b, 0) / parts) * 100));
    });
  const jobs: Promise<unknown>[] = need.pairs.map((p, i) => g.Translator!.create({ sourceLanguage: p.source, targetLanguage: p.target, monitor: monitor(i) }));
  if (need.detector && g.LanguageDetector) jobs.push(g.LanguageDetector.create({ monitor: monitor(need.pairs.length) }));
  return Promise.all(jobs).then(() => onProgress(100));
}
