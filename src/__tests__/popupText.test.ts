import { captionText, engineSummaryText } from '../popupText';

const base = {
  mode: 'subtitles' as const,
  audioRunning: false,
  subtitleState: 'off' as const,
  hasBox: false,
  subtitleLanguage: 'Korean',
  speechLanguage: 'Detect automatically',
  targetLanguage: 'English',
  screenTranslate: 'inactive' as const,
};

describe('caption bar', () => {
  it('speaks the current state', () => {
    expect(captionText(base)).toBe('Draw a box around the subtitles on the video');
    expect(captionText({ ...base, hasBox: true })).toBe('Use your saved box, or draw a new one');
    expect(captionText({ ...base, subtitleState: 'loading' })).toBe('Getting the subtitle reader ready…');
    expect(captionText({ ...base, subtitleState: 'running' })).toBe('Translating Korean subtitles into English');
    expect(captionText({ ...base, subtitleState: 'paused-ad' })).toBe('Paused while the ad plays');
    expect(captionText({ ...base, mode: 'audio' })).toBe('Start live captions to translate speech in this tab');
    expect(captionText({ ...base, mode: 'audio', audioRunning: true })).toBe('Live captions on, translating into English');
    expect(captionText({ ...base, mode: 'audio', audioRunning: true, speechLanguage: 'Japanese' })).toBe('Live captions on, Japanese into English');
  });

  it('Screen Translate takes over while a box is being drawn', () => {
    expect(captionText({ ...base, screenTranslate: 'armed' })).toBe('Drag a box around text on the page');
  });
});

describe('engine summary', () => {
  const form = {
    translateWith: 'keys' as const,
    provider: 'deepl' as const,
    hasFastKey: true,
    hasClaude: true,
    engineMode: 'fast-then-best' as const,
    modelLabel: 'Claude Opus 5.5',
  };

  it('describes what will translate, in plain words', () => {
    expect(engineSummaryText(form)).toBe('DeepL, then Claude Opus 5.5');
    expect(engineSummaryText({ ...form, engineMode: 'fast' })).toBe('DeepL');
    expect(engineSummaryText({ ...form, engineMode: 'best' })).toBe('Claude Opus 5.5');
    expect(engineSummaryText({ ...form, provider: 'google' })).toBe('Google Translate, then Claude Opus 5.5');
    expect(engineSummaryText({ ...form, translateWith: 'subscription' })).toBe('Your subscription, Claude Opus 5.5');
  });

  it('says what is missing instead of pretending', () => {
    expect(engineSummaryText({ ...form, hasClaude: false })).toBe('DeepL (add Claude access for best quality)');
    expect(engineSummaryText({ ...form, hasFastKey: false, hasClaude: false })).toBe('Add a translation key to start');
    expect(engineSummaryText({ ...form, hasFastKey: false })).toBe('Claude Opus 5.5 (add a DeepL key for instant lines)');
  });
});
