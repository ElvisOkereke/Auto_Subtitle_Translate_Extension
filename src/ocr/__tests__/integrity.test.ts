/** @jest-environment node */
// Node has WebCrypto like workers and pages do (jsdom doesn't).
import { sha256Hex, verifySha256 } from '../integrity';

const bytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0)).buffer;

describe('model integrity', () => {
  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('accepts the expected file and rejects anything else', async () => {
    await expect(verifySha256(bytes('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'm')).resolves.toBeUndefined();
    await expect(verifySha256(bytes('abd'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'm')).rejects.toThrow(/integrity/i);
  });
});
