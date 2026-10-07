import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { envSchema, validateEnv } from './env.schema.js';

const PRODUCTION_ENV = 'deploy/helm/rankwarden/env/production.env';

/** The four variables that live in a Kubernetes Secret, never in the file. */
const SECRETS = [
  'BLIZZARD_CLIENT_ID',
  'BLIZZARD_CLIENT_SECRET',
  'RAIDER_IO_API_KEY',
  'MONGODB_URI',
];

/** Seams for pointing the service at a fake upstream; production uses the defaults. */
const TEST_ONLY = ['BLIZZARD_API_HOST_TEMPLATE', 'RAIDERIO_API_BASE_URL'];

function parseEnvFile(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');

        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

/**
 * The production configuration, held to the schema it will be read by.
 *
 * The file is not on any code path the test suite runs, so without this it
 * would first be evaluated by a pod starting in production. The deploy pipeline
 * validates it too (`npm run config:check`), but only for what validation can
 * see — and validation cannot see a misspelt name.
 */
describe('production.env', () => {
  const production = parseEnvFile(PRODUCTION_ENV);
  const known = Object.keys(envSchema.shape);

  it('names only variables the service reads', () => {
    // The schema drops unknown keys without complaint, so a typo here would
    // leave the real variable on its development default, silently.
    const unknown = Object.keys(production).filter((name) => !known.includes(name));

    expect(unknown).toEqual([]);
  });

  it('sets every variable, so none is left to a default by omission', () => {
    // A variable added to the schema must be decided for production on purpose,
    // not inherited from a default chosen for development.
    const expected = known.filter((name) => !SECRETS.includes(name) && !TEST_ONLY.includes(name));

    expect(expected.filter((name) => !(name in production))).toEqual([]);
  });

  it('carries no credential', () => {
    // The file is committed. The chart also refuses to render if one appears.
    for (const secret of SECRETS) expect(production).not.toHaveProperty(secret);
  });

  it('passes the service’s own validation', () => {
    const placeholders = Object.fromEntries(SECRETS.map((name) => [name, 'placeholder']));

    expect(() => validateEnv({ ...production, ...placeholders })).not.toThrow();
  });

  it('runs as production, checking the database structure without changing it', () => {
    const placeholders = Object.fromEntries(SECRETS.map((name) => [name, 'placeholder']));
    const env = validateEnv({ ...production, ...placeholders });

    expect(env.NODE_ENV).toBe('production');
    expect(env.DB_SCHEMA_MODE).toBe('verify');
  });

  it('retires finished seasons for real', () => {
    // Development defaults to a dry run that only logs. In production a season
    // that has ended and been archived is removed from the live collections.
    const placeholders = Object.fromEntries(SECRETS.map((name) => [name, 'placeholder']));
    const env = validateEnv({ ...production, ...placeholders });

    expect(env.SEASON_PURGE_DRY_RUN).toBe(false);
    expect(env.MPLUS_PURGE_DRY_RUN).toBe(false);
    // The purge still waits for the archive: nothing is removed that was not kept.
    expect(env.SEASON_PURGE_REQUIRE_ARCHIVE).toBe(true);
    expect(env.MPLUS_PURGE_REQUIRE_ARCHIVE).toBe(true);
  });
});
