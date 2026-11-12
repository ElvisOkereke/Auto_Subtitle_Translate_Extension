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

export function isMultilingual(model: string): boolean {
  return !/\.en$/i.test(model);
}

export function resolveModelConfig(webgpuAvailable: boolean, overrides: ModelOverrides = {}): ModelConfig {
  const device: Device = overrides.device ?? (webgpuAvailable ? 'webgpu' : 'wasm');
  const base = device === 'webgpu' ? DEFAULT_WEBGPU_CONFIG : DEFAULT_WASM_CONFIG;
  const model = overrides.model ?? base.model;
  return {
    model,
    device,
    dtype: overrides.dtype ?? base.dtype,
    multilingual: isMultilingual(model)
  };
}
