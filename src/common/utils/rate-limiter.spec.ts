import { describe, expect, it } from 'vitest';

import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  it('lets an initial burst through without waiting', async () => {
    const limiter = new RateLimiter(5);
    const started = Date.now();

    for (let i = 0; i < 5; i++) await limiter.acquire();

    expect(Date.now() - started).toBeLessThan(50);
  });

  it('throttles once the bucket is drained', async () => {
    const limiter = new RateLimiter(20);
    for (let i = 0; i < 20; i++) await limiter.acquire();

    const started = Date.now();
    await limiter.acquire();

    // The 21st request has to wait for a token to be refilled (~50ms at 20/s).
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('rejects a non-positive rate', () => {
    expect(() => new RateLimiter(0)).toThrow(RangeError);
  });
});
