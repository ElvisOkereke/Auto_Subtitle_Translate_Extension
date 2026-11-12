// integrity.ts - SHA-256 checks for downloaded OCR models.

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Throws unless `data` hashes to `expected` (a tampered or truncated download is never run). */
export async function verifySha256(data: ArrayBuffer, expected: string, name: string): Promise<void> {
  const actual = await sha256Hex(data);
  if (actual !== expected) throw new Error(`Model integrity check failed for ${name}: sha256 ${actual}, expected ${expected}`);
}
