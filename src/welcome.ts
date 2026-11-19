// welcome.ts - first-run setup (opened on install, and from Settings): languages,
// a graphics-card check, and preparing the models ahead of use, so starting a
// mode never waits for a download or the one-time GPU setup.
import { getSettings, saveSettings } from './settings';
import { applyTheme, type ThemeChoice } from './theme';
import { detectGpu, type GpuSupport } from './utils/gpu';
import { SETUP_KEY, markOcrReady, markSpeechReady, ocrSetupNeeded, speechSetupNeeded, type SetupState } from './setup/readiness';
import { prepareOcr, prepareSpeech } from './setup/prepare';
import type { SpeechModel } from './utils/modelConfig';
import type { SubtitleLanguage } from './subtitle/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const OCR_DOWNLOAD = '20 MB';

let gpu: GpuSupport = { ok: false, f16: false };
let speechModel: SpeechModel = 'turbo';
let subtitleLanguage: SubtitleLanguage = 'ko';
let running = false;
/** "Ready in 12 s" after preparing here, kept when the page re-renders. */
const readyNote: { speech?: string; ocr?: string } = {};

async function loadState(): Promise<SetupState> {
  return ((await chrome.storage.local.get(SETUP_KEY))[SETUP_KEY] as SetupState) ?? {};
}

async function updateState(change: (s: SetupState) => SetupState): Promise<void> {
  await chrome.storage.local.set({ [SETUP_KEY]: change(await loadState()) });
}

function setTask(task: 'speech' | 'ocr', state: string, opts: { tone?: 'good' | 'bad'; percent?: number; busy?: boolean; done?: boolean; note?: string } = {}): void {
  const label = $(`${task}State`);
  label.textContent = state;
  label.className = `task-state${opts.tone ? ` ${opts.tone}` : ''}`;
  const track = $(`${task}BarTrack`);
  track.classList.toggle('busy', !!opts.busy);
  track.classList.toggle('done', !!opts.done);
  $(`${task}Bar`).style.width = opts.busy || opts.done ? '' : `${opts.percent ?? 0}%`;
  if (opts.note !== undefined) $(`${task}Note`).textContent = opts.note;
}

/** Shows what is ready and what the button will do, from the stored setup state. */
async function render(): Promise<void> {
  if (running) return;
  const state = await loadState();
  const speech = speechSetupNeeded(state, speechModel, gpu);
  const ocr = ocrSetupNeeded(state, subtitleLanguage);
  if (speech) setTask('speech', 'Not prepared', { note: `${speech.download} download${speech.gpuSetup ? ', then a one-time setup on your graphics card' : ''}.` });
  else setTask('speech', 'Ready', { tone: 'good', done: true, note: readyNote.speech ?? '' });
  if (ocr) setTask('ocr', 'Not prepared', { note: `About ${OCR_DOWNLOAD}.` });
  else setTask('ocr', 'Ready', { tone: 'good', done: true, note: readyNote.ocr ?? '' });
  const button = $<HTMLButtonElement>('prepare');
  const sizes = [speech?.download, ocr ? OCR_DOWNLOAD : null].filter(Boolean);
  button.disabled = !speech && !ocr;
  button.textContent = button.disabled ? 'Prepared' : `Download and prepare (${sizes.join(' + ')})`;
  $('allSet').classList.toggle('hidden', !button.disabled);
}

function renderGpu(): void {
  const status = $('gpuStatus');
  status.classList.toggle('good', gpu.ok);
  if (gpu.ok && gpu.f16) status.textContent = 'Your graphics card is available, so Audio mode can use the best-accuracy speech model.';
  else if (gpu.ok) status.textContent = 'Your graphics card is available, but not for the best-accuracy model: Audio mode uses the smaller one.';
  else status.textContent = "The browser can't use your graphics card, so speech recognition runs on the processor: slower and less accurate.";
  $('gpuHelp').classList.toggle('hidden', gpu.ok);
  $('speechChoice').classList.toggle('hidden', !gpu.ok);
  const turbo = document.querySelector<HTMLInputElement>('input[name="speechModel"][value="turbo"]')!;
  turbo.disabled = gpu.ok && !gpu.f16;
}

