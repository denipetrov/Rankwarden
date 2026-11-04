import type { IndexDescription } from 'mongodb';

/** Indexes on `mplus_runs`. */
export const MPLUS_RUNS_INDEXES: IndexDescription[] = [
  { key: { season: 1, region: 1, keystoneRunId: 1 }, name: 'run_identity', unique: true },
  // The headline board: a season's best runs in a region, index-ordered.
  { key: { season: 1, region: 1, score: -1 }, name: 'run_board' },
  // The same board filtered to one dungeon, which is how the UI slices it.
  { key: { season: 1, region: 1, 'dungeon.id': 1, score: -1 }, name: 'run_dungeon_board' },
  // "Every run this character appears in", answered from the flat mirror
  // rather than by scanning nested roster documents.
  { key: { season: 1, region: 1, rosterKeys: 1 }, name: 'run_roster' },
  // Pruning reads this: runs the latest pass did not refresh have fallen
  // off the leaderboard.
  { key: { season: 1, region: 1, fetchedAt: 1 }, name: 'run_freshness' },
];

/** Indexes on `mplus_characters`. */
export const MPLUS_CHARACTERS_INDEXES: IndexDescription[] = [
  // One canonical key rather than a four-field tuple, so the merge read and
  // the orphan cleanup can both `$in` on it.
  { key: { season: 1, key: 1 }, name: 'mplus_character_identity', unique: true },
  // The front end's sort: best M+ players in a region.
  { key: { season: 1, region: 1, mythicScore: -1 }, name: 'mplus_score_board' },
  // Cross-region lookup by name, mirroring `character_lookup` on the PvP side.
  { key: { nameKey: 1, realmSlug: 1 }, name: 'mplus_character_lookup' },
  // Name search: an anchored prefix on the folded name, answered as an index
  // range — find({ searchName: { $regex: '^biba' } }).limit(100).
  { key: { searchName: 1 }, name: 'mplus_character_search' },
  // The board filtered to one class, spec or role, still index-ordered by
  // score: across every region, and within one. Without them a filtered page
  // reads the whole board and discards what does not match.
  { key: { season: 1, 'profile.classId': 1, mythicScore: -1 }, name: 'mplus_class_board' },
  { key: { season: 1, 'profile.specId': 1, mythicScore: -1 }, name: 'mplus_spec_board' },
  { key: { season: 1, 'profile.role': 1, mythicScore: -1 }, name: 'mplus_role_board' },
  {
    key: { season: 1, region: 1, 'profile.classId': 1, mythicScore: -1 },
    name: 'mplus_class_region_board',
  },
  {
    key: { season: 1, region: 1, 'profile.specId': 1, mythicScore: -1 },
    name: 'mplus_spec_region_board',
  },
  {
    key: { season: 1, region: 1, 'profile.role': 1, mythicScore: -1 },
    name: 'mplus_role_region_board',
  },
];

/** Indexes on `mplus_affixes`. */
export const MPLUS_AFFIXES_INDEXES: IndexDescription[] = [
  { key: { id: 1 }, name: 'affix_identity', unique: true },
];
