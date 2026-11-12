import { frameSignature, signatureDistance } from '../frameSignature';

function uniform(width: number, height: number, luminance: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = px[i + 1] = px[i + 2] = luminance;
    px[i + 3] = 255;
  }
  return px;
}

describe('frameSignature', () => {
  it('is a 64x16 luminance thumbnail', () => {
    expect(frameSignature(uniform(1152, 151, 80), 1152, 151)).toHaveLength(64 * 16);
  });

  it('gives distance 0 for identical frames', () => {
    const a = frameSignature(uniform(320, 60, 120), 320, 60);
    const b = frameSignature(uniform(320, 60, 120), 320, 60);
    expect(signatureDistance(a, b)).toBe(0);
  });

  it('measures a 10% luminance shift as ~0.1', () => {
    const a = frameSignature(uniform(320, 60, 100), 320, 60);
    const b = frameSignature(uniform(320, 60, 125.5), 320, 60);
    expect(signatureDistance(a, b)).toBeCloseTo(0.1, 2);
  });

  it('notices a localized change such as new text', () => {
    const base = uniform(320, 60, 20);
    const withText = uniform(320, 60, 20);
    for (let y = 20; y < 40; y++) for (let x = 40; x < 280; x++) withText.fill(255, (y * 320 + x) * 4, (y * 320 + x) * 4 + 3);
    expect(signatureDistance(frameSignature(base, 320, 60), frameSignature(withText, 320, 60))).toBeGreaterThan(0.06);
  });
});
