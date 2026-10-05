import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { RaidRankingsScheduler } from './raid-rankings.scheduler.js';
import type { RaidRankingsControl, RaidRankingsService } from './raid-rankings.service.js';

/** A real coordinator, so the gates are the real ones; `warm` opens them all. */
function schedulerWith(enabled: boolean, options: { warm?: boolean; waitMs?: number } = {}) {
  const refreshDue = vi.fn<
    (now: Date, control: RaidRankingsControl) => Promise<{ boards: number }>
  >(async () => ({ boards: 0 }));
  const registry = {
    addInterval: vi.fn(),
    doesExist: vi.fn(() => registry.addInterval.mock.calls.length > 0),
    deleteInterval: vi.fn(),
  };
  let tick: (() => void) | undefined;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    tick = callback;

    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setInterval);
  const env: Record<string, unknown> = {
    RAID_RANKINGS_ENABLED: enabled,
    RAID_RANKINGS_INTERVAL_MS: 3_600_000,
    ARCHIVE_WAIT_FOR_IDLE_MS: options.waitMs ?? 0,
  };
  const coordinator = new IngestionCoordinator();

  if (options.warm ?? true) {
    coordinator.markEnrichmentDisabled();
    coordinator.markMplusDisabled();
  }

  return {
    scheduler: new RaidRankingsScheduler(
      { get: (key: string) => env[key] } as unknown as ConfigService<never, true>,
      { refreshDue } as unknown as RaidRankingsService,
      registry as unknown as SchedulerRegistry,
      coordinator,
    ),
    coordinator,
    refreshDue,
    registry,
    tick: () => tick?.(),
  };
}

/** Marks a job as running until the returned function is called. */
function hold(start: (work: () => Promise<void>) => Promise<void>) {
  let release!: () => void;
  const running = start(() => new Promise<void>((resolve) => (release = resolve)));

  return async () => {
    release();
    await running;
  };
}

