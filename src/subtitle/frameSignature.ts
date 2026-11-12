// Cheap content signature of the subtitle box, used to skip OCR when nothing changed.

export const SIGNATURE_WIDTH = 64;
export const SIGNATURE_HEIGHT = 16;

/** Area-averaged 64x16 luminance thumbnail of an RGBA frame. */
export function frameSignature(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const sig = new Uint8Array(SIGNATURE_WIDTH * SIGNATURE_HEIGHT);
  for (let sy = 0; sy < SIGNATURE_HEIGHT; sy++) {
    const y0 = Math.floor((sy * height) / SIGNATURE_HEIGHT);
    const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * height) / SIGNATURE_HEIGHT));
    for (let sx = 0; sx < SIGNATURE_WIDTH; sx++) {
      const x0 = Math.floor((sx * width) / SIGNATURE_WIDTH);
      const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * width) / SIGNATURE_WIDTH));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        }
      }
      sig[sy * SIGNATURE_WIDTH + sx] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return sig;
}

/** Mean absolute difference of two signatures, in [0, 1]. */
export function signatureDistance(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}
