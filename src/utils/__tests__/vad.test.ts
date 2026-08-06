import { computeRmsAmplitude, isSpeech, SpeechSegmenter, DEFAULT_VAD_CONFIG, VadConfig } from '../vad';

function makeFrame(amplitude: number, length = 10): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

describe('computeRmsAmplitude', () => {
  it('returns the RMS of the samples', () => {
    const samples = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    expect(computeRmsAmplitude(samples)).toBeCloseTo(0.5);
  });
});

describe('isSpeech', () => {
  it('is true above the threshold and false below it', () => {
    const config: VadConfig = { ...DEFAULT_VAD_CONFIG, silenceThreshold: 0.05 };
    expect(isSpeech(makeFrame(0.1), config)).toBe(true);
    expect(isSpeech(makeFrame(0.01), config)).toBe(false);
  });
});

describe('SpeechSegmenter', () => {
  it('emits a segment once silence persists past the hangover', () => {
    const config: VadConfig = {
      silenceThreshold: 0.05,
      minSpeechDurationMs: 200,
      maxSegmentDurationMs: 5000,
      silenceHangoverMs: 300
    };
    const segmenter = new SpeechSegmenter(100, config);

    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.01))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.01))).toBeNull();
    const segment = segmenter.pushFrame(makeFrame(0.01));

    expect(segment).not.toBeNull();
    expect(segment!.length).toBe(50); // 5 buffered frames of length 10
  });

  it('discards blips shorter than minSpeechDurationMs', () => {
    const config: VadConfig = {
      silenceThreshold: 0.05,
      minSpeechDurationMs: 300,
      maxSegmentDurationMs: 5000,
      silenceHangoverMs: 200
    };
    const segmenter = new SpeechSegmenter(100, config);

    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.01))).toBeNull();
    const result = segmenter.pushFrame(makeFrame(0.01));

    expect(result).toBeNull();
  });

  it('forces a cut when continuous speech exceeds maxSegmentDurationMs', () => {
    const config: VadConfig = {
      silenceThreshold: 0.05,
      minSpeechDurationMs: 100,
      maxSegmentDurationMs: 300,
      silenceHangoverMs: 500
    };
    const segmenter = new SpeechSegmenter(100, config);

    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    const segment = segmenter.pushFrame(makeFrame(0.2));

    expect(segment).not.toBeNull();
    expect(segment!.length).toBe(30);
  });

  it('ignores leading silence before any speech has started', () => {
    const segmenter = new SpeechSegmenter(100, DEFAULT_VAD_CONFIG);
    expect(segmenter.pushFrame(makeFrame(0.001))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.001))).toBeNull();
  });
});
