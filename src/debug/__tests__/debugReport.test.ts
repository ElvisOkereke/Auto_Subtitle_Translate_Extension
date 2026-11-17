import { buildDebugReport, type DebugState } from '../debugReport';

const state = (over: Partial<DebugState> = {}): DebugState => ({
  at: 1_000_000,
  version: '1.0.0',
  page: { host: 'www.youtube.com', readAheadAllowed: true },
  background: {
    captureTabId: 7,
    thisTabId: 7,
    offscreenOpen: true,
    settings: {
      translationEngineMode: 'fast-then-best',
      translationProvider: 'deepl',
      claudeAccess: 'key',
      claudeModel: 'claude-opus-5-5',
      speechModel: 'turbo',
      sourceLanguage: 'ko',
      targetLanguage: 'en',
      keys: { deepl: true, google: false, anthropic: false, gateway: false, account: false },
    },
    audioDiag: { frames: 500, peakRms: 0.08, results: 4, errors: 0, lastError: '', model: 'onnx-community/whisper-large-v3-turbo (webgpu)', ra: { windows: 3, resets: 1, stale: 0, healthy: true }, at: 999_000 },
    model: { status: 'ready', percent: 100 },
    transcripts: [{ text: '안녕하세요', at: 999_500, timing: { readAhead: 1, videoStart: 12.5 } }],
    events: [{ at: 999_800, source: 'background', level: 'error', message: 'Translation failed: 403 Forbidden' }],
  },
  audio: { active: true, path: 'read-ahead', lead: 28.4, raStats: { accepted: 60, outsideWindow: 2 }, scheduled: 9, dropped: { paused: 1 } },
  subtitles: null,
  media: { currentTime: 12.9, paused: false, duration: 600 },
  events: [],
  ...over,
});

const find = (r: ReturnType<typeof buildDebugReport>, title: string) => r.sections.find(s => s.title === title);

describe('buildDebugReport', () => {
  it('summarises capture, model, read-ahead and the last transcripts', () => {
    const r = buildDebugReport(state());
    const audio = find(r, 'Audio mode')!;
    expect(audio.rows).toEqual(
      expect.arrayContaining([
        ['Capturing this tab', 'yes'],
        ['Speech model', 'onnx-community/whisper-large-v3-turbo (webgpu), ready'],
        ['Path', 'read-ahead (28.4 s of audio ahead)'],
      ])
    );
    expect(find(r, 'Recent transcripts')!.rows[0]).toEqual(['12.5 s (read-ahead)', '안녕하세요']);
  });

  it('never shows key values, only whether each key is set', () => {
    const r = buildDebugReport(state());
    const keys = find(r, 'Translation setup')!.rows.find(row => row[0] === 'Keys')!;
    expect(keys[1]).toBe('DeepL: yes, Google: no, Claude key: no, Claude gateway: no, Subscription: no');
    expect(JSON.stringify(r)).not.toMatch(/sk-|test-key/);
  });

  it('flags problems at the top: errors, capture on another tab, no audio level, a stalled model download', () => {
    const r = buildDebugReport(
      state({
        background: { ...state().background!, captureTabId: 3, audioDiag: { ...state().background!.audioDiag!, peakRms: 0 }, model: { status: 'download-progress', percent: 40 } },
      })
    );
    expect(r.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/another tab/),
        expect.stringMatching(/downloading.*40%/i),
        expect.stringMatching(/Translation failed: 403/),
      ])
    );
  });

  it('flags captured audio without sound (muted or paused video)', () => {
    const r = buildDebugReport(state({ background: { ...state().background!, audioDiag: { ...state().background!.audioDiag!, peakRms: 0 } } }));
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringMatching(/no sound/i)]));
  });

  it('subtitles mode: state, box and recent lines', () => {
    const r = buildDebugReport(
      state({
        audio: null,
        subtitles: { state: 'running', ocrCalls: 120, translateCalls: 14, readAheadLead: 3.2, box: { x: 0.2, y: 0.75, w: 0.6, h: 0.14 }, lines: [{ start: 41.2, source: '좋아요', translation: 'Nice' }] },
      })
    );
    const subs = find(r, 'Subtitles mode')!;
    expect(subs.rows).toEqual(expect.arrayContaining([['State', 'running'], ['Box', 'x 20%, y 75%, w 60%, h 14%'], ['Text read', '120 frames, 14 translations']]));
    expect(find(r, 'Recent subtitle lines')!.rows[0]).toEqual(['41.2 s', '좋아요 → Nice']);
  });
});
