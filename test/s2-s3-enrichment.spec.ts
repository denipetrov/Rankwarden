import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { World } from './support/world.js';

const DAY = 86_400_000;

/**
 * S2 / S3 — profile enrichment across cycles, and newcomers after a sweep.
 *
 * The two halves age on different clocks, so the cycles are not repetitions of
 * each other: cycle 1 fetches both, cycle 2 only the specs half, cycle 3 both
 * again. Elapsed time is simulated by backdating the stored timestamps, which
 * is deterministic in a way fake timers are not against real driver I/O.
 */
describe('S2 / S3 — enrichment', () => {
  let harness: TestApp;
  let db: Db;
  let enrichment: ProfileEnrichmentService;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const sweep = () => harness.app.get(LeaderboardService).sweep();

  /** Pretends `ms` has passed since every stored profile timestamp. */
  const backdate = async (ms: number) => {
    const docs = await characters()
      .find(
        { profileFetchedAt: { $exists: true } },
        { projection: { profileFetchedAt: 1, specsFetchedAt: 1 } },
      )
      .toArray();

    for (const doc of docs) {
      await characters().updateOne(
        { _id: doc._id },
        {
          $set: {
            profileFetchedAt: new Date(doc.profileFetchedAt.getTime() - ms),
            specsFetchedAt: new Date(doc.specsFetchedAt.getTime() - ms),
          },
        },
      );
    }
  };

  const profileRequests = () =>
    harness.blizzard.requests.filter(
      (request) =>
        request.path.startsWith('profile/') && !request.path.endsWith('/specializations'),
    ).length;
  const specRequests = () => harness.blizzard.countMatching('/specializations');

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us'], players: 40, seed: 2 }), {
      PROFILE_BATCH_SIZE: '20',
    });
    db = harness.app.get(MongoService).db;
    enrichment = harness.app.get(ProfileEnrichmentService);
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S2.1 — cycle 1 fetches both halves for never-enriched characters', async () => {
    harness.blizzard.reset();
    const result = await enrichment.run();

    expect(result!.selected).toBe(20);
    expect(result!.enriched).toBe(20);
    expect(profileRequests()).toBe(20);
    expect(specRequests()).toBe(20);

    const enriched = await characters().findOne({ profileStatus: 'ok' });
    expect(enriched!.profile).toMatchObject({
      race: expect.any(Object),
      class: expect.any(Object),
      spec: expect.any(Object),
      talentLoadouts: expect.any(Array),
    });
    expect(enriched!.profileFetchedAt).toBeInstanceOf(Date);
    expect(enriched!.specsFetchedAt).toBeInstanceOf(Date);
  });

  it('S2.2 — never-enriched characters sort ahead of stale ones', async () => {
    // 20 are enriched, 20 are not. The next pass must take the untouched ones.
    harness.blizzard.reset();
    const result = await enrichment.run();

    expect(result!.selected).toBe(20);
    expect(await characters().countDocuments({ profileFetchedAt: { $exists: false } })).toBe(0);
  });

  it('S2.3 — cycle 2 fetches only the spec half', async () => {
    // 25 hours: past the 1d spec TTL, well inside the 7d summary TTL.
    await backdate(25 * 3_600_000);
    harness.blizzard.reset();

    const result = await enrichment.run();

    expect(result!.selected).toBe(20);
    expect(profileRequests(), 'the summary half is not due').toBe(0);
    expect(specRequests()).toBe(20);
    expect(result!.requests).toBe(20);
  });

  it('S2.4 — cycle 3 fetches both once the summary TTL passes', async () => {
    await backdate(8 * DAY);
    harness.blizzard.reset();

    const result = await enrichment.run();

    expect(profileRequests()).toBe(result!.selected);
    expect(specRequests()).toBe(result!.selected);
  });

  it('S2.5 — the halves never clobber each other', async () => {
    const before = await characters().findOne({ profileStatus: 'ok' });
    const player = harness.world.player(before!.characterId);
    const originalRace = before!.profile.race;
    const originalTitle = before!.profile.title;

    // Respec: only the spec half changes upstream.
    const newSpec = player.loadoutSpecs.find((spec) => spec.specId !== player.spec.specId);
    expect(newSpec, 'the fixture must give this player a second loadout').toBeDefined();
    harness.world.respec(player.id, newSpec!.specSlug);

    await backdate(25 * 3_600_000);
    await enrichment.run();
    await enrichment.run();

    const after = await characters().findOne({ _id: before!._id });

    expect(after!.profile.spec.id, 'the spec half updated').toBe(newSpec!.specId);
    expect(after!.profile.race, 'the summary half survived').toEqual(originalRace);
    expect(after!.profile.title).toEqual(originalTitle);
  });

  it('S2.6 — hero talents stay paired with their own spec', async () => {
    const multi = [...harness.world.players.values()].find(
      (player) => player.loadoutSpecs.length > 1,
    );
    expect(multi, 'the fixture must produce a multi-loadout character').toBeDefined();

    // Make sure that character is the one enriched.
    await characters().updateOne(
      { characterId: multi!.id, region: multi!.region },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '' } },
    );
    await enrichment.run(true);

    const doc = await characters().findOne({ characterId: multi!.id, region: multi!.region });
    const loadouts = doc!.profile.talentLoadouts as {
      spec: { id: number; name: string };
      heroTalentTree: { id: number; name: string } | null;
    }[];

    expect(loadouts.length).toBe(multi!.loadoutSpecs.length);
    // One entry per spec, and the active tree is the active spec's own — never
    // borrowed from another spec's build, which is the trap in SKILLS.md 9.2.
    expect(new Set(loadouts.map((l) => l.spec.id)).size).toBe(loadouts.length);

    const active = loadouts.find((l) => l.spec.id === doc!.profile.spec.id);
    expect(active).toBeDefined();
    expect(doc!.profile.heroTalentTree).toEqual(active!.heroTalentTree);

    for (const loadout of loadouts) {
      const spec = multi!.loadoutSpecs.find((s) => s.specId === loadout.spec.id)!;
      const trees = spec.heroTrees.map((tree) => tree.id);
      if (loadout.heroTalentTree) {
        expect(trees, `${loadout.spec.name} must carry its own tree`).toContain(
          loadout.heroTalentTree.id,
        );
      }
    }
  });

  it('S2.10 — enrichment defers to a running sweep', async () => {
    harness.blizzard.delayMs = 4;
    harness.blizzard.reset();

    const running = sweep();
    // Called while the coordinator is held by the sweep.
    const deferred = await enrichment.run();
    await running;
    harness.blizzard.delayMs = 0;

    expect(deferred, 'a pass during a sweep must defer, not queue').toBeNull();
  });

  describe('S3 — newcomers after a second sweep', () => {
    it('S3.1 / S3.2 — the onlyNew pass selects exactly the newcomers', async () => {
      // Everyone enriched; now make some of them stale as well, so the filter
      // has something it must not pick up.
      await backdate(8 * DAY);
      const added = harness.world.addPlayers(7, { region: 'us' });
      await sweep();

      expect(await characters().countDocuments({ profileFetchedAt: { $exists: false } })).toBe(7);

      harness.blizzard.reset();
      const result = await enrichment.run(true);

      expect(result!.selected, 'only the newcomers, never the stale veterans').toBe(7);
      expect(profileRequests()).toBe(7);

      for (const player of added) {
        const doc = await characters().findOne({ characterId: player.id, region: 'us' });
        expect(doc!.profileStatus).toBe('ok');
      }
    });

    it('S3.5 — a newcomer whose profile 404s is marked missing and not retried', async () => {
      const [newcomer] = harness.world.addPlayers(1, { region: 'us' });
      harness.world.deleteCharacter(newcomer.id);
      await sweep();

      harness.blizzard.reset();
      const first = await enrichment.run(true);
      expect(first!.missing).toBe(1);

      const doc = await characters().findOne({ characterId: newcomer.id, region: 'us' });
      expect(doc!.profileStatus).toBe('missing');
      expect(doc!.profile).toBeUndefined();
      expect(doc!.profileFetchedAt).toBeInstanceOf(Date);
      expect(doc!.specsFetchedAt, 'both stamps move so a 404 cannot hot-loop').toBeInstanceOf(Date);

      harness.blizzard.reset();
      const second = await enrichment.run(true);
      expect(second!.selected, 'nothing new is due').toBe(0);
      expect(profileRequests()).toBe(0);
    });

    it('S3.7 — gaining a bracket does not make a character new', async () => {
      const veteran = await characters().findOne({ profileStatus: 'ok' });
      const fetchedAt = veteran!.profileFetchedAt;

      harness.world.setRating(veteran!.characterId, 'rbg', 2100);
      await sweep();

      harness.blizzard.reset();
      await enrichment.run(true);

      const after = await characters().findOne({ _id: veteran!._id });
      expect(after!.brackets).toHaveProperty('rbg');
      expect(after!.profileFetchedAt).toEqual(fetchedAt);
    });
  });

  /**
   * A character whose profile payload never satisfies the schema must not be
   * retried on every pass forever, starving everyone behind it.
   *
   * `findProfilesToEnrich` sorts by `specsFetchedAt` ascending and an absent
   * field sorts before every date, so a failure that stamps nothing is
   * re-selected indefinitely — and once the failing set fills a batch, nobody
   * else is ever enriched again while the job keeps reporting successful runs.
   * A 404 was always handled correctly (`markProfileMissing` stamps both
   * timestamps); the parse-failure path now does the same.
   */
  it('ISSUE-1 — unparseable profiles must not starve the enrichment queue', async () => {
    // Everyone enriched and then aged, so every character is legitimately due.
    await characters().updateMany({}, { $unset: { profileFetchedAt: '', specsFetchedAt: '' } });
    await enrichment.run();
    await enrichment.run();
    await enrichment.run();
    await backdate(8 * DAY);

    // Exactly one batch worth of characters now serve an unparseable profile,
    // and only they have their timestamps cleared — so they sort ahead of the
    // rest, which are stale but perfectly healthy.
    const victims = [...harness.world.players.values()].slice(0, 20);
    for (const victim of victims) {
      const key = `character:${victim.realmSlug}/${encodeURIComponent(victim.name.toLowerCase())}`;
      harness.world.corrupt(victim.region, key, { id: victim.id, name: victim.name });
    }
    const victimIds = victims.map((victim) => victim.id);
    await characters().updateMany(
      { characterId: { $in: victimIds } },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '' } },
    );

    const healthyBefore = await characters()
      .find({ characterId: { $nin: victimIds } }, { projection: { specsFetchedAt: 1 } })
      .toArray();

    for (let pass = 0; pass < 3; pass += 1) await enrichment.run();

    // The failing characters yield their place after one pass, so the healthy
    // ones behind them are reached instead of being starved out.
    const healthyAfter = await characters()
      .find({ characterId: { $nin: victimIds } }, { projection: { specsFetchedAt: 1 } })
      .toArray();
    const advanced = healthyAfter.filter((doc, index) => {
      const before = healthyBefore[index]?.specsFetchedAt?.getTime() ?? 0;
      return (doc.specsFetchedAt?.getTime() ?? 0) > before;
    });

    expect(
      advanced.length,
      'characters behind a batch of unparseable profiles must still be reached',
    ).toBeGreaterThan(0);
  });
});
