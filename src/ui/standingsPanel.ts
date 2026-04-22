import { getUserInfos } from '../cf/api';
import { fetchFullStandings, type ScrapedRow } from '../cf/standingsScrape';
import { predict, assignTiedRanks, type Contestant, type Prediction } from '../predictor/elo';
import { cacheGet, cacheSet } from '../storage/cache';
import type { CfUserInfo } from '../cf/types';
import { deltaColor } from './colors';
import { contestIdFromPath, waitFor } from '../utils/dom';

const USER_TTL = 60 * 60 * 1000; // 1h — ratings don't change mid-contest.

function isRatedRow(row: ScrapedRow): boolean {
  // Only rows with a participantId are official contestants. Practice/virtual rows lack it
  // and are ignored even if they appear (they won't be ranked-adjusted and don't affect delta).
  return row.participantId !== null && row.handle.length > 0;
}

async function getUserRatingMap(handles: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const missing: string[] = [];
  for (const h of handles) {
    const cached = cacheGet<number>(`yrpr:rating:${h.toLowerCase()}`);
    if (cached !== null) map.set(h, cached);
    else missing.push(h);
  }
  if (missing.length > 0) {
    const infos = await getUserInfos(missing);
    const byHandle = new Map<string, CfUserInfo>();
    for (const u of infos) byHandle.set(u.handle.toLowerCase(), u);
    for (const h of missing) {
      const u = byHandle.get(h.toLowerCase());
      // Brand-new accounts have no `rating` field; treat them as unrated.
      const r = u?.rating ?? 0;
      map.set(h, r);
      cacheSet(`yrpr:rating:${h.toLowerCase()}`, r, USER_TTL);
    }
  }
  return map;
}

function renderStatsBar(
  host: HTMLElement,
  preds: Prediction[],
  contestId: number,
  ctx: { totalRows: number; totalPages: number },
): void {
  const maxUp = preds.reduce((m, p) => (p.delta > m.delta ? p : m), preds[0]);
  const maxDown = preds.reduce((m, p) => (p.delta < m.delta ? p : m), preds[0]);
  host.textContent = '';
  host.append(
    text(`Contest ${contestId}  ·  `),
    text(`${ctx.totalRows} official rows across ${ctx.totalPages} page${ctx.totalPages === 1 ? '' : 's'}, ${preds.length} rated  ·  `),
    colored(`max ↑ ${maxUp.handle} +${maxUp.delta}`, '#008000'),
    text('  ·  '),
    colored(`max ↓ ${maxDown.handle} ${maxDown.delta}`, '#cc0000'),
    text(`  ·  snapshot ${new Date().toLocaleTimeString()}`),
  );
}

function colored(s: string, color: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.textContent = s;
  span.style.color = color;
  span.style.fontWeight = '600';
  return span;
}

function text(s: string): Text {
  return document.createTextNode(s);
}

function injectPanel(): { stats: HTMLDivElement; button: HTMLButtonElement } {
  let host = document.querySelector<HTMLDivElement>('#yrpr-panel');
  if (host) {
    return {
      stats: host.querySelector<HTMLDivElement>('.yrpr-stats')!,
      button: host.querySelector<HTMLButtonElement>('.yrpr-refresh')!,
    };
  }
  host = document.createElement('div');
  host.id = 'yrpr-panel';
  host.style.cssText = [
    'position:sticky', 'top:0', 'z-index:1000',
    'background:#fffbea', 'border:1px solid #f0d265', 'border-radius:6px',
    'padding:8px 12px', 'margin:8px 0', 'font-family:inherit', 'font-size:13px',
    'display:flex', 'align-items:center', 'gap:12px', 'flex-wrap:wrap',
  ].join(';');

  const button = document.createElement('button');
  button.className = 'yrpr-refresh';
  button.type = 'button';
  button.textContent = 'Refresh Predictions';
  button.style.cssText = 'padding:4px 10px; cursor:pointer; border:1px solid #bfa640; background:#fff3b0; border-radius:4px;';

  const stats = document.createElement('div');
  stats.className = 'yrpr-stats';
  stats.style.cssText = 'flex:1; min-width:300px;';
  stats.textContent = 'Click "Refresh Predictions" to compute Δ for this standings snapshot.';

  const buildBadge = document.createElement('span');
  buildBadge.className = 'yrpr-build';
  buildBadge.textContent = `build ${__BUILD_TIME__}`;
  buildBadge.title = 'YRPR build timestamp — use this to verify you have the latest install.';
  buildBadge.style.cssText = 'color:#aa8a20; font-size:11px; font-family:monospace;';

  host.append(button, stats, buildBadge);

  const standingsTable = document.querySelector('.standings');
  standingsTable?.parentElement?.insertBefore(host, standingsTable);

  return { stats, button };
}

