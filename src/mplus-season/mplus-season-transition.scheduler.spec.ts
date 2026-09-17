import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { MplusSeasonEvents } from './mplus-season-events.service.js';
import { MplusSeasonTransitionScheduler } from './mplus-season-transition.scheduler.js';
import type { MplusSeasonTransitionService } from './mplus-season-transition.service.js';

/**
 * The rollover path a live pass takes, asserted directly.
 *
 * A pass observes the season before its first page, so the rollover it notices
 * ticks the transition while that same pass is running — and the transition
 * abstains while a pass runs. The integration story never meets this with an
 * archived season to retire, so it is pinned here: the tick has to wait for the
 * pass, not give up until the next hourly check.
 */
function schedulerWith(coordinator: IngestionCoordinator, events: MplusSeasonEvents) {
  const ranWhileMplusActive: boolean[] = [];
  const run = vi.fn(async () => {
    // Recorded as it happens, so a run that raced the pass is visible.
    ranWhileMplusActive.push(coordinator.isMplusActive);

    return { plan: { dryRun: false }, purged: [] };
  });
  const transitions = {
    isDryRun: false,
    requiresArchive: true,
    run,
  } as unknown as MplusSeasonTransitionService;
  const registry = {
    addInterval: vi.fn(),
    doesExist: vi.fn().mockReturnValue(false),
    deleteInterval: vi.fn(),
  } as unknown as SchedulerRegistry;
  const env: Record<string, unknown> = {
    MPLUS_TRANSITION_ENABLED: true,
    MPLUS_ARCHIVE_ENABLED: true,
    MPLUS_TRANSITION_CHECK_INTERVAL_MS: 3_600_000,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService<never, true>;

  const scheduler = new MplusSeasonTransitionScheduler(
    config,
    transitions,
    events,
    registry,
    coordinator,
  );
  scheduler.onApplicationBootstrap();

  return { scheduler, run, ranWhileMplusActive };
}

const rollover = {
  kind: 'rollover' as const,
  region: 'us' as const,
  season: 'season-mn-3',
  previousSeason: 'season-mn-2',
  at: new Date(),
  acrossRestart: false,
};

describe('MplusSeasonTransitionScheduler', () => {
  let active: MplusSeasonTransitionScheduler | undefined;

  afterEach(() => {
    active?.onModuleDestroy();
    active = undefined;
  });

  it('waits for the pass that noticed a rollover, then runs', async () => {
    const coordinator = new IngestionCoordinator();
    const events = new MplusSeasonEvents();
    const { scheduler, run, ranWhileMplusActive } = schedulerWith(coordinator, events);
    active = scheduler;

    await coordinator.duringMplus(async () => {
      events.emit(rollover);
      // Give the tick every chance to run early.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(run, 'not while the pass is still writing').not.toHaveBeenCalled();
    });

    await scheduler.whenSettled();

    expect(run).toHaveBeenCalledTimes(1);
    expect(ranWhileMplusActive).toEqual([false]);
  });

  it('runs at once on a rollover when no pass is running', async () => {
    const coordinator = new IngestionCoordinator();
    const events = new MplusSeasonEvents();
    const { scheduler, run } = schedulerWith(coordinator, events);
    active = scheduler;

    events.emit(rollover);
    await scheduler.whenSettled();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not tick for a season merely ending', async () => {
    const coordinator = new IngestionCoordinator();
    const events = new MplusSeasonEvents();
    const { scheduler, run } = schedulerWith(coordinator, events);
    active = scheduler;

    events.emit({ ...rollover, kind: 'ended', season: 'season-mn-2' });
    await scheduler.whenSettled();

    expect(run).not.toHaveBeenCalled();
  });
});
