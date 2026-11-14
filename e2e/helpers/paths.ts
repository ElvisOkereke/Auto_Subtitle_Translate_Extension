import path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');
/** The built extension the tests load (E2E_DIST: another build, e.g. a saved baseline). */
export const DIST = process.env.E2E_DIST ? path.resolve(process.env.E2E_DIST) : path.join(ROOT, 'dist');
export const FIXTURES = path.join(ROOT, 'e2e/fixtures');
export const CACHE = path.join(ROOT, 'e2e/.cache');
