import { expect } from 'vitest';
import type { Db } from 'mongodb';

import {
  EXCLUDED_BRACKETS,
  RATING_FAMILIES,
  ratingFamilyOf,
} from '../../src/blizzard/blizzard.constants.js';
import { CHARACTERS_COLLECTION } from '../../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../../src/leaderboard/entities/rating.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../../src/representation/entities/spec-representation.entity.js';
import { ARCHIVE_ENTRIES_COLLECTION } from '../../src/archive/entities/archive.entity.js';

/** The six indexes `characters` must carry, whatever the bracket count. */
export const CHARACTER_INDEXES = [
  '_id_',
  'character_identity',
  'character_lookup',
  'bracket_ratings',
  'specs_staleness',
  'profile_staleness',
];

/**
 * Properties that must hold after *any* sequence of operations.
 *
 * Called at the end of every integration scenario. These catch far more than
 * the per-case assertions do — a cleanup that removes the wrong thing shows up
 * here even in a test written about something else entirely.
 */
export async function expectInvariants(db: Db): Promise<void> {
  await expectRatingsMirrorBrackets(db);
  await expectNoExcludedBrackets(db);
  await expectNoOrphanRatingRows(db);
  await expectRowsInCorrectFamily(db);
  await expectIdentityUniqueness(db);
  await expectRepresentationCoherent(db);
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
