import type { MplusDungeonRef } from '../mplus/entities/mplus-run.entity.js';
import type {
  MplusRepresentationRegion,
  MplusSpecRepresentationDocument,
  MplusSpecShare,
} from './entities/mplus-spec-representation.entity.js';

/**
 * Roster slots of one class and spec in one region and dungeon, as the
 * aggregation returns them.
 */
export interface MplusSpecTally {
  region: string;
  dungeonId: number;
  classId: number;
  className: string;
  /** Null for a slot Raider.io reported without a spec. */
  specId: number | null;
  specName: string | null;
  role: string | null;
  count: number;
}

/** Runs stored in one region and dungeon, with the dungeon's details. */
export interface MplusRunCount {
  region: string;
  dungeon: MplusDungeonRef;
  runs: number;
}

/** Two decimals: enough to rank specs apart, without binary noise on a board. */
function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 10_000) / 100 : 0;
}

/**
 * One representation document from a set of tallies: one region or all of them,
 * one dungeon or all of them.
 *
 * Tallies are merged by class and spec first, so a spec counted in several
 * regions or dungeons is one entry.
 */
export function toRepresentation(input: {
  season: string;
  seasonId: number | null;
  region: MplusRepresentationRegion;
  dungeon: MplusDungeonRef | null;
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
    dungeonId: input.dungeon?.id ?? null,
    dungeon: input.dungeon,
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
 * Every document for a season. For each region with runs, and then for `all`:
 * one over every dungeon, then one per dungeon, by dungeon id.
 *
 * A region or dungeon with no runs stored gets no document rather than an
 * empty one: an empty document would read as "no spec was played" rather than
 * "nothing was read".
 */
export function representationsOf(input: {
  season: string;
  seasonId: number | null;
  source: MplusSpecRepresentationDocument['source'];
  runCounts: readonly MplusRunCount[];
  tallies: readonly MplusSpecTally[];
  computedAt: Date;
}): MplusSpecRepresentationDocument[] {
  const regions = [...new Set(input.runCounts.map((count) => count.region))].sort();
  if (regions.length === 0) return [];

  const scopes: { region: MplusRepresentationRegion; inScope: (region: string) => boolean }[] = [
    ...regions.map((region) => ({
      region: region as MplusRepresentationRegion,
      inScope: (candidate: string) => candidate === region,
    })),
    { region: 'all', inScope: () => true },
  ];
  const documents: MplusSpecRepresentationDocument[] = [];

  for (const scope of scopes) {
    const counts = input.runCounts.filter((count) => scope.inScope(count.region));
    const tallies = input.tallies.filter((tally) => scope.inScope(tally.region));
    const dungeons = new Map<number, MplusDungeonRef>();

    for (const count of counts) dungeons.set(count.dungeon.id, count.dungeon);

    documents.push(
      toRepresentation({
        ...input,
        region: scope.region,
        dungeon: null,
        runs: counts.reduce((sum, count) => sum + count.runs, 0),
        tallies,
      }),
    );

    for (const dungeon of [...dungeons.values()].sort((left, right) => left.id - right.id)) {
      documents.push(
        toRepresentation({
          ...input,
          region: scope.region,
          dungeon,
          runs: counts
            .filter((count) => count.dungeon.id === dungeon.id)
            .reduce((sum, count) => sum + count.runs, 0),
          tallies: tallies.filter((tally) => tally.dungeonId === dungeon.id),
        }),
      );
    }
  }

  return documents;
}
