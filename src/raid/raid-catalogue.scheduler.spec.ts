import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RaidCatalogueScheduler } from './raid-catalogue.scheduler.js';
import type { RaidCatalogueService } from './raid-catalogue.service.js';

function schedulerWith(enabled: boolean) {
  const refreshIfDue = vi.fn(async () => ({ refreshed: false }));
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
    RAID_CATALOGUE_ENABLED: enabled,
    RAID_CATALOGUE_CHECK_INTERVAL_MS: 3_600_000,
  };

  return {
    scheduler: new RaidCatalogueScheduler(
      { get: (key: string) => env[key] } as unknown as ConfigService<never, true>,
      { refreshIfDue } as unknown as RaidCatalogueService,
      registry as unknown as SchedulerRegistry,
    ),
    refreshIfDue,
    registry,
    tick: () => tick?.(),
  };
}

describe('RaidCatalogueScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when the catalogue is switched off', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { scheduler, refreshIfDue, registry } = schedulerWith(false);

    scheduler.onApplicationBootstrap();
    await scheduler.whenSettled();

    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(refreshIfDue).not.toHaveBeenCalled();
  });

  it('checks at bootstrap and registers its interval, and removes it on destroy', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { scheduler, refreshIfDue, registry } = schedulerWith(true);

    scheduler.onApplicationBootstrap();
    await scheduler.whenSettled();

    expect(registry.addInterval.mock.calls[0][0]).toBe('raid-catalogue-check');
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    expect(refreshIfDue).toHaveBeenCalledTimes(1);

    scheduler.onModuleDestroy();
    expect(registry.deleteInterval).toHaveBeenCalledWith('raid-catalogue-check');
  });

  it('logs a failing check as one line, and the next check runs normally', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { scheduler, refreshIfDue, tick } = schedulerWith(true);
    refreshIfDue.mockRejectedValueOnce(new Error('mongo is gone'));

    scheduler.onApplicationBootstrap();
    await scheduler.whenSettled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('Could not check the raid catalogue: mongo is gone');

    tick();
    await scheduler.whenSettled();
    expect(refreshIfDue).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does not stack a check on one still running', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { scheduler, refreshIfDue, tick } = schedulerWith(true);
    let finish!: () => void;
    refreshIfDue.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ refreshed: true }))),
    );

    scheduler.onApplicationBootstrap();
    await vi.waitFor(() => expect(refreshIfDue).toHaveBeenCalledTimes(1));
    tick();
    tick();
    finish();
    await scheduler.whenSettled();

    expect(refreshIfDue).toHaveBeenCalledTimes(1);
  });
});
