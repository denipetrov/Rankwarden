import type { IndexDescription } from 'mongodb';

import {
  ARCHIVE_BRACKETS_INDEXES,
  ARCHIVE_ENTRIES_INDEXES,
  ARCHIVE_SEASONS_INDEXES,
} from '../../archive/archive.indexes.js';
import { RATING_FAMILIES } from '../../blizzard/blizzard.constants.js';
import {
  CHARACTERS_INDEXES,
  LEGACY_CHARACTERS_INDEX_PATTERN,
  RATING_INDEXES,
  SUPERSEDED_CHARACTERS_INDEXES,
} from '../../leaderboard/leaderboard.indexes.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_INDEXES,
  MPLUS_ARCHIVE_RUNS_INDEXES,
} from '../../mplus-archive/mplus-archive.indexes.js';
import {
  LEGACY_MPLUS_SPEC_REPRESENTATION_INDEX,
  MPLUS_SPEC_REPRESENTATION_INDEXES,
} from '../../mplus-representation/mplus-representation.indexes.js';
import {
  MPLUS_DUNGEONS_INDEXES,
  MPLUS_SEASONS_INDEXES,
  MPLUS_SEASON_STATE_INDEXES,
  MPLUS_SEASON_TRANSITIONS_INDEXES,
} from '../../mplus-season/mplus-season.indexes.js';
import {
  MPLUS_AFFIXES_INDEXES,
  MPLUS_CHARACTERS_INDEXES,
  MPLUS_RUNS_INDEXES,
} from '../../mplus/mplus.indexes.js';
import { GUILDS_INDEXES, RAIDS_INDEXES } from '../../raid/raid.indexes.js';
import { SPEC_REPRESENTATION_INDEXES } from '../../representation/representation.indexes.js';
import { SEASON_STATE_INDEXES, SEASON_TRANSITIONS_INDEXES } from '../../season/season.indexes.js';
import {
  ARCHIVE_BRACKETS_COLLECTION,
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
  CHARACTERS_COLLECTION,
  GUILDS_COLLECTION,
  MPLUS_AFFIXES_COLLECTION,
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
  MPLUS_CHARACTERS_COLLECTION,
  MPLUS_DUNGEONS_COLLECTION,
  MPLUS_RUNS_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
  MPLUS_SEASON_STATE_COLLECTION,
  MPLUS_SEASON_TRANSITIONS_COLLECTION,
  MPLUS_SPEC_REPRESENTATION_COLLECTION,
  QUOTA_WINDOWS_COLLECTION,
  RAIDS_COLLECTION,
  RATING_COLLECTIONS,
  SEASON_STATE_COLLECTION,
  SEASON_TRANSITIONS_COLLECTION,
  SPEC_REPRESENTATION_COLLECTION,
} from '../collections.js';

/** What one collection must look like before the service may run against it. */
export interface CollectionSchema {
  collection: string;
  indexes: readonly IndexDescription[];
  /** Index names an earlier build created and a later one replaced. */
  retiredIndexes?: ReadonlySet<string>;
  /** The same, where the retired names follow a pattern rather than a list. */
  retiredIndexPattern?: RegExp;
}

/**
 * The whole database structure this service depends on: every collection, and
 * every index on it.
 *
 * This is the one place the two halves meet — the names from `collections.ts`
 * and the indexes each folder declares in its `*.indexes.ts`. Applying it
 * (`SchemaService.apply`) and checking a database against it
 * (`SchemaService.verify`) both read from here, so the deploy step and the
 * running service cannot disagree about what "ready" means.
 *
 * A collection declared in `collections.ts` and missing here fails a unit test.
 * It would not fail in production: MongoDB creates a collection on its first
 * insert, without any index, and the service's own database user is not allowed
 * to build one afterwards.
 */
export const DATABASE_SCHEMA: readonly CollectionSchema[] = [
  {
    collection: CHARACTERS_COLLECTION,
    indexes: CHARACTERS_INDEXES,
    retiredIndexes: SUPERSEDED_CHARACTERS_INDEXES,
    retiredIndexPattern: LEGACY_CHARACTERS_INDEX_PATTERN,
  },
  ...RATING_FAMILIES.map((family) => ({
    collection: RATING_COLLECTIONS[family],
    indexes: RATING_INDEXES,
  })),
  { collection: SPEC_REPRESENTATION_COLLECTION, indexes: SPEC_REPRESENTATION_INDEXES },
  { collection: SEASON_STATE_COLLECTION, indexes: SEASON_STATE_INDEXES },
  { collection: SEASON_TRANSITIONS_COLLECTION, indexes: SEASON_TRANSITIONS_INDEXES },
  { collection: ARCHIVE_ENTRIES_COLLECTION, indexes: ARCHIVE_ENTRIES_INDEXES },
  { collection: ARCHIVE_SEASONS_COLLECTION, indexes: ARCHIVE_SEASONS_INDEXES },
  { collection: ARCHIVE_BRACKETS_COLLECTION, indexes: ARCHIVE_BRACKETS_INDEXES },
  { collection: MPLUS_RUNS_COLLECTION, indexes: MPLUS_RUNS_INDEXES },
  { collection: MPLUS_CHARACTERS_COLLECTION, indexes: MPLUS_CHARACTERS_INDEXES },
  { collection: MPLUS_AFFIXES_COLLECTION, indexes: MPLUS_AFFIXES_INDEXES },
  {
    collection: MPLUS_SPEC_REPRESENTATION_COLLECTION,
    indexes: MPLUS_SPEC_REPRESENTATION_INDEXES,
    retiredIndexes: new Set([LEGACY_MPLUS_SPEC_REPRESENTATION_INDEX]),
  },
  { collection: MPLUS_SEASONS_COLLECTION, indexes: MPLUS_SEASONS_INDEXES },
  { collection: MPLUS_DUNGEONS_COLLECTION, indexes: MPLUS_DUNGEONS_INDEXES },
  { collection: MPLUS_SEASON_STATE_COLLECTION, indexes: MPLUS_SEASON_STATE_INDEXES },
  {
    collection: MPLUS_SEASON_TRANSITIONS_COLLECTION,
    indexes: MPLUS_SEASON_TRANSITIONS_INDEXES,
  },
  { collection: MPLUS_ARCHIVE_RUNS_COLLECTION, indexes: MPLUS_ARCHIVE_RUNS_INDEXES },
  {
    collection: MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
    indexes: MPLUS_ARCHIVE_CHARACTERS_INDEXES,
  },
  { collection: RAIDS_COLLECTION, indexes: RAIDS_INDEXES },
  { collection: GUILDS_COLLECTION, indexes: GUILDS_INDEXES },
  // Keyed by `_id` alone, so it has no index of its own. Declared all the same,
  // so that every collection the service writes to is one the schema step made.
  { collection: QUOTA_WINDOWS_COLLECTION, indexes: [] },
];
