// setupNotes.ts - popup lines saying a mode still needs its one-time setup (with a
// button to the setup page), so nobody meets a 1.6 GB download or the
// minutes-long first GPU setup by surprise when they start a mode.
import { SETUP_KEY, ocrSetupNeeded, speechSetupNeeded, type SetupState } from './readiness';
import { detectGpu, type GpuSupport } from '../utils/gpu';
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
  };

  for (const id of ['speechSetupButton', 'ocrSetupButton', 'openWelcome']) el(id)?.addEventListener('click', openSetupPage);
  speechModel?.addEventListener('change', () => void render());
  subtitleLanguage?.addEventListener('change', () => void render());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETUP_KEY]) void render();
  });
  // The selects get their saved values when the popup's settings load.
  void render();
  setTimeout(() => void render(), 300);
}
