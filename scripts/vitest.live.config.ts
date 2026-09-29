import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Runs the integration suite's invariant helpers against a live-check
 * database (`rankwarden_check_*`), outside both test projects. Used by the
 * Mythic+ live cross-check; see `scripts/live-mplus-crosscheck.mjs`.
 *
 *   LIVE_DB=rankwarden_check_mplus_<date> npx vitest run --config scripts/vitest.live.config.ts
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    globals: true,
    environment: 'node',
    include: ['scripts/**/*.live.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
