import { describe, expect, it, vi } from 'vitest';

import { IngestionCoordinator } from './ingestion-coordinator.service.js';

describe('IngestionCoordinator', () => {
  it('reports nothing active by default', () => {
    const coordinator = new IngestionCoordinator();

    expect(coordinator.isSweepActive).toBe(false);
    expect(coordinator.isEnrichmentActive).toBe(false);
    expect(coordinator.isLiveIngestionActive).toBe(false);
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

  it('treats enrichment as live ingestion too', async () => {
    const coordinator = new IngestionCoordinator();

    await coordinator.duringEnrichment(async () => {
      expect(coordinator.isSweepActive).toBe(false);
      expect(coordinator.isLiveIngestionActive).toBe(true);
    });

    expect(coordinator.isLiveIngestionActive).toBe(false);
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

  describe('warm-up', () => {
    it('is not warmed up until both a sweep and an enrichment pass have run', async () => {
      const coordinator = new IngestionCoordinator();
      expect(coordinator.isWarmedUp).toBe(false);

      await coordinator.duringSweep(async () => {});
      expect(coordinator.isWarmedUp).toBe(false);

      await coordinator.duringEnrichment(async () => {});
      expect(coordinator.isWarmedUp).toBe(true);
    });

    it('signals once both have completed, regardless of order', async () => {
      const coordinator = new IngestionCoordinator();
      const warmed = vi.fn();
      coordinator.warmedUp$.subscribe(warmed);

      await coordinator.duringEnrichment(async () => {});
      expect(warmed).not.toHaveBeenCalled();

      await coordinator.duringSweep(async () => {});
      expect(warmed).toHaveBeenCalledOnce();
    });

    it('signals only once, not on every later pass', async () => {
      const coordinator = new IngestionCoordinator();
      const warmed = vi.fn();
      coordinator.warmedUp$.subscribe(warmed);

      await coordinator.duringSweep(async () => {});
      await coordinator.duringEnrichment(async () => {});
      await coordinator.duringSweep(async () => {});
      await coordinator.duringEnrichment(async () => {});

      expect(warmed).toHaveBeenCalledOnce();
    });

    it('reaches a subscriber that arrives after warm-up', async () => {
      const coordinator = new IngestionCoordinator();
      await coordinator.duringSweep(async () => {});
      await coordinator.duringEnrichment(async () => {});

      const warmed = vi.fn();
      coordinator.warmedUp$.subscribe(warmed);

      // A late subscriber must not miss the signal and stall forever.
      expect(warmed).toHaveBeenCalledOnce();
    });

    it('does not wait on enrichment that is switched off', async () => {
      const coordinator = new IngestionCoordinator();
      coordinator.markEnrichmentDisabled();

      expect(coordinator.isWarmedUp).toBe(false);

      await coordinator.duringSweep(async () => {});
      expect(coordinator.isWarmedUp).toBe(true);
    });
  });
});
