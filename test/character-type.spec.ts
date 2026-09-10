import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CharacterRepository, enrichmentFilter } from '../src/leaderboard/character.repository.js';
import {
  CHARACTERS_COLLECTION,
  type CharacterDocument,
} from '../src/leaderboard/entities/character.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectIndexInventory, expectInvariants } from './support/invariants.js';
import { World } from './support/world.js';

const DAY = 86_400_000;
const MYTHIC_PLUS = 300;
const MYTHIC_PLUS_REALM = 'keystone-realm';

/**
 * `characterType` — what a character is, and whether enrichment owes it a
 * profile.
 *
 * Nothing writes `M+` characters yet, so they are inserted by hand here, shaped
 * the way the M+ ingestion is expected to leave them: typed, with no ladder
 * data and no enrichment timestamps. That last part is the one that matters. A
 * character that is never enriched never gets a timestamp, and an absent
 * timestamp sorts ahead of every date, so an M+ character is exactly the
 * document the enrichment queue would otherwise put first.
 */
describe('characterType', () => {
  let harness: TestApp;
  let db: Db;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const repository = () => harness.app.get(CharacterRepository);
  const sweep = () => harness.app.get(LeaderboardService).sweep();
  const mythicPlusFetches = () => harness.blizzard.countMatching(MYTHIC_PLUS_REALM);

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us'], players: 120, seed: 31 }), {
      PROFILE_REQUESTS_PER_SECOND: '2000',
    });
    db = harness.app.get(MongoService).db;

    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('stamps every character the sweep creates as PvP', async () => {
    const total = await characters().countDocuments();

    expect(total).toBeGreaterThan(0);
    expect(await characters().countDocuments({ characterType: 'PvP' })).toBe(total);
  });

  describe('with M+ characters in the collection', () => {
    let ladderCharacters: number;

    beforeAll(async () => {
      ladderCharacters = await characters().countDocuments();
      const seasonId = harness.world.season('us').id;

      await characters().insertMany(
        Array.from({ length: MYTHIC_PLUS }, (_, index) => ({
          seasonId,
          region: 'us',
          characterId: 7_000_000 + index,
          characterType: 'M+',
          characterName: `Keystone${index}`,
          realmId: 9_999,
          realmSlug: MYTHIC_PLUS_REALM,
          faction: 'ALLIANCE',
          updatedAt: new Date(),
        })),
      );
    });

    it('leaves them out of the population and the demand count', async () => {
      // Both feed the outlook on readiness: counting M+ characters would report
      // a demand no request is ever made for, and cry infeasible too early.
      expect(await repository().population()).toBe(ladderCharacters);

      const demand = await repository().countEnrichmentDemand(
        new Date(Date.now() - 7 * DAY),
        new Date(Date.now() - DAY),
      );
      expect(demand.characters).toBe(ladderCharacters);
      expect(await repository().countUnenriched()).toBe(ladderCharacters);
    });

    it('never selects or fetches them, however stale they look', async () => {
      const result = await harness.app.get(ProfileEnrichmentService).run();

      expect(result?.selected).toBe(ladderCharacters);
      expect(mythicPlusFetches(), 'no profile request for an M+ character').toBe(0);

      const touched = await characters().countDocuments({
        characterType: 'M+',
        $or: [{ profileFetchedAt: { $exists: true } }, { specsFetchedAt: { $exists: true } }],
      });
      expect(touched).toBe(0);
    });

    it('selects ladder characters without walking past the M+ ones first', async () => {
      // The reason the staleness indexes lead with the type. Keyed on the
      // timestamp alone, every M+ character sits at the front of the index
      // order, and each run would read all of them before its first match.
      for (const onlyNew of [false, true]) {
        const plan = await db
          .collection<CharacterDocument>(CHARACTERS_COLLECTION)
          .find(
            enrichmentFilter(new Date(Date.now() - 7 * DAY), new Date(Date.now() - DAY), onlyNew),
          )
          .sort({ specsFetchedAt: 1 })
          .limit(2_000)
          .explain('executionStats');

        const { totalDocsExamined } = plan.executionStats as { totalDocsExamined: number };
        expect(totalDocsExamined, `onlyNew=${onlyNew}`).toBeLessThanOrEqual(ladderCharacters);
      }
    });

    it('does not reclassify an M+ character the sweep finds on a ladder', async () => {
      // The sweep sets the type on insert only. If it claimed the document, the
      // character would join the enrichment queue and spend quota on a profile
      // its own source already bundles.
      const listed = await characters().findOne({ characterType: 'PvP' });
      await characters().updateOne({ _id: listed!._id }, { $set: { characterType: 'M+' } });

      await sweep();

      const after = await characters().findOne({ _id: listed!._id });
      expect(after!.characterType).toBe('M+');
      expect(after!.updatedAt.getTime(), 'its ladder data is still refreshed').toBeGreaterThan(
        listed!.updatedAt.getTime(),
      );

      await characters().updateOne({ _id: listed!._id }, { $set: { characterType: 'PvP' } });
    });

    it('survives a sweep: having no ladder data is not being unranked', async () => {
      await sweep();

      expect(await characters().countDocuments({ characterType: 'M+' })).toBe(MYTHIC_PLUS);
      await expectInvariants(db, harness.world);
    });
  });

  describe('on boot over a database from before the field existed', () => {
    const legacyId = 8_000_001;

    beforeAll(async () => {
      await characters().insertOne({
        seasonId: harness.world.season('us').id,
        region: 'us',
        characterId: legacyId,
        characterName: 'Untyped',
        realmId: 60,
        realmSlug: 'tarren-mill',
        faction: 'HORDE',
        brackets: {
          '3v3': { rank: 1, rating: 2000, played: 1, won: 1, lost: 0, fetchedAt: new Date() },
        },
        ratings: { '3v3': 2000 },
        updatedAt: new Date(),
        profileFetchedAt: new Date(Date.now() - 30 * DAY),
        specsFetchedAt: new Date(Date.now() - 30 * DAY),
      });
      // The staleness indexes as the previous build created them.
      await characters().createIndex({ specsFetchedAt: 1 }, { name: 'specs_staleness' });
      await characters().createIndex({ profileFetchedAt: 1 }, { name: 'profile_staleness' });

      // Both migrations run in onModuleInit, so a fresh boot is what exercises them.
      const second = await bootTestApp(harness.world, {
        PROFILE_REQUESTS_PER_SECOND: '2000',
        MONGODB_DB: harness.dbName,
      });
      await second.close();
    });

    it('backfills the missing type as PvP, which every such character is', async () => {
      const legacy = await characters().findOne({ characterId: legacyId });

      expect(legacy!.characterType).toBe('PvP');
      expect(await characters().countDocuments({ characterType: { $exists: false } })).toBe(0);
    });

    it('puts the backfilled character back in the enrichment queue', async () => {
      // Untyped, it would have matched no enrichment filter and quietly never
      // been refreshed again.
      const due = await repository().findProfilesToEnrich(
        new Date(Date.now() - 7 * DAY),
        new Date(Date.now() - DAY),
        10,
      );

      expect(due.map((character) => character.characterId)).toContain(legacyId);
    });

    it('replaces the old staleness indexes with the type-led ones', async () => {
      await expectIndexInventory(db);
    });
  });
});
