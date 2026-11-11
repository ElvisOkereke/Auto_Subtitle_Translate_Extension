import path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');
export const DIST = path.join(ROOT, 'dist');
export const FIXTURES = path.join(ROOT, 'e2e/fixtures');
export const CACHE = path.join(ROOT, 'e2e/.cache');
