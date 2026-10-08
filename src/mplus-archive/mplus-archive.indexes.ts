import type { IndexDescription } from 'mongodb';

/** Indexes on `mplus_archive_runs`. */
export const MPLUS_ARCHIVE_RUNS_INDEXES: IndexDescription[] = [
  // World run ids are unique on their own; the season prefix keeps the
  // collection partitionable by season like every other one here.
  { key: { season: 1, keystoneRunId: 1 }, name: 'archive_run_identity', unique: true },
  { key: { season: 1, score: -1 }, name: 'archive_run_board' },
  { key: { season: 1, region: 1, score: -1 }, name: 'archive_run_region_board' },
  { key: { season: 1, 'dungeon.id': 1, score: -1 }, name: 'archive_run_dungeon_board' },
  { key: { season: 1, rosterKeys: 1 }, name: 'archive_run_roster' },
];

/** Indexes on `mplus_archive_characters`. */
export const MPLUS_ARCHIVE_CHARACTERS_INDEXES: IndexDescription[] = [
  { key: { season: 1, key: 1 }, name: 'archive_character_identity', unique: true },
  { key: { season: 1, mythicScore: -1 }, name: 'archive_score_board' },
  { key: { season: 1, region: 1, mythicScore: -1 }, name: 'archive_score_region_board' },
  { key: { nameKey: 1, realmSlug: 1 }, name: 'archive_character_lookup' },
];
