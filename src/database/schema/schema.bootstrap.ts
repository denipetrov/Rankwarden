import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';
import { SchemaService } from './schema.service.js';

/**
 * Decides, at startup, what the service may do to the database structure.
 *
 * `ensure` builds it, which is what development and the test suite want: every
 * test file starts from an empty database. `verify` only checks it and refuses
 * to start when something is missing, which is what production wants: the
 * structure is the deploy step's job (`npm run db:schema`), and a service that
 * quietly rebuilt an index on restart would turn a routine restart into a
 * long, locking operation nobody asked for.
 *
 * Refusing matters as much as not building. A service running without its
 * unique indexes does not fail — it writes duplicates, slowly, and reports
 * success. Stopping at the door makes a skipped deploy step impossible to miss.
 *
 * Runs in `onModuleInit`, and Nest finishes every `onModuleInit` before any
 * `onApplicationBootstrap`, where the schedulers start — so no job ever writes
 * to a database that has not passed through here.
 */
@Injectable()
export class SchemaBootstrap implements OnModuleInit {
  private readonly logger = new Logger(SchemaBootstrap.name);
  private readonly mode: Env['DB_SCHEMA_MODE'];

  constructor(
    config: ConfigService<Env, true>,
    private readonly schema: SchemaService,
  ) {
    this.mode = config.get('DB_SCHEMA_MODE', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    if (this.mode === 'ensure') {
      await this.schema.apply();
      return;
    }

    const problems = await this.schema.verify();

    if (problems.length > 0) {
      throw new Error(
        `The database is not in the structure this build needs (${problems.length} problem(s)):\n` +
          problems.map((problem) => `  - ${problem}`).join('\n') +
          '\nRun the schema step ("npm run db:schema") before starting the service. ' +
          'DB_SCHEMA_MODE=verify never changes the database itself.',
      );
    }

    this.logger.log('Database schema verified; structure left untouched (DB_SCHEMA_MODE=verify)');
  }
}

/**
 * Its own module so the schema command can import the database without it:
 * the command always applies, whatever `DB_SCHEMA_MODE` says, and must not
 * fail a verification against the very database it is about to build.
 */
@Module({ providers: [SchemaBootstrap] })
export class SchemaBootstrapModule {}
