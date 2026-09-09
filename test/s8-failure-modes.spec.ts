import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { postJson } from './support/http.js';
import { World, type WorldPlayer } from './support/world.js';

/**
 * S8 — failure modes that reach the data rather than the transport.
 *
 * Transport classification is covered against a real listener in
 * `blizzard-http.spec.ts`. What is left is what the service *does* with a
 * failure: which ones mark a character missing, which ones a payload can talk
 * the ingester into storing, and what the push endpoint does while a sweep owns
 * the same documents.
 */
describe('S8 — failure modes', () => {
  /** The defaults the service uses, restated so the arithmetic below is legible. */
  const SUMMARY_TTL_MS = 604_800_000;
  const RETRY_BACKOFF_MS = 900_000;

  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    PROFILE_REQUESTS_PER_SECOND: '2000',
  };

  let harness: TestApp;
  let db: Db;
  let world: World;
  let baseUrl: string;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const enrichment = () => harness.app.get(ProfileEnrichmentService);

  const keyFor = (player: WorldPlayer) =>
    `character:${player.realmSlug}/${encodeURIComponent(player.name.toLowerCase())}`;

  /** A us player with a stored document, reset to unenriched. */
  const freshVictim = async (): Promise<WorldPlayer> => {
    const stored = await characters().findOne({
      region: 'us',
      profileStatus: { $ne: 'missing' },
      characterId: { $nin: usedIds },
    });
    usedIds.push(stored!.characterId);
    await characters().updateOne(
      { _id: stored!._id },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '', profileStatus: '' } },
    );

    return world.player(stored!.characterId);
  };
  const usedIds: number[] = [];

  beforeAll(async () => {
    world = World.seed({ regions: ['us'], players: 40, seed: 8, multiBracketShare: 0.4 });
    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    baseUrl = await harness.listen();
    await harness.settle();
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S8.12 — a 403 on a profile is a failure, not a missing character', async () => {
    const denied = await freshVictim();
    const gone = await freshVictim();

    world.fail('us', keyFor(denied), 403);
    world.deleteCharacter(gone.id);

    try {
      await enrichment().run();
    } finally {
      world.clearFailures();
    }

    const stored = await characters().findOne({ region: 'us', characterId: denied.id });
    const missing = await characters().findOne({ region: 'us', characterId: gone.id });

    // Only a 404 means the character no longer exists. A revoked or expired
    // token 403s every request, and mislabelling that as "missing" would blank
    // thousands of profiles for the length of a credential incident.
    expect(missing!.profileStatus, 'a 404 really is missing').toBe('missing');
    expect(stored!.profileStatus, 'a 403 is not').not.toBe('missing');
  });

  it('S8.12b — and the 403 is retried on the next pass rather than waiting out the TTL', async () => {
    const denied = await characters().findOne({
      region: 'us',
      profileStatus: { $nin: ['ok', 'missing'] },
    });
    expect(denied, 'the previous case left a failed character behind').toBeTruthy();

    // A transient failure backdates the timestamp to just short of the TTL, so
    // the character comes back round after the short backoff instead of being
    // parked for a week.
    const age = Date.now() - (denied!.profileFetchedAt as Date).getTime();
    expect(age, 'stamped in the past, not now').toBeGreaterThan(0);
  });

  it('ISSUE-5 — an empty 200 body is transient, not permanently unreadable', async () => {
    const victim = await freshVictim();
    // An empty body used to travel on as `''` and fail at the zod boundary,
    // where `recordFailure` reads a ZodError as deterministic and parks the
    // character for the full TTL — seven days on the summary half. A gateway
    // shedding load answers 200 with nothing, which is as transient as the 502
    // the same gateway would otherwise have sent, so the client now rejects it
    // as a transport failure and it comes back after the short backoff.
    world.corrupt('us', keyFor(victim), '');

    try {
      await enrichment().run();
    } finally {
      world.clearFailures();
    }

    const stored = await characters().findOne({ region: 'us', characterId: victim.id });
    const stampedAt = (stored!.profileFetchedAt as Date).getTime();

    // No status: only a genuine schema failure earns `unparseable`, and calling
    // a gateway blip that would misreport an incident as payload drift.
    expect(stored!.profileStatus).toBeUndefined();

    // Backdated to just short of the TTL, so the character is due again after
    // PROFILE_RETRY_BACKOFF_MS rather than a week from now.
    const dueIn = stampedAt + SUMMARY_TTL_MS - Date.now();
    expect(dueIn, 'due again within the backoff, not the full TTL').toBeLessThan(
      RETRY_BACKOFF_MS + 5_000,
    );
    expect(dueIn, 'and not immediately, or it would starve the queue').toBeGreaterThan(0);
  });

  it('S8.18 — out-of-range numeric values are accepted as-is, deliberately', async () => {
    // The schema takes any integer, and there is no clamping anywhere. That is
    // a decision rather than an oversight — Blizzard is the source of truth for
    // a rating, and a service that silently rewrote one would make a wrong
    // board impossible to diagnose. Pinned so changing it has to be deliberate.
    const player = [...world.players.values()].find((entry) => entry.region === 'us')!;

    world.corrupt('us', '3v3', {
      season: { id: world.season('us').id },
      name: '3v3',
      bracket: { id: 1, type: '3V3' },
      entries: [
        {
          character: {
            id: player.id,
            name: player.name,
            realm: { id: player.realmId, slug: player.realmSlug },
          },
          faction: { type: player.faction },
          rank: 0,
          rating: -50,
          season_match_statistics: { played: 1, won: 0, lost: 1 },
        },
      ],
    });

    try {
      const result = await harness.app.get(LeaderboardService).sweep();
      expect(result!.jobs.find((job) => job.bracket === '3v3')!.entries).toBe(1);
    } finally {
      world.clearFailures();
    }

    const stored = await characters().findOne({ region: 'us', characterId: player.id });
    expect(stored!.brackets['3v3'].rating, 'stored exactly as served').toBe(-50);
    expect(stored!.brackets['3v3'].rank).toBe(0);

    // And the §9.3 guard still does its job: a negative rating never reaches a
    // board, because every board query is `$gt: 0`.
    expect(
      await characters().countDocuments({
        region: 'us',
        characterId: player.id,
        'ratings.3v3': { $gt: 0 },
      }),
      'a negative rating is stored but never ordered onto a board',
    ).toBe(0);
  });

  it('S8.21 — a push during a sweep is refused with 409 and writes nothing', async () => {
    const stored = await characters().findOne({ region: 'us' });
    const payload = {
      seasonId: stored!.seasonId,
      region: 'us',
      characterId: stored!.characterId,
      characterName: 'Should-Not-Land',
      realmId: stored!.realmId,
      realmSlug: stored!.realmSlug,
      faction: stored!.faction ?? null,
      brackets: { '2v2': { rank: 1, rating: 3000, played: 1, won: 1, lost: 0 } },
    };

    const response = await harness.app
      .get(IngestionCoordinator)
      .duringSweep(() => postJson(baseUrl, '/characters/sync', payload));

    expect(response.status).toBe(409);
    const after = await characters().findOne({ region: 'us', characterId: stored!.characterId });
    expect(after!.characterName, 'nothing was written').toBe(stored!.characterName);
  });

  it('S8.21b — but it is a check, not a lock, and the documented limitation holds', async () => {
    // A sweep starting immediately after the check still overwrites the push.
    // Worth stating explicitly: anyone reading the 409 could reasonably assume
    // it makes the two mutually exclusive, and it does not.
    const stored = await characters().findOne({ region: 'us' });
    const accepted = await postJson(baseUrl, '/characters/sync', {
      seasonId: stored!.seasonId,
      region: 'us',
      characterId: stored!.characterId,
      characterName: 'Pushed-Then-Swept',
      realmId: stored!.realmId,
      realmSlug: stored!.realmSlug,
      faction: stored!.faction ?? null,
      brackets: stored!.brackets,
    });
    expect(accepted.status).toBe(200);

    await harness.app.get(LeaderboardService).sweep();

    const after = await characters().findOne({ region: 'us', characterId: stored!.characterId });
    expect(after!.characterName, 'the sweep is authoritative and rewrites what the push set').toBe(
      world.player(stored!.characterId).name,
    );
  });

  it('S8.25 — the push endpoint is unauthenticated, which is a decision to revisit', async () => {
    // Named so it fails the day authentication is added, forcing that change to
    // be deliberate rather than silent. It is a documented limitation rather
    // than a bug, but it is a mutating write open on the configured port.
    const stored = await characters().findOne({ region: 'us' });

    const response = await postJson(baseUrl, '/characters/sync', {
      seasonId: stored!.seasonId,
      region: 'us',
      characterId: stored!.characterId,
      characterName: stored!.characterName,
      realmId: stored!.realmId,
      realmSlug: stored!.realmSlug,
      faction: stored!.faction ?? null,
      brackets: stored!.brackets,
    });

    expect(response.status, 'no credentials, and it is accepted').toBe(200);
  });
});
