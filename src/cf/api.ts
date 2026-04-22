// Thin CF API wrapper.
//
// IMPORTANT: CF locked `contest.standings` behind admin-only access in 2024 (even with a signed
// API key, non-admins only see Gym/mashup). We no longer call it. Standings data is now scraped
// from the rendered HTML of /contest/{id}/standings — see `standingsScrape.ts`.
//
// The remaining API calls (`user.info`, `contest.ratingChanges`) are still public endpoints
// and work anonymously via plain GET.

import type { CfUserInfo, CfRatingChange } from './types';

declare const GM_xmlhttpRequest: (opts: {
  method: 'GET';
  url: string;
  headers?: Record<string, string>;
  onload: (resp: { status: number; responseText: string; finalUrl?: string }) => void;
  onerror: (err: unknown) => void;
  ontimeout?: () => void;
}) => void;

const hasGmXhr = typeof GM_xmlhttpRequest === 'function';

interface RawResponse {
  status: number;
  text: string;
}

function requestViaGM(url: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      onload: (resp) => resolve({ status: resp.status, text: resp.responseText }),
      onerror: (err) => reject(new Error(`network error: ${JSON.stringify(err)}`)),
      ontimeout: () => reject(new Error('timeout')),
    });
  });
}

async function requestViaFetch(url: string): Promise<RawResponse> {
  const resp = await fetch(url, { credentials: 'same-origin' });
  const text = await resp.text();
  return { status: resp.status, text };
}

async function call<T>(method: string, params: Record<string, string | number | boolean>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const url = `https://codeforces.com/api/${method}?${qs.toString()}`;

  const transport = hasGmXhr ? 'GM_xhr' : 'fetch';
  console.log(`[YRPR] → ${transport} GET ${url}`);

  const raw = hasGmXhr ? await requestViaGM(url) : await requestViaFetch(url);
  console.log(`[YRPR] ← ${method} status=${raw.status} bytes=${raw.text.length}`);

  let data: { status?: string; result?: T; comment?: string } | null = null;
  try { data = JSON.parse(raw.text); } catch { /* not JSON — surface raw text below */ }

  if (raw.status < 200 || raw.status >= 300) {
    const reason = data?.comment ?? raw.text.slice(0, 200) ?? `HTTP ${raw.status}`;
    throw new Error(`CF ${method}: ${reason}`);
  }
  if (!data || data.status !== 'OK') {
    throw new Error(`CF ${method}: ${data?.comment ?? 'FAILED'}`);
  }
  return data.result as T;
}

export async function getUserInfos(handles: string[]): Promise<CfUserInfo[]> {
  if (handles.length === 0) return [];
  const out: CfUserInfo[] = [];
  const BATCH = 350;
  for (let i = 0; i < handles.length; i += BATCH) {
    const slice = handles.slice(i, i + BATCH);
    const result = await call<CfUserInfo[]>('user.info', {
      handles: slice.join(';'),
      checkHistoricHandles: false,
    });
    out.push(...result);
  }
  return out;
}

export function getRatingChanges(contestId: number): Promise<CfRatingChange[]> {
  return call<CfRatingChange[]>('contest.ratingChanges', { contestId });
}
