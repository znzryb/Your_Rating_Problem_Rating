// Thin TTL cache on top of localStorage. Content scripts share localStorage with the host page,
// which is fine for our case — the keys are namespaced under `yrpr:` and the data isn't
// sensitive (problem ratings + handle ratings, all derived from public CF API data).

interface Envelope<T> {
  v: T;
  exp: number; // epoch ms
}

export function cacheGet<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as Envelope<T>;
    if (Date.now() > env.exp) {
      localStorage.removeItem(key);
      return null;
    }
    return env.v;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  const env: Envelope<T> = { v: value, exp: Date.now() + ttlMs };
  try {
    localStorage.setItem(key, JSON.stringify(env));
  } catch {
    // Quota exceeded — silently drop. Cache miss next time is harmless.
  }
}
