import 'reflect-metadata';

import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { SchemaService } from './database/schema/schema.service.js';

/**
 * Configuration and the database, and nothing else: no schedulers, no upstream
 * clients, so running this never starts a job or spends a request.
 */
@Module({ imports: [AppConfigModule, DatabaseModule] })
class SchemaCommandModule {}

/**
 * The deploy step: `npm run db:schema`.
 *
 * Creates every collection and index the service needs and drops the retired
 * ones — then verifies the result, so a
 * zero exit code means the service will start. Run it before every release,
 * with a database user allowed to change structure; the service itself then
 * runs with `DB_SCHEMA_MODE=verify` and a user that cannot.
 *
 * `--verify` only checks, changing nothing: exit code 0 when the database is
 * ready, 1 when it is not.
 */
async function main(): Promise<void> {
  const verifyOnly = process.argv.includes('--verify');
  const logger = new Logger('Schema');
  const app = await NestFactory.createApplicationContext(SchemaCommandModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const schema = app.get(SchemaService);

    if (!verifyOnly) await schema.apply();

    const problems = await schema.verify();

    if (problems.length > 0) {
      logger.error(
        `The database is not ready (${problems.length} problem(s)):\n` +
          problems.map((problem) => `  - ${problem}`).join('\n'),
      );
      process.exitCode = 1;
      return;
    }

    logger.log('The database matches the declared schema');
  } finally {
    await app.close();
  }
}

// As a container's first process this has no default SIGTERM behaviour: without
// a handler the signal is ignored, and a cancelled deploy would wait out the
// whole grace period. Every step is safe to interrupt and re-run.
process.on('SIGTERM', () => process.exit(143));

main().catch((error: unknown) => {
  new Logger('Schema').error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
