import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from './concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => value * 2);

    expect(result).toEqual([2, 4, 6, 8]);
  });

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    );

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('rejects a limit below one', async () => {
    await expect(mapWithConcurrency([1], 0, async (v) => v)).rejects.toThrow(RangeError);
  });
});
