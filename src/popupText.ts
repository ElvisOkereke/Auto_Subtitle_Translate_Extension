// The popup's words for its state: the caption bar line and the engine summary.
// Pure functions, so every state's copy is pinned by tests.

export interface PopupState {
  mode: 'subtitles' | 'audio';
  audioRunning: boolean;
  subtitleState: 'off' | 'loading' | 'running' | 'paused-ad';
  hasBox: boolean;
  /** Display names (the selected option's text). */
  subtitleLanguage: string;
  speechLanguage: string;
  targetLanguage: string;
  screenTranslate: 'inactive' | 'armed' | 'ready-to-redraw';
}

/** One subtitle-like line saying what is happening and what to do next. */
export function captionText(s: PopupState): string {
  if (s.screenTranslate === 'armed') return 'Drag a box around text on the page';
  if (s.mode === 'audio') {
    if (!s.audioRunning) return 'Start live captions to translate speech in this tab';
    return s.speechLanguage === 'Detect automatically' || !s.speechLanguage
      ? `Live captions on, translating into ${s.targetLanguage}`
      : `Live captions on, ${s.speechLanguage} into ${s.targetLanguage}`;
  }
  switch (s.subtitleState) {
    case 'loading':
      return 'Getting the subtitle reader ready…';
    case 'running':
      return `Translating ${s.subtitleLanguage} subtitles into ${s.targetLanguage}`;
    case 'paused-ad':
      return 'Paused while the ad plays';
    default:
      return s.hasBox ? 'Use your saved box, or draw a new one' : 'Draw a box around the subtitles on the video';
  }
}

export interface EngineForm {
  translateWith: 'subscription' | 'keys';
  provider: 'deepl' | 'google' | 'subscription';
  hasFastKey: boolean;
  hasClaude: boolean;
  engineMode: 'fast-then-best' | 'fast' | 'best';
  /** e.g. "Claude Opus 5.5" */
  modelLabel: string;
}

const PROVIDER_NAMES: Record<string, string> = { deepl: 'DeepL', google: 'Google Translate', subscription: 'Your subscription' };

/** What will translate, in plain words; says what is missing instead of pretending. */
export function engineSummaryText(f: EngineForm): string {
  if (f.translateWith === 'subscription') return f.engineMode === 'fast' ? 'Your subscription' : `Your subscription, ${f.modelLabel}`;
  const fast = PROVIDER_NAMES[f.provider] ?? f.provider;
  if (!f.hasFastKey && !f.hasClaude) return 'Add a translation key to start';
  if (f.engineMode === 'fast' || !f.hasClaude) {
    if (!f.hasFastKey) return 'Add a translation key to start';
    return f.engineMode === 'fast' ? fast : `${fast} (add Claude access for best quality)`;
  }
  if (!f.hasFastKey) return `${f.modelLabel} (add a ${fast} key for instant lines)`;
  return f.engineMode === 'best' ? f.modelLabel : `${fast}, then ${f.modelLabel}`;
}
