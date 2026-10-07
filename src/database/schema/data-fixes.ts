import type { Db } from 'mongodb';

import { EXCLUDED_BRACKETS } from '../../blizzard/blizzard.constants.js';
import { CHARACTERS_COLLECTION } from '../collections.js';

/**
 * A one-off repair to data an earlier build wrote. Returns a line describing
 * what it changed, or null when there was nothing to do — which is every run
 * after the first, and every run on a database created by a current build.
 */
export type DataFix = (db: Db) => Promise<string | null>;

/**
 * Stamps a type on characters stored before the field existed. The ladder
 * sweep was the only way a character could get into the collection then, so
 * every one of them is `PvP`.
 *
 * This has to finish before any scheduler starts: enrichment selects by type,
 * and an untyped character would simply never be picked up again.
 */
export const backfillCharacterType: DataFix = async (db) => {
  const backfilled = await db
    .collection(CHARACTERS_COLLECTION)
    .updateMany({ characterType: { $exists: false } }, { $set: { characterType: 'PvP' } });

  return backfilled.modifiedCount > 0
    ? `Backfilled characterType "PvP" on ${backfilled.modifiedCount} characters`
    : null;
};

/**
 * Clears aggregate brackets left by earlier builds. Their sweep jobs no longer
 * run, so ordinary pruning would never reach them and the misleading ratings
 * would sit in the data forever.
 */
export const purgeExcludedBrackets: DataFix = async (db) => {
  const characters = db.collection(CHARACTERS_COLLECTION);
  const unset: Record<string, ''> = {};
  for (const bracket of EXCLUDED_BRACKETS) {
    unset[`brackets.${bracket}`] = '';
    unset[`ratings.${bracket}`] = '';
  }

  // `best` was an earlier attempt at the all-specs board; the flat per-family
  // collections replaced it, so clear it out too.
  const purged = await characters.updateMany(
    {
      $or: [
        ...EXCLUDED_BRACKETS.map((bracket) => ({ [`brackets.${bracket}`]: { $exists: true } })),
        { best: { $exists: true } },
      ],
    },
    { $unset: { ...unset, best: '' } },
  );

  if (purged.modifiedCount === 0) return null;

  // Anyone who ranked only in an aggregate bracket now ranks in nothing.
  const removed = await characters.deleteMany({ brackets: {} });

  return (
    `Purged aggregate brackets from ${purged.modifiedCount} characters ` +
    `(${removed.deletedCount} left unranked and deleted)`
  );
};

/** Every fix, in the order they are applied. Each is safe to run repeatedly. */
export const DATA_FIXES: readonly DataFix[] = [backfillCharacterType, purgeExcludedBrackets];
