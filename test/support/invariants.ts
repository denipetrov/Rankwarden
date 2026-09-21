import { expect } from 'vitest';
import type { Db } from 'mongodb';

import {
  EXCLUDED_BRACKETS,
  RATING_FAMILIES,
  isIngestableBracket,
  ratingFamilyOf,
} from '../../src/blizzard/blizzard.constants.js';
import type { World } from './world.js';
import { CHARACTERS_COLLECTION } from '../../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../../src/leaderboard/entities/rating.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../../src/representation/entities/spec-representation.entity.js';
import { ARCHIVE_ENTRIES_COLLECTION } from '../../src/archive/entities/archive.entity.js';
import {
  MPLUS_CHARACTERS_COLLECTION,
  mplusCharacterKey,
} from '../../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../../src/mplus/entities/mplus-run.entity.js';
import { MPLUS_AFFIXES_COLLECTION } from '../../src/mplus/entities/mplus-affix.entity.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
} from '../../src/mplus-archive/entities/mplus-archive.entity.js';
import {
  MPLUS_DUNGEONS_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
} from '../../src/mplus-season/entities/mplus-season.entity.js';

/** The six indexes `characters` must carry, whatever the bracket count. */
export const CHARACTER_INDEXES = [
  '_id_',
  'character_identity',
  'character_lookup',
  'bracket_ratings',
  'enrichment_specs_staleness',
  'enrichment_profile_staleness',
];

/**
 * Properties that must hold after *any* sequence of operations.
 *
 * Called at the end of every integration scenario. These catch far more than
 * the per-case assertions do — a cleanup that removes the wrong thing shows up
 * here even in a test written about something else entirely.
 */
export async function expectInvariants(db: Db, world?: World): Promise<void> {
  await expectRatingsMirrorBrackets(db);
  await expectNoExcludedBrackets(db);
  await expectNoOrphanRatingRows(db);
  await expectRowsInCorrectFamily(db);
  await expectIdentityUniqueness(db);
  await expectIndexInventory(db);
  await expectRepresentationCoherent(db);
  await expectEveryCharacterTyped(db);
  await expectMplusScoreMatchesRuns(db);
  await expectMplusRunsReferenceKnownAffixes(db);
  await expectNoAnonymisedMplusCharacters(db);
  await expectMplusCharacterKeysWellFormed(db);
  // The same three rules, held against the archive: an archived board that
  // does not add up is as wrong as a live one, and nothing re-reads it to notice.
  await expectMplusScoreMatchesRuns(db, MPLUS_ARCHIVE_CHARACTERS_COLLECTION);
  await expectMplusRunsReferenceKnownAffixes(db, MPLUS_ARCHIVE_RUNS_COLLECTION);
  await expectNoAnonymisedMplusCharacters(db, MPLUS_ARCHIVE_CHARACTERS_COLLECTION);
  await expectMplusArchiveMarkersMatchRows(db);
  await expectMplusSeasonsReferenceKnownDungeons(db);

  // Every check above is self-consistency: the data agreeing with itself. Pass
  // the world and I7 also checks it against what was actually served, which is
  // the only one of the ten that can catch a suite that is perfectly coherent
  // and uniformly wrong.
  if (world) await expectStoredMatchesWorld(db, world);
}

