import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { FakeBlizzard } from './support/fake-blizzard.js';
import { World } from './support/world.js';

/**
 * Two seams the harness gained after the first execution pass, both of which
 * exist to make a case reachable rather than to test the product directly.
 *
 * They are covered here so the next person to rely on them can see they work,
 * and so removing them breaks something visible.
 */
describe('harness seams', () => {
  describe('a failing token provider', () => {
    let harness: TestApp;
    let db: Db;

    beforeAll(async () => {
      harness = await bootTestApp(
        World.seed({ regions: ['us'], players: 40, seed: 11 }),
        {},
        {
          getAccessToken: async () => {
            throw new Error('OAuth token request rejected');
          },
        },
      );
      db = harness.app.get(MongoService).db;
    });

    afterAll(async () => {
      await db?.dropDatabase();
      await harness?.close();
    });

    it('fails every request, as it would in production', async () => {
      // The real BlizzardHttpService mints a bearer token in a beforeRequest
      // hook on every call. The fake consults the same seam, so credentials
      // failing is expressible at all — without it the provider is never asked
      // and an OAuth outage changes nothing.
      const result = await harness.app.get(LeaderboardService).sweep();

      expect(result).not.toBeNull();
      expect(result!.jobs, 'no bracket can be resolved without a token').toEqual([]);
    });

    it('deletes nothing when no data could be fetched', async () => {
      // The dangerous direction: a total upstream failure must not be read as
      // "everybody fell off every ladder".
      expect(await db.collection(CHARACTERS_COLLECTION).countDocuments()).toBe(0);
    });
  });

  describe('injecting a fault into one half of a profile', () => {
    const world = World.seed({ regions: ['us'], players: 5, seed: 12 });
    const blizzard = new FakeBlizzard(world);
    const player = [...world.players.values()][0];
    const key = `${player.realmSlug}/${encodeURIComponent(player.name.toLowerCase())}`;
    const profilePath = `profile/wow/character/${key}`;
    const specsPath = `${profilePath}/specializations`;

    it('serves both halves normally to begin with', async () => {
      await expect(blizzard.get('us', profilePath)).resolves.toMatchObject({ id: player.id });
      await expect(blizzard.get('us', specsPath)).resolves.toHaveProperty('specializations');
    });

    it('targets the specializations response alone', async () => {
      // Both routes used to key on `character:<realm>/<name>`, so a test aiming
      // at the specs response had to supply a payload that also satisfied the
      // profile schema — indirect enough to be mistaken for product behaviour.
      world.corrupt('us', `specs:${key}`, { specializations: 'not-an-array' });

      await expect(blizzard.get('us', specsPath)).resolves.toEqual({
        specializations: 'not-an-array',
      });
      await expect(blizzard.get('us', profilePath)).resolves.toMatchObject({ id: player.id });
    });

    it('still lets the shared key cover both halves', async () => {
      // Backward compatible: faults already injected against the wide key keep
      // hitting both responses.
      const other = [...world.players.values()][1];
      const wide = `${other.realmSlug}/${encodeURIComponent(other.name.toLowerCase())}`;
      world.corrupt('us', `character:${wide}`, { broken: true });

      await expect(blizzard.get('us', `profile/wow/character/${wide}`)).resolves.toEqual({
        broken: true,
      });
      await expect(
        blizzard.get('us', `profile/wow/character/${wide}/specializations`),
      ).resolves.toEqual({ broken: true });
    });
  });
});
