import { Logger } from '@nestjs/common';
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

/**
 * M5.3 — the interlock's one boot warning (T9).
 *
 * With the interlock on and the archive off, a superseded season is never
 * retired, and a plan nobody reads is the only other sign of it. So it is said
 * once at boot, under exactly that combination, and never repeated per tick.
 */
describe('MplusSeasonTransitionScheduler boot warning', () => {
  const INTERLOCK = /MPLUS_PURGE_REQUIRE_ARCHIVE is on but MPLUS_ARCHIVE_ENABLED is off/;
  let active: MplusSeasonTransitionScheduler | undefined;

  afterEach(() => {
    active?.onModuleDestroy();
    active = undefined;
    vi.restoreAllMocks();
  });

  const boot = (settings: { enabled: boolean; archive: boolean; interlock: boolean }) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let tick: (() => void) | undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      tick = callback;

      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setInterval);

    const env: Record<string, unknown> = {
      MPLUS_TRANSITION_ENABLED: settings.enabled,
      MPLUS_ARCHIVE_ENABLED: settings.archive,
      MPLUS_TRANSITION_CHECK_INTERVAL_MS: 3_600_000,
    };
    const transitions = {
      isDryRun: false,
      requiresArchive: settings.interlock,
      run: vi.fn(async () => ({ plan: { dryRun: false }, purged: [] })),
    } as unknown as MplusSeasonTransitionService;
    const registry = {
      addInterval: vi.fn(),
      doesExist: vi.fn().mockReturnValue(false),
      deleteInterval: vi.fn(),
    } as unknown as SchedulerRegistry;
    const scheduler = new MplusSeasonTransitionScheduler(
      { get: (key: string) => env[key] } as unknown as ConfigService<never, true>,
      transitions,
      new MplusSeasonEvents(),
      registry,
      new IngestionCoordinator(),
    );
    scheduler.onApplicationBootstrap();
    active = scheduler;

    return {
      scheduler,
      tick: () => tick?.(),
      interlockWarnings: () =>
        warn.mock.calls.filter(([message]) => INTERLOCK.test(String(message))),
    };
  };

  it('warns once, naming both variables, when the interlock waits on an archive that is off', async () => {
    const { scheduler, tick, interlockWarnings } = boot({
      enabled: true,
      archive: false,
      interlock: true,
    });

    expect(interlockWarnings()).toHaveLength(1);
    expect(String(interlockWarnings()[0][0])).toMatch(/superseded Mythic\+ seasons will stay/);

    tick();
    await scheduler.whenSettled();
    expect(interlockWarnings(), 'not repeated on a later tick').toHaveLength(1);
  });

  it.each([
    ['the archive on', { enabled: true, archive: true, interlock: true }],
    ['the interlock off', { enabled: true, archive: false, interlock: false }],
    ['transitions off', { enabled: false, archive: false, interlock: true }],
  ])('says nothing with %s', (_name, settings) => {
    expect(boot(settings).interlockWarnings()).toHaveLength(0);
  });
});
