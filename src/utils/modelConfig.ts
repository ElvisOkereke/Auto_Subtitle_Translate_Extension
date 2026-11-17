// modelConfig.ts - Chooses which Whisper checkpoint/precision to run.
// Pure (no DOM / worker globals) so it is unit-testable.

export type Device = 'webgpu' | 'wasm';
export type DType = 'fp32' | 'fp16' | 'q8' | 'q4' | 'int8' | 'uint8' | 'bnb4' | 'q4f16';

export interface ModelConfig {
  model: string;
  device: Device;
  dtype: DType | Record<string, DType>;
  multilingual: boolean;
}

export interface ModelOverrides {
  model?: string;
  device?: Device;
  dtype?: DType | Record<string, DType>;
  /** ONNX Runtime wasm thread count (only effective when crossOriginIsolated). */
  numThreads?: number;
}

// Defaults are chosen from the benchmark in docs/performance.md.
export const DEFAULT_WEBGPU_CONFIG: ModelConfig = {
  model: 'onnx-community/whisper-base',
  device: 'webgpu',
  // Whisper's encoder is sensitive to quantisation; the decoder is not.
  dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  multilingual: true
};

export const DEFAULT_WASM_CONFIG: ModelConfig = {
  model: 'onnx-community/whisper-base',
  device: 'wasm',
  dtype: 'q8',
  multilingual: true
};

/**
 * What Settings offers on computers with a GPU. Measured on screen on real
 * YouTube (Korean commentary over game sound): turbo put the right subtitle up
 * 44% of the time and a wrong one 17%; small 29% and 39%; base worse still.
 */
export type SpeechModel = 'turbo' | 'small';

export const SPEECH_MODELS: Record<SpeechModel, { model: string; dtype: Record<string, DType>; download: string; needsF16?: boolean }> = {
  turbo: {
    model: 'onnx-community/whisper-large-v3-turbo',
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
    download: '1.6 GB',
    needsF16: true,
  },
  small: { model: 'onnx-community/whisper-small', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, download: '590 MB' },
};

export function isMultilingual(model: string): boolean {
  return !/\.en$/i.test(model);
}

/**
 * `choice`: the Settings choice and whether the GPU does half precision (turbo's
 * fp16 encoder needs it; without it, small). Without a GPU the CPU model is used.
 * An explicit model override (dev/test) wins.
 */
export function resolveModelConfig(webgpuAvailable: boolean, overrides: ModelOverrides = {}, choice?: { speechModel: SpeechModel; f16: boolean }): ModelConfig {
  const device: Device = overrides.device ?? (webgpuAvailable ? 'webgpu' : 'wasm');
  let base = device === 'webgpu' ? DEFAULT_WEBGPU_CONFIG : DEFAULT_WASM_CONFIG;
  if (device === 'webgpu' && choice) {
    const pick = SPEECH_MODELS[choice.speechModel]?.needsF16 && !choice.f16 ? SPEECH_MODELS.small : SPEECH_MODELS[choice.speechModel] ?? SPEECH_MODELS.small;
    base = { model: pick.model, device, dtype: pick.dtype, multilingual: true };
  }
  const model = overrides.model ?? base.model;
  return {
    model,
    device,
    dtype: overrides.dtype ?? base.dtype,
    multilingual: isMultilingual(model)
  };
}
