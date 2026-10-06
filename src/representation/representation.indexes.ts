import type { IndexDescription } from 'mongodb';

/** Indexes on `spec_representation`. */
export const SPEC_REPRESENTATION_INDEXES: IndexDescription[] = [
  {
    key: { date: 1, seasonId: 1, region: 1, family: 1, minRating: 1 },
    name: 'snapshot_identity',
    unique: true,
  },
  // The visualisation's own query: one series over time.
  { key: { seasonId: 1, region: 1, family: 1, minRating: 1, date: 1 }, name: 'series' },
];
