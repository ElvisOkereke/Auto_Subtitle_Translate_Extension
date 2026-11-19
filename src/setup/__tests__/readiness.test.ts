import { markOcrReady, markSpeechReady, ocrSetupNeeded, speechSetupNeeded, type SetupState } from '../readiness';

const GPU = { ok: true, f16: true };
const NO_GPU = { ok: false, f16: false };

describe('speechSetupNeeded (is the speech model this computer will use already prepared?)', () => {
  it('nothing prepared: the model the settings pick on this computer, with its download size', () => {
    expect(speechSetupNeeded({}, 'turbo', GPU)).toEqual({ model: 'onnx-community/whisper-large-v3-turbo', device: 'webgpu', download: '1.6 GB', gpuSetup: true });
    expect(speechSetupNeeded({}, 'small', GPU)).toMatchObject({ model: 'onnx-community/whisper-small', download: '590 MB' });
    // A GPU without half precision runs small instead of turbo.
    expect(speechSetupNeeded({}, 'turbo', { ok: true, f16: false })).toMatchObject({ model: 'onnx-community/whisper-small' });
    // No GPU: the CPU model, with no GPU setup step.
    expect(speechSetupNeeded({}, 'turbo', NO_GPU)).toEqual({ model: 'onnx-community/whisper-base', device: 'wasm', download: '80 MB', gpuSetup: false });
  });

  it('prepared: nothing needed, until the setting asks for another model', () => {
    let state: SetupState = {};
    state = markSpeechReady(state, { model: 'onnx-community/whisper-large-v3-turbo', device: 'webgpu' }, 1000);
    expect(speechSetupNeeded(state, 'turbo', GPU)).toBeNull();
    expect(speechSetupNeeded(state, 'small', GPU)).not.toBeNull();
  });

  it('prepared on the CPU does not count for the GPU (turning hardware acceleration on needs the GPU setup)', () => {
    const state = markSpeechReady({}, { model: 'onnx-community/whisper-base', device: 'wasm' }, 1000);
    expect(speechSetupNeeded(state, 'turbo', NO_GPU)).toBeNull();
    expect(speechSetupNeeded(state, 'turbo', GPU)).not.toBeNull();
  });
});

describe('ocrSetupNeeded (the subtitle reader for a language)', () => {
  it('needed until prepared; languages sharing a reader share the setup', () => {
    let state: SetupState = {};
    expect(ocrSetupNeeded(state, 'ja')).toBe(true);
    state = markOcrReady(state, 'ja', 1000);
    expect(ocrSetupNeeded(state, 'ja')).toBe(false);
    expect(ocrSetupNeeded(state, 'zh-Hans')).toBe(false); // same Chinese/Japanese reader
    expect(ocrSetupNeeded(state, 'ko')).toBe(true);
  });
});
