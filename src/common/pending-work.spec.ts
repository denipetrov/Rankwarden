import { describe, expect, it } from 'vitest';

import { PendingWork } from './pending-work.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PendingWork', () => {
  it('is idle with nothing running', async () => {
    const pending = new PendingWork();

    expect(pending.isIdle).toBe(true);
    await expect(pending.whenSettled()).resolves.toBeUndefined();
  });

  it('waits for work started and dropped', async () => {
    const pending = new PendingWork();
    let finished = false;

    pending.run(async () => {
      await tick(10);
      finished = true;
    });

    expect(pending.isIdle).toBe(false);
    await pending.whenSettled();
    expect(finished).toBe(true);
    expect(pending.isIdle).toBe(true);
  });

  it('waits for work that starts more work', async () => {
    // The archive walks its backlog this way, and a finished sweep wakes
    // enrichment — awaiting the set once would return between the two.
    const pending = new PendingWork();
    const order: string[] = [];

    pending.run(async () => {
      await tick(5);
      order.push('first');
      pending.run(async () => {
        await tick(5);
        order.push('second');
      });
    });

    await pending.whenSettled();

    expect(order).toEqual(['first', 'second']);
  });

  it('settles even when the work throws', async () => {
    const pending = new PendingWork();

    pending.run(async () => {
      throw new Error('boom');
    });

    await expect(pending.whenSettled()).resolves.toBeUndefined();
    expect(pending.isIdle).toBe(true);
  });

  it('does not reject when work throws synchronously', async () => {
    const pending = new PendingWork();

    expect(() =>
      pending.run(() => {
        throw new Error('thrown before the promise');
      }),
    ).not.toThrow();

    await expect(pending.whenSettled()).resolves.toBeUndefined();
  });

  it('waits for every concurrent job', async () => {
    const pending = new PendingWork();
    const done: number[] = [];

    for (const ms of [15, 5, 10]) {
      pending.run(async () => {
        await tick(ms);
        done.push(ms);
      });
    }

    await pending.whenSettled();

    expect(done).toHaveLength(3);
  });
});
