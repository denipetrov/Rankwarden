import type {
  MplusRepresentationRegion,
  MplusSpecRepresentationDocument,
  MplusSpecShare,
} from './entities/mplus-spec-representation.entity.js';

/** Roster slots of one class and spec in one region, as the aggregation returns them. */
export interface MplusSpecTally {
  region: string;
  classId: number;
  className: string;
  /** Null for a slot Raider.io reported without a spec. */
  specId: number | null;
  specName: string | null;
  role: string | null;
  count: number;
}

/** Two decimals: enough to rank specs apart, without binary noise on a board. */
function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 10_000) / 100 : 0;
}

/**
 * One representation document from the tallies of one region, or of every
 * region merged (`region: 'all'`).
 *
 * Tallies are merged by class and spec first, so a spec counted in several
 * regions — or in several tally rows of one region — is one entry.
 */
export function toRepresentation(input: {
  season: string;
  seasonId: number | null;
  region: MplusRepresentationRegion;
  source: MplusSpecRepresentationDocument['source'];
  runs: number;
  tallies: readonly MplusSpecTally[];
  computedAt: Date;
}): MplusSpecRepresentationDocument {
  const merged = new Map<string, MplusSpecTally>();
  let slots = 0;

  for (const tally of input.tallies) {
    slots += tally.count;
    if (tally.specId === null) continue;

    const key = `${tally.classId}:${tally.specId}`;
    const existing = merged.get(key);

    if (existing) existing.count += tally.count;
    else merged.set(key, { ...tally });
  }

  const classified = [...merged.values()].reduce((sum, tally) => sum + tally.count, 0);
  const roles: Record<string, number> = {};

  for (const tally of merged.values()) {
    const role = tally.role ?? 'unknown';
    roles[role] = (roles[role] ?? 0) + tally.count;
  }

  const specs: MplusSpecShare[] = [...merged.values()]
    .map((tally) => ({
      classId: tally.classId,
      className: tally.className,
      specId: tally.specId as number,
      specName: tally.specName ?? String(tally.specId),
      role: tally.role ?? 'unknown',
      count: tally.count,
      percent: percentOf(tally.count, classified),
      rolePercent: percentOf(tally.count, roles[tally.role ?? 'unknown']),
    }))
    // Ties by spec id, so equal counts always list in the same order.
    .sort((left, right) => right.count - left.count || left.specId - right.specId);

  return {
    season: input.season,
    seasonId: input.seasonId,
    region: input.region,
    source: input.source,
    runs: input.runs,
    slots,
    classified,
    roles,
    specs,
    computedAt: input.computedAt,
  };
}

/**
 * Every document for a season: one per region with runs, then `all`.
 *
 * A region with no runs stored gets no document rather than an empty one: an
 * empty document would read as "no spec was played" rather than "not read".
 */
export function representationsOf(input: {
  season: string;
  seasonId: number | null;
  source: MplusSpecRepresentationDocument['source'];
  runsByRegion: ReadonlyMap<string, number>;
  tallies: readonly MplusSpecTally[];
  computedAt: Date;
}): MplusSpecRepresentationDocument[] {
  const regions = [...input.runsByRegion.keys()].sort();
  const documents = regions.map((region) =>
    toRepresentation({
      ...input,
      region: region as MplusRepresentationRegion,
      runs: input.runsByRegion.get(region) ?? 0,
      tallies: input.tallies.filter((tally) => tally.region === region),
    }),
  );

  if (documents.length === 0) return [];

  return [
    ...documents,
    toRepresentation({
      ...input,
      region: 'all',
      runs: [...input.runsByRegion.values()].reduce((sum, runs) => sum + runs, 0),
      tallies: input.tallies,
    }),
  ];
}
