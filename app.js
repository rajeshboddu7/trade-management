/* Trade Management — trade journal with a P/L calendar.
   Local cache in localStorage; synced cross-device via Supabase when signed in. */
(() => {
'use strict';

const KEY_TRADES    = 'tm.trades.v1';
const KEY_PREFS     = 'tm.prefs.v1';
const KEY_POSITIONS = 'tm.positions.v1';

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

/** Pull all cloud state for the signed-in user and overwrite the local cache with it —
 *  cloud is the source of truth once signed in, so this is what makes cross-device work. */
async function pullCloudState() {
  const { data, error } = await sb.from('app_state').select('key,data').eq('user_id', currentUser.id);
  if (error) { toast('Could not load cloud data: ' + error.message); return; }
  const map = {};
  (data || []).forEach(row => { map[row.key] = row.data; });

  const cloudHasData = (Array.isArray(map.trades) && map.trades.length)
    || (Array.isArray(map.positions) && map.positions.length)
    || (map.prefs && Object.keys(map.prefs).length);
  const localHasData = trades.length || positions.length;

  if (cloudHasData || !localHasData) {
    // Cloud has real data — or both are empty, in which case this is a no-op either way.
    // Either way, cloud wins: this is what makes cross-device sync actually work.
    trades = Array.isArray(map.trades) ? map.trades : [];
    positions = Array.isArray(map.positions) ? map.positions : [];
    prefs = Object.assign({ theme: 'dark' }, map.prefs || {});
    localStorage.setItem(KEY_TRADES, JSON.stringify(trades));
    localStorage.setItem(KEY_POSITIONS, JSON.stringify(positions));
    localStorage.setItem(KEY_PREFS, JSON.stringify(prefs));
  } else {
    // Cloud account is empty but this browser already has local data (first-ever login
    // on this device) — upload local to the cloud instead of wiping it with nothing.
    await syncToCloud('trades', trades);
    await syncToCloud('positions', positions);
    await syncToCloud('prefs', prefs);
    toast('Uploaded your existing local data to your account');
  }
}

/* ============================ state ============================ */

let trades = load(KEY_TRADES, []);
let prefs  = Object.assign({ theme: 'dark' }, load(KEY_PREFS, {}));
const CURRENCY = '$';
let positions = load(KEY_POSITIONS, []);

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

/* ============================ helpers ============================ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Parse 'YYYY-MM-DD' as a *local* date (avoids the UTC shift of new Date(str)). */
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtMoney(n, { sign = false } = {}) {
  const abs = Math.abs(n);
  const s = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lead = n < 0 ? '-' : (sign && n > 0 ? '+' : '');
  return `${lead}${CURRENCY}${s}`;
}
function fmtCompact(n) {
  const abs = Math.abs(n);
  const unit = abs >= 1e7 ? [1e7, 'Cr'] : abs >= 1e5 ? [1e5, 'L'] : abs >= 1e3 ? [1e3, 'k'] : [1, ''];
  const v = (n / unit[0]).toFixed(abs >= 1e3 ? 1 : 0);
  return (n > 0 ? '+' : '') + v + unit[1];
}
function fmtNum(n, dp = 2) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
function cls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero'; }
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

/* ============================ trade math ============================ */

/** True if a trade has no exit price yet — still an open/holding position. */
function isOpenTrade(t) { return t.exit == null || t.exit === ''; }

/** Net P/L: direction-aware, fees subtracted. null if the trade is still open (no exit price). */
function pnlOf(t) {
  if (isOpenTrade(t)) return null;
  const gross = (t.side === 'short' ? (t.entry - t.exit) : (t.exit - t.entry)) * t.qty;
  return gross - (t.fees || 0);
}
/** R-multiple: net P/L divided by the risk implied by the stop. null if no usable stop, or still open. */
function rOf(t) {
  const pnl = pnlOf(t);
  if (pnl == null) return null;
  if (t.stop == null || t.stop === '' || !isFinite(t.stop)) return null;
  const risk = Math.abs(t.entry - t.stop) * t.qty;
  if (risk <= 0) return null;
  return pnl / risk;
}
/** Days held: entry date (t.entryDate if set, else t.date) to exit date (t.exitDate, or today if still open).
 *  null when the trade is closed but has no recorded exit date (e.g. legacy data from before this field existed). */
function daysInTrade(t) {
  const entry = t.entryDate || t.date;
  if (isOpenTrade(t)) return daysBetween(entry, ymd(new Date()));
  if (!t.exitDate) return null;
  return daysBetween(entry, t.exitDate);
}

function withDerived(t) {
  return Object.assign({}, t, { pnl: pnlOf(t), rmultiple: rOf(t), days: daysInTrade(t) });
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

/* ============================ position math ============================ */

/** A position's events, chronologically (stable sort keeps same-day insertion order). */
function sortedEvents(p) {
  return p.events.slice().sort((a, b) => a.date === b.date ? 0 : a.date.localeCompare(b.date));
}

/** Replay a position's event log into avg cost, remaining qty, realized/unrealized P/L. */
function derivePosition(p) {
  let qty = 0, avgCost = 0, realized = 0;
  let lastPrice = null, lastStatus = null, lastNote = '', lastEventDate = p.openDate;

  for (const e of sortedEvents(p)) {
    if (e.type === 'entry' || e.type === 'add') {
      avgCost = qty === 0 ? e.price : (avgCost * qty + e.price * e.qty) / (qty + e.qty);
      qty += e.qty;
    } else if (e.type === 'trim') {
      const closeQty = Math.min(e.qty, qty);
      const gross = (p.side === 'short' ? (avgCost - e.price) : (e.price - avgCost)) * closeQty;
      realized += gross - (e.fees || 0);
      qty -= closeQty;
    }
    if (e.price != null) { lastPrice = e.price; lastEventDate = e.date; }
    if (e.type === 'checkin') { lastStatus = e.status; lastNote = e.note; }
  }

  const unrealized = (lastPrice == null || qty === 0) ? 0 :
    (p.side === 'short' ? (avgCost - lastPrice) : (lastPrice - avgCost)) * qty;
  const entryEvent = sortedEvents(p).find(e => e.type === 'entry');
  const entryPrice = entryEvent ? entryEvent.price : avgCost;
  const pctMove = lastPrice == null ? 0 :
    ((p.side === 'short' ? (entryPrice - lastPrice) : (lastPrice - entryPrice)) / entryPrice) * 100;

  return {
    remainingQty: qty, avgCost, realizedPnl: realized, unrealizedPnl: unrealized,
    totalPnl: realized + unrealized, lastPrice, lastStatus, lastNote, lastEventDate,
    entryPrice, pctMove,
  };
}
function withPositionDerived(p) { return Object.assign({}, p, derivePosition(p)); }

/** True if a closed trade row was auto-generated from a position trim. */
function isPositionTrade(t) { return /(^|,)position:/.test(t.tags || ''); }

function trimToTrade(pos, event, avgCostBefore) {
  const entryEvent = sortedEvents(pos).find(e => e.type === 'entry');
  return {
    id: event.tradeId || uid(),
    date: event.date,
    entryDate: entryEvent ? entryEvent.date : pos.openDate,
    exitDate: event.date,
    symbol: pos.symbol,
    side: pos.side,
    qty: event.qty,
    entry: avgCostBefore,
    exit: event.price,
    fees: event.fees || 0,
    stop: null,
    platform: pos.platform || '',
    tags: [pos.tags, `position:${pos.id}`].filter(Boolean).join(','),
    notes: `From position ${pos.symbol}${event.note ? ' — ' + event.note : ''}`,
  };
}

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
      const trade = trimToTrade(pos, e, avgCost);
      e.tradeId = trade.id;
      keepIds.add(trade.id);
      const i = trades.findIndex(t => t.id === trade.id);
      if (i >= 0) trades[i] = trade; else trades.push(trade);
      qty -= Math.min(e.qty, qty);
    }
  }

  trades = trades.filter(t => !isPositionTrade(t) || !(t.tags || '').includes(`position:${pos.id}`) || keepIds.has(t.id));

  pos.status = qty <= 0 && sortedEvents(pos).some(e => e.type === 'trim') ? 'closed' : 'open';
  pos.closedDate = pos.status === 'closed' ? sortedEvents(pos).slice(-1)[0].date : null;
  saveTrades();
}

