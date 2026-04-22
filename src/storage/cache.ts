// Thin wrapper around GM_getValue/GM_setValue with TTL. Falls back to localStorage when the
// userscript grants aren't available (e.g. during vite dev against a plain HTTP page).

declare const GM_getValue: <T>(key: string, def: T) => T;
declare const GM_setValue: (key: string, value: unknown) => void;
declare const GM_deleteValue: (key: string) => void;

interface Envelope<T> {
  v: T;
  exp: number; // epoch ms
}

const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

function readRaw(key: string): string | null {
  if (hasGM) return GM_getValue<string | null>(key, null);
  return localStorage.getItem(key);
}

function writeRaw(key: string, val: string): void {
  if (hasGM) GM_setValue(key, val);
  else localStorage.setItem(key, val);
}

function deleteRaw(key: string): void {
  if (hasGM) GM_deleteValue(key);
  else localStorage.removeItem(key);
}

export function cacheGet<T>(key: string): T | null {
  const raw = readRaw(key);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as Envelope<T>;
    if (Date.now() > env.exp) {
      deleteRaw(key);
      return null;
    }
    return env.v;
  } catch {
    deleteRaw(key);
    return null;
  }
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  const env: Envelope<T> = { v: value, exp: Date.now() + ttlMs };
  writeRaw(key, JSON.stringify(env));
}
