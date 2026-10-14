/**
 * A small in-memory cache whose entries expire a fixed time after they are set.
 *
 * For upstream reference data that changes rarely but is asked for by every
 * run of a repeating job. Process-local and lost on restart, which is the
 * point: the worst a stale entry can do is bounded by `ttlMs`.
 *
 * A `ttlMs` of 0 switches it off: nothing is stored and every `get` misses.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.ttlMs <= 0) return;

    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}
