import path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');
export const FIXTURES = path.join(ROOT, 'e2e/fixtures');
export const CACHE = path.join(ROOT, 'e2e/.cache');
/** Another build to test (E2E_DIST, e.g. a saved baseline); global setup copies it to DIST. */
export const DIST_SOURCE = process.env.E2E_DIST ? path.resolve(process.env.E2E_DIST) : null;
/**
 * The built extension the tests load. An unpacked extension's id comes from its
 * folder, and its speech model cache from its id: every E2E_DIST build is loaded
 * from one fixed folder, so switching builds doesn't re-download the model.
 * E2E_DIST_SLOT: another fixed folder, for a second run at the same time.
 */
export const DIST = DIST_SOURCE ? path.join(CACHE, process.env.E2E_DIST_SLOT ? `dist-bench-${process.env.E2E_DIST_SLOT}` : 'dist-bench') : path.join(ROOT, 'dist');
