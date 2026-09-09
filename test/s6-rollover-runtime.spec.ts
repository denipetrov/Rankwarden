import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import {
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
} from '../src/archive/entities/archive.entity.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import {
  SPEC_REPRESENTATION_COLLECTION,
  startOfUtcDay,
} from '../src/representation/entities/spec-representation.entity.js';
import { ArchiveService } from '../src/archive/archive.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { SpecRepresentationService } from '../src/representation/spec-representation.service.js';
import { SeasonService } from '../src/season/season.service.js';
import { SeasonTransitionService } from '../src/season/season-transition.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectNoOrphanRatingRows } from './support/invariants.js';
import { World } from './support/world.js';

const SEASON = 42;
const NEXT = 43;

/**
 * S6 — what a running process does across a season boundary, beyond the
 * retention gate itself.
 *
 * The gate and the per-region purge scope are covered in
 * `s6-season-transition.spec.ts`. This file is about everything that has to keep
 * working *while* two seasons coexist: the ended season is archivable but still
 * live, sweeps keep writing to it, the two regions disagree about which season
 * is current inside a single sweep, and the daily snapshot has to attribute
 * itself correctly on the one day the answer changes underneath it.
 */
describe('S6 — rollover at runtime', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    SEASON_PURGE_DRY_RUN: 'false',
    // The archive interlock has its own cases; here it would only add setup.
    SEASON_PURGE_REQUIRE_ARCHIVE: 'false',
    ARCHIVE_MAX_ENTRIES_PER_BRACKET: '5',
    // Bound the archive to the season under test: the World seeds two finished
    // seasons behind the live one as history, and they would be offered first.
    ARCHIVE_MIN_SEASON: String(SEASON),
    ARCHIVE_MAX_SEASON: String(SEASON),
    REPRESENTATION_MIN_RATINGS: '0',
  };

  let harness: TestApp;
  let db: Db;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const entries = () => db.collection(ARCHIVE_ENTRIES_COLLECTION);
  const snapshots = () => db.collection(SPEC_REPRESENTATION_COLLECTION);
  const seasons = () => harness.app.get(SeasonService);
  const representation = () => harness.app.get(SpecRepresentationService);

  const sweep = async () => {
    const result = await harness.app.get(LeaderboardService).sweep();
    expect(result, 'sweep must not be skipped').not.toBeNull();

    return result!;
  };

  /**
   * Gives a region's players ratings again after a rollover.
   *
   * `World.rollover` clears every ladder in the region, which is what really
   * happens on day one — so a new season has to be repopulated before there is
   * anything to assert about the two coexisting.
   */
  const repopulate = (region: 'us' | 'eu') => {
    const players = [...harness.world.players.values()].filter(
      (player) => player.region === region,
    );
    for (const [index, player] of players.entries()) {
      harness.world.setRating(player.id, index % 2 === 0 ? '3v3' : '2v2', 1800 + index);
    }
  };

  beforeAll(async () => {
    harness = await bootTestApp(
      World.seed({ regions: ['us', 'eu'], players: 60, seed: 61, season: SEASON }),
      ENV,
    );
    db = harness.app.get(MongoService).db;
    await harness.settle();
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  describe('the season has ended but not rolled over', () => {
    beforeAll(async () => {
      harness.world.endSeason('us', new Date('2026-09-01T05:00:00.000Z'));
      await seasons().refresh('us');
      expect(seasons().hasEnded('us')).toBe(true);
    });

    it('S6.4 — sweeps keep writing to the frozen season and churn nothing', async () => {
      const before = await characters().countDocuments({ region: 'us', seasonId: SEASON });
      const sample = await characters().findOne({ region: 'us', seasonId: SEASON });

      const first = await sweep();
      const second = await sweep();

      // An end date is metadata. It must not make the ingester think the ladder
      // has emptied, which is the one way this could quietly delete everything.
      expect(first.removedCharacters).toBe(0);
      expect(second.removedCharacters).toBe(0);
      expect(first.jobs.every((job) => job.region !== 'us' || job.seasonId === SEASON)).toBe(true);
      expect(await characters().countDocuments({ region: 'us', seasonId: SEASON })).toBe(before);

      const after = await characters().findOne({ characterId: sample!.characterId, region: 'us' });
      const standings = (document: Record<string, { rating: number; rank: number }>) =>
        Object.fromEntries(
          Object.entries(document).map(([bracket, entry]) => [
            bracket,
            { rating: entry.rating, rank: entry.rank },
          ]),
        );

      expect(standings(after!.brackets), 'the standings themselves are unchanged').toEqual(
        standings(sample!.brackets),
      );
      expect(
        after!.brackets[Object.keys(after!.brackets)[0]].fetchedAt.getTime(),
        'only the timestamps move',
      ).toBeGreaterThan(sample!.brackets[Object.keys(sample!.brackets)[0]].fetchedAt.getTime());
    });

    it('S6.3 — the ended-but-current season becomes archivable while still live', async () => {
      // Before it ended, the active season was not offered at all.
      const pending = await harness.app.get(ArchiveService).nextPending();
      expect(pending, 'an ended season is archivable even while it is current').toEqual({
        seasonId: SEASON,
        region: 'us',
      });

      await harness.app.get(ArchiveService).archiveSeason(SEASON, 'us');

      const marker = await db
        .collection(ARCHIVE_SEASONS_COLLECTION)
        .findOne({ seasonId: SEASON, region: 'us' });
      expect(marker!.failedBrackets).toEqual([]);

      // Both representations coexist: archiving does not consume the live rows.
      expect(await entries().countDocuments({ seasonId: SEASON, region: 'us' })).toBeGreaterThan(0);
      expect(await characters().countDocuments({ seasonId: SEASON, region: 'us' })).toBeGreaterThan(
        0,
      );
    });

    it('S6.15 — the archive and the live rows agree on every bracket', async () => {
      // Two independent write paths reading the same upstream. Comparing them
      // is the cheapest oracle available for either one being wrong.
      const brackets = await entries().distinct('bracket', { seasonId: SEASON, region: 'us' });
      expect(brackets.length, 'something must have been archived to compare').toBeGreaterThan(0);

      for (const bracket of brackets) {
        const archived = await entries()
          .find({ seasonId: SEASON, region: 'us', bracket })
          .sort({ rating: -1 })
          .toArray();

        for (const row of archived) {
          const live = await characters().findOne({
            seasonId: SEASON,
            region: 'us',
            characterId: row.characterId,
          });

          expect(live, `${row.characterName} is archived in ${bracket} but not live`).toBeTruthy();
          expect(
            live!.ratings[bracket],
            `${bracket} rating disagrees for ${row.characterName}`,
          ).toBe(row.rating);
          expect(live!.brackets[bracket].rank).toBe(row.rank);
        }
      }
    });
  });

  describe('us rolls over while eu stays behind', () => {
    const usStart = new Date('2026-09-02T15:00:00.000Z');
    let coldStartRequests = 0;

    beforeAll(async () => {
      // Enrich the season-42 population first, so "the new season is a cold
      // start" is a real claim rather than an artefact of nothing being enriched.
      await harness.app.get(ProfileEnrichmentService).run();

      harness.world.rollover('us', NEXT, usStart);
      repopulate('us');
      await seasons().refresh('us');
      await sweep();
    });

    it('S6.6 — one sweep carries a different season per region', async () => {
      const result = await sweep();

      const usSeasons = new Set(
        result.jobs.filter((job) => job.region === 'us').map((job) => job.seasonId),
      );
      const euSeasons = new Set(
        result.jobs.filter((job) => job.region === 'eu').map((job) => job.seasonId),
      );

      expect(usSeasons, 'us has moved on').toEqual(new Set([NEXT]));
      expect(euSeasons, 'eu is still playing the old season').toEqual(new Set([SEASON]));

      // Cleanup is scoped the same way, or the trailing region loses its board.
      expect(result.removedCharacters).toBe(0);
      expect(await characters().countDocuments({ region: 'eu', seasonId: SEASON })).toBeGreaterThan(
        0,
      );
      expect(await characters().countDocuments({ region: 'us', seasonId: NEXT })).toBeGreaterThan(
        0,
      );
    });

    it('S6.10 — the new season is a cold start for enrichment', async () => {
      const enrichedOld = await characters().countDocuments({
        region: 'us',
        seasonId: SEASON,
        profileFetchedAt: { $exists: true },
      });
      expect(enrichedOld, 'season 42 was enriched before the rollover').toBeGreaterThan(0);

      const newPopulation = await characters().countDocuments({ region: 'us', seasonId: NEXT });
      expect(
        await characters().countDocuments({
          region: 'us',
          seasonId: NEXT,
          profileFetchedAt: { $exists: true },
        }),
        'documents are keyed by season, so nothing carries over',
      ).toBe(0);

      // The peak load moment of the service's year, measured rather than
      // assumed: every character in the new season needs both halves fetched.
      harness.blizzard.reset();
      const pass = await harness.app.get(ProfileEnrichmentService).run(true);
      coldStartRequests = harness.blizzard.countMatching('profile/wow/character/');

      expect(pass!.selected, 'the whole new population is newcomers').toBeGreaterThan(0);
      expect(coldStartRequests).toBe(pass!.requests);
      expect(
        coldStartRequests,
        `a cold start costs 2 requests per character (${newPopulation} in season ${NEXT})`,
      ).toBe(pass!.selected * 2);
    });

    it('S6.12 — a spec ladder added by the new season is swept without a code change', async () => {
      // A new hero spec arriving mid-expansion is the realistic version of this.
      const ladder = 'shuffle-warrior-mountainking';
      harness.world.publishBracket('us', ladder);
      const player = [...harness.world.players.values()].find((entry) => entry.region === 'us')!;
      harness.world.setRating(player.id, ladder, 2100);

      await sweep();

      const stored = await characters().findOne({
        region: 'us',
        seasonId: NEXT,
        characterId: player.id,
      });
      expect(stored!.ratings[ladder], 'nothing hardcodes the bracket list').toBe(2100);

      // `ratingFamilyOf` splits on the first segment, so the row must land in
      // the shuffle family; the representation pipeline splits on the third.
      const row = await db
        .collection(RATING_COLLECTIONS.shuffle)
        .findOne({ region: 'us', seasonId: NEXT, bracket: ladder, characterId: player.id });
      expect(row, 'the row belongs to the shuffle family').toBeTruthy();
      expect(row!.rating).toBe(2100);
    });

    it('S6.26 — season-42 snapshots survive the rollover untouched', async () => {
      // Thirty days of history, on both sides of the new season's start.
      const day = 86_400_000;
      const rows = Array.from({ length: 30 }, (_, index) => ({
        date: startOfUtcDay(new Date(usStart.getTime() - (index + 1) * day)),
        seasonId: SEASON,
        region: index % 2 === 0 ? 'us' : 'eu',
        family: '3v3',
        minRating: 0,
        total: 10,
        classified: 10,
        specs: [],
        computedAt: new Date(),
      }));
      await snapshots().insertMany(rows);

      await representation().snapshot();

      // `pruneBeforeSeasonStart` is gone. Were it still there, a snapshot run
      // after the rollover would have deleted the us history here — ahead of the
      // retention gate and without the archive interlock.
      // Only the history: today's row is written by the snapshot run itself.
      const history = { date: { $lt: startOfUtcDay(new Date()) }, seasonId: SEASON };
      expect(
        await snapshots().countDocuments({ ...history, region: 'us' }),
        'the old season keeps its history until the purge takes it',
      ).toBe(15);
      expect(await snapshots().countDocuments({ ...history, region: 'eu' })).toBe(15);
    });

    it('S6.27 — the first snapshot after a rollover names the new season', async () => {
      const today = await snapshots()
        .find({ region: 'us', date: startOfUtcDay(new Date()) })
        .toArray();

      expect(today.length, 'the run above wrote something for today').toBeGreaterThan(0);
      expect(
        [...new Set(today.map((row) => row.seasonId))],
        'resolveSeason refreshes rather than trusting a cache the sweep owns',
      ).toEqual([NEXT]);
    });

    it('S6.27b — a rollover mid-day makes a second snapshot due that same day', async () => {
      // Keyed on (date, region, seasonId): keying on the date alone made day one
      // of every season permanently missing, because an early tick filed it
      // under the old season and no later tick could correct it.
      expect(await representation().isSnapshotDue(), 'today is already written').toBe(false);

      await snapshots().updateMany(
        { date: startOfUtcDay(new Date()), region: 'us' },
        { $set: { seasonId: SEASON } },
      );

      expect(
        await representation().isSnapshotDue(),
        'the day holds an old-season snapshot, so a new-season one is still owed',
      ).toBe(true);
    });

    it('S6.27c — an unreachable API falls back to the cached season', async () => {
      await snapshots().deleteMany({ date: startOfUtcDay(new Date()) });
      harness.world.fail('us', 'index', 503);

      try {
        const summary = await representation().snapshot();
        expect(summary.written, 'a stale season beats no snapshot for the day').toBeGreaterThan(0);

        const row = await snapshots().findOne({ region: 'us', date: startOfUtcDay(new Date()) });
        expect(row!.seasonId).toBe(NEXT);
      } finally {
        harness.world.clearFailures();
      }
    });

    it('S6.25 — the purge order keeps the orphan invariant true throughout', async () => {
      // The purge deletes rating rows before characters. Walking that order by
      // hand and asserting I3 after each step proves the intermediate states are
      // safe, which is what an interrupted purge actually leaves behind.
      const filter = { seasonId: SEASON, region: 'us' };
      expect(await characters().countDocuments(filter)).toBeGreaterThan(0);

      for (const collection of Object.values(RATING_COLLECTIONS)) {
        await db.collection(collection).deleteMany(filter);
        // Rows without characters is the state `removeOrphans` exists to clean;
        // characters without rows is harmless and self-corrects on the next sweep.
        await expectNoOrphanRatingRows(db);
      }

      const outcome = await harness.app.get(SeasonTransitionService).run();

      expect(
        outcome.purged.find((entry) => entry.region === 'us' && entry.seasonId === SEASON),
        'the next tick finishes the season off',
      ).toBeDefined();
      expect(await characters().countDocuments(filter)).toBe(0);
      await expectNoOrphanRatingRows(db);

      // And only now do the snapshots go with it.
      expect(await snapshots().countDocuments({ seasonId: SEASON, region: 'us' })).toBe(0);
      expect(
        await snapshots().countDocuments({
          date: { $lt: startOfUtcDay(new Date()) },
          seasonId: SEASON,
          region: 'eu',
        }),
        'the trailing region keeps its history',
      ).toBe(15);
    });
  });
});
