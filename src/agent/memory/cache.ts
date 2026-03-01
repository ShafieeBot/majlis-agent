/**
 * Cache — In-memory TTL cache for reducing DB round-trips.
 *
 * Module-level Map (survives across requests within the same serverless cold start).
 * Wedding/events: 5min TTL. Policy: 2min TTL.
 * Guest data (RSVPs, tables, notes): NEVER cached (always fresh).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

// ── TTL Constants (milliseconds) ──

export const TTL = {
  WEDDING: 5 * 60 * 1000,   // 5 minutes
  EVENTS: 5 * 60 * 1000,    // 5 minutes
  POLICY: 2 * 60 * 1000,    // 2 minutes
  SHORT: 30 * 1000,          // 30 seconds
} as const;

/**
 * Get a cached value. Returns undefined if expired or missing.
 */
export function get<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }

  return entry.value as T;
}

/**
 * Set a cached value with a TTL in milliseconds.
 */
export function set<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Invalidate a specific cache key.
 */
export function invalidate(key: string): void {
  store.delete(key);
}

/**
 * Invalidate all cache keys matching a prefix.
 */
export function invalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

/**
 * Clear the entire cache. Useful for testing.
 */
export function clear(): void {
  store.clear();
}

/**
 * Get the number of entries in the cache. Useful for testing.
 */
export function size(): number {
  return store.size;
}

// ── Cache Key Builders ──

export function weddingKey(weddingId: string): string {
  return `wedding:${weddingId}`;
}

export function eventsKey(weddingId: string): string {
  return `events:${weddingId}`;
}

export function policyKey(weddingId: string): string {
  return `policy:${weddingId}`;
}
