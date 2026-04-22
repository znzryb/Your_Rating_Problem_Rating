// Scrape Codeforces standings HTML directly, since the `contest.standings` API is locked down
// for non-admins as of 2024.
//
// We deliberately fetch canonical URLs — `/contest/{id}/standings` for page 1 and
// `/contest/{id}/standings/page/{N}` for the rest — rather than reading the user's current
// page DOM. The rendered page may be filtered by "friends only" / "show rated only" toggles
// that the user clicked, which would give inconsistent data across page fetches. Going through
// the canonical URL returns CF's default official view every time, even if the user's tab has
// filters applied.

declare const GM_xmlhttpRequest: (opts: {
  method: 'GET';
  url: string;
  onload: (resp: { status: number; responseText: string; finalUrl?: string }) => void;
  onerror: (err: unknown) => void;
  ontimeout?: () => void;
}) => void;

const hasGmXhr = typeof GM_xmlhttpRequest === 'function';

export interface ScrapedRow {
  handle: string;
  rank: number;
  points: number;
  penalty: number;
  /** One boolean per problem, in the order `problems[]` is returned. */
  solved: boolean[];
  /** Present on official contestant rows; missing on unofficial/practice/virtual. */
  participantId: string | null;
}

export interface ScrapedPage {
  /** Problem letters in column order, e.g. ['A','B','C','D','E','F']. */
  problems: string[];
  rows: ScrapedRow[];
  totalPages: number;
}

interface HtmlResponse {
  text: string;
  finalUrl: string;
}

function fetchHtml(url: string): Promise<HtmlResponse> {
  return new Promise((resolve, reject) => {
    if (hasGmXhr) {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            resolve({ text: r.responseText, finalUrl: r.finalUrl ?? url });
          } else {
            reject(new Error(`HTTP ${r.status} for ${url}`));
          }
        },
        onerror: (e) => reject(new Error(`network error: ${JSON.stringify(e)}`)),
      });
    } else {
      fetch(url, { credentials: 'same-origin' })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
          resolve({ text: await r.text(), finalUrl: r.url });
        })
        .catch(reject);
    }
  });
}

/**
 * Canonical standings URL — with `/friends/false` explicitly pinned so CF can't serve us a
 * friends-only view based on a persistent session preference the user may have toggled on.
 * Observed behaviour: base `/standings` sometimes respects the last-clicked filter, while
 * `/standings/friends/false` always returns the full official view.
 */
export function standingsPageUrl(contestId: number, page: number): string {
  const base = `https://codeforces.com/contest/${contestId}/standings/friends/false`;
  return page <= 1 ? base : `${base}/page/${page}`;
}

/**
 * Parse a CF standings page HTML string into a structured view.
 *
 * The CF table layout is stable: a leading group of non-problem columns (rank, handle, points,
 * and optionally penalty for ICPC rounds) followed by one column per problem. We identify
 * which columns are problem cells by looking for a `<a href=".../problem/X">` in the header
 * row — everything to the left is metadata, everything from there on is a problem column.
 */
