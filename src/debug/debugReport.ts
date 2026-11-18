// debugReport.ts - turns everything the extension knows about this tab into
// readable sections for the debug panel (and its "Copy report"). Pure, so it
// is unit-tested; key values never reach it, only whether each key is set.

export interface DebugEvent {
  at: number;
  source: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface DebugState {
  at: number;
  version: string;
  page: { host: string; readAheadAllowed: boolean };
  background: {
    captureTabId: number | null;
    thisTabId: number | null;
    offscreenOpen: boolean;
    settings: {
      translationEngineMode: string;
      translationProvider: string;
      claudeAccess: string;
      claudeModel: string;
      speechModel: string;
      sourceLanguage: string;
      targetLanguage: string;
      keys: { deepl: boolean; google: boolean; anthropic: boolean; gateway: boolean; account: boolean };
    };
    audioDiag: {
      frames?: number;
      peakRms?: number;
      results?: number;
      emptyResults?: number;
      errors?: number;
      lastError?: string;
      model?: string;
      loadMs?: number;
      prepareMs?: number | null;
      suppressed?: number;
      nonSpeech?: number;
      ra?: { windows?: number; resets?: number; stale?: number; healthy?: boolean };
      at?: number;
    } | null;
    model: { status: string; percent?: number } | null;
    /** False when the speech model runs on the CPU (no WebGPU); null before it loaded. */
    gpu?: boolean | null;
    transcripts: { text: string; at: number; timing?: Record<string, number> }[];
    events: DebugEvent[];
  } | null;
  audio: {
    active: boolean;
    path: string | null;
    lead: number | null;
    raStats: Record<string, number> | null;
    scheduled: number;
    dropped: Record<string, number> | null;
  } | null;
  subtitles: {
    state: string;
    ocrCalls: number;
    translateCalls: number;
    readAheadLead: number;
    box: { x: number; y: number; w: number; h: number } | null;
    lines: { start: number; source: string; translation: string | null }[];
  } | null;
  media: { currentTime: number; paused: boolean; duration: number } | null;
  events: DebugEvent[];
}

export interface DebugSection {
  title: string;
  rows: [string, string][];
}

export interface DebugReport {
  problems: string[];
  sections: DebugSection[];
}

const yes = (b: boolean | undefined) => (b ? 'yes' : 'no');
const pct = (v: number) => `${Math.round(v * 100)}%`;
const ago = (now: number, at: number | undefined) => (at ? `${Math.max(0, Math.round((now - at) / 1000))} s ago` : '–');

export function buildDebugReport(s: DebugState): DebugReport {
  const problems: string[] = [];
  const sections: DebugSection[] = [];
  const bg = s.background;

  sections.push({
    title: 'Extension',
    rows: [
      ['Version', s.version],
      ['Page', s.page.host],
      ['Read-ahead possible here', yes(s.page.readAheadAllowed)],
      ['Video', s.media ? `${s.media.currentTime.toFixed(1)} s of ${Number.isFinite(s.media.duration) ? s.media.duration.toFixed(0) : '?'} s, ${s.media.paused ? 'paused' : 'playing'}` : 'none found'],
    ],
  });

  if (!bg) problems.push('The background service did not answer (reload the extension in chrome://extensions).');
  else {
    const st = bg.settings;
    const k = st.keys;
    sections.push({
      title: 'Translation setup',
      rows: [
        ['Languages', `${st.sourceLanguage} → ${st.targetLanguage}`],
        ['Engine', `${st.translationEngineMode} (fast: ${st.translationProvider}, Claude: ${st.claudeAccess}, ${st.claudeModel})`],
        ['Keys', `DeepL: ${yes(k.deepl)}, Google: ${yes(k.google)}, Claude key: ${yes(k.anthropic)}, Claude gateway: ${yes(k.gateway)}, Subscription: ${yes(k.account)}`],
        ['Speech model setting', st.speechModel],
      ],
    });
    const fastKey = st.translationProvider === 'deepl' ? k.deepl : st.translationProvider === 'google' ? k.google : k.account;
    if (st.translationEngineMode !== 'best' && !fastKey) problems.push(`No ${st.translationProvider} key: fast translations will fail.`);
    if (st.translationEngineMode !== 'fast' && !(k.anthropic || k.gateway || k.account)) problems.push('No Claude access: the "best" translations will fail.');
    if (st.sourceLanguage === st.targetLanguage) problems.push('Source and target language are the same: nothing is translated.');
  }

  if (s.audio?.active || (bg && bg.captureTabId !== null)) {
    const d = bg?.audioDiag ?? null;
    const capturingHere = !!bg && bg.captureTabId !== null && bg.captureTabId === bg.thisTabId;
    const modelState = bg?.model
      ? bg.model.status === 'download-progress' && (bg.model.percent ?? 0) < 100
        ? `downloading ${bg.model.percent ?? 0}%`
        : bg.model.status === 'download-progress' || bg.model.status === 'preparing'
          ? 'downloaded, preparing on the device'
          : bg.model.status
      : 'not loaded yet';
    const rows: [string, string][] = [
      ['Captions on in this tab', yes(s.audio?.active)],
      ['Capturing this tab', yes(capturingHere)],
      ['Capture worker open', yes(bg?.offscreenOpen)],
      ['Speech model', d?.model ? `${d.model}, ${modelState}` : modelState],
      ['Sound level (last 2 s)', d ? (d.peakRms ?? 0).toFixed(3) : '–'],
      ['Transcriptions', d ? `${d.results ?? 0} with text, ${d.emptyResults ?? 0} empty, ${d.nonSpeech ?? 0} sound-only, ${d.errors ?? 0} errors` : '–'],
      ['Last health report', ago(s.at, d?.at)],
      ['Model load time', d?.loadMs ? `${(d.loadMs / 1000).toFixed(0)} s${d.prepareMs != null ? ` (${(d.prepareMs / 1000).toFixed(0)} s preparing)` : ''}` : '–'],
    ];
    if (s.audio) {
      rows.push(['Path', s.audio.path === 'read-ahead' ? `read-ahead (${(s.audio.lead ?? 0).toFixed(1)} s of audio ahead)` : `${s.audio.path ?? 'live'} (captions after the speech)`]);
      if (s.audio.raStats) rows.push(['Read-ahead audio', Object.entries(s.audio.raStats).map(([a, b]) => `${a} ${b}`).join(', ')]);
      if (d?.ra) rows.push(['Read-ahead windows', `${d.ra.windows ?? 0} sent, ${d.ra.resets ?? 0} restarts, ${d.ra.stale ?? 0} stale`]);
      rows.push(['Captions made ahead', String(s.audio.scheduled)]);
      if (s.audio.dropped && Object.keys(s.audio.dropped).length) rows.push(['Dropped', Object.entries(s.audio.dropped).map(([a, b]) => `${a} ${b}`).join(', ')]);
    }
    if (d?.lastError) rows.push(['Last error', d.lastError]);
    sections.push({ title: 'Audio mode', rows });
    if (bg && bg.captureTabId !== null && !capturingHere) problems.push('Live captions are capturing another tab, not this one.');
    if (capturingHere && d && (d.peakRms ?? 0) === 0 && (d.frames ?? 0) > 0) problems.push('The captured audio has no sound (is the video muted or paused?).');
    if (bg?.gpu === false)
      problems.push('No WebGPU: speech recognition runs on the CPU with the small model (slower, less accurate). Turn on hardware acceleration in the browser settings and restart it.');
    rows.splice(4, 0, ['GPU (WebGPU)', bg?.gpu === null || bg?.gpu === undefined ? 'not known yet' : yes(bg.gpu)]);
    if (bg?.model?.status === 'download-progress' && (bg.model.percent ?? 0) < 100)
      problems.push(`Speech model still downloading (${bg.model.percent ?? 0}%): captions start when it is ready.`);
    else if (bg?.model?.status === 'preparing' || bg?.model?.status === 'download-progress')
      problems.push('Speech model downloaded, now being prepared on your GPU: the first time takes several minutes (about 8 on an RTX 3070), later only seconds.');
    if (bg?.model?.status === 'fallback') problems.push('The best-accuracy model did not start on this device: using the smaller model.');
    if (d?.lastError) problems.push(`Speech recognition error: ${d.lastError}`);
    if (bg?.transcripts.length) {
      sections.push({
        title: 'Recent transcripts',
        rows: bg.transcripts
          .slice(-8)
          .reverse()
          .map(t => [t.timing?.readAhead ? `${(t.timing.videoStart ?? 0).toFixed(1)} s (read-ahead)` : `${ago(s.at, t.at)} (live)`, t.text]),
      });
    }
  }

  if (s.subtitles) {
    const sub = s.subtitles;
    const b = sub.box;
    sections.push({
      title: 'Subtitles mode',
      rows: [
        ['State', sub.state],
        ['Box', b ? `x ${pct(b.x)}, y ${pct(b.y)}, w ${pct(b.w)}, h ${pct(b.h)}` : 'none drawn'],
        ['Text read', `${sub.ocrCalls} frames, ${sub.translateCalls} translations`],
        ['Read ahead', `${sub.readAheadLead.toFixed(1)} s`],
      ],
    });
    if (sub.state === 'running' && sub.ocrCalls > 20 && sub.lines.length === 0) problems.push('Subtitles mode reads frames but finds no text in the box (is the box over the subtitles?).');
    if (sub.lines.length) {
      sections.push({
        title: 'Recent subtitle lines',
        rows: sub.lines
          .slice(-8)
          .reverse()
          .map(l => [`${l.start.toFixed(1)} s`, `${l.source} → ${l.translation ?? '(not translated yet)'}`]),
      });
    }
  }

  const events = [...(bg?.events ?? []), ...s.events].sort((a, b) => a.at - b.at);
  for (const e of events.filter(e => e.level === 'error').slice(-3)) problems.push(e.message);
  if (events.length) {
    sections.push({
      title: 'Event log',
      rows: events
        .slice(-25)
        .reverse()
        .map(e => [`${new Date(e.at).toLocaleTimeString()} ${e.source}${e.level === 'info' ? '' : ` (${e.level})`}`, e.message]),
    });
  }
  return { problems, sections };
}
