import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { ARCHIVE_ENTRIES_COLLECTION } from '../src/database/collections.js';
import type { MongoService } from '../src/database/mongo.service.js';
import { SchemaService } from '../src/database/schema/schema.service.js';
import { bootTestApp } from './support/app.js';
import { openTestDatabase, testDbName } from './support/database.js';
import { getJson } from './support/http.js';
import { World } from './support/world.js';

/**
 * `DB_SCHEMA_MODE=verify` — how the service starts in production.
 *
 * Its own file because it needs its own configuration: every other integration
 * file boots in `ensure`, which is why none of them could show what happens
 * when the structure is *not* there. Here the deploy step is played by hand —
 * skipped, then run, then partly undone — and the service is booted after each.
 */
describe('starting with DB_SCHEMA_MODE=verify', () => {
  const ENV = { DB_SCHEMA_MODE: 'verify' };
  const world = World.seed({ regions: ['us'], players: 10, seed: 91 });

  let db: Db;
  let drop: () => Promise<void>;
  let schema: SchemaService;

  beforeAll(async () => {
    const opened = await openTestDatabase(testDbName(expect.getState().testPath));
    ({ db, drop } = opened);
    schema = new SchemaService({ db } as unknown as MongoService);
  });

  afterAll(async () => {
    await drop?.();
  });

  it('refuses to start on a database the schema step never touched', async () => {
    const error = await bootTestApp(world, ENV).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not in the structure this build needs/);
    // The message has to say what to do about it, not only what is wrong.
    expect((error as Error).message).toMatch(/npm run db:schema/);
  });

  it('and creates nothing while refusing', async () => {
    // The whole point of the mode: a start, successful or not, never changes
    // the structure.
    expect(await db.listCollections().toArray()).toEqual([]);
  });

  it('starts once the schema step has run, and reports ready', async () => {
    await schema.apply();

    const harness = await bootTestApp(world, ENV);

    try {
      const ready = await getJson<{ status: string }>(await harness.listen(), '/health/ready');

      expect(ready.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it('refuses again when one index goes missing, and names it', async () => {
    await db.collection(ARCHIVE_ENTRIES_COLLECTION).dropIndex('archive_identity');

    const error = await bootTestApp(world, ENV).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(
      `index "archive_identity" on "${ARCHIVE_ENTRIES_COLLECTION}" is missing`,
    );
    // Not rebuilt on the way out.
    expect(
      (await db.collection(ARCHIVE_ENTRIES_COLLECTION).indexes()).map((index) => index.name),
    ).not.toContain('archive_identity');
  });
});
