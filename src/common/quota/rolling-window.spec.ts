import { describe, expect, it } from 'vitest';

import { RollingWindow } from './rolling-window.js';

type Key = 'a' | 'b';
const KEYS: readonly Key[] = ['a', 'b'];

function windowAt(start: number, bucketMs = 1_000, buckets = 60) {
  const window = new RollingWindow<Key>(KEYS, bucketMs, buckets);
  let now = start;
  window.now = () => now;

  return { window, advance: (ms: number) => (now += ms) };
}

describe('RollingWindow', () => {
  it('counts per key and in total', () => {
    const { window } = windowAt(0);

    window.record('a', 3);
    window.record('b');

    expect(window.spent('a')).toBe(3);
    expect(window.spent('b')).toBe(1);
    expect(window.spent()).toBe(4);
  });

  it('keeps events for the whole window and forgets them after it', () => {
    const { window, advance } = windowAt(0);

    window.record('a');
    advance(60_000);
    expect(window.spent('a'), 'still inside the 60-bucket window').toBe(1);

    advance(1_000);
    expect(window.spent('a'), 'now one bucket past the window').toBe(0);
  });

  it('errs towards over-counting rather than under', () => {
    // Recorded 1ms into a bucket, read 999ms before the window would expire it:
    // a quota that forgets early is the failure that gets a client banned.
    const { window, advance } = windowAt(1);

    window.record('a');
    advance(60_000);

    expect(window.spent('a')).toBe(1);
  });

  it('reuses a ring slot without double counting the old occupant', () => {
    // The ring is 64 slots for a 60-bucket window, so bucket 0 and bucket 64
    // share a slot. Without the index check the second would read as the first.
    const { window, advance } = windowAt(0);

    window.record('a', 5);
    advance(64_000);
    window.record('a', 2);

    expect(window.spent('a'), 'only the recent record survives').toBe(2);
  });

  it('supports a minute-into-hour window as well as a second-into-minute one', () => {
    const { window, advance } = windowAt(0, 60_000, 60);

    window.record('a');
    advance(59 * 60_000);
    expect(window.spent('a')).toBe(1);

    advance(2 * 60_000);
    expect(window.spent('a')).toBe(0);
  });
});
