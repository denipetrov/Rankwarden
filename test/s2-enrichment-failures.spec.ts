import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { World, type WorldPlayer } from './support/world.js';

/**
 * Independent verification of the ISSUE-1 fix, from the angles the original
 * case did not reach.
 *
 * The first ISSUE-1 test only broke the *summary* half: both profile routes
 * share one corruption key in the fake, and the specializations schema is
 * entirely optional, so a payload that fails the profile schema still parses as
 * specs. The character therefore cleared the queue on its second pass by way of
 * a successful specs fetch. These cases break both halves, so the fix has to
 * hold without that escape route.
 */
describe('S2 — enrichment failure handling', () => {
  let harness: TestApp;
  let db: Db;
  let enrichment: ProfileEnrichmentService;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const profileKey = (player: WorldPlayer) =>
    `character:${player.realmSlug}/${encodeURIComponent(player.name.toLowerCase())}`;

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us'], players: 30, seed: 11 }), {
      PROFILE_BATCH_SIZE: '10',
      PROFILE_RETRY_BACKOFF_MS: '900000',
    });
    db = harness.app.get(MongoService).db;
    enrichment = harness.app.get(ProfileEnrichmentService);
    await harness.app.get(LeaderboardService).sweep();

    // Enrich everyone first, so a test that clears one character's timestamps
    // makes it the only candidate with an absent field. Without this baseline
    // every character ties on the sort and the batch is an arbitrary sample.
    for (let pass = 0; pass < 4; pass += 1) await enrichment.run();
    expect(await characters().countDocuments({ profileFetchedAt: { $exists: false } })).toBe(0);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('clears the queue when BOTH halves are permanently unparseable', async () => {
    const victims = [...harness.world.players.values()].slice(0, 10);
    for (const victim of victims) {
      // Fails characterProfileSchema (no id/level/race/realm) *and*
      // characterSpecializationsSchema (specializations is not an array), so
      // neither half can succeed and stamp the timestamp for the other.
      harness.world.corrupt(victim.region, profileKey(victim), { specializations: 'not-an-array' });
    }
    const victimIds = victims.map((victim) => victim.id);
    await characters().updateMany(
      { characterId: { $in: victimIds } },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '', profileStatus: '' } },
    );
    // Everyone else is freshly enriched and not yet due, so make them due too —
    // otherwise "the queue made progress" would be vacuous.
    await characters().updateMany(
      { characterId: { $nin: victimIds } },
      { $set: { specsFetchedAt: new Date(Date.now() - 30 * 86_400_000) } },
    );

    // The first pass is entirely theirs: they are the only characters with both
    // halves absent, so they sort ahead of every dated one and fill the batch.
    const first = await enrichment.run();
    expect(first!.failed).toBe(10);
    expect(first!.enriched).toBe(0);

    // Every one of them now carries a stamp on the half that failed, so they no
    // longer sort strictly ahead of everyone else.
    expect(
      await characters().countDocuments({
        characterId: { $in: victimIds },
        profileFetchedAt: { $exists: false },
      }),
      'the failing half must be stamped',
    ).toBe(0);
    expect(
      await characters().countDocuments({
        characterId: { $in: victimIds },
        profileStatus: 'unparseable',
      }),
      'a schema failure is flagged rather than silently retried',
    ).toBe(10);

    // The point of the fix: healthy characters are now reached. Before it, the
    // same ten were re-selected on every pass and this stayed at zero forever.
    let enriched = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      const result = await enrichment.run();
      enriched += result!.enriched;
    }
    expect(enriched, 'characters behind the failing set must be enriched').toBeGreaterThan(0);
  });

  it('keeps unparseable distinct from missing, and preserves stored data', async () => {
    const [player] = [...harness.world.players.values()].slice(10, 11);

    // Already enriched by the baseline, so there is real data to preserve.
    const healthy = await characters().findOne({ characterId: player.id });
    expect(healthy!.profileStatus).toBe('ok');
    expect(healthy!.profile?.race).toBeDefined();

    // Now the payload goes bad while the character still exists.
    harness.world.corrupt(player.region, profileKey(player), { specializations: 'not-an-array' });
    await characters().updateOne(
      { characterId: player.id },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '' } },
    );
    await enrichment.run();
    await enrichment.run();

    const after = await characters().findOne({ characterId: player.id });

    expect(after!.profileStatus, 'a live character is never reported as deleted').toBe(
      'unparseable',
    );
    expect(after!.profile?.race, 'stale-but-real data beats nothing').toEqual(
      healthy!.profile.race,
    );
    expect(after!.profile?.spec).toBeDefined();
  });

  it('treats a transient failure as transient, not as unparseable', async () => {
    const [player] = [...harness.world.players.values()].slice(11, 12);
    harness.world.fail(player.region, profileKey(player), 503);

    await characters().updateOne(
      { characterId: player.id },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '', profileStatus: '' } },
    );
    await enrichment.run();

    const after = await characters().findOne({ characterId: player.id });

    expect(after!.profileStatus, 'a 503 says nothing about the character').toBeUndefined();
    expect(after!.profileFetchedAt, 'the failing half is still stamped').toBeInstanceOf(Date);

    // Backdated to just short of the TTL, so it returns after the backoff
    // rather than waiting the full week.
    const age = Date.now() - (after!.profileFetchedAt as Date).getTime();
    expect(age, 'a transient failure is backdated, not stamped as now').toBeGreaterThan(0);

    harness.world.clearFailures();
  });

  it('ISSUE-2 — the hero talent tree falls back to the active loadout', async () => {
    const player = [...harness.world.players.values()].find(
      (candidate) => candidate.spec.heroTrees.length > 0,
    )!;

    const specs = harness.world.specsPayload(player);
    const { active_hero_talent_tree: omitted, ...rest } = specs;
    expect(omitted, 'the fixture must normally send it').toBeDefined();

    // The fake keys both halves of the profile on one path, so a corruption
    // cannot target the specializations route alone. This payload therefore has
    // to satisfy *both* schemas: a full profile document, plus the loadouts and
    // the active spec, and without the optional top-level tree. Zod strips the
    // keys each schema does not know about.
    harness.world.corrupt(player.region, profileKey(player), {
      ...harness.world.profilePayload(player),
      specializations: rest.specializations,
      active_specialization: rest.active_specialization,
    });

    await characters().updateOne(
      { characterId: player.id },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '', profileStatus: '' } },
    );
    await enrichment.run(true);
    harness.world.corrupt(player.region, profileKey(player), undefined);

    const after = await characters().findOne({ characterId: player.id });
    const loadouts = (after!.profile?.talentLoadouts ?? []) as {
      spec: { id: number };
      heroTalentTree: { id: number; name: string } | null;
    }[];
    const active = loadouts.find((loadout) => loadout.spec.id === after!.profile?.spec?.id);

    expect(active?.heroTalentTree, 'the loadout carries the answer').toBeTruthy();
    expect(
      after!.profile?.heroTalentTree,
      'so the stored tree must not be null just because the top-level field was absent',
    ).toEqual(active!.heroTalentTree);
  });
});
