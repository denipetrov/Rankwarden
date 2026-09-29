import { Logger } from '@nestjs/common';
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

    it('announces warm-up in the log once, not after every later pass', async () => {
      const coordinator = new IngestionCoordinator();
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      try {
        for (let pass = 0; pass < 3; pass += 1) {
          await coordinator.duringSweep(async () => {});
          await coordinator.duringEnrichment(async () => {});
        }
        coordinator.markEnrichmentDisabled();

        const announced = log.mock.calls.filter(([message]) =>
          String(message).includes('Live ingestion warmed up'),
        );
        expect(announced).toHaveLength(1);
      } finally {
        log.mockRestore();
      }
    });

    it('signals Mythic+ warm-up once, however many passes follow', async () => {
      const coordinator = new IngestionCoordinator();
      const warmed = vi.fn();
      coordinator.mplusWarmedUp$.subscribe(warmed);

      await coordinator.duringMplus(async () => {});
      await coordinator.duringMplus(async () => {});
      coordinator.markMplusDisabled();

      expect(warmed).toHaveBeenCalledOnce();
      expect(coordinator.isMplusWarmedUp).toBe(true);
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

  describe('the Mythic+ archive', () => {
    it('counts every other job as above it, and nothing else', async () => {
      const coordinator = new IngestionCoordinator();
      const seen: Record<string, boolean> = {};

      await coordinator.duringSweep(async () => {
        seen.sweep = coordinator.isAboveMplusArchiveActive;
      });
      await coordinator.duringEnrichment(async () => {
        seen.enrichment = coordinator.isAboveMplusArchiveActive;
      });
      await coordinator.duringMplus(async () => {
        seen.mplus = coordinator.isAboveMplusArchiveActive;
      });
      await coordinator.duringArchive(async () => {
        seen.archive = coordinator.isAboveMplusArchiveActive;
      });
      await coordinator.duringMplusArchive(async () => {
        seen.itself = coordinator.isAboveMplusArchiveActive;
      });

      expect(seen).toEqual({
        sweep: true,
        enrichment: true,
        mplus: true,
        archive: true,
        itself: false,
      });
      expect(coordinator.isAboveMplusArchiveActive).toBe(false);
    });

    it('does not make the PvP archive or enrichment wait on either Mythic+ job', async () => {
      const coordinator = new IngestionCoordinator();

      await coordinator.duringMplusArchive(async () => {
        expect(coordinator.isLiveIngestionActive).toBe(false);
        expect(coordinator.isMplusActive).toBe(false);
      });
    });

    it('opens the Mythic+ gate once the first live pass finishes', async () => {
      const coordinator = new IngestionCoordinator();
      const opened = vi.fn();
      coordinator.mplusWarmedUp$.subscribe(opened);

      await coordinator.duringMplus(async () => {
        expect(coordinator.isMplusWarmedUp, 'not while it runs').toBe(false);
      });

      expect(coordinator.isMplusWarmedUp).toBe(true);
      expect(opened).toHaveBeenCalledTimes(1);

      await coordinator.duringMplus(async () => {});
      expect(opened, 'and only once').toHaveBeenCalledTimes(1);
    });

    it('opens the Mythic+ gate at once when Mythic+ is switched off', () => {
      // Otherwise the archive would wait forever for a pass that never comes.
      const coordinator = new IngestionCoordinator();
      const opened = vi.fn();
      coordinator.mplusWarmedUp$.subscribe(opened);

      coordinator.markMplusDisabled();

      expect(coordinator.isMplusWarmedUp).toBe(true);
      expect(opened).toHaveBeenCalledTimes(1);
    });

    it('keeps the Mythic+ gate out of the PvP warm-up', async () => {
      // The PvP archive has nothing to do with Mythic+ and must not wait on it.
      const coordinator = new IngestionCoordinator();
      coordinator.markEnrichmentDisabled();
      await coordinator.duringSweep(async () => {});

      expect(coordinator.isWarmedUp).toBe(true);
      expect(coordinator.isMplusWarmedUp).toBe(false);
    });
  });
});

/**
 * The bounded wait lower-priority jobs use instead of skipping a tick. Skipping
 * starved the archives: their hourly tick lands on the hourly sweep every time.
 */
describe('IngestionCoordinator.waitFor', () => {
  it('resolves true at once when the condition already holds', async () => {
    const coordinator = new IngestionCoordinator();

    await expect(coordinator.waitFor(() => !coordinator.isSweepActive, 0)).resolves.toBe(true);
  });

  it('resolves true as soon as the job it waits on ends, not at the deadline', async () => {
    const coordinator = new IngestionCoordinator();
    let finish!: () => void;
    const sweep = coordinator.duringSweep(() => new Promise<void>((resolve) => (finish = resolve)));

    const startedAt = Date.now();
    const waited = coordinator.waitFor(() => !coordinator.isLiveIngestionActive, 10_000);
    setTimeout(() => finish(), 30);

    await expect(waited).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await sweep;
  });

  it('re-checks on every job ending, so an unrelated job ending does not release it', async () => {
    const coordinator = new IngestionCoordinator();
    let finishSweep!: () => void;
    const sweep = coordinator.duringSweep(
      () => new Promise<void>((resolve) => (finishSweep = resolve)),
    );
    let released = false;
    const waited = coordinator
      .waitFor(() => !coordinator.isSweepActive, 10_000)
      .then((value) => (released = value));

    await coordinator.duringArchive(async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(released, 'the archive ending is not the sweep ending').toBe(false);

    finishSweep();
    await waited;
    expect(released).toBe(true);
    await sweep;
  });

  it('resolves false when the job outlasts the wait, so the waiter can give up the tick', async () => {
    const coordinator = new IngestionCoordinator();
    let finish!: () => void;
    const mplus = coordinator.duringMplus(() => new Promise<void>((resolve) => (finish = resolve)));

    await expect(coordinator.waitFor(() => !coordinator.isMplusActive, 30)).resolves.toBe(false);

    finish();
    await mplus;
  });
});
