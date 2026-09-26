import type { INestApplication } from '@nestjs/common';

import { IngestionCoordinator } from '../../src/common/ingestion-coordinator.service.js';

/** A job the coordinator can be told is running. */
export type HeldJob = 'sweep' | 'enrichment' | 'mplus' | 'archive' | 'mplusArchive';

const holds = new Set<() => Promise<void>>();

/**
 * Marks `job` as running on the coordinator until the returned function is
 * called, without running anything.
 *
 * What a yield case needs: a higher-priority job starting *during* a lower one,
 * at a point the lower one cannot see coming (`FakeRaiderIo.beforeServe` is how
 * the point is chosen). Releasing ends the hold as a real job ending would, so
 * a released sweep or enrichment counts towards the warm-up exactly as the real
 * one does.
 *
 * Every hold is tracked, because one that is never released leaves the
 * coordinator busy for the rest of the file: every later pass yields, and the
 * failure it causes names nothing to do with the cause. `releaseAllHolds` in an
 * `afterEach` rules that out.
 */
export function holdActive(app: INestApplication, job: HeldJob): () => Promise<void> {
  const coordinator = app.get(IngestionCoordinator);
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const work = () => blocked;

  const running = {
    sweep: () => coordinator.duringSweep(work),
    enrichment: () => coordinator.duringEnrichment(work),
    mplus: () => coordinator.duringMplus(work),
    archive: () => coordinator.duringArchive(work),
    mplusArchive: () => coordinator.duringMplusArchive(work),
  }[job]();

  const release = async () => {
    holds.delete(release);
    unblock();
    await running;
  };
  holds.add(release);

  return release;
}

/** Releases every hold still in place. For an `afterEach`. */
export async function releaseAllHolds(): Promise<void> {
  await Promise.all([...holds].map((release) => release()));
}