function renderDeltaColumn(preds: Prediction[]): void {
  const byHandle = new Map<string, Prediction>();
  for (const p of preds) byHandle.set(p.handle.toLowerCase(), p);

  const table = document.querySelector<HTMLTableElement>('table.standings');
  if (!table) return;

  const headerRow = table.querySelector<HTMLTableRowElement>('tr:first-child');
  if (headerRow && !headerRow.querySelector('.yrpr-delta-head')) {
    const th = document.createElement('th');
    th.className = 'yrpr-delta-head';
    th.textContent = 'Δ';
    th.style.minWidth = '50px';
    headerRow.appendChild(th);
  }

  const rows = table.querySelectorAll<HTMLTableRowElement>('tr[participantid], tr.standings-flag');
  const dataRows = rows.length > 0 ? rows : Array.from(table.querySelectorAll<HTMLTableRowElement>('tr')).slice(1);

  for (const tr of Array.from(dataRows)) {
    const handleLink = tr.querySelector<HTMLAnchorElement>('a[href*="/profile/"]');
    if (!handleLink) continue;
    const handle = handleLink.textContent?.trim().toLowerCase() ?? '';
    const pred = byHandle.get(handle);

    let td = tr.querySelector<HTMLTableCellElement>('td.yrpr-delta-cell');
    if (!td) {
      td = document.createElement('td');
      td.className = 'yrpr-delta-cell';
      td.style.textAlign = 'center';
      td.style.fontWeight = '600';
      tr.appendChild(td);
    }
    if (pred) {
      td.textContent = pred.delta > 0 ? `+${pred.delta}` : `${pred.delta}`;
      td.style.color = deltaColor(pred.delta);
    } else {
      td.textContent = '—';
      td.style.color = '#aaa';
    }
  }
}

/**
 * Re-rank contestants ourselves from (points, penalty). CF's own rank is trustworthy but may
 * include unofficial rows interleaved; tied-rank assignment over filtered rated rows gives us
 * the correct actualRank_i for the Elo formula.
 */
function rankComparator(a: ScrapedRow, b: ScrapedRow): number {
  if (b.points !== a.points) return b.points - a.points;
  return a.penalty - b.penalty;
}

async function runPrediction(contestId: number, statsEl: HTMLElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const prev = button.textContent;
  button.textContent = 'Computing…';
  try {
    statsEl.textContent = 'Fetching standings page 1…';

    const agg = await fetchFullStandings(contestId, (done, total) => {
      statsEl.textContent = `Fetching standings: page ${done}/${total}…`;
    });

    const officialRated = agg.rows.filter(isRatedRow);
    if (officialRated.length === 0) {
      statsEl.textContent =
        `Got 0 official rows across ${agg.totalPages} page(s). ` +
        `First-page final URL: ${agg.firstFinalUrl}. ` +
        `If this looks redirected (e.g. contains /friends/true), CF honored a session filter — tell me and I'll widen the URL overrides.`;
      return;
    }

    statsEl.textContent = `Got ${agg.rows.length} official rows across ${agg.totalPages} pages. Fetching ratings…`;
    const handles = officialRated.map((r) => r.handle);
    const ratingMap = await getUserRatingMap(handles);

    statsEl.textContent = `Computing predictions over ${officialRated.length} contestants…`;

    const tied = assignTiedRanks(officialRated, rankComparator);
    const contestants: Contestant[] = [];
    for (const row of officialRated) {
      const rating = ratingMap.get(row.handle) ?? 0;
      // Unrated accounts (rating = 0 / undefined) don't affect anyone's Elo — skip them.
      if (rating <= 0) continue;
      contestants.push({ handle: row.handle, rating, rank: tied.get(row)! });
    }

    if (contestants.length === 0) {
      statsEl.textContent = 'No rated contestants with a pre-contest rating — nothing to predict.';
      return;
    }

    const preds = predict(contestants);
    renderDeltaColumn(preds);
    renderStatsBar(statsEl, preds, contestId, {
      totalRows: agg.rows.length,
      totalPages: agg.totalPages,
    });
  } catch (err) {
    statsEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[YRPR]', err);
  } finally {
    button.disabled = false;
    button.textContent = prev;
  }
}

export async function bootstrapStandingsPanel(): Promise<void> {
  const contestId = contestIdFromPath();
  if (!contestId) return;
  await waitFor('table.standings');
  const { stats, button } = injectPanel();
  button.addEventListener('click', () => {
    void runPrediction(contestId, stats, button);
  });
}
