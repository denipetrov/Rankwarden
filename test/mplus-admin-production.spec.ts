import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { postJson } from './support/http.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const MPLUS_ROUTES = [
  '/admin/mplus',
  '/admin/mplus-season',
  '/admin/mplus-season-transition',
  '/admin/mplus-archive',
  '/admin/mplus-catalogue',
];

/**
 * M12.6 — every Mythic+ admin route 404s in production (gap §7.1).
 *
 * The routes are unauthenticated, and two of them delete data. Named one by
 * one, so a route added later without `this.guard()` fails here rather than
 * shipping.
 */
describe('Mythic+ admin routes in production', () => {
  let app: TestApp;
  let db: Db;

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { NODE_ENV: 'production', RAIDERIO_REGIONS: 'us' },
      undefined,
      undefined,
      new MplusWorld().seed('us', 20, 500),
    );
    db = app.app.get(MongoService).db;
    await app.listen();
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(MPLUS_ROUTES)('M12.6 POST %s is not found, and does nothing', async (route) => {
    const response = await postJson(app.url(), route);

    expect(response.status).toBe(404);
    expect(app.raiderIo.requests, 'no Raider.io request').toEqual([]);

    const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((collection) => collection.name)
      .filter((name) => name.startsWith('mplus_'));
    for (const name of collections) {
      expect(await db.collection(name).countDocuments(), `${name} is untouched`).toBe(0);
    }
  });
});
