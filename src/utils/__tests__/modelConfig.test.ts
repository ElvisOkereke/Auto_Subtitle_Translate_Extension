import { resolveModelConfig, DEFAULT_WEBGPU_CONFIG, DEFAULT_WASM_CONFIG, isMultilingual, SPEECH_MODELS } from '../modelConfig';

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

describe('speech model choice (Settings: best accuracy / smaller download)', () => {
  it('best accuracy on a GPU with half precision: Whisper large-v3-turbo (fp16 encoder, q4 decoder)', () => {
    const c = resolveModelConfig(true, {}, { speechModel: 'turbo', f16: true });
    expect(c.model).toBe('onnx-community/whisper-large-v3-turbo');
    expect(c.dtype).toEqual({ encoder_model: 'fp16', decoder_model_merged: 'q4' });
    expect(c.device).toBe('webgpu');
  });

  it('best accuracy on a GPU without half precision falls back to Whisper small', () => {
    expect(resolveModelConfig(true, {}, { speechModel: 'turbo', f16: false }).model).toBe('onnx-community/whisper-small');
  });

  it('smaller download: Whisper small', () => {
    const c = resolveModelConfig(true, {}, { speechModel: 'small', f16: true });
    expect(c.model).toBe('onnx-community/whisper-small');
    expect(c.dtype).toEqual({ encoder_model: 'fp32', decoder_model_merged: 'q4' });
  });

  it('without a GPU the CPU model is used whatever the choice', () => {
    expect(resolveModelConfig(false, {}, { speechModel: 'turbo', f16: false })).toEqual(DEFAULT_WASM_CONFIG);
  });

  it('an explicit model override (dev/test) wins over the choice', () => {
    expect(resolveModelConfig(true, { model: 'onnx-community/whisper-base' }, { speechModel: 'turbo', f16: true }).model).toBe('onnx-community/whisper-base');
  });

  it('lists the two choices with their download sizes', () => {
    expect(Object.keys(SPEECH_MODELS)).toEqual(['turbo', 'small']);
  });
});