/** I1 — `ratings` is the indexed mirror of `brackets`; drift is invisible. */
export async function expectRatingsMirrorBrackets(db: Db): Promise<void> {
  const drifted = await db
    .collection(CHARACTERS_COLLECTION)
    .aggregate([
      {
        $project: {
          characterId: 1,
          bracketKeys: { $objectToArray: { $ifNull: ['$brackets', {}] } },
          ratingKeys: { $objectToArray: { $ifNull: ['$ratings', {}] } },
        },
      },
      {
        $project: {
          characterId: 1,
          mismatched: {
            $ne: [
              { $sortArray: { input: '$bracketKeys.k', sortBy: 1 } },
              { $sortArray: { input: '$ratingKeys.k', sortBy: 1 } },
            ],
          },
          ratingsWrong: {
            $anyElementTrue: {
              $map: {
                input: '$bracketKeys',
                in: {
                  $ne: [
                    '$$this.v.rating',
                    {
                      $getField: {
                        field: '$$this.k',
                        input: { $arrayToObject: '$ratingKeys' },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      { $match: { $or: [{ mismatched: true }, { ratingsWrong: true }] } },
      { $limit: 5 },
    ])
    .toArray();

  expect(drifted, 'I1: ratings must mirror brackets exactly').toEqual([]);
}

/** I2 — no aggregate bracket anywhere, in any collection. */
export async function expectNoExcludedBrackets(db: Db): Promise<void> {
  for (const bracket of EXCLUDED_BRACKETS) {
    const onCharacters = await db
      .collection(CHARACTERS_COLLECTION)
      .countDocuments({ [`brackets.${bracket}`]: { $exists: true } });
    expect(onCharacters, `I2: ${bracket} must never be stored on characters`).toBe(0);

    for (const family of RATING_FAMILIES) {
      const rows = await db.collection(RATING_COLLECTIONS[family]).countDocuments({ bracket });
      expect(rows, `I2: ${bracket} must never reach ${RATING_COLLECTIONS[family]}`).toBe(0);
    }
  }
}

/** I3 — every rating row points at a character that exists. */
export async function expectNoOrphanRatingRows(db: Db): Promise<void> {
  const known = new Set(
    (
      await db
        .collection(CHARACTERS_COLLECTION)
        .find({}, { projection: { seasonId: 1, region: 1, characterId: 1 } })
        .toArray()
    ).map((doc) => `${doc.seasonId}:${doc.region}:${doc.characterId}`),
  );

  for (const family of RATING_FAMILIES) {
    const rows = await db
      .collection(RATING_COLLECTIONS[family])
      .find({}, { projection: { seasonId: 1, region: 1, characterId: 1 } })
      .toArray();

    const orphans = rows
      .map((row) => `${row.seasonId}:${row.region}:${row.characterId}`)
      .filter((key) => !known.has(key));

    expect(orphans.slice(0, 5), `I3: orphan rows in ${RATING_COLLECTIONS[family]}`).toEqual([]);
  }
}

/** I4 — a completed sweep leaves nobody ranked in nothing. */
export async function expectNoUnrankedCharacters(db: Db): Promise<void> {
  const unranked = await db.collection(CHARACTERS_COLLECTION).countDocuments({ brackets: {} });

  expect(unranked, 'I4: characters ranking in nothing must be deleted').toBe(0);
}

/** I5 — every row sits in the collection its bracket resolves to. */
export async function expectRowsInCorrectFamily(db: Db): Promise<void> {
  for (const family of RATING_FAMILIES) {
    const brackets = await db.collection(RATING_COLLECTIONS[family]).distinct('bracket');
    const misfiled = brackets.filter((bracket) => ratingFamilyOf(String(bracket)) !== family);

    expect(misfiled, `I5: wrong family in ${RATING_COLLECTIONS[family]}`).toEqual([]);
  }
}

/** I6 — identity uniqueness, verified rather than trusted to the index. */
export async function expectIdentityUniqueness(db: Db): Promise<void> {
  const duplicateCharacters = await db
    .collection(CHARACTERS_COLLECTION)
    .aggregate([
      { $group: { _id: { s: '$seasonId', r: '$region', c: '$characterId' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 5 },
    ])
    .toArray();

  expect(duplicateCharacters, 'I6: duplicate character identity').toEqual([]);

  for (const family of RATING_FAMILIES) {
    const duplicates = await db
      .collection(RATING_COLLECTIONS[family])
      .aggregate([
        {
          $group: {
            _id: { s: '$seasonId', r: '$region', b: '$bracket', c: '$characterId' },
            n: { $sum: 1 },
          },
        },
        { $match: { n: { $gt: 1 } } },
        { $limit: 5 },
      ])
      .toArray();

    expect(duplicates, `I6: duplicate rows in ${RATING_COLLECTIONS[family]}`).toEqual([]);
  }
}

/**
 * I7 — what is stored is what the fake served.
 *
 * The other nine invariants are self-consistency checks: the mirror agrees with
 * `brackets`, rows point at characters that exist, the snapshot arithmetic adds
 * up. All of them hold just as well over data that is uniformly wrong. This is
 * the only one that reaches back to the source of truth, so it is the one that
 * catches a mapper dropping a field or a prune removing the wrong bracket.
 *
 * Compared per bracket rather than in aggregate: a count that matches while the
 * membership differs is exactly the failure a total would hide.
 */
export async function expectStoredMatchesWorld(db: Db, world: World): Promise<void> {
  for (const region of world.regions) {
    const seasonId = world.season(region).id;

    for (const bracket of world.brackets(region).filter(isIngestableBracket)) {
      const family = ratingFamilyOf(bracket);
      if (!family) continue;

      const served = new Map(
        world
          .ladder(region, seasonId, bracket)
          .entries.map((entry) => [entry.character.id, entry.rating]),
      );

      const rows = await db
        .collection(RATING_COLLECTIONS[family])
        .find({ seasonId, region, bracket }, { projection: { characterId: 1, rating: 1 } })
        .toArray();

      const stored = new Map(rows.map((row) => [row.characterId as number, row.rating as number]));

      expect(
        [...stored.keys()].sort((a, b) => a - b),
        `I7: ${region}/${bracket} membership differs from the ladder served`,
      ).toEqual([...served.keys()].sort((a, b) => a - b));

      const wrong = [...served].filter(([id, rating]) => stored.get(id) !== rating);
      expect(
        wrong.slice(0, 5),
        `I7: ${region}/${bracket} ratings differ from those served`,
      ).toEqual([]);
    }
  }

  // The mirror on the character document has to agree with the same source, or
  // a board read from `ratings` disagrees with one read from the flat rows.
  const characters = await db
    .collection(CHARACTERS_COLLECTION)
    .find({}, { projection: { region: 1, characterId: 1, ratings: 1 } })
    .toArray();

  const mismatched = characters.filter((doc) => {
    const player = world.players.get(doc.characterId as number);
    if (!player || player.region !== doc.region) return false;

    return Object.entries((doc.ratings ?? {}) as Record<string, number>).some(
      ([bracket, rating]) => player.ratings.get(bracket) !== rating,
    );
  });

  expect(
    mismatched.slice(0, 5).map((doc) => doc.characterId),
    'I7: mirrored ratings differ from those served',
  ).toEqual([]);
}

/** I8 — the index inventory does not grow with the bracket count. */
export async function expectIndexInventory(db: Db): Promise<void> {
  const names = (await db.collection(CHARACTERS_COLLECTION).indexes())
    .map((index) => index.name)
    .sort();

  expect(names, 'I8: characters must hold exactly six indexes').toEqual(
    [...CHARACTER_INDEXES].sort(),
  );
}

/** I9 — the arithmetic inside a representation snapshot is self-consistent. */
export async function expectRepresentationCoherent(db: Db): Promise<void> {
  const snapshots = await db.collection(SPEC_REPRESENTATION_COLLECTION).find({}).toArray();

  for (const snapshot of snapshots) {
    const specs = (snapshot.specs ?? []) as {
      count: number;
      share: number;
      heroTalentsClassified: number;
      heroTalents: { count: number; share: number }[];
    }[];
    const label = `I9: ${snapshot.family}/${snapshot.minRating} ${snapshot.region}`;

    expect(snapshot.classified, `${label} classified <= total`).toBeLessThanOrEqual(snapshot.total);

    const counted = specs.reduce((sum, spec) => sum + spec.count, 0);
    expect(counted, `${label} spec counts must sum to classified`).toBe(snapshot.classified);

    for (const spec of specs) {
      const heroes = spec.heroTalents.reduce((sum, tree) => sum + tree.count, 0);
      expect(heroes, `${label} hero counts must sum to heroTalentsClassified`).toBe(
        spec.heroTalentsClassified,
      );
      expect(spec.heroTalentsClassified, `${label} hero classified <= count`).toBeLessThanOrEqual(
        spec.count,
      );
    }

    if (specs.length > 0 && snapshot.classified > 0) {
      const shares = specs.reduce((sum, spec) => sum + spec.share, 0);
      // Shares are stored at 4dp, so ~40 specs can drift by about 0.002.
      expect(Math.abs(shares - 1), `${label} shares must sum to 1`).toBeLessThan(0.005);
    }
  }
}

/**
 * I11 — every character carries a type.
 *
 * Enrichment selects by type, so an untyped character is not an oddity but a
 * silent drop-out: it is never selected again and never counted as due.
 */
export async function expectEveryCharacterTyped(db: Db): Promise<void> {
  const untyped = await db
    .collection(CHARACTERS_COLLECTION)
    .find({ characterType: { $nin: ['PvP', 'M+'] } }, { projection: { characterId: 1 } })
    .limit(5)
    .toArray();

  expect(
    untyped.map((doc) => doc.characterId),
    'I11: every character must carry a characterType',
  ).toEqual([]);
}

/** I10 — archive rows read correctly with `characters` gone entirely. */
export async function expectArchiveSelfContained(db: Db): Promise<void> {
  const before = await db
    .collection(ARCHIVE_ENTRIES_COLLECTION)
    .find({})
    .sort({ _id: 1 })
    .toArray();
  const characters = await db.collection(CHARACTERS_COLLECTION).find({}).toArray();

  await db.collection(CHARACTERS_COLLECTION).deleteMany({});
  const after = await db.collection(ARCHIVE_ENTRIES_COLLECTION).find({}).sort({ _id: 1 }).toArray();

  if (characters.length > 0) await db.collection(CHARACTERS_COLLECTION).insertMany(characters);

  expect(after, 'I10: archive must not depend on characters').toEqual(before);
}

/**
 * I12 — a Mythic+ character's score is the sum of the runs stored on it.
 *
 * The stat the front end sorts on, recomputed from the document's own
 * `dungeonRuns`. It also catches the subtler error: two entries for the same
 * dungeon, which would double-count that dungeon's score and put a character
 * above people who actually out-performed them.
 */
export async function expectMplusScoreMatchesRuns(
  db: Db,
  collection: string = MPLUS_CHARACTERS_COLLECTION,
): Promise<void> {
  const characters = await db.collection(collection).find({}).toArray();

  for (const character of characters) {
    const runs = (character.dungeonRuns ?? []) as { dungeon: { id: number }; score: number }[];
    const label = `I12: ${character.key}`;

    const dungeonIds = runs.map((run) => run.dungeon.id);
    expect(new Set(dungeonIds).size, `${label} one entry per dungeon`).toBe(dungeonIds.length);

    expect(character.dungeonsCovered, `${label} dungeonsCovered counts the runs`).toBe(runs.length);

    const summed = Math.round(runs.reduce((sum, run) => sum + run.score, 0) * 10) / 10;
    expect(character.mythicScore, `${label} mythicScore sums the stored runs`).toBe(summed);
  }
}

/**
 * I13 — every affix a run references is stored.
 *
 * The whole point of keeping affix names out of the run documents is that the
 * id resolves. An id with no row is a run whose affixes cannot be rendered, and
 * nothing else in the system would notice.
 */
export async function expectMplusRunsReferenceKnownAffixes(
  db: Db,
  collection: string = MPLUS_RUNS_COLLECTION,
): Promise<void> {
  const referenced = (await db.collection(collection).distinct('affixIds')) as number[];

  if (referenced.length === 0) return;

  const known = new Set((await db.collection(MPLUS_AFFIXES_COLLECTION).distinct('id')) as number[]);
  const missing = referenced.filter((id) => !known.has(id));

  expect(missing, 'I13: every affix a run references must be stored').toEqual([]);
}

/**
 * I14 — no anonymised character reaches `mplus_characters`.
 *
 * Every anonymised character upstream carries `id: 0` and the placeholder realm
 * `anonymous`, so one that got through would not be one character but all of
 * them folded together, holding one player's runs under another's name. The run
 * roster is where they belong, and this asserts they are still there.
 */
export async function expectNoAnonymisedMplusCharacters(
  db: Db,
  collection: string = MPLUS_CHARACTERS_COLLECTION,
): Promise<void> {
  const leaked = await db
    .collection(collection)
    .find({ $or: [{ realmSlug: 'anonymous' }, { rioCharacterId: 0 }] }, { projection: { key: 1 } })
    .limit(5)
    .toArray();

  expect(
    leaked.map((doc) => doc.key),
    'I14: anonymised characters must stay out of mplus_characters',
  ).toEqual([]);
}

/**
 * I17 - a character's `key` is the one its own identity fields build.
 *
 * The key is the collection's identity, the join to `mplus_runs.rosterKeys`, and
 * what the orphan cleanup deletes by. A key that has drifted from the fields
 * beside it makes a character unreachable by lookup and, worse, invisible to the
 * cleanup - it would survive every pass forever.
 */
export async function expectMplusCharacterKeysWellFormed(db: Db): Promise<void> {
  const characters = await db.collection(MPLUS_CHARACTERS_COLLECTION).find({}).toArray();

  for (const character of characters) {
    expect(character.key, `I17: ${character.key} must match its identity fields`).toBe(
      mplusCharacterKey(character.region, character.realmSlug, character.characterName),
    );
    expect(character.nameKey, `I17: ${character.key} nameKey is the lowercased name`).toBe(
      character.characterName.toLowerCase(),
    );
  }
}

/**
 * I18 - every stored Mythic+ character is still named by a surviving run.
 *
 * The cleanup's postcondition. A character no run lists is one that has fallen
 * off the leaderboard entirely; left behind it would sit on the score board
 * forever, never refreshed and never removed, because nothing else would ever
 * look at it again.
 *
 * Deliberately NOT the converse: a character's `dungeonRuns` may reference a run
 * that has since been pruned, because a dungeon's best run is kept once earned
 * even after it drops out of the ingested window. That dangling reference is by
 * design - see `MplusCharacterDocument`.
 */
export async function expectNoOrphanMplusCharacters(db: Db): Promise<void> {
  const live = new Set(
    (await db.collection(MPLUS_RUNS_COLLECTION).distinct('rosterKeys')) as string[],
  );

  if (live.size === 0) return;

  const orphans = (await db.collection(MPLUS_CHARACTERS_COLLECTION).find({}).toArray())
    .filter((character) => !live.has(character.key as string))
    .map((character) => character.key);

  expect(orphans, 'I18: every mplus character must be named by a surviving run').toEqual([]);
}

/**
 * I15 — `mplus_runs` rows read correctly with `mplus_characters` gone.
 *
 * Self-contained for the same reason `archive_entries` is: a run is a
 * historical fact and must keep reading after the character is renamed,
 * transferred, or pruned off the board.
 */
export async function expectMplusRunsSelfContained(db: Db): Promise<void> {
  const before = await db.collection(MPLUS_RUNS_COLLECTION).find({}).sort({ _id: 1 }).toArray();
  const characters = await db.collection(MPLUS_CHARACTERS_COLLECTION).find({}).toArray();

  await db.collection(MPLUS_CHARACTERS_COLLECTION).deleteMany({});
  const after = await db.collection(MPLUS_RUNS_COLLECTION).find({}).sort({ _id: 1 }).toArray();

  if (characters.length > 0) {
    await db.collection(MPLUS_CHARACTERS_COLLECTION).insertMany(characters);
  }

  expect(after, 'I15: mplus_runs must not depend on mplus_characters').toEqual(before);
}

/**
 * I16 — a run's `rosterKeys` mirror its named roster members exactly.
 *
 * The flat mirror is what the `run_roster` index serves, so drift between it
 * and the roster it mirrors means a character lookup silently misses runs they
 * are in, or claims runs they are not.
 */
export async function expectMplusRosterKeysMirrorRoster(db: Db): Promise<void> {
  const runs = await db.collection(MPLUS_RUNS_COLLECTION).find({}).toArray();

  for (const run of runs) {
    const roster = (run.roster ?? []) as {
      region: string;
      realmSlug: string;
      characterName: string;
      anonymized: boolean;
    }[];
    const expected = roster
      .filter((member) => !member.anonymized)
      .map((member) => mplusCharacterKey(member.region, member.realmSlug, member.characterName));

    expect(run.rosterKeys, `I16: run ${run.keystoneRunId} rosterKeys mirror its roster`).toEqual(
      expected,
    );
  }
}

/**
 * I19 - a `complete` archive marker describes exactly the rows stored for it.
 *
 * The marker is what makes the archive run once, so a marker claiming more than
 * is stored makes the shortfall permanent: the season is never read again. The
 * rows are written before the marker for exactly this reason; this is what
 * catches the order being reversed.
 *
 * Checked per region, since each region's share is settled on its own, and
 * then for the season as a whole, so no run sits outside the regions recorded.
 *
 * Only `complete` markers. A `partial` or `incomplete` season still has a region
 * to read, whose rows the marker does not claim yet.
 */
export async function expectMplusArchiveMarkersMatchRows(db: Db): Promise<void> {
  const seasons = await db
    .collection(MPLUS_SEASONS_COLLECTION)
    .find({ 'archive.status': 'complete' })
    .toArray();

  for (const season of seasons) {
    const archive = season.archive as {
      runs: number;
      characters: number;
      regions?: Record<string, { runs: number; characters: number }>;
    };

    expect(archive.regions, `I19: ${season.slug} records its regions`).toBeDefined();

    for (const [region, entry] of Object.entries(archive.regions ?? {})) {
      const label = `I19: archive of ${season.slug} in ${region}`;
      const filter = { season: season.slug, region };

      expect(
        await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).countDocuments(filter),
        `${label} runs`,
      ).toBe(entry.runs);
      expect(
        await db.collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION).countDocuments(filter),
        `${label} characters`,
      ).toBe(entry.characters);
    }

    expect(
      await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).countDocuments({ season: season.slug }),
      `I19: ${season.slug} stores no run outside the regions it records`,
    ).toBe(archive.runs);
  }
}

/**
 * I20 - every dungeon a catalogued season lists is in the dungeon catalogue.
 *
 * Seasons reference dungeons by id so the details are stored once; an id with
 * no document is a season whose dungeons cannot be named.
 */
export async function expectMplusSeasonsReferenceKnownDungeons(db: Db): Promise<void> {
  const referenced = (await db
    .collection(MPLUS_SEASONS_COLLECTION)
    .distinct('dungeonIds')) as number[];

  if (referenced.length === 0) return;

  const known = new Set(
    (await db.collection(MPLUS_DUNGEONS_COLLECTION).distinct('id')) as number[],
  );

  expect(
    referenced.filter((id) => !known.has(id)),
    'I20: every dungeon a season lists must be catalogued',
  ).toEqual([]);
}
