import type { IndexDescription } from 'mongodb';

/** Indexes on `mplus_seasons`. */
export const MPLUS_SEASONS_INDEXES: IndexDescription[] = [
  { key: { slug: 1 }, name: 'season_identity', unique: true },
  { key: { expansionId: 1 }, name: 'season_expansion' },
];

/** Indexes on `mplus_dungeons`. */
export const MPLUS_DUNGEONS_INDEXES: IndexDescription[] = [
  { key: { id: 1 }, name: 'dungeon_identity', unique: true },
];

/** Indexes on `mplus_season_state`. */
export const MPLUS_SEASON_STATE_INDEXES: IndexDescription[] = [
  { key: { region: 1 }, name: 'mplus_state_region', unique: true },
];

/** Indexes on `mplus_season_transitions`. */
export const MPLUS_SEASON_TRANSITIONS_INDEXES: IndexDescription[] = [
  { key: { season: 1, region: 1 }, name: 'mplus_transition_identity', unique: true },
  { key: { purgedAt: -1 }, name: 'mplus_transition_recent' },
];
