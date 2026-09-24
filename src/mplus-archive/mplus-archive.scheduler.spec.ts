import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import type { MplusArchiveService } from './mplus-archive.service.js';
import { MplusArchiveScheduler } from './mplus-archive.scheduler.js';

/**
 * The scheduler's gates, asserted directly.
 *
 * The integration file shows the gates working in the order a real boot
 * produces, but that order also happens to protect the archive by itself: the
 * live pass subscribes first and is already active when the archive checks. So
 * the gates are pinned here, where nothing else can stand in for them.
 */
function schedulerWith(coordinator: IngestionCoordinator) {
  const archiveBacklog = vi.fn().mockResolvedValue(null);
  const archive = { isRunning: false, archiveBacklog } as unknown as MplusArchiveService;
  const registry = {
    addInterval: vi.fn(),
    doesExist: vi.fn().mockReturnValue(false),
    deleteInterval: vi.fn(),
  } as unknown as SchedulerRegistry;
  const env: Record<string, unknown> = {
    MPLUS_ARCHIVE_ENABLED: true,
    MPLUS_ARCHIVE_CHECK_INTERVAL_MS: 3_600_000,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService<never, true>;

  const scheduler = new MplusArchiveScheduler(config, archive, registry, coordinator);
  scheduler.onApplicationBootstrap();

  return { scheduler, archiveBacklog };
}

describe('MplusArchiveScheduler', () => {
  let active: MplusArchiveScheduler | undefined;

  afterEach(() => {
    active?.onModuleDestroy();
    active = undefined;
  });

  it('does not archive when live ingestion has warmed up but no Mythic+ pass has run', async () => {
    const coordinator = new IngestionCoordinator();
    const { scheduler, archiveBacklog } = schedulerWith(coordinator);
    active = scheduler;

    coordinator.markEnrichmentDisabled();
    await coordinator.duringSweep(async () => {});
    await scheduler.whenSettled();

    expect(archiveBacklog).not.toHaveBeenCalled();
  });

  it('archives once the first Mythic+ pass has also finished', async () => {
    const coordinator = new IngestionCoordinator();
    const { scheduler, archiveBacklog } = schedulerWith(coordinator);
    active = scheduler;

    coordinator.markEnrichmentDisabled();
    await coordinator.duringSweep(async () => {});
    await coordinator.duringMplus(async () => {});
    await scheduler.whenSettled();

    expect(archiveBacklog).toHaveBeenCalledTimes(1);
  });

  it('does not archive when Mythic+ has run but live ingestion has not warmed up', async () => {
    // The gates arrive in either order; whichever comes first must not start it.
    const coordinator = new IngestionCoordinator();
    const { scheduler, archiveBacklog } = schedulerWith(coordinator);
    active = scheduler;

    coordinator.markMplusDisabled();
    await scheduler.whenSettled();

    expect(archiveBacklog).not.toHaveBeenCalled();
  });

  it('does not start while another job is running, even with both gates open', async () => {
    const coordinator = new IngestionCoordinator();
    coordinator.markEnrichmentDisabled();
    coordinator.markMplusDisabled();

    await coordinator.duringArchive(async () => {
      const { scheduler, archiveBacklog } = schedulerWith(coordinator);
      active = scheduler;

      // Both gates are already open, so the ReplaySubjects deliver at once.
      await coordinator.duringSweep(async () => {});
      await scheduler.whenSettled();

      expect(archiveBacklog, 'the PvP archive is still running').not.toHaveBeenCalled();
    });
  });
});
