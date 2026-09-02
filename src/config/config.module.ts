import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';

import { validateEnv, type Env } from './env.schema.js';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
  ],
  exports: [NestConfigModule],
})
export class AppConfigModule {}

/** Config service typed against the validated env shape. */
export type TypedConfigService = ConfigService<Env, true>;
