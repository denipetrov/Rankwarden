/**
 * The kinds of run that get their own correlation id.
 *
 * Rankwarden's own vocabulary. The correlation itself — `withRunId`,
 * `RunLogger`, `currentRunKind` — comes from `@denipetrov/spirit-link/logging`,
 * which takes any string; this list is what keeps the values consistent here,
 * and what the quota budgets map a run to its consumer by.
 */
export const RunKind = {
  Sweep: 'sweep',
  Enrich: 'enrich',
  Archive: 'archive',
  Mplus: 'mplus',
  MplusArchive: 'mplus-archive',
  MplusSeason: 'mplus-season',
  RaidCatalogue: 'raid-catalogue',
  RaidRankings: 'raid-rankings',
  Snapshot: 'snapshot',
  Transition: 'transition',
} as const;
export type RunKind = (typeof RunKind)[keyof typeof RunKind];
