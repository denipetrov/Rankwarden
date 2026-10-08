import type { IndexDescription } from 'mongodb';

/** Indexes on `season_state`. */
export const SEASON_STATE_INDEXES: IndexDescription[] = [
  { key: { region: 1 }, name: 'state_region', unique: true },
];

/** Indexes on `season_transitions`. */
export const SEASON_TRANSITIONS_INDEXES: IndexDescription[] = [
  // The once-only guard: a season/region pair is purged at most once.
  { key: { seasonId: 1, region: 1 }, name: 'transition_identity', unique: true },
  { key: { purgedAt: -1 }, name: 'transition_recent' },
];
