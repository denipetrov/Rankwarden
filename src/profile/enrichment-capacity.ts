import { HOUR_MS } from '../common/quota/quota-budget.service.js';

export interface CapacityInputs {
  population: number;
  specsTtlMs: number;
  summaryTtlMs: number;
  /** Requests an hour enrichment may plan: the quota share. */
  enrichmentShare: number;
  /** Characters per run, at most. */
  batchSize: number;
  intervalMs: number;
  oldestRefreshAgeMs: number | null;
}

export interface CapacityProjection {
  demandPerHour: number;
  capacityPerHour: number;
  bindingConstraint: 'quota share' | 'batch size';
  feasible: boolean;
  maxSustainablePopulation: number;
  behind: boolean;
}

/**
 * How far behind the specs TTL the stalest refresh may drift before the queue
 * counts as falling behind rather than merely busy. One TTL is normal — a
 * character refreshed a day ago is due, not late — so the line sits at two.
 */
const BEHIND_AFTER_TTLS = 2;

/**
 * Whether enrichment can keep every TTL at the current population, and if not,
 * where the ceiling is.
 *
 * In steady state every character needs its specs once per specs TTL and its
 * summary once per summary TTL, so demand scales linearly with the population.
 * Capacity is the smaller of two limits, and naming which one binds is most of
 * the value: raising the quota share does nothing while the batch size binds,
 * and the reverse.
 *
 * Kept as a pure function so the arithmetic can be checked without a database.
 */
export function projectCapacity(inputs: CapacityInputs): CapacityProjection {
  const { population, specsTtlMs, summaryTtlMs, enrichmentShare, batchSize, intervalMs } = inputs;

  // Requests one character needs per hour to stay inside both TTLs.
  const requestsPerCharacterHour = HOUR_MS / specsTtlMs + HOUR_MS / summaryTtlMs;
  const demandPerHour = population * requestsPerCharacterHour;

  // A character selected in steady state always needs its specs, and its
  // summary one time in (summary TTL / specs TTL) — so on average it costs
  // slightly more than one request.
  const requestsPerSelection = 1 + specsTtlMs / summaryTtlMs;
  const batchBound = batchSize * (HOUR_MS / intervalMs) * requestsPerSelection;

  const capacityPerHour = Math.min(enrichmentShare, batchBound);

  return {
    demandPerHour: Math.round(demandPerHour),
    capacityPerHour: Math.round(capacityPerHour),
    bindingConstraint: batchBound < enrichmentShare ? 'batch size' : 'quota share',
    feasible: demandPerHour <= capacityPerHour,
    maxSustainablePopulation: Math.floor(capacityPerHour / requestsPerCharacterHour),
    behind:
      inputs.oldestRefreshAgeMs !== null &&
      inputs.oldestRefreshAgeMs > specsTtlMs * BEHIND_AFTER_TTLS,
  };
}
