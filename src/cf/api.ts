// CF API wrapper.
//
// Important findings (verified against carrot DEBUG logs on 2026-04-30):
//   - `contest.standings` is gated by CF auth in a way that does NOT see the user's session
//     cookie when called from any extension context (content script, service worker, page
//     world — same result). Returns `400 contestId: You have to be authenticated to use this
//     method`. Carrot has the same problem, so it falls back to building standings from
//     `contest.status` (which is a public anonymous endpoint).
//   - `contest.status`, `contest.list`, `contest.ratingChanges`, `user.info` all work
//     anonymously and return 200 with full data via plain content-script `fetch()`.
//
// We follow Carrot's "rebuild from status" approach: get every submission for the contest via
// `contest.status`, filter to official CONTESTANT non-ghost entries within the contest window,
// and derive (handle → solved-problems) from there. No `contest.standings` call at all.

import type {
  CfUserInfo,
  CfRatingChange,
  CfContest,
  CfSubmission,
} from './types';

const API_PATH = '/api/';
const API_FETCH_RETRIES = 5;
const API_FETCH_TIMEOUT_MS = 30 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FetchedResponse {
  status: number;
  text: string;
}

/**
 * Fetch CF API with retries that handle BOTH network errors AND transient HTTP errors:
 * - 5xx (especially 503 Service Unavailable from nginx when the API is overloaded)
 * - 429 Too Many Requests (CF rate-limit kick-in)
 * Anything else (200, business 4xx like "auth required", 4xx Tomcat from oversized URL) is
 * returned as-is so the caller can format the error precisely.
 */
async function fetchWithRetries(url: URL): Promise<FetchedResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= API_FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url.toString(), {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      const text = await resp.text();
      const transient = resp.status >= 500 || resp.status === 429;
      if (transient && attempt < API_FETCH_RETRIES) {
        const backoff = 800 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(
          `[YRPR] CF API HTTP ${resp.status} (transient), attempt ${attempt}/${API_FETCH_RETRIES}, retrying in ${backoff}ms`,
        );
        await sleep(backoff);
        continue;
      }
      return { status: resp.status, text };
    } catch (err) {
      lastError = err;
      console.warn(`[YRPR] CF API fetch threw, attempt ${attempt}/${API_FETCH_RETRIES}:`, err);
      if (attempt < API_FETCH_RETRIES) {
        await sleep(800 * Math.pow(2, attempt - 1));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`CF API: failed after retries ${url}`);
}

async function call<T>(
  method: string,
  params: Record<string, string | number | boolean>,
): Promise<T> {
  const url = new URL(location.origin + API_PATH + method);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.append(k, String(v));
  }

  console.log(`[YRPR] → fetch GET ${url.toString()}`);
  const { status, text } = await fetchWithRetries(url);
  console.log(`[YRPR] ← ${method} status=${status} bytes=${text.length}`);

  if (status !== 200) {
    let comment: string | undefined;
    try {
      comment = (JSON.parse(text) as { comment?: string }).comment;
    } catch {
      /* not JSON */
    }
    throw new Error(`CF ${method}: ${comment ?? `HTTP ${status}: ${text.slice(0, 200)}`}`);
  }

  let data: { status?: string; result?: T; comment?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`CF ${method}: invalid JSON: ${text.slice(0, 200)}`);
  }
  if (data.status !== 'OK' || data.result === undefined) {
    throw new Error(`CF ${method}: ${data.comment ?? 'FAILED'}`);
  }
  return data.result;
}

export interface BatchProgress {
  (done: number, total: number): void;
}

export async function getUserInfos(
  handles: string[],
  onProgress?: BatchProgress,
): Promise<CfUserInfo[]> {
  if (handles.length === 0) return [];

  // CF's API server (Tomcat) has a default `maxHttpHeaderSize` of 8 KB. With ~500 handles per
  // call, the encoded URL blows past that limit and Tomcat (not CF API) returns a generic
  // 400 HTML page in Chinese ("HTTP状态 400 - 错误的请求"). 100 handles ≈ 3 KB URL, safely under.
  const BATCH = 100;
  const batches: string[][] = [];
  for (let i = 0; i < handles.length; i += BATCH) batches.push(handles.slice(i, i + BATCH));

  // Concurrency 4 is the sweet spot: 8 triggers CF nginx 503/429 on big rounds (90+ batches);
  // 4 finishes a 90-batch run in ~10s without rate-limit kicks.
  const CONCURRENCY = 4;
  const results: CfUserInfo[][] = new Array(batches.length);
  let done = 0;
  const queue = batches.map((b, idx) => ({ b, idx }));
  onProgress?.(0, batches.length);

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        const r = await call<CfUserInfo[]>('user.info', {
          handles: job.b.join(';'),
          checkHistoricHandles: false,
        });
        results[job.idx] = r;
      } catch (err) {
        // CF can 400 a whole batch over a single deleted/renamed handle (e.g.
        // "User with handle X not found"). Don't let one bad batch take down
        // the entire inference — those handles just won't contribute ratings,
        // and the Elo fit on the surviving ~99% is still meaningful.
        console.warn(
          `[YRPR] user.info batch ${job.idx} failed (${job.b.length} handles skipped):`,
          err,
        );
        results[job.idx] = [];
      }
      done++;
      onProgress?.(done, batches.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  const out: CfUserInfo[] = [];
  for (const r of results) if (r) out.push(...r);
  return out;
}

export function getRatingChanges(contestId: number): Promise<CfRatingChange[]> {
  return call<CfRatingChange[]>('contest.ratingChanges', { contestId });
}

/**
 * Look up a single contest's metadata. Calls `contest.list?gym=false` first; if not found,
 * falls back to `contest.list?gym=true`.
 */
export async function findContest(contestId: number): Promise<CfContest | null> {
  for (const gym of [false, true]) {
    const list = await call<CfContest[]>('contest.list', { gym });
    const c = list.find((x) => x.id === contestId);
    if (c) return c;
  }
  return null;
}

/**
 * Page through `contest.status` and yield all submissions for the contest. Each page is up to
 * 10000 submissions; we loop until a page comes back short.
 */
export async function fetchAllContestSubmissions(
  contestId: number,
  onProgress?: (loaded: number) => void,
): Promise<CfSubmission[]> {
  const PAGE = 10000;
  const all: CfSubmission[] = [];
  let from = 1;
  while (true) {
    const page = await call<CfSubmission[]>('contest.status', {
      contestId,
      from,
      count: PAGE,
    });
    all.push(...page);
    onProgress?.(all.length);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return all;
}
