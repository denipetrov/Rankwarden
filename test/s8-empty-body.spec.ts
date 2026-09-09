import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants, expectNoUnrankedCharacters } from './support/invariants.js';
import { World, type WorldPlayer } from './support/world.js';

/**
 * Independent verification of the ISSUE-5 fix in `05bc833`.
 *
 * Re-running the case that found a defect only proves the developer read the
 * case. The two tests that shipped with the fix assert the client's error type
 * and the arithmetic on the stored timestamp; these attack the same change from
 * the angles those cannot reach — whether the character actually comes back,
 * whether it comes back *behind* the newcomers rather than in front of them,
 * and what an empty body does on the sweep path, which the fix also changed and
 * nothing covered.
 */
describe('ISSUE-5 — verifying the empty-body classification', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    PROFILE_REQUESTS_PER_SECOND: '2000',
    PROFILE_BATCH_SIZE: '100',
  };

  let harness: TestApp;
  let db: Db;
  let world: World;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const enrichment = () => harness.app.get(ProfileEnrichmentService);
  const keyFor = (player: WorldPlayer) =>
    `character:${player.realmSlug}/${encodeURIComponent(player.name.toLowerCase())}`;

  const sweep = async () => {
    const result = await harness.app.get(LeaderboardService).sweep();
    expect(result, 'sweep must not be skipped').not.toBeNull();

    return result!;
  };

  beforeAll(async () => {
    world = World.seed({ regions: ['us'], players: 40, seed: 85, multiBracketShare: 0.4 });
    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    await harness.settle();
    await sweep();
    // A clean baseline: everyone enriched, so anything unenriched below is
    // there because this file put it there.
    await enrichment().run();
    expect(await characters().countDocuments({ profileFetchedAt: { $exists: false } })).toBe(0);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  describe('on the enrichment path', () => {
    let victim: WorldPlayer;

    beforeAll(async () => {
      const stored = await characters().findOne({ region: 'us', profileStatus: 'ok' });
      victim = world.player(stored!.characterId);

      await characters().updateOne(
        { region: 'us', characterId: victim.id },
        { $unset: { profileFetchedAt: '', specsFetchedAt: '', profileStatus: '', profile: '' } },
      );
      world.corrupt('us', keyFor(victim), '');

      try {
        await enrichment().run();
      } finally {
        world.clearFaults();
      }
    });

    it('leaves the character genuinely due again, not merely stamped in the past', async () => {
      // The shipped case checks the arithmetic on the timestamp. This checks the
      // thing the arithmetic exists for: that a later pass actually selects it.
      // Backdating past the backoff is what a real fifteen minutes would do.
      const stamp = (await characters().findOne({ region: 'us', characterId: victim.id }))!
        .profileFetchedAt as Date;
      await characters().updateOne(
        { region: 'us', characterId: victim.id },
        { $set: { profileFetchedAt: new Date(stamp.getTime() - 3_600_000) } },
      );

      harness.blizzard.reset();
      const pass = await enrichment().run();

      const requested = harness.blizzard.requests.some((request) =>
        request.path.includes(encodeURIComponent(victim.name.toLowerCase())),
      );
      expect(pass!.selected, 'the pass had work to do').toBeGreaterThan(0);
      expect(requested, 'the character the empty body hit was fetched again').toBe(true);
    });

    it('recovers completely once the upstream answers again', async () => {
      const stored = await characters().findOne({ region: 'us', characterId: victim.id });

      expect(stored!.profileStatus, 'back to a healthy character').toBe('ok');
      expect(stored!.profile?.spec?.id, 'and the profile is really populated').toBeTruthy();
      expect(stored!.profile?.class?.name).toBeTruthy();
    });

    it('does not let the failed character jump ahead of a newcomer', async () => {
      // The danger the other way round. A failure that leaves the timestamp
      // absent — rather than backdated — puts the character at the front of the
      // queue forever, which is exactly how ISSUE-1 starved it. A backdated
      // stamp is still a stamp, so newcomers keep priority.
      const added = world.addPlayers(3, { region: 'us', brackets: ['3v3'] });
      await sweep();

      await characters().updateOne(
        { region: 'us', characterId: victim.id },
        { $set: { profileFetchedAt: new Date(0), specsFetchedAt: new Date(0) } },
      );

      const due = await characters()
        .find({ region: 'us' })
        .sort({ specsFetchedAt: 1, profileFetchedAt: 1 })
        .limit(added.length)
        .toArray();

      expect(
        due.every((row) => row.profileFetchedAt === undefined),
        'the newcomers with no timestamp still sort first',
      ).toBe(true);
    });
  });

  describe('on the sweep path', () => {
    it('an empty ladder body fails the bracket rather than emptying it', async () => {
      // The dangerous reading. An empty *body* is a transport failure; an empty
      // `entries` array is a real, ingestable answer meaning nobody is ranked.
      // Confusing the two would delete a whole ladder on a gateway blip, and
      // nothing in the suite separated them before this fix existed.
      const before = await characters().countDocuments({
        region: 'us',
        'brackets.3v3': { $exists: true },
      });
      expect(before, 'there is a 3v3 ladder to lose').toBeGreaterThan(0);

      world.corrupt('us', '3v3', '');

      let result;
      try {
        result = await sweep();
      } finally {
        world.clearFaults();
      }

      const job = result.jobs.find((entry) => entry.bracket === '3v3' && entry.region === 'us')!;
      expect(job.error, 'the bracket is a failure, not an empty ladder').toBeTruthy();
      expect(result.removedCharacters, 'and nothing is deleted on the strength of it').toBe(0);
      expect(
        await characters().countDocuments({ region: 'us', 'brackets.3v3': { $exists: true } }),
        'every 3v3 player kept their standing',
      ).toBe(before);
      expect(
        await db.collection(RATING_COLLECTIONS['3v3']).countDocuments({ region: 'us' }),
      ).toBeGreaterThan(0);

      await expectInvariants(db);
      await expectNoUnrankedCharacters(db);
    });

    it('groups the failure under "no HTTP status" rather than under 200', async () => {
      // The response really was a 2xx, so `BlizzardEmptyResponseError` is
      // deliberately not a `BlizzardApiError`. The digest is where that choice
      // becomes visible: a line reading "200: 3v3" would be actively
      // misleading at three in the morning.
      world.corrupt('us', '3v3', '');

      let result;
      try {
        result = await sweep();
      } finally {
        world.clearFaults();
      }

      const digest = result.failures.find((entry) => entry.brackets.includes('3v3'));

      expect(digest, 'the failing bracket is in the digest').toBeTruthy();
      expect(digest!.status).toBe('no HTTP status');
      expect(
        result.failures.some((entry) => entry.status === '200'),
        'no status group claims the request succeeded',
      ).toBe(false);
    });

    it('recovers the ladder on the very next sweep', async () => {
      const result = await sweep();

      expect(result.failed).toBe(0);
      expect(
        result.jobs.find((entry) => entry.bracket === '3v3' && entry.region === 'us')!.entries,
      ).toBeGreaterThan(0);
      await expectInvariants(db, world);
    });
  });
});