/* ============================ rendering ============================ */

function renderAll() {
  renderSummary();
  renderCalendar();
  renderDayPanel();
  renderTrades();
  renderPositions();
  renderStats();
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

function ensureCurrentPrice(symbol) {
  if (!$('#view-trades').classList.contains('is-active')) return;
  const c = currentPriceCache[symbol];
  if (c && (c.loading || (c.fetchedAt && Date.now() - c.fetchedAt < CURRENT_PRICE_TTL_MS))) return;
  currentPriceCache[symbol] = { loading: true };
  fetchYahooChart(symbol).then(result => {
    const meta = result && result.meta;
    if (!meta || meta.regularMarketPrice == null) throw new Error('No quote in response');
    currentPriceCache[symbol] = { price: meta.regularMarketPrice, prevClose: meta.previousClose ?? null, fetchedAt: Date.now() };
  }).catch(err => {
    currentPriceCache[symbol] = { error: err.message, fetchedAt: Date.now() };
  }).finally(() => {
    if ($('#view-trades').classList.contains('is-active')) renderTrades();
  });
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

function renderTrades() {
  const list = filteredTrades();
  $('#tradesEmpty').hidden = list.length > 0;
  $('#tradeBody').innerHTML = list.map(t => `
    <tr data-id="${t.id}">
      <td class="mono">${t.date}</td>
      <td><b>${esc(t.symbol)}</b></td>
      <td><span class="pill ${t.side}">${t.side}</span></td>
      <td>${t.platform ? `<span class="pill">${platformLabel(t.platform)}</span>` : '—'}</td>
      <td class="num">${fmtNum(t.qty)}</td>
      <td class="num">${fmtNum(t.entry)}</td>
      <td class="num">${currentPriceCell(t)}</td>
      <td class="num">${t.exit == null ? '—' : fmtNum(t.exit)}</td>
      <td class="num">${t.days == null ? '—' : `${t.days}d${t.pnl == null ? ' (open)' : ''}`}</td>
      <td class="num ${t.pnl == null ? '' : cls(t.pnl)}">${
        t.pnl == null ? '<span class="pill">Open</span>' : `<b>${fmtMoney(t.pnl, { sign: true })}</b>`}</td>
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

/* ---- critique: on-demand Gemini equity analysis ---- */
function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

const GEMINI_KEY_STORAGE = 'tm.geminiApiKey';
const GEMINI_MODEL = 'gemini-2.0-flash';
function getGeminiApiKey() { return localStorage.getItem(GEMINI_KEY_STORAGE) || ''; }
function saveGeminiApiKey() {
  const key = $('#critiqueApiKey').value.trim();
  localStorage.setItem(GEMINI_KEY_STORAGE, key);
  toast(key ? 'API key saved' : 'API key cleared');
}

/** Fetch daily OHLC history for a symbol from Yahoo Finance's chart endpoint (no key needed).
 *  Yahoo doesn't reliably send CORS headers, so fall back to a public CORS proxy on failure. */
async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  const attempts = [url, `https://corsproxy.io/?url=${encodeURIComponent(url)}`];
  let lastErr;
  for (const target of attempts) {
    try {
      const res = await fetch(target);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const data = await res.json();
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      if (!result) { lastErr = new Error(data?.chart?.error?.description || 'No data returned'); continue; }
      return result;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not fetch price data for ${symbol} (${lastErr ? lastErr.message : 'unknown error'}). Yahoo may be blocking direct/proxied browser requests right now — check the symbol is valid, or try again.`);
}

/** Simple technicals computed client-side from real daily closes — no invented numbers. */
function computeTechnicals(chartResult) {
  const ts = chartResult.timestamp || [];
  const quote = (chartResult.indicators && chartResult.indicators.quote && chartResult.indicators.quote[0]) || {};
  const closes = (quote.close || []).map((c, i) => ({ t: ts[i], c })).filter(x => x.c != null);
  if (!closes.length) throw new Error('No price history returned for this symbol.');

  const last = closes[closes.length - 1];
  const prev = closes.length > 1 ? closes[closes.length - 2] : last;
  const changePct = prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;

  const sma = n => {
    const slice = closes.slice(-n);
    if (slice.length < Math.min(n, 10)) return null;
    return slice.reduce((s, x) => s + x.c, 0) / slice.length;
  };
  const sma20 = sma(20), sma50 = sma(50);
  const vals = closes.map(x => x.c);
  const rangeHigh = Math.max(...vals), rangeLow = Math.min(...vals);
  const rangePct = rangeHigh !== rangeLow ? ((last.c - rangeLow) / (rangeHigh - rangeLow)) * 100 : 50;

  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1].c) rets.push((closes[i].c - closes[i - 1].c) / closes[i - 1].c);
  }
  const mean = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const variance = rets.length ? rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length : 0;
  const volatilityPct = Math.sqrt(variance) * 100;

  return {
    price: last.c, changePct, sma20, sma50, rangeHigh, rangeLow, rangePct, volatilityPct,
    asOf: last.t ? new Date(last.t * 1000).toISOString().slice(0, 10) : '',
  };
}

async function callGeminiApi(prompt, useSearch) {
  const key = getGeminiApiKey();
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (useSearch) body.tools = [{ google_search: {} }];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function callGeminiEquityAnalysis(symbol, tech, contextNote) {
  const key = getGeminiApiKey();
  if (!key) throw new Error('No Gemini API key set — paste one into the field and click "Save key" first.');
  if (!/^AIza[\w-]{20,}$/.test(key)) {
    throw new Error(
      `That doesn't look like a Gemini API key (yours: "${key.slice(0, 6)}…${key.slice(-4)}", ${key.length} chars). ` +
      'A real key from aistudio.google.com/apikey starts with "AIza". If yours doesn\'t, you likely copied an OAuth Client ID or something else — go back to aistudio.google.com/apikey and copy the API key value specifically.');
  }

  const prompt = `You are giving an unbiased equity analysis for ${symbol}.

Computed technicals (from real daily closing prices, not a live tick — may lag the current quote by minutes to a day):
- Last close: ${fmtNum(tech.price)} (as of ${tech.asOf})
- Change vs prior close: ${tech.changePct >= 0 ? '+' : ''}${tech.changePct.toFixed(2)}%
- 20-day SMA: ${tech.sma20 != null ? fmtNum(tech.sma20) : 'not enough history'}
- 50-day SMA: ${tech.sma50 != null ? fmtNum(tech.sma50) : 'not enough history'}
- 6-month range: ${fmtNum(tech.rangeLow)} to ${fmtNum(tech.rangeHigh)} (currently at ${tech.rangePct.toFixed(0)}% of that range)
- Daily volatility (stdev of daily returns): ${tech.volatilityPct.toFixed(2)}%
${contextNote ? `\nThe trader's own notes on this symbol from their journal (for context only — do not just validate this):\n${contextNote}\n` : ''}
If you have live search available, check for recent news, earnings, or catalysts on ${symbol} from the last few weeks; otherwise rely on what you already know and say plainly that catalyst info may not be current. Then give a candid, unbiased analysis covering: what the technicals suggest, what the real catalysts/risks are, and specifically what could go wrong with both a bullish and a bearish read. Do not simply agree with the trader's existing thesis — actively look for what it's missing. Keep it to a few tight paragraphs, no filler.`;

  let { ok, status, data } = await callGeminiApi(prompt, true);
  if (!ok) ({ ok, status, data } = await callGeminiApi(prompt, false)); // retry without search grounding

  if (!ok) throw new Error((data && data.error && data.error.message) || `Gemini API error (HTTP ${status})`);

  const candidate = data.candidates && data.candidates[0];
  if (!candidate) throw new Error('Gemini returned no result — it may have blocked the request.');
  if (candidate.finishReason === 'SAFETY') throw new Error('Gemini declined to analyze this request (safety filter).');

  const text = ((candidate.content && candidate.content.parts) || []).map(p => p.text || '').join('\n');
  return text || '(Gemini returned no text.)';
}

async function runCritiqueAnalysis() {
  const symbol = $('#critiqueSymbol').value.trim().toUpperCase();
  if (!symbol) { toast('Enter a symbol first'); return; }

  const statusEl = $('#critiqueStatus');
  $('#critiqueIntro').hidden = true;
  $('#critiqueResultPanel').hidden = true;
  statusEl.hidden = false;
  statusEl.textContent = `Fetching price data for ${symbol}…`;
  $('#critiqueRunBtn').disabled = true;

  try {
    const chart = await fetchYahooChart(symbol);
    const tech = computeTechnicals(chart);

    statusEl.textContent = `Asking Gemini for analysis on ${symbol}…`;

    const notesParts = [];
    positions.filter(p => p.symbol === symbol).forEach(p => { if (p.thesis) notesParts.push(`Position thesis: ${p.thesis}`); });
    trades.filter(t => t.symbol === symbol).slice(-5).forEach(t => { if (t.notes) notesParts.push(`Trade entry note (${t.date}): ${t.notes}`); });

    const analysis = await callGeminiEquityAnalysis(symbol, tech, notesParts.join('\n'));

    statusEl.hidden = true;
    $('#critiqueResultPanel').hidden = false;
    $('#critiqueResultTitle').textContent = `${symbol} — Gemini equity analysis`;
    $('#critiqueMeta').textContent = `Price ${fmtNum(tech.price)} (${tech.changePct >= 0 ? '+' : ''}${tech.changePct.toFixed(2)}%) as of ${tech.asOf} · SMA20 ${tech.sma20 != null ? fmtNum(tech.sma20) : 'n/a'} · SMA50 ${tech.sma50 != null ? fmtNum(tech.sma50) : 'n/a'} · 6mo range ${fmtNum(tech.rangeLow)}–${fmtNum(tech.rangeHigh)}`;
    $('#critiqueAnalysis').textContent = analysis;
  } catch (err) {
    statusEl.hidden = false;
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    $('#critiqueRunBtn').disabled = false;
  }
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
  const worst = chrono.length ? chrono.reduce((a, b) => b.pnl < a.pnl ? b : a) : null;

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
    ['Worst trade', worst ? `<span class="neg">${fmtMoney(worst.pnl, { sign: true })}</span>` : '—', worst ? `${esc(worst.symbol)} · ${worst.date}` : ''],
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

function openDialog(trade, presetDate) {
  const f = $('#tradeForm');
  f.reset();
  $('#dlgTitle').textContent = trade ? 'Edit Trade' : 'New Trade';
  $('#deleteBtn').hidden = !trade;

  if (trade) {
    for (const [k, v] of Object.entries(trade)) {
      if (f.elements[k]) f.elements[k].value = v ?? '';
    }
  } else {
    f.elements.id.value = '';
    f.elements.date.value = presetDate || ymd(new Date());
    f.elements.qty.value = 1;
  }
  updateCalc();
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

$('#tradeForm').addEventListener('input', updateCalc);
$('#tradeForm').addEventListener('submit', e => {
  e.preventDefault();
  const t = readForm();
  if (!t.date || !t.symbol || !t.notes) return;
  const i = trades.findIndex(x => x.id === t.id);
  if (i >= 0) trades[i] = t; else trades.push(t);
  saveTrades();
  selectedDate = t.date;
  cursor = startOfMonth(parseYmd(t.date));
  closeDialog();
  renderAll();
  toast(i >= 0 ? 'Trade updated' : 'Trade saved');
});
$('#cancelBtn').addEventListener('click', closeDialog);
$('#dlgClose').addEventListener('click', closeDialog);
$('#deleteBtn').addEventListener('click', () => {
  const id = $('#tradeForm').elements.id.value;
  if (!id || !confirm('Delete this trade? This cannot be undone.')) return;
  trades = trades.filter(t => t.id !== id);
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
  trades = trades.filter(t => !t.tags || !t.tags.includes(`position:${pos.id}`));
  positions = positions.filter(p => p.id !== pos.id);
  saveTrades();
  savePositions();
  posDetailDlg.close();
  renderAll();
  toast('Position deleted');
});
$('#pdCloseBtn').addEventListener('click', () => posDetailDlg.close());
$('#pdDlgClose').addEventListener('click', () => posDetailDlg.close());

/* ---- quick group detail (loose trades rolled into one card per symbol) ---- */
const quickGroupDlg = $('#quickGroupDialog');

function openQuickGroup(symbol, side) {
  const list = quickGroupTrades(symbol, side);
  const openList = list.filter(t => t.pnl == null);
  const closedList = list.filter(t => t.pnl != null);
  let openQty = 0, avgCost = 0;
  for (const t of openList) {
    avgCost = openQty === 0 ? t.entry : (avgCost * openQty + t.entry * t.qty) / (openQty + t.qty);
    openQty += t.qty;
  }
  const realizedPnl = closedList.reduce((s, t) => s + (t.pnl || 0), 0);

  $('#qgTitle').innerHTML = `${esc(symbol)} <span class="pill ${side}">${side}</span> <span class="pill">Quick trades</span>`;
  $('#qgStats').innerHTML = `
    <span><i>Avg cost (open)</i><b>${fmtNum(avgCost)}</b></span>
    <span><i>Qty open</i><b>${fmtNum(openQty)}</b></span>
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

// table
$('#tradeBody').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('Delete this trade?')) return;
    trades = trades.filter(t => t.id !== del.dataset.del);
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

// theme
function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme;
  $('#themeBtn').textContent = prefs.theme === 'dark' ? '☀' : '☾';
}
$('#themeBtn').addEventListener('click', () => {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePrefs(); applyTheme();
});

// critique
$('#critiqueApiKey').value = getGeminiApiKey();
$('#critiqueApiKeySave').addEventListener('click', saveGeminiApiKey);
$('#critiqueApiKey').addEventListener('keydown', e => { if (e.key === 'Enter') saveGeminiApiKey(); });
$('#critiqueRunBtn').addEventListener('click', runCritiqueAnalysis);
$('#critiqueSymbol').addEventListener('keydown', e => { if (e.key === 'Enter') runCritiqueAnalysis(); });

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
    'export-json': exportJson,
    'export-csv': exportCsv,
    'import-json': () => $('#importFile').click(),
    'sample': loadSample,
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

$('#authSignInBtn').addEventListener('click', authSignIn);
$('#authSignUpBtn').addEventListener('click', authSignUp);
$('#authPassword').addEventListener('keydown', e => { if (e.key === 'Enter') authSignIn(); });
$('#signOutBtn').addEventListener('click', authSignOut);

sb.auth.onAuthStateChange(async (event, session) => {
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
    $('#authUserLabel').hidden = true;
    $('#signOutBtn').hidden = true;
  }
});

/* ============================ boot ============================ */

applyTheme();
selectedDate = ymd(new Date());
renderAll();

})();