export function parseStandingsHtml(html: string): ScrapedPage {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table.standings') as HTMLTableElement | null;
  if (!table) throw new Error('standings table not found (is the contest ID valid?)');

  const allTr = Array.from(table.querySelectorAll('tr'));
  if (allTr.length === 0) throw new Error('standings table is empty');

  const headerTr = allTr[0];
  const headerCells = Array.from(headerTr.querySelectorAll('th')) as HTMLElement[];

  const problems: string[] = [];
  const problemColIndexes: number[] = [];
  headerCells.forEach((th, i) => {
    const link = th.querySelector('a[href*="/problem/"]') as HTMLAnchorElement | null;
    if (!link) return;
    const m = (link.getAttribute('href') ?? '').match(/\/problem\/([A-Za-z][\w-]*)/);
    if (!m) return;
    problems.push(m[1]);
    problemColIndexes.push(i);
  });
  if (problems.length === 0) throw new Error('no problem columns detected');

  const firstProblemCol = problemColIndexes[0];
  // Layout: [rank, handle, points, (penalty)?, problems...]
  // firstProblemCol == 3 → IOI/CF (no penalty); == 4 → ICPC (has penalty).
  const hasPenaltyCol = firstProblemCol >= 4;

  const rows: ScrapedRow[] = [];
  for (let r = 1; r < allTr.length; r++) {
    const tr = allTr[r];
    // Skip the occasional divider / banner row: only real rows have a profile link.
    const handleLink = tr.querySelector('a[href*="/profile/"]') as HTMLAnchorElement | null;
    if (!handleLink) continue;

    const cells = Array.from(tr.children) as HTMLElement[];
    if (cells.length < problemColIndexes[problemColIndexes.length - 1] + 1) continue;

    const rank = parseInt((cells[0]?.textContent ?? '').trim(), 10);
    const handle = (handleLink.textContent ?? '').trim();
    const points = parseFloat((cells[2]?.textContent ?? '').trim()) || 0;
    const penalty = hasPenaltyCol ? parseInt((cells[3]?.textContent ?? '').trim(), 10) || 0 : 0;

    const solved: boolean[] = problemColIndexes.map((ci) =>
      cells[ci]?.classList.contains('cell-accepted') ?? false,
    );

    rows.push({
      handle,
      rank: Number.isFinite(rank) ? rank : 0,
      points,
      penalty,
      solved,
      participantId: tr.getAttribute('participantid'),
    });
  }

  // Pagination: derive the max page from `/page/N` occurrences anywhere in the document.
  // This is more robust than relying on specific pagination widget class names, which CF has
  // tweaked before.
  let totalPages = 1;
  const pageRegex = /\/standings(?:\/[^"'\s]+)*?\/page\/(\d+)/g;
  const html4 = doc.documentElement.outerHTML; // cheaper than requerying DOM via selectors
  let m: RegExpExecArray | null;
  while ((m = pageRegex.exec(html4)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > totalPages) totalPages = n;
  }

  return { problems, rows, totalPages };
}

export interface FetchProgress {
  (done: number, total: number): void;
}

export interface AggregatedStandings {
  problems: string[];
  rows: ScrapedRow[];
  totalPages: number;
  /** Whichever final URL page 1 redirected to — surfaces session-filter hijacks at the UI. */
  firstFinalUrl: string;
}

/**
 * Fetch all pages of the standings for a contest and aggregate rows. Concurrency-limited so
 * big rounds (10k+ contestants = 200+ pages) don't drown CF in parallel requests.
 */
export async function fetchFullStandings(
  contestId: number,
  onProgress?: FetchProgress,
): Promise<AggregatedStandings> {
  const firstUrl = standingsPageUrl(contestId, 1);
  console.log(`[YRPR] scrape fetch page 1: ${firstUrl}`);
  const firstResp = await fetchHtml(firstUrl);
  if (firstResp.finalUrl !== firstUrl) {
    console.warn(`[YRPR] page 1 redirected: ${firstUrl} → ${firstResp.finalUrl}`);
  }
  const first = parseStandingsHtml(firstResp.text);
  console.log(`[YRPR] page 1 parsed: ${first.rows.length} rows, totalPages=${first.totalPages}`);
  onProgress?.(1, first.totalPages);
  if (first.totalPages <= 1) {
    return {
      problems: first.problems,
      rows: first.rows,
      totalPages: 1,
      firstFinalUrl: firstResp.finalUrl,
    };
  }

  const pagesByIndex: ScrapedRow[][] = new Array(first.totalPages);
  pagesByIndex[0] = first.rows;

  const queue: number[] = [];
  for (let p = 2; p <= first.totalPages; p++) queue.push(p);

  const CONCURRENCY = 5;
  let done = 1;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const page = queue.shift()!;
      const url = standingsPageUrl(contestId, page);
      const resp = await fetchHtml(url);
      const parsed = parseStandingsHtml(resp.text);
      pagesByIndex[page - 1] = parsed.rows;
      done++;
      console.log(`[YRPR] page ${page} parsed: ${parsed.rows.length} rows (done ${done}/${first.totalPages})`);
      onProgress?.(done, first.totalPages);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const allRows: ScrapedRow[] = [];
  for (const batch of pagesByIndex) if (batch) allRows.push(...batch);

  return {
    problems: first.problems,
    rows: allRows,
    totalPages: first.totalPages,
    firstFinalUrl: firstResp.finalUrl,
  };
}
