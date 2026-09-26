import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MplusSeasonService } from './mplus-season.service.js';
import { MplusSeasonScheduler } from './mplus-season.scheduler.js';

/**
 * M1.3 — the season check's wiring (gap §7.2).
 *
 * The integration files boot it only with a Mythic+ job on, where it always
 * ticks. Its gates, its interval and what a failing tick does are pinned here,
 * with the interval's callback captured so a tick is a function call rather
 * than a wait.
 */
function schedulerWith(env: Record<string, unknown>) {
  const calls: string[] = [];
  const seasons = {
    ensureCatalogue: vi.fn(async () => {
      calls.push('ensureCatalogue');
    }),
    observe: vi.fn(async () => {
      calls.push('observe');
    }),
  };
  const registry = {
    addInterval: vi.fn(),
    doesExist: vi.fn((_type: string, name: string) =>
      registry.addInterval.mock.calls.some(([added]) => added === name),
    ),
    deleteInterval: vi.fn(),
  };
  let tick: (() => void) | undefined;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    tick = callback;

    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setInterval);

  const settings: Record<string, unknown> = {
    MPLUS_SEASON_REFRESH_ENABLED: true,
    MPLUS_ENABLED: false,
    MPLUS_ARCHIVE_ENABLED: false,
    MPLUS_SEASON_CHECK_INTERVAL_MS: 3_600_000,
    ...env,
  };
  const config = { get: (key: string) => settings[key] } as unknown as ConfigService<never, true>;
  const scheduler = new MplusSeasonScheduler(
    config,
    seasons as unknown as MplusSeasonService,
    registry as unknown as SchedulerRegistry,
  );

  return { scheduler, seasons, registry, calls, tick: () => tick?.() };
}

describe('MplusSeasonScheduler', () => {
  let active: MplusSeasonScheduler | undefined;

  afterEach(() => {
    active?.onModuleDestroy();
    active = undefined;
    vi.restoreAllMocks();
  });

  it('does nothing when the season check is switched off', async () => {
    const { scheduler, seasons, registry } = schedulerWith({
      MPLUS_SEASON_REFRESH_ENABLED: false,
      MPLUS_ENABLED: true,
    });
    active = scheduler;

    scheduler.onApplicationBootstrap();
    await scheduler.whenSettled();

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(seasons.ensureCatalogue).not.toHaveBeenCalled();
  });

  it('idles when no Mythic+ job is on, with no key to read the catalogue with', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { scheduler, seasons, registry } = schedulerWith({});
    active = scheduler;

    scheduler.onApplicationBootstrap();
    await scheduler.whenSettled();

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(seasons.ensureCatalogue).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([message]) => message)).toContain(
      'No Mythic+ job is enabled; Mythic+ season checks idle',
    );
  });

  it.each([
    ['the live pass', { MPLUS_ENABLED: true }],
    ['the archive', { MPLUS_ARCHIVE_ENABLED: true }],
  ])('with %s on, registers its interval and ticks at bootstrap', async (_job, env) => {
    const { scheduler, registry, calls } = schedulerWith(env);
    active = scheduler;

    scheduler.onApplicationBootstrap();
    await scheduler.whenSettled();

    expect(registry.addInterval).toHaveBeenCalledTimes(1);
    expect(registry.addInterval.mock.calls[0][0]).toBe('mplus-season-check');
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    // The catalogue first: the season is resolved from it.
    expect(calls).toEqual(['ensureCatalogue', 'observe']);

    scheduler.onModuleDestroy();
    active = undefined;
    expect(registry.deleteInterval).toHaveBeenCalledWith('mplus-season-check');
  });

  it('logs a failing tick as one line, and the next tick runs normally', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { scheduler, seasons, tick, calls } = schedulerWith({ MPLUS_ENABLED: true });
    active = scheduler;
    seasons.ensureCatalogue.mockRejectedValueOnce(new Error('Raider.io API 503 for static-data'));

    scheduler.onApplicationBootstrap();
    await scheduler.whenSettled();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe(
      'Could not check the Mythic+ season: Raider.io API 503 for static-data',
    );
    expect(seasons.observe, 'nothing resolved from a catalogue not read').not.toHaveBeenCalled();

    calls.length = 0;
    tick();
    await scheduler.whenSettled();
    expect(calls).toEqual(['ensureCatalogue', 'observe']);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does not stack a tick on one still running', async () => {
    const { scheduler, seasons, tick } = schedulerWith({ MPLUS_ENABLED: true });
    active = scheduler;
    let finish!: () => void;
    seasons.ensureCatalogue.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    scheduler.onApplicationBootstrap();
    // The bootstrap tick is now parked inside the catalogue read.
    await vi.waitFor(() => expect(seasons.ensureCatalogue).toHaveBeenCalledTimes(1));
    tick();
    tick();
    finish();
    await scheduler.whenSettled();

    expect(seasons.ensureCatalogue).toHaveBeenCalledTimes(1);
    expect(seasons.observe).toHaveBeenCalledTimes(1);
  });
});
