import { resolveModelConfig, DEFAULT_WASM_CONFIG, DEFAULT_WEBGPU_CONFIG, isMultilingual } from '../modelConfig';

describe('resolveModelConfig', () => {
  it('uses the WebGPU default when a GPU adapter is available', () => {
    expect(resolveModelConfig(true)).toEqual(DEFAULT_WEBGPU_CONFIG);
  });

  it('falls back to the wasm default without WebGPU', () => {
    expect(resolveModelConfig(false)).toEqual(DEFAULT_WASM_CONFIG);
  });

  it('applies overrides and derives multilingual support from the model name', () => {
    const config = resolveModelConfig(true, { model: 'onnx-community/whisper-tiny.en', device: 'wasm', dtype: 'q8' });
    expect(config).toEqual({ model: 'onnx-community/whisper-tiny.en', device: 'wasm', dtype: 'q8', multilingual: false });
  });

  it('treats non-.en checkpoints as multilingual', () => {
    expect(isMultilingual('onnx-community/whisper-base')).toBe(true);
    expect(isMultilingual('Xenova/whisper-small.en')).toBe(false);
  });
});
