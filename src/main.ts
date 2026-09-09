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

void bootstrap();
