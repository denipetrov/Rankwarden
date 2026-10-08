import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { logLevelsFor } from './common/logging/log-levels.js';
import type { Env } from './config/env.schema.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);

  const level = config.get('LOG_LEVEL', { infer: true });
  app.useLogger(logLevelsFor(level));
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  new Logger('Bootstrap').log(`Rankwarden listening on port ${port}`);
}

// A failed start is reported once, readably, and exits non-zero. Left unhandled,
// the rejection prints a source excerpt and a stack around the one line that
// matters — and a refused start (see `SchemaBootstrap`) is exactly when an
// operator needs to read that line.
bootstrap().catch((error: unknown) => {
  // `console.error`, not the Nest logger: with `bufferLogs` on, a failure before
  // the logger is attached would leave this line in a buffer nobody flushes.
  console.error(
    `Rankwarden failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
