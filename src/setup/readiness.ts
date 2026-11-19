// readiness.ts - what this computer has prepared ahead of use (models downloaded,
// the speech model set up on the GPU once), so a mode never starts with a
// download or a minutes-long first-time GPU setup. Pure: unit-tested.
import { resolveModelConfig, SPEECH_MODELS, type SpeechModel } from '../utils/modelConfig';
import { modelFor } from '../ocr/models';
import type { SubtitleLanguage } from '../subtitle/types';

/** chrome.storage.local key. */
export const SETUP_KEY = 'setupState';

export interface SetupState {
  /** Speech models that finished loading (and a first transcription), by model + device. */
  speech?: Record<string, { at: number }>;
  /** Subtitle readers (OCR recognition models) that finished loading, by model. */
  ocr?: Record<string, { at: number }>;
}

export interface SpeechSetup {
  model: string;
  device: 'webgpu' | 'wasm';
  /** Download size, for the person deciding when to do it. */
  download: string;
  /** The first load sets the model up on the GPU (minutes once, seconds afterwards). */
  gpuSetup: boolean;
}

const CPU_DOWNLOAD = '80 MB'; // whisper-base q8

const speechKey = (c: { model: string; device: string }) => `${c.model}|${c.device}`;
const ocrKey = (lang: SubtitleLanguage) => modelFor(lang).rec;

/** The speech model the settings pick on this computer, if it is not prepared yet (null = ready). */
export function speechSetupNeeded(state: SetupState, speechModel: SpeechModel, gpu: { ok: boolean; f16: boolean }): SpeechSetup | null {
  const config = resolveModelConfig(gpu.ok, {}, { speechModel, f16: gpu.f16 });
  if (state.speech?.[speechKey(config)]) return null;
  const download = config.device === 'wasm' ? CPU_DOWNLOAD : (Object.values(SPEECH_MODELS).find(m => m.model === config.model)?.download ?? '');
  return { model: config.model, device: config.device, download, gpuSetup: config.device === 'webgpu' };
}

export function markSpeechReady(state: SetupState, config: { model: string; device: string }, at: number): SetupState {
  return { ...state, speech: { ...state.speech, [speechKey(config)]: { at } } };
}

export function ocrSetupNeeded(state: SetupState, lang: SubtitleLanguage): boolean {
  return !state.ocr?.[ocrKey(lang)];
}

export function markOcrReady(state: SetupState, lang: SubtitleLanguage, at: number): SetupState {
  return { ...state, ocr: { ...state.ocr, [ocrKey(lang)]: { at } } };
}