describe('RaidRankingsScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const quiet = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  };

  it('does nothing when the rankings are switched off', async () => {
    quiet();
    const { scheduler, coordinator, refreshDue, registry } = schedulerWith(false);

    scheduler.onApplicationBootstrap();
    await coordinator.duringSweep(async () => undefined);
    await scheduler.whenSettled();

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(refreshDue).not.toHaveBeenCalled();
  });

  it('does not run at bootstrap, and registers its interval', async () => {
    quiet();
    const { scheduler, refreshDue, registry, tick } = schedulerWith(true);

    scheduler.onApplicationBootstrap();
    await scheduler.whenSettled();

    expect(registry.addInterval.mock.calls[0][0]).toBe('raid-rankings');
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    expect(refreshDue, 'no sweep has finished yet').not.toHaveBeenCalled();

    // Nor on an interval tick that comes before the gates open.
    tick();
    await scheduler.whenSettled();
    expect(refreshDue).not.toHaveBeenCalled();

    scheduler.onModuleDestroy();
    expect(registry.deleteInterval).toHaveBeenCalledWith('raid-rankings');
  });

  it('first runs when the first sweep, enrichment pass and Mythic+ pass are all done', async () => {
    quiet();
    const { scheduler, coordinator, refreshDue } = schedulerWith(true, { warm: false });
    scheduler.onApplicationBootstrap();

    await coordinator.duringSweep(async () => undefined);
    await scheduler.whenSettled();
    expect(refreshDue, 'the sweep alone is not enough').not.toHaveBeenCalled();

    await coordinator.duringEnrichment(async () => undefined);
    await scheduler.whenSettled();
    expect(refreshDue, 'live ingestion is warm, Mythic+ is not').not.toHaveBeenCalled();

    await coordinator.duringMplus(async () => undefined);
    await scheduler.whenSettled();
    expect(refreshDue).toHaveBeenCalledTimes(1);
  });

  it('runs once when both gates open at the same moment, and then once per tick', async () => {
    quiet();
    const { scheduler, coordinator, refreshDue, tick } = schedulerWith(true);
    scheduler.onApplicationBootstrap();

    // Enrichment and Mythic+ are off, so the sweep opens everything at once.
    await coordinator.duringSweep(async () => undefined);
    await scheduler.whenSettled();
    expect(refreshDue).toHaveBeenCalledTimes(1);

    tick();
    await scheduler.whenSettled();
    expect(refreshDue).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a sweep', (c: IngestionCoordinator, w: () => Promise<void>) => c.duringSweep(w)],
    ['enrichment', (c: IngestionCoordinator, w: () => Promise<void>) => c.duringEnrichment(w)],
    ['a Mythic+ pass', (c: IngestionCoordinator, w: () => Promise<void>) => c.duringMplus(w)],
    ['the PvP archive', (c: IngestionCoordinator, w: () => Promise<void>) => c.duringArchive(w)],
    [
      'the Mythic+ archive',
      (c: IngestionCoordinator, w: () => Promise<void>) => c.duringMplusArchive(w),
    ],
  ])('waits for %s to finish before it starts, rather than skipping the tick', async (_, job) => {
    quiet();
    const { scheduler, coordinator, refreshDue, tick } = schedulerWith(true, { waitMs: 5_000 });
    scheduler.onApplicationBootstrap();
    await coordinator.duringSweep(async () => undefined);
    await scheduler.whenSettled();
    refreshDue.mockClear();

    const release = hold((work) => job(coordinator, work));
    tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshDue, 'held back while the job runs').not.toHaveBeenCalled();

    await release();
    await scheduler.whenSettled();
    expect(refreshDue).toHaveBeenCalledTimes(1);
  });

  it('gives the tick up when the job above outlasts the wait', async () => {
    quiet();
    const { scheduler, coordinator, refreshDue, tick } = schedulerWith(true, { waitMs: 0 });
    scheduler.onApplicationBootstrap();
    await coordinator.duringSweep(async () => undefined);
    await scheduler.whenSettled();
    refreshDue.mockClear();

    const release = hold((work) => coordinator.duringEnrichment(work));
    tick();
    await scheduler.whenSettled();
    expect(refreshDue).not.toHaveBeenCalled();

    await release();
    tick();
    await scheduler.whenSettled();
    expect(refreshDue).toHaveBeenCalledTimes(1);
  });

  it('hands the run a way to wait between boards, and to stop at shutdown', async () => {
    quiet();
    const { scheduler, coordinator, refreshDue } = schedulerWith(true, { waitMs: 5_000 });
    scheduler.onApplicationBootstrap();
    await coordinator.duringSweep(async () => undefined);
    await scheduler.whenSettled();
    const control = refreshDue.mock.calls[0][1];

    expect(await control.whenClear!(), 'nothing above is running').toBe(true);

    const release = hold((work) => coordinator.duringMplusArchive(work));
    let cleared = false;
    const waiting = control.whenClear!().then((clear) => (cleared = clear));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cleared, 'paused while the job above runs').toBe(false);
    await release();
    expect(await waiting).toBe(true);

    expect(control.shouldStop!()).toBe(false);
    scheduler.onModuleDestroy();
    expect(control.shouldStop!()).toBe(true);
  });

  it('logs a failing run as one line, and the next run goes ahead', async () => {
    quiet();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { scheduler, coordinator, refreshDue, tick } = schedulerWith(true);
    refreshDue.mockRejectedValueOnce(new Error('mongo is gone'));

    scheduler.onApplicationBootstrap();
    await coordinator.duringSweep(async () => undefined);
    await scheduler.whenSettled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('Could not read raid rankings: mongo is gone');

    tick();
    await scheduler.whenSettled();
    expect(refreshDue).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does not stack a run on one still going, as a backfill outlasts an interval', async () => {
    quiet();
    const { scheduler, coordinator, refreshDue, tick } = schedulerWith(true);
    let finish!: () => void;
    refreshDue.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ boards: 1 }))),
    );

    scheduler.onApplicationBootstrap();
    await coordinator.duringSweep(async () => undefined);
    await vi.waitFor(() => expect(refreshDue).toHaveBeenCalledTimes(1));
    tick();
    tick();
    finish();
    await scheduler.whenSettled();

    expect(refreshDue).toHaveBeenCalledTimes(1);
  });
});
