import { describe, expect, it } from 'vitest';

import { IngestionCoordinator } from './ingestion-coordinator.service.js';

describe('IngestionCoordinator', () => {
  it('reports no sweep active by default', () => {
    expect(new IngestionCoordinator().isSweepActive).toBe(false);
  });

  it('marks a sweep active only for the duration of the work', async () => {
    const coordinator = new IngestionCoordinator();
    let activeDuringWork = false;

    await coordinator.duringSweep(async () => {
      activeDuringWork = coordinator.isSweepActive;
    });

    expect(activeDuringWork).toBe(true);
    expect(coordinator.isSweepActive).toBe(false);
  });

  it('clears the flag when the sweep throws', async () => {
    const coordinator = new IngestionCoordinator();

    await expect(
      coordinator.duringSweep(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(coordinator.isSweepActive).toBe(false);
  });

  it('stays active until the last of overlapping sweeps finishes', async () => {
    const coordinator = new IngestionCoordinator();
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const outer = coordinator.duringSweep(async () => {
      await coordinator.duringSweep(async () => {});
      // The inner sweep returning must not clear the flag for the outer one.
      expect(coordinator.isSweepActive).toBe(true);
      await blocked;
    });

    release();
    await outer;
    expect(coordinator.isSweepActive).toBe(false);
  });
});
