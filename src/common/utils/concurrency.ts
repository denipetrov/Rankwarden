/**
 * Maps over `items` with at most `limit` workers in flight, preserving input order
 * in the returned array. Used to keep leaderboard sweeps inside Blizzard's rate limits.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) {
    throw new RangeError(`Concurrency limit must be >= 1, received ${limit}`);
  }

  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
