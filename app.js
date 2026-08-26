/* Trade Management — trade journal with a P/L calendar.
   Local cache in localStorage; synced cross-device via Supabase when signed in. */
(() => {
'use strict';

/** Pure calculation core lives in trade-math.js (loaded before this script) so it can be
 *  unit-tested standalone in tests.html without dragging in the DOM/state/cloud-sync code below. */
const {
  CURRENCY, ymd, parseYmd, daysBetween, tradingDaysBetween,
  fmtMoney, fmtNum, cls,
  isOpenTrade, pnlOf, rOf, daysInTrade, computeDefaultStop, calcUnrealized,
  sortedEvents, derivePosition, isPositionTrade, trimToTrade, migratePositionId,
  mergeById,
} = window.TradeMath;

const KEY_TRADES    = 'tm.trades.v1';
const KEY_PREFS     = 'tm.prefs.v1';
const KEY_POSITIONS = 'tm.positions.v1';
const KEY_SCANNER   = 'tm.scanner.v1';
const KEY_DELETED_TRADES    = 'tm.deletedTradeIds.v1';
const KEY_DELETED_POSITIONS = 'tm.deletedPositionIds.v1';

/* ============================ cloud sync (Supabase) ============================ */

const SUPABASE_URL = 'https://aqqotvfzsvcmlaqyaakn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxcW90dmZ6c3ZjbWxhcXlhYWtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4NDYxMDEsImV4cCI6MjEwMjQyMjEwMX0.Ic44bF9B4K1fGpfm8suCRs2p8gYgb9BFRDIGcfwJ-cg';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentUser = null;

async function syncToCloud(key, value) {
  if (!currentUser) return;
  const { error } = await sb.from('app_state').upsert({
    user_id: currentUser.id, key, data: value, updated_at: new Date().toISOString(),
  });
  if (error) console.error(`Cloud sync failed for "${key}":`, error.message);
}

/** Pull all cloud state for the signed-in user and merge it into the local cache (mergeById,
 *  from trade-math.js) — cloud is never allowed to blow away local-only records, which is what
 *  makes cross-device sync safe. */
async function pullCloudState() {
  const { data, error } = await sb.from('app_state').select('key,data').eq('user_id', currentUser.id);
  if (error) { toast('Could not load cloud data: ' + error.message); return; }
  const map = {};
  (data || []).forEach(row => { map[row.key] = row.data; });

  const cloudTrades = Array.isArray(map.trades) ? map.trades : [];
  const cloudPositions = Array.isArray(map.positions) ? map.positions : [];
  const cloudDeletedTrades = Array.isArray(map.deletedTradeIds) ? map.deletedTradeIds : [];
  const cloudDeletedPositions = Array.isArray(map.deletedPositionIds) ? map.deletedPositionIds : [];

  // Tombstones only ever grow (a plain set union) — merge these first so the delete lists used
  // just below already reflect anything deleted on either side.
  const mergedDeletedTrades = Array.from(new Set([...deletedTradeIds, ...cloudDeletedTrades]));
  const mergedDeletedPositions = Array.from(new Set([...deletedPositionIds, ...cloudDeletedPositions]));
  const deletedTradesGrew = mergedDeletedTrades.length > cloudDeletedTrades.length;
  const deletedPositionsGrew = mergedDeletedPositions.length > cloudDeletedPositions.length;
  deletedTradeIds = mergedDeletedTrades;
  deletedPositionIds = mergedDeletedPositions;

  const mergedTrades = mergeById(trades, cloudTrades, deletedTradeIds).map(migratePositionId);
  const mergedPositions = mergeById(positions, cloudPositions, deletedPositionIds);
  const tradesGrew = mergedTrades.length > cloudTrades.filter(t => !deletedTradeIds.includes(t.id)).length;
  const positionsGrew = mergedPositions.length > cloudPositions.filter(p => !deletedPositionIds.includes(p.id)).length;

  trades = mergedTrades;
  positions = mergedPositions;
  prefs = Object.assign({ theme: 'dark' }, prefs, map.prefs || {});
  // Scanner results are written only by scanner.py (via the Supabase REST API,
  // not this client), so the cloud copy is always authoritative -- no merge needed.
  if (map.scanner) scannerData = map.scanner;

  localStorage.setItem(KEY_TRADES, JSON.stringify(trades));
  localStorage.setItem(KEY_POSITIONS, JSON.stringify(positions));
  localStorage.setItem(KEY_PREFS, JSON.stringify(prefs));
  localStorage.setItem(KEY_DELETED_TRADES, JSON.stringify(deletedTradeIds));
  localStorage.setItem(KEY_DELETED_POSITIONS, JSON.stringify(deletedPositionIds));
  if (scannerData) localStorage.setItem(KEY_SCANNER, JSON.stringify(scannerData));

  // Push anything this browser had that the cloud didn't, so the cloud catches up too.
  if (tradesGrew) await syncToCloud('trades', trades);
  if (positionsGrew) await syncToCloud('positions', positions);
  if (deletedTradesGrew) await syncToCloud('deletedTradeIds', deletedTradeIds);
  if (deletedPositionsGrew) await syncToCloud('deletedPositionIds', deletedPositionIds);
  if (tradesGrew || positionsGrew) toast('Synced — merged local and cloud data, nothing dropped.');
}

/* ============================ state ============================ */

let trades = load(KEY_TRADES, []).map(migratePositionId);
let prefs  = Object.assign({ theme: 'dark' }, load(KEY_PREFS, {}));
let positions = load(KEY_POSITIONS, []);
let scannerData = load(KEY_SCANNER, null);
// Tombstones: ids the user actually chose to delete, so a stale cached copy on another device
// (or another tab) can't bring a deleted trade/position back to life on its next sync.
let deletedTradeIds = load(KEY_DELETED_TRADES, []);
let deletedPositionIds = load(KEY_DELETED_POSITIONS, []);

let cursor = startOfMonth(new Date());   // month shown in the calendar
let selectedDate = null;                 // 'YYYY-MM-DD'
let sortKey = 'date', sortDir = -1;
let viewingPositionId = null;            // id of the position shown in the detail dialog

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveTrades() {
  localStorage.setItem(KEY_TRADES, JSON.stringify(trades));
  syncToCloud('trades', trades);
}
function savePrefs() {
  localStorage.setItem(KEY_PREFS, JSON.stringify(prefs));
  syncToCloud('prefs', prefs);
}
function savePositions() {
  localStorage.setItem(KEY_POSITIONS, JSON.stringify(positions));
  syncToCloud('positions', positions);
}
function saveDeletedTradeIds() {
  localStorage.setItem(KEY_DELETED_TRADES, JSON.stringify(deletedTradeIds));
  syncToCloud('deletedTradeIds', deletedTradeIds);
}
function saveDeletedPositionIds() {
  localStorage.setItem(KEY_DELETED_POSITIONS, JSON.stringify(deletedPositionIds));
  syncToCloud('deletedPositionIds', deletedPositionIds);
}
/** Call at every trade-deletion site so the delete sticks across devices instead of a stale
 *  cached copy elsewhere resurrecting it on its next sync (see mergeById's deletedIds param). */
function recordDeletedTradeIds(ids) {
  let changed = false;
  for (const id of (Array.isArray(ids) ? ids : [ids])) {
    if (id != null && !deletedTradeIds.includes(id)) { deletedTradeIds.push(id); changed = true; }
  }
  if (changed) saveDeletedTradeIds();
}
function recordDeletedPositionId(id) {
  if (id != null && !deletedPositionIds.includes(id)) { deletedPositionIds.push(id); saveDeletedPositionIds(); }
}

/* ============================ helpers ============================ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function fmtCompact(n) {
  const abs = Math.abs(n);
  const unit = abs >= 1e7 ? [1e7, 'Cr'] : abs >= 1e5 ? [1e5, 'L'] : abs >= 1e3 ? [1e3, 'k'] : [1, ''];
  const v = (n / unit[0]).toFixed(abs >= 1e3 ? 1 : 0);
  return (n > 0 ? '+' : '') + v + unit[1];
}
function tone(n) { return n > 0 ? 'win' : n < 0 ? 'loss' : 'flat'; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

const PLATFORM_LABELS = {
  etrade: 'E*TRADE', schwab: 'Schwab / thinkorswim', fidelity: 'Fidelity',
  'fidelity-ira': 'Fidelity IRA', 'fidelity-roth': 'Fidelity ROTH', other: 'Other',
};
function platformLabel(p) { return PLATFORM_LABELS[p] || ''; }

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ============================ trade/position math glue ============================ */
/* The actual math (pnlOf, rOf, derivePosition, mergeById, etc.) lives in trade-math.js and is
 * destructured in at the top of this file. What's left here is state-aware glue that needs
 * `trades`/`positions`/`uid`, which trade-math.js deliberately has no access to. */

function withDerived(t) {
  return Object.assign({}, t, { pnl: pnlOf(t), rmultiple: rOf(t), days: daysInTrade(t, ymd(new Date())) });
}

/** Group trades by date -> { pnl, count, trades }. */
function byDate(list = trades) {
  const map = new Map();
  for (const t of list) {
    let e = map.get(t.date);
    if (!e) map.set(t.date, e = { pnl: 0, count: 0, open: 0, trades: [] });
    const pnl = pnlOf(t);
    if (pnl == null) e.open++; else e.pnl += pnl;
    e.count++;
    e.trades.push(t);
  }
  return map;
}

function withPositionDerived(p) { return Object.assign({}, p, derivePosition(p)); }

/** Replay a position's events, syncing every trim to a trade row (idempotent via event.tradeId),
 *  dropping trade rows for trims that were edited/deleted away, and updating open/closed status. */
function resyncPositionTrades(pos) {
  let qty = 0, avgCost = 0;
  const keepIds = new Set();

  for (const e of sortedEvents(pos)) {
    if (e.type === 'entry' || e.type === 'add') {
      avgCost = qty === 0 ? e.price : (avgCost * qty + e.price * e.qty) / (qty + e.qty);
      qty += e.qty;
    } else if (e.type === 'trim') {
      const trade = trimToTrade(pos, e, avgCost, uid);
      e.tradeId = trade.id;
      keepIds.add(trade.id);
      const i = trades.findIndex(t => t.id === trade.id);
      if (i >= 0) trades[i] = trade; else trades.push(trade);
      qty -= Math.min(e.qty, qty);
    }
  }

  const droppedIds = trades.filter(t => t.positionId === pos.id && !keepIds.has(t.id)).map(t => t.id);
  trades = trades.filter(t => t.positionId !== pos.id || keepIds.has(t.id));
  if (droppedIds.length) recordDeletedTradeIds(droppedIds);

  pos.status = qty <= 0 && sortedEvents(pos).some(e => e.type === 'trim') ? 'closed' : 'open';
  pos.closedDate = pos.status === 'closed' ? sortedEvents(pos).slice(-1)[0].date : null;
  saveTrades();
  // No screenshot for individual scale-in/trim events while the position is open — only once
  // it's fully closed, showing the whole lifecycle on one chart. Re-runs (and re-generates)
  // on every resync while already closed too, so editing an old event after the fact still
  // produces an accurate chart, not a stale one.
  if (pos.status === 'closed') generatePositionChart(pos);
}

/* ============================ rendering ============================ */

function renderAll() {
  renderSummary();
  renderCalendar();
  renderDayPanel();
  renderTrades();
  renderPositions();
  renderTradesCheck();
  renderStats();
  renderScanner();
}

/* ---- summary strip ---- */
function renderSummary() {
  const total = trades.reduce((s, t) => s + (pnlOf(t) ?? 0), 0);
  const days = byDate();
  const dayPnls = Array.from(days.values(), d => d.pnl);
  const greenDays = dayPnls.filter(p => p > 0).length;
  const tradedDays = dayPnls.length;
  const openCount = trades.filter(isOpenTrade).length;
  const wins = trades.filter(t => pnlOf(t) > 0).length;
  const decided = trades.filter(t => { const p = pnlOf(t); return p != null; }).length;

  const today = ymd(new Date());
  const todayPnl = days.get(today)?.pnl ?? 0;

  const items = [
    ['Net P/L', `<span class="${cls(total)}">${fmtMoney(total, { sign: true })}</span>`],
    ['Today', `<span class="${cls(todayPnl)}">${fmtMoney(todayPnl, { sign: true })}</span>`],
    ['Trades', String(trades.length)],
    ['Open', String(openCount)],
    ['Win rate', decided ? `${((wins / decided) * 100).toFixed(1)}%` : '—'],
    ['Green days', tradedDays ? `${greenDays}/${tradedDays}` : '—'],
  ];
  $('#summary').innerHTML = items.map(([l, v]) =>
    `<div class="sm"><span class="sm-label">${l}</span><span class="sm-value">${v}</span></div>`).join('');
}

/* ---- calendar ---- */
function renderCalendar() {
  const grid = $('#calGrid');
  const y = cursor.getFullYear(), m = cursor.getMonth();
  $('#monthLabel').textContent = `${MONTHS[m]} ${y}`;

  const days = byDate();
  const todayStr = ymd(new Date());

  // start on the Sunday on/before the 1st
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());

  let html = '';
  let weekPnl = 0, weekDays = 0;
  const cursorDay = new Date(start);

  for (let i = 0; i < 42; i++) {
    const ds = ymd(cursorDay);
    const inMonth = cursorDay.getMonth() === m;
    const e = days.get(ds);

    const closedCount = e ? e.count - e.open : 0;
    const t = e ? (closedCount ? tone(e.pnl) : 'open') : '';
    const classes = ['day', t, inMonth ? '' : 'is-out',
                     ds === todayStr ? 'is-today' : '',
                     ds === selectedDate ? 'is-selected' : ''].filter(Boolean).join(' ');

    html += `<button class="${classes}" data-date="${ds}">
      <span class="day-num">${cursorDay.getDate()}</span>
      ${e ? `<span class="day-pnl">${closedCount ? fmtCompact(e.pnl) : 'Open'}</span>
             <span class="day-count">${e.count} trade${e.count > 1 ? 's' : ''}</span>` : ''}
    </button>`;

    if (inMonth && e) { weekPnl += e.pnl; weekDays += e.count; }

    // close the week with a summary cell
    if (i % 7 === 6) {
      html += `<div class="wk">
        <span class="wk-label">Week</span>
        <span class="wk-pnl ${cls(weekPnl)}">${weekDays ? fmtCompact(weekPnl) : '—'}</span>
        <span class="wk-days">${weekDays ? weekDays + ' trades' : ''}</span>
      </div>`;
      weekPnl = 0; weekDays = 0;
    }

    cursorDay.setDate(cursorDay.getDate() + 1);

    // stop after the week that contains the last day of the month
    if (i % 7 === 6 && cursorDay.getMonth() !== m && cursorDay > new Date(y, m + 1, 0)) break;
  }
  grid.innerHTML = html;

  // month stats
  const monthTrades = trades.filter(t => t.date.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`));
  const mPnl = monthTrades.reduce((s, t) => s + (pnlOf(t) ?? 0), 0);
  const mDays = byDate(monthTrades);
  const green = Array.from(mDays.values()).filter(d => d.pnl > 0).length;
  const best = Array.from(mDays.entries()).sort((a, b) => b[1].pnl - a[1].pnl)[0];
  const worst = Array.from(mDays.entries()).sort((a, b) => a[1].pnl - b[1].pnl)[0];

  $('#monthStats').innerHTML = `
    <span><i>Month P/L</i><b class="${cls(mPnl)}">${fmtMoney(mPnl, { sign: true })}</b></span>
    <span><i>Trades</i><b>${monthTrades.length}</b></span>
    <span><i>Green days</i><b>${mDays.size ? `${green}/${mDays.size}` : '—'}</b></span>
    <span><i>Best day</i><b class="pos">${best ? fmtCompact(best[1].pnl) : '—'}</b></span>
    <span><i>Worst day</i><b class="neg">${worst && worst[1].pnl < 0 ? fmtCompact(worst[1].pnl) : '—'}</b></span>`;
}

/* ---- day panel ---- */
function renderDayPanel() {
  const panel = $('#dayPanel');
  if (!selectedDate) {
    panel.innerHTML = `<div class="daypanel-empty">Select a day to see its trades.</div>`;
    return;
  }
  const d = parseYmd(selectedDate);
  const list = trades.filter(t => t.date === selectedDate).map(withDerived);
  const total = list.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = list.filter(t => t.pnl > 0).length;
  const openN = list.filter(t => t.pnl == null).length;
  const decidedN = list.length - openN;

  panel.innerHTML = `
    <div class="dp-head">
      <span class="dp-date">${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}</span>
      <button class="btn btn-ghost" id="dpAdd" title="Add a trade on this day">+ Add</button>
    </div>
    <div class="dp-total ${cls(total)}">${fmtMoney(total, { sign: true })}</div>
    <div class="dp-meta">${list.length} trade${list.length === 1 ? '' : 's'}${
      decidedN ? ` · ${wins}W / ${decidedN - wins}L` : ''}${openN ? ` · ${openN} open` : ''}</div>
    <div style="margin-top:12px">
      ${list.length ? list.map(t => `
        <div class="dp-trade" data-id="${t.id}">
          <div class="dp-row1">
            <span><span class="dp-sym">${esc(t.symbol)}</span> <span class="pill ${t.side}">${t.side}</span></span>
            ${t.pnl == null ? `<span class="pill">Open</span>` :
              `<span class="dp-pnl ${cls(t.pnl)}">${fmtMoney(t.pnl, { sign: true })}</span>`}
          </div>
          <div class="dp-row2">${fmtNum(t.qty)} @ ${fmtNum(t.entry)} → ${t.exit == null ? '—' : fmtNum(t.exit)}${
            t.rmultiple != null ? ` · ${t.rmultiple >= 0 ? '+' : ''}${t.rmultiple.toFixed(2)}R` : ''}</div>
          ${t.notes ? `<div class="dp-note">${esc(t.notes)}</div>` : ''}
          ${t.exitNotes ? `<div class="dp-note">Exit: ${esc(t.exitNotes)}</div>` : ''}
        </div>`).join('')
        : `<div class="daypanel-empty">No trades logged on this day.</div>`}
    </div>`;

  $('#dpAdd').addEventListener('click', () => openDialog(null, selectedDate));
  $$('.dp-trade', panel).forEach(el =>
    el.addEventListener('click', () => openDialog(trades.find(t => t.id === el.dataset.id))));
}

/* ---- trades table ---- */
function filteredTrades() {
  const q = $('#fSearch').value.trim().toLowerCase();
  const from = $('#fFrom').value, to = $('#fTo').value;
  const side = $('#fSide').value, result = $('#fResult').value, platform = $('#fPlatform').value;

  return trades.map(withDerived).filter(t => {
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (side && t.side !== side) return false;
    if (platform && t.platform !== platform) return false;
    if (result === 'open' && t.pnl != null) return false;
    if (result === 'win'  && !(t.pnl > 0)) return false;
    if (result === 'loss' && !(t.pnl < 0)) return false;
    if (result === 'flat' && (t.pnl == null || t.pnl !== 0)) return false;
    if (q) {
      const hay = [t.symbol, t.notes, t.exitNotes].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (va == null) va = -Infinity;
    if (vb == null) vb = -Infinity;
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    return (va - vb) * sortDir;
  });
}

/** symbol -> { price, prevClose, fetchedAt, loading, error } — shared across all rows so each
 *  unique symbol is only fetched once, regardless of how many trade rows reference it. */
const currentPriceCache = {};
const CURRENT_PRICE_TTL_MS = 5 * 60 * 1000;

/** Finnhub's free-tier /quote endpoint sends proper CORS headers (Access-Control-Allow-Origin: *),
 *  unlike Yahoo's unofficial endpoint and the public CORS proxies fronting it — those are flaky and
 *  frequently rate-limited/blocked from real browsers. Finnhub is the reliable primary source for a
 *  live quote when the user has supplied a free key; Yahoo+proxies remain the fallback/history source. */
const FINNHUB_KEY_STORAGE = 'tm.finnhubApiKey';
function getFinnhubApiKey() { return localStorage.getItem(FINNHUB_KEY_STORAGE) || ''; }
function saveFinnhubApiKey() {
  const key = $('#finnhubApiKey').value.trim();
  localStorage.setItem(FINNHUB_KEY_STORAGE, key);
  toast(key ? 'Finnhub API key saved' : 'Finnhub API key cleared');
  for (const k of Object.keys(currentPriceCache)) delete currentPriceCache[k];
  renderTrades();
  renderPositions();
}

async function fetchFinnhubQuote(symbol) {
  const key = getFinnhubApiKey();
  if (!key) return null;
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const data = await res.json();
  if (data == null || data.c == null || data.c === 0) throw new Error('No quote from Finnhub for this symbol');
  return { price: data.c, prevClose: data.pc ?? null };
}

function activePriceView() {
  if ($('#view-trades').classList.contains('is-active')) return 'trades';
  if ($('#view-positions').classList.contains('is-active')) return 'positions';
  if ($('#view-tradescheck').classList.contains('is-active')) return 'tradescheck';
  if ($('#view-scanner').classList.contains('is-active')) return 'scanner';
  return null;
}

/** The Scanner tab can have 100+ unique tickers on screen at once (vs. a handful of open
 *  trades/positions), so firing every quote fetch at once would blow through free-tier rate
 *  limits (Finnhub, and the unofficial Yahoo endpoint behind a CORS proxy) and stampede-fail.
 *  This caps how many quote fetches are in flight at a time; the rest just wait their turn. */
const quoteFetchQueue = [];
let activeQuoteFetches = 0;
const MAX_CONCURRENT_QUOTE_FETCHES = 4;

function drainQuoteFetchQueue() {
  while (activeQuoteFetches < MAX_CONCURRENT_QUOTE_FETCHES && quoteFetchQueue.length) {
    const run = quoteFetchQueue.shift();
    activeQuoteFetches++;
    run().finally(() => { activeQuoteFetches--; drainQuoteFetchQueue(); });
  }
}

function ensureCurrentPrice(symbol) {
  if (!activePriceView()) return;
  const c = currentPriceCache[symbol];
  if (c && (c.loading || (c.fetchedAt && Date.now() - c.fetchedAt < CURRENT_PRICE_TTL_MS))) return;
  currentPriceCache[symbol] = { loading: true };
  quoteFetchQueue.push(() => (getFinnhubApiKey() ? fetchFinnhubQuote(symbol) : fetchYahooChart(symbol).then(result => {
    const meta = result && result.meta;
    if (!meta || meta.regularMarketPrice == null) throw new Error('No quote in response');
    return { price: meta.regularMarketPrice, prevClose: meta.previousClose ?? null };
  })).then(quote => {
    currentPriceCache[symbol] = { price: quote.price, prevClose: quote.prevClose, fetchedAt: Date.now() };
  }).catch(err => {
    currentPriceCache[symbol] = { error: err.message, fetchedAt: Date.now() };
  }).finally(() => {
    const view = activePriceView();
    if (view === 'trades') renderTrades();
    else if (view === 'positions') renderPositions();
    else if (view === 'tradescheck') renderTradesCheck();
    else if (view === 'scanner') renderScanner();
    if (quickGroupDlg.open && quickGroupOpenSymbol === symbol) openQuickGroup(quickGroupOpenSymbol, quickGroupOpenSide);
  }));
  drainQuoteFetchQueue();
}

function quickGroupUnrealizedRow(g) {
  if (!(g.openQty > 0)) return '';
  const c = currentPriceCache[g.symbol];
  if (!c) { ensureCurrentPrice(g.symbol); return `<div class="pos-card-row"><span>Unrealized P/L</span><b>…</b></div>`; }
  if (c.loading) return `<div class="pos-card-row"><span>Unrealized P/L</span><b>…</b></div>`;
  if (c.error) return `<div class="pos-card-row"><span>Unrealized P/L</span><b title="${esc(c.error)}">—</b></div>`;
  const upl = calcUnrealized(g.side, g.avgCost, g.openQty, c.price);
  return `<div class="pos-card-row"><span>Unrealized P/L</span><b class="${cls(upl)}">${fmtMoney(upl, { sign: true })}</b></div>`;
}

/** Flags whether the live price has breached the stop, side-aware: a long is breached at or
 *  below its stop; a short (whose stop sits above entry) is breached at or above its stop.
 *  Falls back to the standard 5% default when the trade has no stop explicitly saved — trades
 *  opened before the default existed, or saved without ever touching the Stop loss field, still
 *  get flagged against the same 5% rule everything else uses, not silently skipped. */
function stopFlagDot(t, price) {
  if (t.pnl != null) return '';
  let stop = t.stop, isDefault = false;
  if (stop == null || stop === '' || !isFinite(stop)) {
    stop = computeDefaultStop(t.entry, t.side);
    isDefault = true;
    if (stop == null) return '';
  }
  const breached = t.side === 'short' ? price >= stop : price <= stop;
  const label = isDefault ? `default 5% stop (${fmtNum(stop)})` : `stop (${fmtNum(stop)})`;
  const title = breached
    ? `Stop breached — price is ${t.side === 'short' ? 'at/above' : 'at/below'} ${label}`
    : `Price is ${t.side === 'short' ? 'below' : 'above'} ${label}`;
  return ` <span class="stop-flag ${breached ? 'stop-breach' : 'stop-safe'}" title="${esc(title)}"></span>`;
}

/** Symbol-cell wrapper for stopFlagDot() — reads the live price straight from the cache since the
 *  Symbol column renders independently of currentPriceCell(). */
function symbolStopFlagDot(t) {
  const c = currentPriceCache[t.symbol];
  if (!c || c.loading || c.error || c.price == null) return '';
  return stopFlagDot(t, c.price);
}

function currentPriceCell(t) {
  const c = currentPriceCache[t.symbol];
  if (!c) { ensureCurrentPrice(t.symbol); return '<span class="pill">…</span>'; }
  if (c.loading) return '<span class="pill">…</span>';
  if (c.error) return `<span class="pill" title="${esc(c.error)}">—</span>`;
  const up = t.side === 'short' ? c.price < t.entry : c.price > t.entry;
  const down = t.side === 'short' ? c.price > t.entry : c.price < t.entry;
  const toneClass = up ? 'pos' : down ? 'neg' : 'zero';
  return `<span class="${toneClass}">${fmtNum(c.price)}</span>`;
}

/** Live unrealized % move from entry, or null if no usable quote yet. */
function unrealizedPct(t) {
  const c = currentPriceCache[t.symbol];
  if (!c || c.loading || c.error || c.price == null) return null;
  return (t.side === 'short' ? (t.entry - c.price) : (c.price - t.entry)) / t.entry * 100;
}

function unrealizedPctCell(t) {
  if (t.pnl != null) return '—';
  const c = currentPriceCache[t.symbol];
  if (!c || c.loading) return '<span class="pill">…</span>';
  if (c.error) return `<span class="pill" title="${esc(c.error)}">—</span>`;
  const pct = unrealizedPct(t);
  return `<b class="${cls(pct)}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b>`;
}

function realizedPctCell(t) {
  if (t.pnl == null || t.exit == null) return '—';
  const pct = (t.side === 'short' ? (t.entry - t.exit) : (t.exit - t.entry)) / t.entry * 100;
  return `<b class="${cls(pct)}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b>`;
}

function renderTrades() {
  const list = filteredTrades();
  $('#tradesEmpty').hidden = list.length > 0;
  $('#tradeBody').innerHTML = list.map(t => `
    <tr data-id="${t.id}">
      <td class="mono">${t.date}</td>
      <td><b>${esc(t.symbol)}</b>${symbolStopFlagDot(t)}</td>
      <td><span class="pill ${t.side}">${t.side}</span></td>
      <td>${t.platform ? `<span class="pill">${platformLabel(t.platform)}</span>` : '—'}</td>
      <td class="num">${fmtNum(t.qty)}</td>
      <td class="num">${fmtNum(t.entry)}</td>
      <td class="num">${currentPriceCell(t)}</td>
      <td class="num">${unrealizedPctCell(t)}</td>
      <td class="num">${t.exit == null ? '—' : fmtNum(t.exit)}</td>
      <td class="num">${t.days == null ? '—' : `${t.days}d${t.pnl == null ? ' (open)' : ''}`}</td>
      <td class="num ${t.pnl == null ? '' : cls(t.pnl)}">${
        t.pnl == null ? '<span class="pill">Open</span>' : `<b>${fmtMoney(t.pnl, { sign: true })}</b>`}</td>
      <td class="num">${realizedPctCell(t)}</td>
      <td class="num ${t.rmultiple == null ? '' : cls(t.rmultiple)}">${
        t.rmultiple == null ? '—' : (t.rmultiple >= 0 ? '+' : '') + t.rmultiple.toFixed(2)}</td>
      <td><button class="row-del" data-del="${t.id}" title="Delete">✕</button></td>
    </tr>`).join('');
}

/* ---- positions ---- */
function filteredPositions() {
  const q = $('#posSearch').value.trim().toLowerCase();
  const side = $('#posSide').value, status = $('#posStatusFilter').value, platform = $('#posPlatform').value;

  return positions.map(withPositionDerived).filter(p => {
    if (side && p.side !== side) return false;
    if (status && p.status !== status) return false;
    if (platform && p.platform !== platform) return false;
    if (q) {
      const hay = [p.symbol, p.thesis, p.lastNote].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Loose trades (scaled in/out one Trade row at a time, not through a tracked Position),
 *  grouped by symbol+side into a single card with a blended average cost — so scaling in
 *  or trimming via individual Trade rows still reads as one position per symbol. */
function quickPositionGroups() {
  const q = $('#posSearch').value.trim().toLowerCase();
  const side = $('#posSide').value, status = $('#posStatusFilter').value, platform = $('#posPlatform').value;

  const loose = trades.map(withDerived).filter(t => {
    if (isPositionTrade(t)) return false;
    if (side && t.side !== side) return false;
    if (platform && t.platform !== platform) return false;
    if (q) {
      const hay = [t.symbol, t.notes, t.exitNotes].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const groups = new Map();
  for (const t of loose) {
    const key = `${t.symbol}|${t.side}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = {
      symbol: t.symbol, side: t.side, platform: t.platform || '',
      openQty: 0, avgCost: 0, realizedPnl: 0, openCount: 0, closedCount: 0,
      firstDate: t.date, lastDate: t.exitDate || t.date,
    });
    if (isOpenTrade(t)) {
      g.avgCost = g.openQty === 0 ? t.entry : (g.avgCost * g.openQty + t.entry * t.qty) / (g.openQty + t.qty);
      g.openQty += t.qty;
      g.openCount++;
    } else {
      g.realizedPnl += (t.pnl || 0);
      g.closedCount++;
    }
    if (!g.platform && t.platform) g.platform = t.platform;
    if (t.date < g.firstDate) g.firstDate = t.date;
    const d = t.exitDate || t.date;
    if (d > g.lastDate) g.lastDate = d;
  }

  return Array.from(groups.values())
    .map(g => Object.assign(g, { status: g.openQty > 0 ? 'open' : 'closed' }))
    .filter(g => !status || g.status === status);
}

/** Unfiltered constituent trades for one quick-position group, for the detail dialog. */
function quickGroupTrades(symbol, side) {
  return trades.map(withDerived)
    .filter(t => !isPositionTrade(t) && t.symbol === symbol && t.side === side)
    .sort((a, b) => (b.exitDate || b.date).localeCompare(a.exitDate || a.date));
}

function statusLabel(s) {
  return s === 'working' ? 'Working' : s === 'not-working' ? 'Not working' : s === 'watch' ? 'Watch' : '';
}
function statusPillClass(s) {
  return s === 'working' ? 'working' : s === 'not-working' ? 'notworking' : s === 'watch' ? 'watch' : '';
}

function renderPositions() {
  const statusFilter = $('#posStatusFilter').value;
  $('#posOpenWrap').hidden = statusFilter === 'closed';
  $('#posClosedWrap').hidden = statusFilter === 'open';

  const list = filteredPositions();
  const open = list.filter(p => p.status === 'open').sort((a, b) => b.openDate.localeCompare(a.openDate));
  const closed = list.filter(p => p.status === 'closed').sort((a, b) => (b.closedDate || '').localeCompare(a.closedDate || ''));

  const quickGroups = quickPositionGroups();
  const openGroups = quickGroups.filter(g => g.status === 'open').sort((a, b) => b.lastDate.localeCompare(a.lastDate));
  const closedGroups = quickGroups.filter(g => g.status === 'closed').sort((a, b) => b.lastDate.localeCompare(a.lastDate));

  $('#posEmpty').hidden = (open.length + openGroups.length) > 0;
  $('#posGrid').innerHTML =
    open.map(p => `
    <button class="pos-card" data-type="position" data-id="${p.id}">
      <div class="pos-card-head">
        <span class="pos-card-sym">${esc(p.symbol)}</span>
        <span class="pos-card-pills">
          <span class="pill ${p.side}">${p.side}</span>
          ${p.platform ? `<span class="pill">${platformLabel(p.platform)}</span>` : ''}
          ${p.lastStatus ? `<span class="pill ${statusPillClass(p.lastStatus)}">${statusLabel(p.lastStatus)}</span>` : ''}
        </span>
      </div>
      <div class="pos-card-pnl-label">Unrealized P/L</div>
      <div class="pos-card-pnl ${cls(p.unrealizedPnl)}">${fmtMoney(p.unrealizedPnl, { sign: true })}</div>
      <div class="pos-card-row"><span>Realized P/L</span><b class="${cls(p.realizedPnl)}">${fmtMoney(p.realizedPnl, { sign: true })}</b></div>
      <div class="pos-card-row"><span>Avg cost</span><b>${fmtNum(p.avgCost)}</b></div>
      <div class="pos-card-row"><span>Qty open</span><b>${fmtNum(p.remainingQty)}</b></div>
      <div class="pos-card-row"><span>Move from entry</span><b class="${cls(p.pctMove)}">${p.pctMove >= 0 ? '+' : ''}${p.pctMove.toFixed(2)}%</b></div>
      ${p.lastNote ? `<div class="pos-card-note">${esc(p.lastNote)}</div>` : ''}
    </button>`).join('')
    + openGroups.map(g => `
    <button class="pos-card" data-type="quickgroup" data-symbol="${esc(g.symbol)}" data-side="${g.side}">
      <div class="pos-card-head">
        <span class="pos-card-sym">${esc(g.symbol)}</span>
        <span class="pos-card-pills">
          <span class="pill ${g.side}">${g.side}</span>
          ${g.platform ? `<span class="pill">${platformLabel(g.platform)}</span>` : ''}
          <span class="pill">Quick × ${g.openCount}</span>
        </span>
      </div>
      <div class="pos-card-row"><span>Avg cost</span><b>${fmtNum(g.avgCost)}</b></div>
      <div class="pos-card-row"><span>Qty open</span><b>${fmtNum(g.openQty)}</b></div>
      ${quickGroupUnrealizedRow(g)}
      ${g.realizedPnl ? `<div class="pos-card-row"><span>Realized P/L</span><b class="${cls(g.realizedPnl)}">${fmtMoney(g.realizedPnl, { sign: true })}</b></div>` : ''}
      <div class="pos-card-note">${g.openCount} open lot${g.openCount === 1 ? '' : 's'}${g.closedCount ? `, ${g.closedCount} closed` : ''} — click to view.</div>
    </button>`).join('');

  $('#posClosedEmpty').hidden = (closed.length + closedGroups.length) > 0;
  $('#posClosedBody').innerHTML = closed.map(p => `
    <tr data-type="position" data-id="${p.id}">
      <td><b>${esc(p.symbol)}</b></td>
      <td><span class="pill ${p.side}">${p.side}</span></td>
      <td>${p.platform ? platformLabel(p.platform) : '—'}</td>
      <td class="mono">${p.openDate}</td>
      <td class="mono">${p.closedDate || '—'}</td>
      <td class="num">${sortedEvents(p).filter(e => e.type === 'trim').length}</td>
      <td class="num ${cls(p.realizedPnl)}"><b>${fmtMoney(p.realizedPnl, { sign: true })}</b></td>
    </tr>`).join('')
    + closedGroups.map(g => `
    <tr data-type="quickgroup" data-symbol="${esc(g.symbol)}" data-side="${g.side}">
      <td><b>${esc(g.symbol)}</b> <span class="pill">Quick × ${g.closedCount}</span></td>
      <td><span class="pill ${g.side}">${g.side}</span></td>
      <td>${g.platform ? platformLabel(g.platform) : '—'}</td>
      <td class="mono">${g.firstDate}</td>
      <td class="mono">${g.lastDate}</td>
      <td class="num">${g.closedCount}</td>
      <td class="num ${cls(g.realizedPnl)}"><b>${fmtMoney(g.realizedPnl, { sign: true })}</b></td>
    </tr>`).join('');
}

/** Fetch daily OHLC history for a symbol from Yahoo Finance's chart endpoint (no key needed).
 *  Yahoo doesn't reliably send CORS headers, so fall back to public CORS proxies on failure.
 *  corsproxy.io now rejects most free/anonymous traffic ("Server-side requests are not allowed
 *  on your plan"), so allorigins is tried first with corsproxy kept as a last-resort fallback. */
async function fetchYahooChart(symbol, range = '6mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const attempts = [
    url,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  ];
  let lastErr;
  for (const target of attempts) {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const res = await fetch(target);
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const data = await res.json();
        const result = data && data.chart && data.chart.result && data.chart.result[0];
        if (!result) { lastErr = new Error(data?.chart?.error?.description || 'No data returned'); continue; }
        return result;
      } catch (e) { lastErr = e; }
    }
  }
  throw new Error(`Could not fetch price data for ${symbol} (${lastErr ? lastErr.message : 'unknown error'}). Yahoo may be blocking direct/proxied browser requests right now — check the symbol is valid, or try again.`);
}

/* ---- trade chart screenshots (daily-timeframe, entry/exit markers) ---- */

const CHART_LOOKBACK_DAYS = 40; // calendar days of context shown before the entry marker

/** Smallest Yahoo `range` value that reaches back `daysNeeded` days from today. */
function yahooRangeFor(daysNeeded) {
  if (daysNeeded <= 85) return '3mo';
  if (daysNeeded <= 170) return '6mo';
  if (daysNeeded <= 340) return '1y';
  if (daysNeeded <= 680) return '2y';
  return '5y';
}

function barsFromYahooChart(result) {
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ date: ymd(new Date(ts[i] * 1000)), open: o, high: h, low: l, close: c });
  }
  return bars;
}

/** Builds and uploads the chart image for a trade — entry marker only while open, entry+exit
 *  once closed — to a fixed path keyed by trade id, so closing a trade overwrites the
 *  entry-only image in place instead of leaving a second, now-redundant file behind. Never
 *  throws; a failure just leaves the trade without a chart (or its last successful one). */
async function generateTradeChart(t) {
  if (!currentUser || !t.entry || !t.symbol) return;
  try {
    const today = ymd(new Date());
    const entryDate = t.entryDate || t.date;
    const endDate = t.exitDate || today;
    const startDate = ymd(new Date(parseYmd(entryDate).getTime() - CHART_LOOKBACK_DAYS * 86400000));
    const result = await fetchYahooChart(t.symbol, yahooRangeFor(daysBetween(startDate, today)));
    const bars = barsFromYahooChart(result).filter(b => b.date >= startDate && b.date <= endDate);

    const canvas = ChartRender.renderTradeChart(bars, {
      symbol: t.symbol, side: t.side,
      entryDate, entryPrice: t.entry,
      exitDate: t.exitDate || null, exitPrice: t.exit ?? null,
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Canvas produced no image data');

    const path = `${currentUser.id}/${t.id}.png`;
    const { error } = await sb.storage.from('trade-charts').upload(path, blob, {
      contentType: 'image/png', upsert: true,
    });
    if (error) throw error;

    const i = trades.findIndex(x => x.id === t.id);
    if (i >= 0 && trades[i].chartPath !== path) { trades[i].chartPath = path; saveTrades(); }
    if ($('#tradeForm').elements.id.value === t.id) showTradeChart(t.id);
  } catch (err) {
    console.error(`Chart generation failed for ${t.symbol}:`, err.message || err);
    if ($('#tradeForm').elements.id.value === t.id) {
      $('#tradeChartBody').innerHTML = `<span class="muted">Chart failed to load — ${esc(err.message || 'unknown error')}</span>`;
    }
  }
}

async function getTradeChartUrl(path) {
  const { data, error } = await sb.storage.from('trade-charts').createSignedUrl(path, 3600);
  if (error) { console.error('Could not load chart:', error.message); return null; }
  return data.signedUrl;
}

/** Shows the chart for trade `id` in the open trade dialog, fetching a fresh signed URL. */
async function showTradeChart(id) {
  const t = trades.find(x => x.id === id);
  const wrap = $('#tradeChartWrap'), body = $('#tradeChartBody');
  if (!t || !t.chartPath) { wrap.hidden = true; return; }
  wrap.hidden = false;
  body.innerHTML = `<span class="muted">Loading…</span>`;
  const url = await getTradeChartUrl(t.chartPath);
  // The dialog may have been closed/reopened for a different trade while this was in flight.
  if ($('#tradeForm').elements.id.value !== id) return;
  body.innerHTML = url ? `<img src="${esc(url)}" alt="Daily chart for ${esc(t.symbol)}">`
    : `<span class="muted">Chart unavailable right now.</span>`;
}

/** One chart per fully-closed position, covering its whole lifecycle: entry, every add/trim,
 *  and the final close, all on a single daily chart — generated only once the position closes
 *  (see resyncPositionTrades), not on every scale-in/trim along the way. Same overwrite-in-place
 *  approach as generateTradeChart: re-closing (e.g. after editing an old event) replaces the
 *  same file rather than accumulating copies. */
async function generatePositionChart(pos) {
  if (!currentUser || !pos.symbol || !pos.events.length) return;
  try {
    const today = ymd(new Date());
    const startDate = ymd(new Date(parseYmd(pos.openDate).getTime() - CHART_LOOKBACK_DAYS * 86400000));
    const endDate = pos.closedDate || today;
    const result = await fetchYahooChart(pos.symbol, yahooRangeFor(daysBetween(startDate, today)));
    const bars = barsFromYahooChart(result).filter(b => b.date >= startDate && b.date <= endDate);

    const events = sortedEvents(pos).filter(e => e.price != null && (e.type === 'entry' || e.type === 'add' || e.type === 'trim'));
    const lastTrim = events.filter(e => e.type === 'trim').slice(-1)[0];
    const markers = events.map(e => {
      if (e.type === 'entry') return { date: e.date, price: e.price, label: 'ENTRY', color: ChartRender.COLORS.entry, dir: 'up' };
      if (e.type === 'add') return { date: e.date, price: e.price, label: 'ADD', color: ChartRender.COLORS.add, dir: 'up' };
      const isClose = e === lastTrim;
      return { date: e.date, price: e.price, label: isClose ? 'CLOSE' : 'TRIM', color: isClose ? ChartRender.COLORS.close : ChartRender.COLORS.trim, dir: 'down' };
    });

    const canvas = ChartRender.renderChart(bars, { symbol: pos.symbol, markers });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Canvas produced no image data');

    const path = `${currentUser.id}/position-${pos.id}.png`;
    const { error } = await sb.storage.from('trade-charts').upload(path, blob, {
      contentType: 'image/png', upsert: true,
    });
    if (error) throw error;

    if (pos.chartPath !== path) { pos.chartPath = path; savePositions(); }
    if (viewingPositionId === pos.id) showPositionChart(pos.id);
  } catch (err) {
    console.error(`Position chart generation failed for ${pos.symbol}:`, err.message || err);
    if (viewingPositionId === pos.id) {
      $('#pdChartWrap').hidden = false;
      $('#pdChartBody').innerHTML = `<span class="muted">Chart failed to load — ${esc(err.message || 'unknown error')}</span>`;
    }
  }
}

/** Shows the lifecycle chart for position `id` in the open position-detail dialog. */
async function showPositionChart(id) {
  const pos = positions.find(p => p.id === id);
  const wrap = $('#pdChartWrap'), body = $('#pdChartBody');
  if (!pos || !pos.chartPath) { wrap.hidden = true; return; }
  wrap.hidden = false;
  body.innerHTML = `<span class="muted">Loading…</span>`;
  const url = await getTradeChartUrl(pos.chartPath);
  if (viewingPositionId !== id) return;
  body.innerHTML = url ? `<img src="${esc(url)}" alt="Lifecycle chart for ${esc(pos.symbol)}">`
    : `<span class="muted">Chart unavailable right now.</span>`;
}

/** Manual "pull the latest from cloud" action. pullCloudState() normally only runs once, right
 *  after sign-in (see onAuthStateChange below) — a tab left open (this site or a VS Code Live
 *  Preview tab pointed at the same local files) has no other way to learn about a change made
 *  from elsewhere until it's reloaded. This lets you force that reconciliation on demand. */
async function syncNow() {
  if (!currentUser) { toast('Sign in first to sync.'); return; }
  toast('Syncing…');
  await pullCloudState();
  renderAll();
  toast('Synced with cloud.');
}

/** Generates charts for existing trades/closed positions that don't have one yet — covers data
 *  that predates this feature. Individual trades linked to a position are skipped (they're
 *  covered by that position's own lifecycle chart, not their own). Runs one at a time (each
 *  generateTradeChart/generatePositionChart call is awaited in turn) so it doesn't burst Yahoo/
 *  Finnhub with concurrent requests. */
async function backfillTradeCharts() {
  if (!currentUser) { toast('Sign in first to generate charts.'); return; }
  const targetTrades = trades.filter(t => !t.positionId && !t.chartPath && t.entry);
  const targetPositions = positions.filter(p => p.status === 'closed' && !p.chartPath);
  const total = targetTrades.length + targetPositions.length;
  if (!total) { toast('Every trade and closed position already has a chart.'); return; }

  toast(`Generating ${total} chart${total === 1 ? '' : 's'}… this may take a bit — feel free to keep using the app.`);
  let done = 0;
  for (const t of targetTrades) { await generateTradeChart(t); done++; }
  for (const p of targetPositions) { await generatePositionChart(p); done++; }
  renderAll();
  toast(`Backfilled ${done} chart${done === 1 ? '' : 's'}.`);
}

/* ---- trades check: flag open trades/positions against a fixed rule set ---- */
const TC_LOSS_CAP_PCT = -10;               // rule 1: unrealized loss must stay above this
const TC_EARLY_LOSS_PCT = -2;              // rule 2: loss threshold within the early window
const TC_EARLY_WINDOW_DAYS = 2;            // rule 2 & 3: "within 2 days of entry" / "immediately"
const TC_CAPITAL_CAP = 20000;              // rule 4: max capital per symbol+side
const TC_REGULAR_HOLD_DAYS = 21;           // rule 4: regular hold period, calendar days
const TC_REGULAR_HOLD_TRADING_DAYS = 15;   // rule 4: regular hold period, trading days
const TC_CAPITAL_REDUCE_TRADING_DAYS = 3;  // rule 4: grace period to bring capital back under cap

/** Evaluates the fixed rule set against current open trades/positions. Nothing here is stored —
 *  it's recomputed fresh each render from trades/positions plus whatever live quotes are cached. */
function computeTradesCheck() {
  const openTrades = trades.map(withDerived).filter(t => t.pnl == null);
  openTrades.forEach(t => ensureCurrentPrice(t.symbol));
  const withPct = openTrades.map(t => ({ t, pct: unrealizedPct(t) }));

  const rule1 = withPct.filter(x => x.pct != null && x.pct <= TC_LOSS_CAP_PCT);
  const rule2 = withPct.filter(x => x.pct != null && x.t.days != null && x.t.days <= TC_EARLY_WINDOW_DAYS && x.pct <= TC_EARLY_LOSS_PCT);
  const rule3 = withPct.filter(x => x.pct != null && x.t.days != null && x.t.days <= TC_EARLY_WINDOW_DAYS && x.pct > 0);

  // Capital cap (rule 4) looks at total capital per symbol+side across BOTH loose open trades
  // and open multi-leg Positions, since that's a portfolio-level exposure question, not a
  // per-trade one — unlike rules 1-3, which are about a single trade's own live % move.
  const capMap = new Map();
  function addCapital(symbol, side, capital, entryDate) {
    const key = `${symbol}|${side}`;
    let g = capMap.get(key);
    if (!g) capMap.set(key, g = { symbol, side, capital: 0, entryDate });
    g.capital += capital;
    if (entryDate && (!g.entryDate || entryDate < g.entryDate)) g.entryDate = entryDate;
  }
  trades.filter(t => !isPositionTrade(t) && isOpenTrade(t)).forEach(t => addCapital(t.symbol, t.side, t.entry * t.qty, t.entryDate || t.date));
  positions.filter(p => p.status === 'open').map(withPositionDerived).forEach(p => {
    if (p.remainingQty > 0) addCapital(p.symbol, p.side, p.avgCost * p.remainingQty, p.openDate);
  });

  const today = ymd(new Date());
  const rule4 = Array.from(capMap.values())
    .filter(g => g.capital > TC_CAPITAL_CAP)
    .map(g => {
      const calDays = g.entryDate ? daysBetween(g.entryDate, today) : null;
      const tDays = g.entryDate ? tradingDaysBetween(g.entryDate, today) : null;
      const beyondRegularHold = (calDays != null && calDays > TC_REGULAR_HOLD_DAYS) || (tDays != null && tDays > TC_REGULAR_HOLD_TRADING_DAYS);
      return Object.assign(g, { calDays, tDays, beyondRegularHold });
    })
    .sort((a, b) => b.capital - a.capital);

  return { openCount: openTrades.length, rule1, rule2, rule3, rule4 };
}

function renderTradesCheck() {
  const { openCount, rule1, rule2, rule3, rule4 } = computeTradesCheck();
  const flagCount = rule1.length + rule2.length + rule3.length + rule4.length;

  $('#tcSummaryGrid').innerHTML = `
    <div class="stat"><div class="stat-label">Open trades checked</div><div class="stat-value">${openCount}</div></div>
    <div class="stat"><div class="stat-label">Rules flagged</div>
      <div class="stat-value ${flagCount ? 'neg' : 'pos'}">${flagCount}</div>
      <div class="stat-sub">${flagCount ? 'See below' : 'All clear'}</div></div>`;

  const rowOrEmpty = (rows, emptySel, bodySel, html) => {
    $(emptySel).hidden = rows.length > 0;
    $(bodySel).innerHTML = rows.map(html).join('');
  };

  rowOrEmpty(rule1, '#tcRule1Empty', '#tcRule1Body', ({ t, pct }) => `
    <tr>
      <td><b>${esc(t.symbol)}</b></td>
      <td><span class="pill ${t.side}">${t.side}</span></td>
      <td class="num neg"><b>${pct.toFixed(2)}%</b></td>
      <td class="mono">${t.entryDate || t.date}</td>
    </tr>`);

  rowOrEmpty(rule2, '#tcRule2Empty', '#tcRule2Body', ({ t, pct }) => `
    <tr>
      <td><b>${esc(t.symbol)}</b></td>
      <td><span class="pill ${t.side}">${t.side}</span></td>
      <td class="num neg"><b>${pct.toFixed(2)}%</b></td>
      <td class="num">${t.days}d</td>
      <td><span class="pill notworking">Exit now</span></td>
    </tr>`);

  rowOrEmpty(rule3, '#tcRule3Empty', '#tcRule3Body', ({ t, pct }) => `
    <tr>
      <td><b>${esc(t.symbol)}</b></td>
      <td><span class="pill ${t.side}">${t.side}</span></td>
      <td class="num pos"><b>+${pct.toFixed(2)}%</b></td>
      <td class="num">${t.days}d</td>
      <td><span class="pill working">Add to position</span></td>
    </tr>`);

  rowOrEmpty(rule4, '#tcRule4Empty', '#tcRule4Body', g => `
    <tr>
      <td><b>${esc(g.symbol)}</b></td>
      <td><span class="pill ${g.side}">${g.side}</span></td>
      <td class="num neg"><b>${fmtMoney(g.capital)}</b></td>
      <td class="num">${fmtMoney(g.capital - TC_CAPITAL_CAP)}</td>
      <td class="num">${g.calDays != null ? `${g.calDays}d / ${g.tDays}td` : '—'}</td>
      <td>${g.beyondRegularHold
        ? `<span class="pill notworking">Reduce within ${TC_CAPITAL_REDUCE_TRADING_DAYS} trading days</span>`
        : `<span class="pill watch">Within regular hold — reduce if it runs past ${TC_REGULAR_HOLD_DAYS}d/${TC_REGULAR_HOLD_TRADING_DAYS}td</span>`}</td>
    </tr>`);
}

/* ---- swing scanner ---- */
const SCAN_PATTERN_GROUPS = [
  { key: 'ipo_base', bodyId: '#scanBodyIpoBase', emptyId: '#scanEmptyIpoBase' },
  { key: 'downtrend_reversal', bodyId: '#scanBodyDowntrendReversal', emptyId: '#scanEmptyDowntrendReversal' },
  { key: 'high_consolidation', bodyId: '#scanBodyHighConsolidation', emptyId: '#scanEmptyHighConsolidation' },
  { key: 'trend_continuation', bodyId: '#scanBodyTrendContinuation', emptyId: '#scanEmptyTrendContinuation' },
];

/** Live quote for a scan match, independent of when the scan itself last ran — the scan's
 *  own last_close is only used as the up/down comparison baseline and as a fallback while
 *  the live quote is still loading or failed. */
function scanCurrentPriceCell(m) {
  const c = currentPriceCache[m.ticker];
  if (!c) {
    ensureCurrentPrice(m.ticker);
    return m.last_close != null ? `<span class="pill" title="Scan-time close, live quote loading…">${fmtMoney(m.last_close)}</span>` : '<span class="pill">…</span>';
  }
  if (c.loading) return m.last_close != null ? `<span class="pill" title="Scan-time close, live quote loading…">${fmtMoney(m.last_close)}</span>` : '<span class="pill">…</span>';
  if (c.error) return m.last_close != null ? `<span class="pill" title="${esc(c.error)} — showing scan-time close">${fmtMoney(m.last_close)}</span>` : `<span class="pill" title="${esc(c.error)}">—</span>`;
  if (m.last_close == null) return fmtNum(c.price);
  const up = c.price > m.last_close, down = c.price < m.last_close;
  const toneClass = up ? 'pos' : down ? 'neg' : 'zero';
  return `<span class="${toneClass}" title="Close at scan time: ${fmtMoney(m.last_close)}">${fmtNum(c.price)}</span>`;
}

function scanMatchRow(m, groupId, collapsed) {
  return `
    <tr class="scan-group-row" data-group="${esc(groupId)}"${collapsed ? ' hidden' : ''}>
      <td><b>${esc(m.ticker)}</b></td>
      <td class="num">${scanCurrentPriceCell(m)}</td>
      <td class="num">${m.rs_percentile != null ? m.rs_percentile.toFixed(1) : '—'}</td>
      <td>${m.sector_leader ? '<span class="pill working">Leader</span>' : ''}</td>
      <td>${m.earnings_within_14d ? '<span class="pill watch">Soon</span>' : ''}</td>
    </tr>`;
}

/** Clusters a pattern's matches by industry so correlated setups (several names in the same
 *  industry breaking out together) are visually obvious instead of buried in one flat list.
 *  Groups sort leading-theme industries first, then by their best RS percentile, so the
 *  strongest clusters land at the top; rows within a group sort by RS percentile too. */
function groupByIndustry(rows) {
  const map = new Map();
  for (const m of rows) {
    const key = m.industry || m.sector || '—';
    let g = map.get(key);
    if (!g) map.set(key, g = { industry: key, leadingTheme: false, rows: [] });
    g.rows.push(m);
    if (m.leading_theme) g.leadingTheme = true;
  }
  const groups = Array.from(map.values());
  for (const g of groups) g.rows.sort((a, b) => (b.rs_percentile ?? -1) - (a.rs_percentile ?? -1));
  groups.sort((a, b) => {
    if (a.leadingTheme !== b.leadingTheme) return a.leadingTheme ? -1 : 1;
    const bestA = Math.max(...a.rows.map(r => r.rs_percentile ?? -1));
    const bestB = Math.max(...b.rows.map(r => r.rs_percentile ?? -1));
    if (bestA !== bestB) return bestB - bestA;
    return a.industry.localeCompare(b.industry);
  });
  return groups;
}

// Which industry groups are collapsed, keyed by "<patternKey>::<industry>" so it stays stable
// (and survives) across re-renders — renderScanner() rebuilds each tbody's HTML from scratch on
// every call (any trade/position save re-renders the whole app), so collapse state can't live
// in the DOM the way the pattern-panel <details> elements' own open/closed state does.
const collapsedScanGroups = new Set();

function renderScanGroups(rows, patternKey) {
  return groupByIndustry(rows).map(g => {
    const gid = `${patternKey}::${g.industry}`;
    const collapsed = collapsedScanGroups.has(gid);
    return `
    <tr class="scan-group-head${g.leadingTheme ? ' leading-theme' : ''}${collapsed ? ' collapsed' : ''}" data-group="${esc(gid)}"
        title="${g.leadingTheme ? 'Leading theme — one of the strongest relative-strength industries this run' : ''}">
      <td colspan="5"><span class="scan-group-chevron">▸</span>${esc(g.industry)} <span class="scan-group-count">${g.rows.length}</span></td>
    </tr>
    ${g.rows.map(m => scanMatchRow(m, gid, collapsed)).join('')}`;
  }).join('');
}

function renderScanner() {
  const matches = (scannerData && scannerData.matches) || [];

  $('#scanSummaryGrid').innerHTML = `
    <div class="stat"><div class="stat-label">Matches</div><div class="stat-value">${matches.length}</div></div>
    <div class="stat"><div class="stat-label">Universe file</div>
      <div class="stat-value" style="font-size:16px">${scannerData ? esc(scannerData.universeFile || '—') : '—'}</div></div>`;

  const lastRunText = scannerData && scannerData.generatedAt
    ? `Last run: ${new Date(scannerData.generatedAt).toLocaleString()}`
    : '';
  document.querySelectorAll('.scan-last-run').forEach(el => { el.textContent = lastRunText; });

  $('#scanEmpty').hidden = matches.length > 0;

  // A ticker can match more than one pattern -- it appears in every group it
  // matched, since these are independent setups, not mutually exclusive categories.
  SCAN_PATTERN_GROUPS.forEach(({ key, bodyId, emptyId }) => {
    const group = matches.filter(m => (m.patterns || '').split(', ').includes(key));
    $(emptyId).hidden = group.length > 0;
    $(bodyId).innerHTML = renderScanGroups(group, key);
  });
}

/* ---- stats ---- */
function renderStats() {
  const list = trades.map(withDerived);
  const grid = $('#statGrid');

  if (!list.length) {
    grid.innerHTML = `<div class="stat"><div class="stat-label">No data</div>
      <div class="stat-value">—</div><div class="stat-sub">Log a trade to see stats</div></div>`;
    $('#equityChart').innerHTML = ''; $('#monthChart').innerHTML = '';
    $('#bySymbol').innerHTML = $('#byPlatform').innerHTML = $('#byWeekday').innerHTML = '';
    return;
  }

  const openCount = list.filter(t => t.pnl == null).length;
  const closedList = list.filter(t => t.pnl != null);

  const pnls = closedList.map(t => t.pnl);
  const wins = pnls.filter(p => p > 0), losses = pnls.filter(p => p < 0);
  const gross = { win: wins.reduce((s, p) => s + p, 0), loss: Math.abs(losses.reduce((s, p) => s + p, 0)) };
  const total = pnls.reduce((s, p) => s + p, 0);
  const avgWin = wins.length ? gross.win / wins.length : 0;
  const avgLoss = losses.length ? gross.loss / losses.length : 0;
  const decided = wins.length + losses.length;
  const winRate = decided ? wins.length / decided : 0;
  const expectancy = closedList.length ? total / closedList.length : 0;
  const pf = gross.loss ? gross.win / gross.loss : (gross.win ? Infinity : 0);

  // max drawdown on the cumulative curve (chronological, closed trades only)
  const chrono = closedList.slice().sort((a, b) => a.date.localeCompare(b.date));
  let peak = 0, run = 0, maxDD = 0;
  for (const t of chrono) { run += t.pnl; peak = Math.max(peak, run); maxDD = Math.min(maxDD, run - peak); }

  // day streaks
  const dayEntries = Array.from(byDate().entries()).sort((a, b) => a[0].localeCompare(b[0]));
  let curW = 0, bestW = 0, curL = 0, bestL = 0;
  for (const [, d] of dayEntries) {
    if (d.pnl > 0) { curW++; curL = 0; bestW = Math.max(bestW, curW); }
    else if (d.pnl < 0) { curL++; curW = 0; bestL = Math.max(bestL, curL); }
  }

  const rs = closedList.map(t => t.rmultiple).filter(r => r != null);
  const avgR = rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null;

  const best = chrono.length ? chrono.reduce((a, b) => b.pnl > a.pnl ? b : a) : null;
  // Excludes the trade already picked as best — with only one closed trade (or a tie for best),
  // reducing over the full list would pick that same trade again and "Worst" would just repeat
  // "Best" verbatim, which reads as a bug even though the number is technically correct.
  const worstPool = best ? chrono.filter(t => t.id !== best.id) : [];
  const worst = worstPool.length ? worstPool.reduce((a, b) => b.pnl < a.pnl ? b : a) : null;

  const cards = [
    ['Net P/L', `<span class="${cls(total)}">${fmtMoney(total, { sign: true })}</span>`, `${closedList.length} closed${openCount ? `, ${openCount} open` : ''}`],
    ['Win rate', `${(winRate * 100).toFixed(1)}%`, `${wins.length}W / ${losses.length}L`],
    ['Profit factor', pf === Infinity ? '∞' : pf.toFixed(2), 'gross win ÷ gross loss'],
    ['Expectancy', `<span class="${cls(expectancy)}">${fmtMoney(expectancy, { sign: true })}</span>`, 'per closed trade'],
    ['Avg win', `<span class="pos">${fmtMoney(avgWin)}</span>`, `avg loss ${fmtMoney(avgLoss)}`],
    ['Payoff ratio', avgLoss ? (avgWin / avgLoss).toFixed(2) : '—', 'avg win ÷ avg loss'],
    ['Max drawdown', `<span class="neg">${fmtMoney(maxDD)}</span>`, 'peak to trough'],
    ['Avg R', avgR == null ? '—' : `<span class="${cls(avgR)}">${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R</span>`,
      `${rs.length} trades with a stop`],
    ['Best day streak', `${bestW} day${bestW === 1 ? '' : 's'}`, `worst run ${bestL} day${bestL === 1 ? '' : 's'}`],
    ['Best trade', best ? `<span class="pos">${fmtMoney(best.pnl, { sign: true })}</span>` : '—', best ? `${esc(best.symbol)} · ${best.date}` : ''],
    ['Worst trade', worst ? `<span class="${cls(worst.pnl)}">${fmtMoney(worst.pnl, { sign: true })}</span>` : '—',
      worst ? `${esc(worst.symbol)} · ${worst.date}` : (chrono.length ? 'only one closed trade so far' : '')],
    ['Days traded', String(dayEntries.length), `${fmtMoney(total / (dayEntries.length || 1), { sign: true })} / day`],
  ];
  grid.innerHTML = cards.map(([l, v, s]) =>
    `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div>
     <div class="stat-sub">${s}</div></div>`).join('');

  drawEquity(chrono);
  drawMonths(closedList);
  renderBreakdown('#bySymbol', groupBy(closedList, t => t.symbol));
  renderBreakdown('#byPlatform', groupBy(closedList, t => t.platform ? platformLabel(t.platform) : '(none)'));
  renderBreakdown('#byWeekday', groupBy(closedList, t => WEEKDAYS[parseYmd(t.date).getDay()]), false);
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const t of list) {
    const k = keyFn(t);
    let e = m.get(k);
    if (!e) m.set(k, e = { key: k, pnl: 0, n: 0, wins: 0 });
    e.pnl += t.pnl; e.n++; if (t.pnl > 0) e.wins++;
  }
  return Array.from(m.values());
}

function renderBreakdown(sel, rows, sortByPnl = true) {
  if (sortByPnl) rows.sort((a, b) => b.pnl - a.pnl);
  $(sel).innerHTML = rows.map(r => `
    <tr>
      <td><b>${esc(r.key)}</b></td>
      <td class="num">${r.n}</td>
      <td class="num">${((r.wins / r.n) * 100).toFixed(0)}%</td>
      <td class="num ${cls(r.pnl)}"><b>${fmtMoney(r.pnl, { sign: true })}</b></td>
    </tr>`).join('') || `<tr><td class="empty">No data</td></tr>`;
}

/* ---- charts (hand-rolled SVG, no libraries) ---- */
function drawEquity(chrono) {
  const svg = $('#equityChart');
  const W = 1000, H = 220, pad = { l: 8, r: 8, t: 12, b: 22 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  let run = 0;
  const pts = chrono.map((t, i) => { run += t.pnl; return { i, v: run, date: t.date }; });
  if (pts.length < 2) { svg.innerHTML = `<text x="12" y="30" class="axis-txt">Need at least 2 trades</text>`; return; }

  const vs = pts.map(p => p.v);
  const min = Math.min(0, ...vs), max = Math.max(0, ...vs);
  const span = (max - min) || 1;
  const x = i => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
  const y = v => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;

  svg.innerHTML = `
    <path class="eq-area" d="${area}"/>
    <line class="axis" x1="${pad.l}" y1="${y(0)}" x2="${W - pad.r}" y2="${y(0)}"/>
    <path class="eq-line" d="${line}"/>
    <text class="axis-txt" x="${pad.l}" y="${H - 6}">${pts[0].date}</text>
    <text class="axis-txt" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${pts[pts.length - 1].date}</text>
    <text class="axis-txt" x="${pad.l}" y="${y(max) - 3}">${fmtCompact(max)}</text>`;
}

function drawMonths(list) {
  const svg = $('#monthChart');
  const W = 600, H = 220, pad = { l: 8, r: 8, t: 14, b: 26 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const m = new Map();
  for (const t of list) {
    const k = t.date.slice(0, 7);
    m.set(k, (m.get(k) || 0) + t.pnl);
  }
  const rows = Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  if (!rows.length) { svg.innerHTML = ''; return; }

  const maxAbs = Math.max(...rows.map(r => Math.abs(r[1]))) || 1;
  const bw = (W - pad.l - pad.r) / rows.length;
  const zeroY = pad.t + (H - pad.t - pad.b) / 2;
  const half = (H - pad.t - pad.b) / 2;

  svg.innerHTML = rows.map(([k, v], i) => {
    const h = Math.max(1, (Math.abs(v) / maxAbs) * half);
    const bx = pad.l + i * bw + bw * 0.15;
    const by = v >= 0 ? zeroY - h : zeroY;
    return `<rect class="${v >= 0 ? 'bar-pos' : 'bar-neg'}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}"
              width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${k}: ${fmtMoney(v, { sign: true })}</title></rect>
            <text class="axis-txt" x="${(bx + bw * 0.35).toFixed(1)}" y="${H - 8}" text-anchor="middle">${k.slice(2)}</text>`;
  }).join('') + `<line class="axis" x1="${pad.l}" y1="${zeroY}" x2="${W - pad.r}" y2="${zeroY}"/>`;
}

/* ============================ dialog ============================ */

const dlg = $('#tradeDialog');

/** Re-fills Stop loss with the default whenever entry/side changes, unless the user has typed
 *  into the Stop loss field themselves this dialog session (tracked via dataset.stopTouched). */
function syncDefaultStop() {
  const f = $('#tradeForm');
  if (f.dataset.stopTouched === '1') return;
  const def = computeDefaultStop(parseFloat(f.elements.entry.value), f.elements.side.value);
  if (def != null) f.elements.stop.value = def.toFixed(2);
}

function openDialog(trade, presetDate) {
  const f = $('#tradeForm');
  f.reset();
  f.dataset.stopTouched = '';
  $('#dlgTitle').textContent = trade ? 'Edit Trade' : 'New Trade';
  $('#deleteBtn').hidden = !trade;

  if (trade) {
    for (const [k, v] of Object.entries(trade)) {
      if (f.elements[k]) f.elements[k].value = v ?? '';
    }
    if (trade.stop != null && trade.stop !== '') {
      // Only treat the stop as deliberately customized if it actually differs from what the 5%
      // default would compute right now — a stop that's just never been anything but the auto
      // value should keep tracking entry/side edits, not freeze at whatever entry was when it
      // was first saved (that's how a saved trade's stop silently drifts off 5% after an entry
      // correction: it looks "custom" merely for having a value, even though no one chose it).
      const autoStop = computeDefaultStop(trade.entry, trade.side);
      const matchesAuto = autoStop != null && Math.abs(Number(trade.stop) - autoStop) < 0.005;
      f.dataset.stopTouched = matchesAuto ? '' : '1';
    }
  } else {
    f.elements.id.value = '';
    f.elements.date.value = presetDate || ymd(new Date());
    f.elements.qty.value = 1;
  }
  syncDefaultStop();
  updateCalc();
  if (trade) showTradeChart(trade.id); else $('#tradeChartWrap').hidden = true;
  dlg.showModal();
  setTimeout(() => f.elements[trade ? 'entry' : 'symbol'].focus(), 30);
}

function readForm() {
  const f = $('#tradeForm');
  const g = n => f.elements[n].value.trim();
  const num = n => { const v = parseFloat(f.elements[n].value); return isFinite(v) ? v : null; };
  return {
    id: g('id') || uid(),
    date: g('date'),
    symbol: g('symbol').toUpperCase(),
    side: g('side'),
    qty: num('qty') ?? 0,
    entry: num('entry') ?? 0,
    exit: num('exit'),
    exitDate: g('exitDate') || null,
    fees: 0,
    stop: num('stop'),
    platform: g('platform'),
    notes: g('notes'),
    exitNotes: g('exitNotes'),
  };
}

function updateCalc() {
  const t = readForm();
  const pnl = pnlOf(t);
  const r = rOf(t);
  const invested = t.entry * t.qty;
  const pct = (invested && pnl != null) ? (pnl / invested) * 100 : null;
  $('#calcPreview').innerHTML = `
    <span><i>Net P/L</i><b class="${pnl == null ? '' : cls(pnl)}">${pnl == null ? 'Open' : fmtMoney(pnl, { sign: true })}</b></span>
    <span><i>Return</i><b class="${pct == null ? '' : cls(pct)}">${pct == null ? '—' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'}</b></span>
    <span><i>R multiple</i><b class="${r == null ? '' : cls(r)}">${r == null ? '—' : (r >= 0 ? '+' : '') + r.toFixed(2) + 'R'}</b></span>
    <span><i>Position size</i><b>${fmtMoney(invested)}</b></span>`;
}

function closeDialog() { dlg.close(); }

$('#tradeForm').addEventListener('input', e => {
  if (e.target.name === 'stop') $('#tradeForm').dataset.stopTouched = '1';
  else if (e.target.name === 'entry' || e.target.name === 'side') syncDefaultStop();
  updateCalc();
});
$('#tradeForm').addEventListener('submit', e => {
  e.preventDefault();
  const t = readForm();
  if (!t.date || !t.symbol || !t.notes) return;
  const i = trades.findIndex(x => x.id === t.id);
  const prev = i >= 0 ? trades[i] : null;
  // Editing a position-generated trade through this dialog has no field for positionId (it's
  // not user-editable), so carry the existing link forward instead of letting the save drop it.
  if (i >= 0) { t.positionId = prev.positionId ?? null; t.chartPath = prev.chartPath ?? null; trades[i] = t; } else trades.push(t);
  saveTrades();
  selectedDate = t.date;
  cursor = startOfMonth(parseYmd(t.date));
  closeDialog();
  renderAll();
  toast(i >= 0 ? 'Trade updated' : 'Trade saved');
  // Regenerate whenever there's no chart yet, or an entry/exit field just changed — covers a
  // brand-new trade, a trade going from open to closed, and a correction to either price/date.
  const entryOrExitChanged = !prev || prev.entry !== t.entry || (prev.entryDate || prev.date) !== (t.entryDate || t.date)
    || prev.exit !== t.exit || prev.exitDate !== t.exitDate;
  if (!t.chartPath || entryOrExitChanged) generateTradeChart(t);
});
$('#cancelBtn').addEventListener('click', closeDialog);
$('#dlgClose').addEventListener('click', closeDialog);
$('#regenChartBtn').addEventListener('click', () => {
  const id = $('#tradeForm').elements.id.value;
  const t = trades.find(x => x.id === id);
  if (!t) return;
  $('#tradeChartBody').innerHTML = `<span class="muted">Regenerating…</span>`;
  generateTradeChart(t);
});
$('#deleteBtn').addEventListener('click', () => {
  const id = $('#tradeForm').elements.id.value;
  if (!id || !confirm('Delete this trade? This cannot be undone.')) return;
  trades = trades.filter(t => t.id !== id);
  recordDeletedTradeIds(id);
  saveTrades();
  closeDialog();
  renderAll();
  toast('Trade deleted');
});

/* ============================ position dialogs ============================ */

const newPosDlg = $('#newPositionDialog');
const posDetailDlg = $('#positionDetailDialog');

function openNewPositionDialog(presetDate) {
  const f = $('#newPositionForm');
  f.reset();
  f.elements.date.value = presetDate || ymd(new Date());
  f.elements.qty.value = 1;
  newPosDlg.showModal();
  setTimeout(() => f.elements.symbol.focus(), 30);
}

$('#newPositionForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const g = n => f.elements[n].value.trim();
  const num = n => { const v = parseFloat(f.elements[n].value); return isFinite(v) ? v : null; };
  const date = g('date'), symbol = g('symbol').toUpperCase(), price = num('price'), qty = num('qty');
  if (!date || !symbol || price == null || qty == null) return;

  const pos = {
    id: uid(), symbol, side: g('side'), thesis: g('thesis'), platform: g('platform'),
    status: 'open', openDate: date, closedDate: null,
    events: [{ id: uid(), type: 'entry', date, price, qty, fees: 0, status: null, note: '', tradeId: null }],
  };
  positions.push(pos);
  savePositions();
  newPosDlg.close();
  renderAll();
  toast('Position opened');
});
$('#npCancelBtn').addEventListener('click', () => newPosDlg.close());
$('#npDlgClose').addEventListener('click', () => newPosDlg.close());

function openPositionDetail(id) {
  viewingPositionId = id;
  renderPositionDetail();
  posDetailDlg.showModal();
}

function renderPositionDetail() {
  const pos = positions.find(p => p.id === viewingPositionId);
  if (!pos) { posDetailDlg.close(); return; }
  const d = withPositionDerived(pos);

  showPositionChart(pos.id);

  $('#pdSymSide').innerHTML = `${esc(pos.symbol)}
    <span class="pill ${pos.side}">${pos.side}</span>
    ${d.lastStatus ? `<span class="pill ${statusPillClass(d.lastStatus)}">${statusLabel(d.lastStatus)}</span>` : ''}
    ${pos.status === 'closed' ? `<span class="pill">closed</span>` : ''}`;

  $('#pdStats').innerHTML = `
    <span><i>Avg cost</i><b>${fmtNum(d.avgCost)}</b></span>
    <span><i>Qty open</i><b>${fmtNum(d.remainingQty)}</b></span>
    <span><i>Unrealized P/L</i><b class="${cls(d.unrealizedPnl)}">${fmtMoney(d.unrealizedPnl, { sign: true })}</b></span>
    <span><i>Realized P/L</i><b class="${cls(d.realizedPnl)}">${fmtMoney(d.realizedPnl, { sign: true })}</b></span>
    <span><i>Total P/L</i><b class="${cls(d.totalPnl)}">${fmtMoney(d.totalPnl, { sign: true })}</b></span>
    <span><i>Move from entry</i><b class="${cls(d.pctMove)}">${d.pctMove >= 0 ? '+' : ''}${d.pctMove.toFixed(2)}%</b></span>`;

  $('#pdThesisView').textContent = pos.thesis || '(no thesis written)';
  $('#pdThesisView').hidden = false;
  $('#pdThesisEdit').hidden = true;

  const f = $('#posEventForm');
  f.elements.date.value = ymd(new Date());
  updatePevFieldVisibility();

  $('#pdTimeline').innerHTML = sortedEvents(pos).slice().reverse().map(e => `
    <div class="pos-event" data-id="${e.id}">
      <div class="pev-row1">
        <span><span class="pev-type">${e.type}</span> · ${e.date}${e.price != null ? ` · ${fmtNum(e.price)}` : ''}</span>
        <span style="display:flex; align-items:center; gap:6px;">
          ${e.status ? `<span class="pill ${statusPillClass(e.status)}">${statusLabel(e.status)}</span>` : ''}
          ${e.type !== 'entry' ? `<button type="button" class="row-del" data-del-event="${e.id}" title="Delete">✕</button>` : ''}
        </span>
      </div>
      ${e.qty != null ? `<div class="pev-row2">${fmtNum(e.qty)} shares/contracts</div>` : ''}
      ${e.note ? `<div class="pev-note">${esc(e.note)}</div>` : ''}
    </div>`).join('') || `<div class="daypanel-empty">No events yet.</div>`;
}

function updatePevFieldVisibility() {
  const type = $('#pevType').value;
  $('#pevQtyWrap').hidden = type === 'checkin';
  $('#pevStatusWrap').hidden = type !== 'checkin';
  $('#pevCloseRemaining').hidden = type !== 'trim';
}
$('#pevType').addEventListener('change', updatePevFieldVisibility);

$('#pevCloseRemaining').addEventListener('click', () => {
  const pos = positions.find(p => p.id === viewingPositionId);
  if (!pos) return;
  $('#posEventForm').elements.qty.value = derivePosition(pos).remainingQty;
});

$('#posEventForm').addEventListener('submit', e => {
  e.preventDefault();
  const pos = positions.find(p => p.id === viewingPositionId);
  if (!pos) return;
  const f = e.target;
  const g = n => f.elements[n].value.trim();
  const num = n => { const v = parseFloat(f.elements[n].value); return isFinite(v) ? v : null; };
  const type = g('type'), date = g('date'), price = num('price');
  if (!date || price == null) return;

  const event = { id: uid(), type, date, price, note: g('note'), tradeId: null,
    qty: type === 'checkin' ? null : (num('qty') ?? 0),
    fees: 0,
    status: type === 'checkin' ? g('status') : null };
  pos.events.push(event);
  resyncPositionTrades(pos);
  savePositions();
  renderAll();
  renderPositionDetail();
  toast('Event logged');
});

$('#pdTimeline').addEventListener('click', e => {
  const del = e.target.closest('[data-del-event]');
  if (!del) return;
  const pos = positions.find(p => p.id === viewingPositionId);
  if (!pos || !confirm('Delete this event?')) return;
  pos.events = pos.events.filter(ev => ev.id !== del.dataset.delEvent);
  resyncPositionTrades(pos);
  savePositions();
  renderAll();
  renderPositionDetail();
  toast('Event deleted');
});

$('#pdThesisEditBtn').addEventListener('click', () => {
  const pos = positions.find(p => p.id === viewingPositionId);
  if (!pos) return;
  $('#pdThesisText').value = pos.thesis || '';
  $('#pdThesisView').hidden = true;
  $('#pdThesisEdit').hidden = false;
});
$('#pdThesisCancel').addEventListener('click', () => {
  $('#pdThesisView').hidden = false;
  $('#pdThesisEdit').hidden = true;
});
$('#pdThesisSave').addEventListener('click', () => {
  const pos = positions.find(p => p.id === viewingPositionId);
  if (!pos) return;
  pos.thesis = $('#pdThesisText').value.trim();
  savePositions();
  renderPositionDetail();
  toast('Thesis updated');
});

$('#pdDeleteBtn').addEventListener('click', () => {
  const pos = positions.find(p => p.id === viewingPositionId);
  if (!pos) return;
  if (!confirm('Delete this position? This also removes any closed trades it generated. This cannot be undone.')) return;
  const droppedTradeIds = trades.filter(t => t.positionId === pos.id).map(t => t.id);
  trades = trades.filter(t => t.positionId !== pos.id);
  positions = positions.filter(p => p.id !== pos.id);
  recordDeletedTradeIds(droppedTradeIds);
  recordDeletedPositionId(pos.id);
  saveTrades();
  savePositions();
  posDetailDlg.close();
  renderAll();
  toast('Position deleted');
});
$('#pdCloseBtn').addEventListener('click', () => posDetailDlg.close());
$('#pdDlgClose').addEventListener('click', () => posDetailDlg.close());
$('#pdRegenChartBtn').addEventListener('click', () => {
  const pos = positions.find(p => p.id === viewingPositionId);
  if (!pos) return;
  $('#pdChartBody').innerHTML = `<span class="muted">Regenerating…</span>`;
  generatePositionChart(pos);
});

/* ---- quick group detail (loose trades rolled into one card per symbol) ---- */
const quickGroupDlg = $('#quickGroupDialog');
let quickGroupOpenSymbol = null, quickGroupOpenSide = null;

function openQuickGroup(symbol, side) {
  quickGroupOpenSymbol = symbol;
  quickGroupOpenSide = side;
  const list = quickGroupTrades(symbol, side);
  const openList = list.filter(t => t.pnl == null);
  const closedList = list.filter(t => t.pnl != null);
  let openQty = 0, avgCost = 0;
  for (const t of openList) {
    avgCost = openQty === 0 ? t.entry : (avgCost * openQty + t.entry * t.qty) / (openQty + t.qty);
    openQty += t.qty;
  }
  const realizedPnl = closedList.reduce((s, t) => s + (t.pnl || 0), 0);
  const priceInfo = currentPriceCache[symbol];
  const unrealizedPnl = openQty > 0 && priceInfo && !priceInfo.loading && !priceInfo.error
    ? calcUnrealized(side, avgCost, openQty, priceInfo.price) : null;
  const unrealizedCell = openQty === 0 ? ''
    : priceInfo && priceInfo.error ? `<b title="${esc(priceInfo.error)}">—</b>`
    : `<b class="${cls(unrealizedPnl)}">${unrealizedPnl == null ? '…' : fmtMoney(unrealizedPnl, { sign: true })}</b>`;
  if (openQty > 0) ensureCurrentPrice(symbol);

  $('#qgTitle').innerHTML = `${esc(symbol)} <span class="pill ${side}">${side}</span> <span class="pill">Quick trades</span>`;
  $('#qgStats').innerHTML = `
    <span><i>Avg cost (open)</i><b>${fmtNum(avgCost)}</b></span>
    <span><i>Qty open</i><b>${fmtNum(openQty)}</b></span>
    ${openQty > 0 ? `<span><i>Unrealized P/L</i>${unrealizedCell}</span>` : ''}
    <span><i>Realized P/L</i><b class="${cls(realizedPnl)}">${fmtMoney(realizedPnl, { sign: true })}</b></span>`;
  $('#qgTimeline').innerHTML = list.map(t => `
    <div class="pos-event" data-id="${t.id}">
      <div class="pev-row1">
        <span><span class="pev-type">${t.pnl == null ? 'open' : 'closed'}</span> · ${t.date}${t.exitDate ? ` → ${t.exitDate}` : ''}</span>
        <span>${t.pnl == null ? '<span class="pill">Open</span>' : `<b class="${cls(t.pnl)}">${fmtMoney(t.pnl, { sign: true })}</b>`}</span>
      </div>
      <div class="pev-row2">${fmtNum(t.qty)} @ ${fmtNum(t.entry)}${t.exit != null ? ` → ${fmtNum(t.exit)}` : ''}</div>
      ${t.notes ? `<div class="pev-note">${esc(t.notes)}</div>` : ''}
    </div>`).join('') || `<div class="daypanel-empty">No trades.</div>`;
  quickGroupDlg.showModal();
}

$('#qgTimeline').addEventListener('click', e => {
  const row = e.target.closest('.pos-event');
  if (!row) return;
  const t = trades.find(x => x.id === row.dataset.id);
  if (!t) return;
  quickGroupDlg.close();
  openDialog(t);
});
$('#qgCloseBtn').addEventListener('click', () => quickGroupDlg.close());
$('#qgDlgClose').addEventListener('click', () => quickGroupDlg.close());
quickGroupDlg.addEventListener('close', () => { quickGroupOpenSymbol = null; quickGroupOpenSide = null; });

$('#posGrid').addEventListener('click', e => {
  const card = e.target.closest('.pos-card');
  if (!card) return;
  if (card.dataset.type === 'quickgroup') {
    openQuickGroup(card.dataset.symbol, card.dataset.side);
  } else {
    openPositionDetail(card.dataset.id);
  }
});
$('#posClosedBody').addEventListener('click', e => {
  const row = e.target.closest('tr');
  if (!row) return;
  if (row.dataset.type === 'quickgroup') {
    openQuickGroup(row.dataset.symbol, row.dataset.side);
  } else {
    openPositionDetail(row.dataset.id);
  }
});
$('#newPositionBtn').addEventListener('click', () => openNewPositionDialog(selectedDate));
['#posSearch', '#posSide', '#posStatusFilter', '#posPlatform'].forEach(sel => $(sel).addEventListener('input', renderPositions));
$('#posClearFilters').addEventListener('click', () => {
  $('#posSearch').value = '';
  $('#posSide').value = '';
  $('#posStatusFilter').value = 'open';
  $('#posPlatform').value = '';
  renderPositions();
});

/* ============================ events ============================ */

// tabs
$('#tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  $$('.tab').forEach(t => t.classList.toggle('is-active', t === btn));
  $$('.view').forEach(v => v.classList.toggle('is-active', v.id === `view-${btn.dataset.view}`));
  if (btn.dataset.view === 'trades') renderTrades();
  if (btn.dataset.view === 'tradescheck') renderTradesCheck();
  if (btn.dataset.view === 'scanner') renderScanner();
});

$('#newTradeBtn').addEventListener('click', () => openDialog(null, selectedDate));

// calendar nav
$('#prevMonth').addEventListener('click', () => { cursor.setMonth(cursor.getMonth() - 1); renderCalendar(); });
$('#nextMonth').addEventListener('click', () => { cursor.setMonth(cursor.getMonth() + 1); renderCalendar(); });
$('#todayBtn').addEventListener('click', () => {
  cursor = startOfMonth(new Date());
  selectedDate = ymd(new Date());
  renderCalendar(); renderDayPanel();
});
$('#calGrid').addEventListener('click', e => {
  const cell = e.target.closest('.day');
  if (!cell) return;
  selectedDate = cell.dataset.date;
  renderCalendar();
  renderDayPanel();
});

// scanner — click an industry group header to collapse/expand just its rows
$('#view-scanner').addEventListener('click', e => {
  const head = e.target.closest('.scan-group-head');
  if (!head) return;
  const gid = head.dataset.group;
  if (collapsedScanGroups.has(gid)) collapsedScanGroups.delete(gid); else collapsedScanGroups.add(gid);
  renderScanner();
});

// table
$('#tradeBody').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('Delete this trade?')) return;
    trades = trades.filter(t => t.id !== del.dataset.del);
    recordDeletedTradeIds(del.dataset.del);
    saveTrades(); renderAll(); toast('Trade deleted');
    return;
  }
  const row = e.target.closest('tr');
  if (row) openDialog(trades.find(t => t.id === row.dataset.id));
});
$('#tradeTable').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const k = th.dataset.sort;
  sortDir = sortKey === k ? -sortDir : (k === 'date' ? -1 : 1);
  sortKey = k;
  renderTrades();
});
['#fSearch', '#fFrom', '#fTo', '#fSide', '#fResult', '#fPlatform'].forEach(sel =>
  $(sel).addEventListener('input', renderTrades));
$('#clearFilters').addEventListener('click', () => {
  ['#fSearch', '#fFrom', '#fTo', '#fSide', '#fResult', '#fPlatform'].forEach(sel => { $(sel).value = ''; });
  renderTrades();
});
$('#refreshPricesBtn').addEventListener('click', () => {
  for (const k of Object.keys(currentPriceCache)) delete currentPriceCache[k];
  renderTrades();
});
$('#finnhubApiKey').value = getFinnhubApiKey();
$('#finnhubApiKeySave').addEventListener('click', saveFinnhubApiKey);
$('#finnhubApiKey').addEventListener('keydown', e => { if (e.key === 'Enter') saveFinnhubApiKey(); });

// theme
function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme;
  $('#themeBtn').textContent = prefs.theme === 'dark' ? '☀' : '☾';
}
$('#themeBtn').addEventListener('click', () => {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePrefs(); applyTheme();
});

// overflow menu
$('#moreBtn').addEventListener('click', e => {
  e.stopPropagation();
  $('#moreMenu').hidden = !$('#moreMenu').hidden;
});
document.addEventListener('click', () => { $('#moreMenu').hidden = true; });
$('#moreMenu').addEventListener('click', e => {
  const act = e.target.dataset?.act;
  if (!act) return;
  $('#moreMenu').hidden = true;
  ({
    'sync-now': syncNow,
    'export-json': exportJson,
    'export-csv': exportCsv,
    'import-json': () => $('#importFile').click(),
    'sample': loadSample,
    'backfill-charts': backfillTradeCharts,
    'wipe': wipe,
  })[act]?.();
});

// keyboard
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openDialog(null, selectedDate); }
  if (e.key === 'ArrowLeft')  $('#prevMonth').click();
  if (e.key === 'ArrowRight') $('#nextMonth').click();
  if (e.key === 't') $('#todayBtn').click();
});

/* ============================ data in/out ============================ */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  download(`trades-${ymd(new Date())}.json`,
    JSON.stringify({ version: 1, exported: new Date().toISOString(), trades, positions }, null, 2),
    'application/json');
  toast('Backup downloaded');
}

function exportCsv() {
  const cols = ['date','symbol','side','platform','qty','entry','exit','exitDate','days','stop','pnl','rmultiple','notes','exitNotes'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = trades.map(withDerived)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(t => cols.map(c => q(c === 'rmultiple' && t[c] != null ? t[c].toFixed(3) : t[c])).join(','));
  download(`trades-${ymd(new Date())}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
  toast('CSV downloaded');
}

$('#importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = Array.isArray(data) ? data : data.trades;
      if (!Array.isArray(incoming)) throw new Error('No trades array found');
      const byId = new Map(trades.map(t => [t.id, t]));
      for (const t of incoming) {
        if (!t.date || !t.symbol) continue;
        byId.set(t.id || uid(), Object.assign({ id: uid(), side: 'long', fees: 0 }, t));
      }
      trades = Array.from(byId.values());
      saveTrades();

      const incomingPos = Array.isArray(data.positions) ? data.positions : [];
      if (incomingPos.length) {
        const byPosId = new Map(positions.map(p => [p.id, p]));
        for (const p of incomingPos) {
          if (!p.symbol || !Array.isArray(p.events)) continue;
          byPosId.set(p.id || uid(), Object.assign({ id: uid(), side: 'long', status: 'open' }, p));
        }
        positions = Array.from(byPosId.values());
        savePositions();
      }

      renderAll();
      toast(`Imported ${incoming.length} trades${incomingPos.length ? `, ${incomingPos.length} positions` : ''}`);
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

function wipe() {
  if (!confirm('Erase ALL trades and positions from this browser? Export a backup first if you want to keep them.')) return;
  if (!confirm('Really erase everything? This cannot be undone.')) return;
  recordDeletedTradeIds(trades.map(t => t.id));
  positions.forEach(p => recordDeletedPositionId(p.id));
  trades = [];
  positions = [];
  saveTrades(); savePositions(); renderAll();
  toast('All data erased');
}

function loadSample() {
  if (trades.length && !confirm('Add sample trades to your existing data?')) return;
  const syms = ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK'];
  const out = [];
  const today = new Date();
  for (let back = 75; back >= 0; back--) {
    const d = new Date(today); d.setDate(d.getDate() - back);
    if (d.getDay() === 0 || d.getDay() === 6) continue;   // weekdays only
    if (Math.random() < 0.25) continue;                    // some days off
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.62 ? 'long' : 'short';
      const entry = +(200 + Math.random() * 2200).toFixed(2);
      const edge = Math.random() < 0.54 ? 1 : -1;          // slight positive edge
      const move = entry * (Math.random() * 0.02 + 0.002) * edge;
      const exit = +(side === 'long' ? entry + move : entry - move).toFixed(2);
      const qty = [10, 25, 50, 75, 100][Math.floor(Math.random() * 5)];
      out.push({
        id: uid(), date: ymd(d), symbol: syms[Math.floor(Math.random() * syms.length)],
        side, qty, entry, exit, fees: 0,
        stop: +(side === 'long' ? entry * 0.99 : entry * 1.01).toFixed(2),
        notes: 'Sample trade — generated for demo purposes.',
      });
    }
  }
  trades = trades.concat(out);
  saveTrades(); renderAll();
  toast(`Added ${out.length} sample trades`);
}

/* ============================ input UX ============================ */

// Always uppercase ticker symbols as you type.
$$('input[name="symbol"]').forEach(el => {
  el.addEventListener('input', () => {
    const pos = el.selectionStart;
    el.value = el.value.toUpperCase();
    el.selectionStart = el.selectionEnd = pos;
  });
});

// Open the native calendar picker on focus/click instead of requiring the tiny icon.
$$('input[type="date"]').forEach(el => {
  el.addEventListener('focus', () => { try { el.showPicker(); } catch {} });
  el.addEventListener('click', () => { try { el.showPicker(); } catch {} });
});

/* ============================ auth ============================ */

function showAuthOverlay(show) {
  $('#authOverlay').style.display = show ? 'flex' : 'none';
}
function setAuthError(msg) {
  const el = $('#authError');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

async function authSignIn() {
  setAuthError('');
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) setAuthError(error.message);
}
async function authSignUp() {
  setAuthError('');
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { setAuthError(error.message); return; }
  if (!data.session) toast('Account created — check your email to confirm, then sign in.');
}
async function authSignOut() {
  await sb.auth.signOut();
}

function showResetMode(show) {
  $('#authLoginFields').hidden = show;
  $('#authResetFields').hidden = !show;
}

async function authForgotPassword() {
  setAuthError('');
  const email = $('#authEmail').value.trim();
  if (!email) { setAuthError('Enter your email above first, then click "Forgot password?".'); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
  if (error) { setAuthError(error.message); return; }
  toast('Password reset email sent — check your inbox.');
}

async function authSetNewPassword() {
  setAuthError('');
  const password = $('#authNewPassword').value;
  if (!password || password.length < 6) { setAuthError('Password must be at least 6 characters.'); return; }
  const { error } = await sb.auth.updateUser({ password });
  if (error) { setAuthError(error.message); return; }
  toast('Password updated.');
  showResetMode(false);
}

$('#authSignInBtn').addEventListener('click', authSignIn);
$('#authSignUpBtn').addEventListener('click', authSignUp);
$('#authPassword').addEventListener('keydown', e => { if (e.key === 'Enter') authSignIn(); });
$('#signOutBtn').addEventListener('click', authSignOut);
$('#authForgotBtn').addEventListener('click', authForgotPassword);
$('#authSetPasswordBtn').addEventListener('click', authSetNewPassword);
$('#authNewPassword').addEventListener('keydown', e => { if (e.key === 'Enter') authSetNewPassword(); });

sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    showAuthOverlay(true);
    showResetMode(true);
    return; // wait for the user to set a new password before touching app state
  }
  if (session && session.user) {
    currentUser = session.user;
    showAuthOverlay(false);
    $('#authUserLabel').hidden = false;
    $('#authUserLabel').textContent = currentUser.email;
    $('#signOutBtn').hidden = false;
    await pullCloudState();
    applyTheme();
    renderAll();
  } else {
    currentUser = null;
    showAuthOverlay(true);
    showResetMode(false);
    $('#authUserLabel').hidden = true;
    $('#signOutBtn').hidden = true;
  }
});

/* ============================ boot ============================ */

applyTheme();
selectedDate = ymd(new Date());
renderAll();

})();
