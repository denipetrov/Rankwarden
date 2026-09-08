import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC keeps `emitDecoratorMetadata` working so Nest DI can be exercised in tests.
const plugins = [swc.vite({ module: { type: 'es6' } })];

/**
 * Two projects, because the layers have different costs and prerequisites.
 *
 * `unit` is pure functions and mocked collaborators: no Docker, runs on every
 * push in seconds. `integration` boots the real application against a real
 * `mongo:8`, so it needs the container up and is kept out of the default `npm
 * test` — otherwise every push demands Docker.
 */
export default defineConfig({
  plugins,
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.module.ts', 'src/main.ts', 'src/types/**'],
    },
    projects: [
      {
        plugins,
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        plugins,
        test: {
          name: 'integration',
          globals: true,
          environment: 'node',
          include: ['test/**/*.spec.ts'],
          globalSetup: ['test/setup/global-setup.ts'],
          setupFiles: ['test/setup/integration-env.ts'],
          // Real driver I/O against a container: index creation and a full
          // sweep are both far slower than a unit test.
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Each file owns its own database, so file-level parallelism is safe.
          fileParallelism: true,
        },
      },
    ],
  },
});
