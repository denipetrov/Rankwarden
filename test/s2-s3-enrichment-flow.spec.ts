import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { SweepEvents } from '../src/common/events/sweep-events.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { CORE_BRACKETS, World } from './support/world.js';

const BATCH = 500;
const SEEDED = 800;

/**
 * S2 / S3 — how an enrichment pass behaves as a whole, rather than what it
 * writes.
 *
 * The per-character mapping is covered in `s2-s3-enrichment.spec.ts`. What is
 * left is everything about the pass itself: it yields to a sweep between
 * characters, refuses to run twice at once, respects its concurrency limit, and
 * drains a backlog larger than one batch without re-fetching anyone early.
 *
 * Three core ladders rather than eighty-five, because every case here is about
 * the eight hundred characters, not the breadth of the bracket list.
 */
describe('S2 / S3 — enrichment passes', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    PROFILE_ENRICHMENT_ENABLED: 'true',
    PROFILE_BATCH_SIZE: String(BATCH),
    PROFILE_CONCURRENCY: '4',
    // Effectively unlimited: this file is about the pass, and throttling 1,600
    // requests through the default bucket would add two minutes of waiting
    // without asserting anything the rate-limiter unit tests do not already.
    PROFILE_REQUESTS_PER_SECOND: '2000',
    // Long enough that nothing ages out mid-file; staleness is simulated by
    // backdating the stored timestamps, which is deterministic.
    PROFILE_SUMMARY_TTL_MS: String(30 * 86_400_000),
    PROFILE_SPECS_TTL_MS: String(30 * 86_400_000),
  };

  let harness: TestApp;
  let db: Db;
  let world: World;
  let completions = 0;
  /** Slightly under what was seeded: the World shares one id across regions. */
  let population = 0;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const enrichment = () => harness.app.get(ProfileEnrichmentService);
  const unenriched = () => characters().countDocuments({ profileFetchedAt: { $exists: false } });
  const profileRequests = () =>
    harness.blizzard.requests.filter((request) =>
      request.path.startsWith('profile/wow/character/'),
    );

  const sweep = async () => {
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
    await harness.settle();
  };

  beforeAll(async () => {
    world = World.seed({
      regions: ['us', 'eu'],
      players: SEEDED,
      seed: 23,
      brackets: [...CORE_BRACKETS],
      multiBracketShare: 0.2,
    });
    // Everyone on a published ladder. The World's default is a spec-split
    // bracket matching the character, and none of those are published here, so
    // without this most of the population would never be ingested at all.
    for (const [index, player] of [...world.players.values()].entries()) {
      world.setRating(player.id, CORE_BRACKETS[index % CORE_BRACKETS.length], 1500 + (index % 900));
    }

    population = world.players.size;
    expect(population).toBeGreaterThan(2 * BATCH - 300);

    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    harness.app.get(SweepEvents).completed$.subscribe(() => {
      completions += 1;
    });
    await harness.settle();

    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S3.3 — sweep completion fires once and drives one pass that does real work', async () => {
    expect(completions, 'one completion per sweep, not one per bracket').toBe(1);

    // It fires after the coordinator has released, so the pass it triggers must
    // not immediately defer and return null — which would look identical from
    // outside and quietly leave every newcomer unenriched.
    expect(await characters().countDocuments()).toBe(population);
    expect(
      await characters().countDocuments({ profileFetchedAt: { $exists: true } }),
      'the automatic onlyNew pass enriched a full batch',
    ).toBe(BATCH);
  });

  it('S3.4 — a backlog larger than the batch leaves the rest for the next pass', async () => {
    const leftover = population - BATCH;
    expect(await unenriched(), `${population} newcomers, ${BATCH} to a batch`).toBe(leftover);

    const stranded = await characters()
      .find({ profileFetchedAt: { $exists: false } }, { projection: { characterId: 1, region: 1 } })
      .toArray();
    harness.blizzard.reset();

    const pass = await enrichment().run();

    // Exactly the leftovers, and nothing else: an absent timestamp sorts ahead
    // of every date, and everything already enriched is inside its TTL. Nobody
    // is revisited while a newcomer is still waiting.
    expect(pass!.selected, 'the leftovers and only the leftovers').toBe(leftover);
    expect(pass!.enriched).toBe(leftover);
    expect(await unenriched(), 'and the backlog is drained').toBe(0);
    expect(stranded.length).toBe(leftover);
  });

  it('S2.13 — the pass fetched each character at most once', async () => {
    const summaries = profileRequests().filter(
      (request) => !request.path.endsWith('/specializations'),
    );
    const distinct = new Set(summaries.map((request) => request.path));

    expect(summaries.length, 'one summary request per selected character').toBe(population - BATCH);
    expect(distinct.size, 'and no character selected twice inside one pass').toBe(summaries.length);

    // Everyone has now been enriched at least once, which is the property the
    // batching exists to reach rather than any particular per-pass count.
    expect(await unenriched()).toBe(0);
  });

  it('S2.9 — concurrency stays inside its configured limit', async () => {
    await characters().updateMany({}, { $unset: { specsFetchedAt: '' } });
    harness.blizzard.reset();
    harness.blizzard.delayMs = 2;

    try {
      const pass = await enrichment().run();
      expect(pass!.selected).toBeGreaterThan(0);
    } finally {
      harness.blizzard.delayMs = 0;
    }

    expect(
      harness.blizzard.peakInFlight,
      `PROFILE_CONCURRENCY is 4, peak was ${harness.blizzard.peakInFlight}`,
    ).toBeLessThanOrEqual(4);
    expect(harness.blizzard.peakInFlight, 'and the limit was actually reached').toBe(4);
  });

  it('S2.12 — a second run while one is in flight is refused without cost', async () => {
    await characters().updateMany({}, { $unset: { specsFetchedAt: '' } });
    harness.blizzard.delayMs = 2;

    try {
      const first = enrichment().run();
      const second = await enrichment().run();

      expect(second, 'the re-entrant call declines rather than queueing').toBeNull();
      expect((await first)!.selected).toBeGreaterThan(0);
    } finally {
      harness.blizzard.delayMs = 0;
    }
  });

  it('S2.11 — a sweep starting mid-pass stops the pass between characters', async () => {
    await characters().updateMany({}, { $unset: { profileFetchedAt: '', specsFetchedAt: '' } });
    harness.blizzard.reset();

    // The flag is flipped from inside the fake, on a request count, so the
    // hand-off happens at a known point rather than whenever a timer lands.
    const coordinator = harness.app.get(IngestionCoordinator);
    const original = harness.blizzard.get.bind(harness.blizzard);
    let releaseSweep = () => {};
    const sweepHeld = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    let seen = 0;

    harness.blizzard.get = async (region, path, options) => {
      seen += 1;
      if (seen === 20) void coordinator.duringSweep(() => sweepHeld);

      return original(region, path, options);
    };

    let pass;
    try {
      pass = await enrichment().run();
    } finally {
      harness.blizzard.get = original;
      releaseSweep();
    }

    expect(pass!.selected).toBe(BATCH);
    expect(pass!.enriched, 'the characters already under way finish').toBeGreaterThan(0);
    expect(pass!.skipped, 'the rest stand down for the sweep').toBeGreaterThan(0);
    expect(pass!.enriched + pass!.skipped).toBe(pass!.selected);

    // A skipped character keeps its absent timestamps, so it sorts first next
    // time. Half-writing one would leave it looking enriched and never revisited.
    const half = await characters().countDocuments({
      profileFetchedAt: { $exists: true },
      specsFetchedAt: { $exists: false },
    });
    expect(half, 'a character is either untouched or has both halves').toBe(0);
  });

  it('S3.8 — newcomers in one region are fetched against that region', async () => {
    await characters().updateMany(
      {},
      { $set: { profileFetchedAt: new Date(), specsFetchedAt: new Date() } },
    );
    harness.blizzard.reset();

    const added = world.addPlayers(12, { region: 'eu', brackets: ['3v3'] });
    // The sweep's own completion drives the pass, so this is the real path
    // rather than a hand-called one.
    await sweep();

    expect(
      await characters().countDocuments({ region: 'eu', profileFetchedAt: { $exists: false } }),
      'the newcomers were picked up automatically',
    ).toBe(0);

    const summaries = profileRequests().filter(
      (request) => !request.path.endsWith('/specializations'),
    );
    expect(summaries.length, 'only the new characters were fetched').toBe(added.length);
    expect(
      new Set(profileRequests().map((request) => request.region)),
      'no request went to the wrong host',
    ).toEqual(new Set(['eu']));
    expect(
      new Set(profileRequests().map((request) => request.namespace)),
      'and under the region-scoped profile namespace',
    ).toEqual(new Set(['profile-eu']));
  });

  it('S3.9 — a rename follows through to the next enrichment request', async () => {
    const player = [...world.players.values()].find(
      (candidate) => candidate.region === 'us' && candidate.ratings.size > 0 && !candidate.deleted,
    )!;
    const before = await characters().countDocuments({ region: 'us', characterId: player.id });
    expect(before).toBe(1);

    world.rename(player.id, 'Rënamed');
    player.faction = player.faction === 'HORDE' ? 'ALLIANCE' : 'HORDE';
    await sweep();

    const stored = await characters().findOne({ region: 'us', characterId: player.id });
    expect(
      await characters().countDocuments({ region: 'us', characterId: player.id }),
      'the same document, not a second one keyed on the name',
    ).toBe(1);
    expect(stored!.characterName).toBe('Rënamed');
    expect(stored!.faction).toBe(player.faction);

    // The request has to use the new name percent-encoded and lowercased. The
    // old one would 404 and mark a perfectly healthy character missing.
    await characters().updateOne(
      { region: 'us', characterId: player.id },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '' } },
    );
    harness.blizzard.reset();
    await enrichment().run();

    const encoded = encodeURIComponent('Rënamed'.toLowerCase());
    expect(
      profileRequests().some((request) => request.path.endsWith(`/${encoded}`)),
      'the profile was requested under the new name',
    ).toBe(true);

    const after = await characters().findOne({ region: 'us', characterId: player.id });
    expect(after!.profileStatus, 'and it resolved rather than 404ing').toBe('ok');
  });

  it('S3.6 — a character that goes missing recovers once the TTL passes', async () => {
    const player = [...world.players.values()].find(
      (candidate) => candidate.region === 'us' && candidate.ratings.size > 0 && !candidate.deleted,
    )!;

    world.deleteCharacter(player.id);
    await characters().updateOne(
      { region: 'us', characterId: player.id },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '' } },
    );
    await enrichment().run();

    const missing = await characters().findOne({ region: 'us', characterId: player.id });
    expect(missing!.profileStatus, 'a 404 is recorded, not treated as a failure').toBe('missing');

    // Transferred back, or the 404 was Blizzard having a bad day.
    world.player(player.id).deleted = false;
    await characters().updateOne(
      { region: 'us', characterId: player.id },
      { $set: { profileFetchedAt: new Date(0), specsFetchedAt: new Date(0) } },
    );
    await enrichment().run();

    const recovered = await characters().findOne({ region: 'us', characterId: player.id });
    expect(recovered!.profileStatus, 'and the status flips back on its own').toBe('ok');
    expect(recovered!.profile?.spec?.id).toBeTruthy();
  });
});
