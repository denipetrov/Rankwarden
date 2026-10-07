import { validateEnv } from './config/env.schema.js';

/**
 * Validates the environment against the service's own schema and exits:
 * `npm run config:check`.
 *
 * For the deploy pipeline. A production value that fails validation would
 * otherwise be discovered by the pod crash-looping after the release went out;
 * this finds it before anything is deployed, using the exact rules the service
 * applies at startup, cross-field checks included. Nothing is connected to and
 * nothing is started.
 *
 * Prints variable names and what is wrong with them, never a value.
 */
try {
  const env = validateEnv(process.env);

  console.log(
    `Configuration is valid (NODE_ENV=${env.NODE_ENV}, DB_SCHEMA_MODE=${env.DB_SCHEMA_MODE}).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
