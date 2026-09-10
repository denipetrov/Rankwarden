import { describe, expect, it } from 'vitest';

import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp } from './support/app.js';
import { World } from './support/world.js';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.schema.js';

/** Short enough that an unreachable server fails in a second, not in thirty. */
const FAIL_FAST = 'serverSelectionTimeoutMS=800&connectTimeoutMS=800';

/**
 * S8.5 / S8.7 — the database being unreachable or misconfigured at boot.
 *
 * The requirement is that this is loud and immediate. A service that comes up
 * "healthy" against no database, or that sits in a retry loop against a
 * permanent misconfiguration, hides the one class of failure an operator can
 * actually fix in a minute.
 */
describe('S8.5 / S8.7 — the database is unreachable at boot', () => {
  const config = (uri: string) =>
    ({
      get: (key: keyof Env) =>
        ({ MONGODB_URI: uri, MONGODB_DB: 'rankwarden_test_boot' })[key as string],
    }) as unknown as ConfigService<Env, true>;

  it('S8.5 — a closed port fails at onModuleInit rather than being retried away', async () => {
    const mongo = new MongoService(config(`mongodb://127.0.0.1:1/?${FAIL_FAST}`));

    const started = Date.now();
    const error = await mongo.onModuleInit().catch((caught: unknown) => caught);
    const elapsed = Date.now() - started;

    expect(error, 'the failure surfaces rather than being swallowed').toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/ECONNREFUSED|connect|Server selection/i);
    // Bounded by the configured selection timeout: no unbounded retry loop that
    // would let the process look like it is starting when it never will.
    expect(elapsed, `${elapsed}ms`).toBeLessThan(10_000);
  });

  it('S8.7 — an unresolvable host fails with a distinguishable message', async () => {
    const mongo = new MongoService(config(`mongodb://no-such-host.invalid:27017/?${FAIL_FAST}`));

    const error = await mongo.onModuleInit().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    // Distinguishable from the closed-port case above: an operator reading only
    // the log has to be able to tell "wrong address" from "server is down".
    expect((error as Error).message).toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo|no-such-host/i);
  });

  it('S8.5b — and the application refuses to come up at all', async () => {
    // `onModuleInit` runs before `onApplicationBootstrap`, so no interval is
    // ever registered and no job can start against a database that is not
    // there. The boot rejecting is the whole guarantee.
    await expect(
      bootTestApp(World.seed({ regions: ['us'], players: 2, seed: 85 }), {
        MONGODB_URI: `mongodb://127.0.0.1:1/?${FAIL_FAST}`,
      }),
    ).rejects.toThrow();
  }, 30_000);
});
