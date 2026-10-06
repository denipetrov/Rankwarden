import type { IndexDescription } from 'mongodb';

/** Indexes on `mplus_spec_representation`. */
export const MPLUS_SPEC_REPRESENTATION_INDEXES: IndexDescription[] = [
  // Also the front end's filter: season, then region, then dungeon — null
  // for every dungeon together.
  {
    key: { season: 1, region: 1, dungeonId: 1 },
    name: 'mplus_representation_key',
    unique: true,
  },
  { key: { region: 1, season: 1 }, name: 'mplus_representation_by_region' },
];

/**
 * The unique index before documents were split by dungeon: one per season and
 * region. Every per-dungeon document would collide with it, so it is dropped at
 * boot before the indexes above are built.
 */
export const LEGACY_MPLUS_SPEC_REPRESENTATION_INDEX = 'mplus_representation_identity';