const elapsed = (since: number) => {
  const s = Math.floor((Date.now() - since) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function runSpeech(): Promise<void> {
  setTask('speech', 'Downloading 0%', { percent: 0 });
  let setupSince = 0;
  const timer = window.setInterval(() => {
    if (setupSince) setTask('speech', `Setting up ${elapsed(setupSince)}`, { busy: true });
  }, 1000);
  try {
    const ready = await prepareSpeech(speechModel, p => {
      if (p.phase === 'download') setTask('speech', `Downloading ${p.percent}%`, { percent: p.percent });
      else if (p.phase === 'gpu-setup') {
        setupSince = Date.now();
        setTask('speech', 'Setting up 0:00', {
          busy: true,
          note: 'Setting the model up on your graphics card. The first time takes several minutes (about 8 on a mid-range card); after this, Audio mode starts in seconds.',
        });
      } else if (p.phase === 'cpu-fallback') setTask('speech', 'Preparing', { busy: true, note: 'Your graphics card could not run it: using the processor instead.' });
      else if (p.phase === 'warm-up') {
        setupSince = 0;
        setTask('speech', 'Almost done', { busy: true });
      }
    });
    await updateState(s => markSpeechReady(s, ready, Date.now()));
    readyNote.speech = `Prepared in ${Math.round((ready.loadMs + ready.warmMs) / 1000)} s.`;
    setTask('speech', 'Ready', { tone: 'good', done: true, note: readyNote.speech });
  } finally {
    window.clearInterval(timer);
  }
}

async function runOcr(): Promise<void> {
  setTask('ocr', 'Downloading', { busy: true, note: '' });
  const lang = subtitleLanguage;
  const ready = await prepareOcr(lang);
  await updateState(s => markOcrReady(s, lang, Date.now()));
  readyNote.ocr = `Prepared in ${Math.max(1, Math.round(ready.ms / 1000))} s.`;
  setTask('ocr', 'Ready', { tone: 'good', done: true, note: readyNote.ocr });
}

async function prepareAll(): Promise<void> {
  const state = await loadState();
  const needSpeech = !!speechSetupNeeded(state, speechModel, gpu);
  const needOcr = ocrSetupNeeded(state, subtitleLanguage);
  running = true;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('select, input, #prepare').forEach(el => (el.disabled = true));
  $('keepOpen').classList.remove('hidden');
  let failed = false;
  // The small subtitle reader first (seconds), then the speech model (minutes).
  for (const [need, task, run] of [
    [needOcr, 'ocr', runOcr],
    [needSpeech, 'speech', runSpeech],
  ] as const) {
    if (!need) continue;
    try {
      await run();
    } catch (error) {
      failed = true;
      setTask(task, "Couldn't finish", { tone: 'bad', note: error instanceof Error ? error.message : String(error) });
    }
  }
  running = false;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('select, input, #prepare').forEach(el => (el.disabled = false));
  $('keepOpen').classList.add('hidden');
  renderGpu(); // re-applies the turbo radio's disabled state
  if (failed) {
    const button = $<HTMLButtonElement>('prepare');
    button.textContent = 'Try again';
    return;
  }
  await render();
}

async function init(): Promise<void> {
  const settings = await getSettings();
  applyTheme(document.documentElement, (settings.theme ?? 'system') as ThemeChoice);
  speechModel = settings.speechModel ?? 'turbo';
  subtitleLanguage = settings.subtitleLanguage ?? 'ko';
  for (const key of ['subtitleLanguage', 'sourceLanguage', 'targetLanguage'] as const) {
    const select = $<HTMLSelectElement>(key);
    select.value = String(settings[key]);
    select.addEventListener('change', async () => {
      await saveSettings({ [key]: select.value });
      if (key === 'subtitleLanguage') subtitleLanguage = select.value as SubtitleLanguage;
      await render();
    });
  }
  document.querySelectorAll<HTMLInputElement>('input[name="speechModel"]').forEach(radio => {
    radio.checked = radio.value === speechModel;
    radio.addEventListener('change', async () => {
      speechModel = radio.value as SpeechModel;
      await saveSettings({ speechModel });
      await render();
    });
  });
  $('openBrowserSettings').addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://settings/system' }));
  $('prepare').addEventListener('click', () => void prepareAll());
  window.addEventListener('beforeunload', event => {
    if (running) event.preventDefault(); // closing now would lose the download in progress
  });
  gpu = await detectGpu();
  if (gpu.ok && !gpu.f16 && speechModel === 'turbo') speechModel = 'small';
  document.querySelectorAll<HTMLInputElement>('input[name="speechModel"]').forEach(radio => (radio.checked = radio.value === speechModel));
  renderGpu();
  await render();
}

void init();
