// setupNotes.ts - popup lines saying a mode still needs its one-time setup (with a
// button to the setup page), so nobody meets a 1.6 GB download or the
// minutes-long first GPU setup by surprise when they start a mode.
import { SETUP_KEY, ocrSetupNeeded, speechSetupNeeded, type SetupState } from './readiness';
import { detectGpu, type GpuSupport } from '../utils/gpu';
import { getSecrets, hostedServiceUrl } from '../settings';
import { chooseFastProvider } from '../translation/fastProvider';
import { translatorPlan, translatorStatus, type ChromeAi } from './translatorSetup';
import type { SpeechModel } from '../utils/modelConfig';
import type { SubtitleLanguage } from '../subtitle/types';

export function openSetupPage(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
}

export function installSetupNotes(doc: Document = document): void {
  const el = (id: string) => doc.getElementById(id);
  const speechModel = el('speechModel') as HTMLSelectElement | null;
  const subtitleLanguage = el('subtitleLanguage') as HTMLSelectElement | null;
  let gpu: GpuSupport | null = null;

  const render = async () => {
    gpu ??= await detectGpu();
    const state = ((await chrome.storage.local.get(SETUP_KEY))[SETUP_KEY] as SetupState) ?? {};
    const speech = speechSetupNeeded(state, (speechModel?.value || 'turbo') as SpeechModel, gpu);
    el('speechSetupNote')?.classList.toggle('hidden', !speech);
    const speechText = el('speechSetupText');
    if (speech && speechText) {
      speechText.textContent = `Audio mode needs a one-time setup: a ${speech.download} download${speech.gpuSetup ? ', then a few minutes on your graphics card' : ''}.`;
    }
    const ocr = ocrSetupNeeded(state, (subtitleLanguage?.value || 'ko') as SubtitleLanguage);
    el('ocrSetupNote')?.classList.toggle('hidden', !ocr);
    el('translatorSetupNote')?.classList.toggle('hidden', !(await translatorNeedsDownload()));
  };

  /** The free translator does the translating (no key) and a language pack for the chosen languages isn't downloaded. */
  const translatorNeedsDownload = async (): Promise<boolean> => {
    const [{ translationProvider }, secrets] = await Promise.all([chrome.storage.sync.get('translationProvider'), getSecrets()]);
    if (chooseFastProvider(translationProvider ?? 'builtin', secrets, hostedServiceUrl()) !== 'builtin') return false;
    const value = (id: string, fallback: string) => (el(id) as HTMLSelectElement | null)?.value || fallback;
    const plan = translatorPlan(value('subtitleLanguage', 'ko'), value('sourceLanguage', 'auto'), value('targetLanguage', 'en'));
    return typeof (await translatorStatus(globalThis as unknown as ChromeAi, plan)) === 'object';
  };

  for (const id of ['speechSetupButton', 'ocrSetupButton', 'translatorSetupButton', 'openWelcome']) el(id)?.addEventListener('click', openSetupPage);
  for (const id of ['speechModel', 'subtitleLanguage', 'sourceLanguage', 'targetLanguage', 'translationProvider']) el(id)?.addEventListener('change', () => void render());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETUP_KEY]) void render();
  });
  // The selects get their saved values when the popup's settings load.
  void render();
  setTimeout(() => void render(), 300);
}
