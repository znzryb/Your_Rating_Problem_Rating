export function waitFor<T extends Element>(selector: string, timeoutMs = 10_000): Promise<T | null> {
  const existing = document.querySelector<T>(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector<T>(selector);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(document.querySelector<T>(selector));
    }, timeoutMs);
  });
}

export function contestIdFromPath(): number | null {
  const m = location.pathname.match(/\/contest\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function problemIndexFromPath(): string | null {
  // Matches /contest/123/problem/A  and  /problemset/problem/123/A
  const m = location.pathname.match(/\/problem\/(?:\d+\/)?([A-Za-z]\w*)/);
  return m ? m[1] : null;
}
