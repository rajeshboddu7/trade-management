/* Trade Management — pure calculation core.
   No DOM, no localStorage, no network — just math over plain trade/position objects.
   Loaded before app.js (which destructures everything it needs off window.TradeMath) and
   loaded standalone by tests.html, so the exact same code that runs in the app is what
   gets tested — nothing here is duplicated or reimplemented in the test file. */
(() => {
'use strict';

const CURRENCY = '$';

/* ---- dates ---- */

function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse 'YYYY-MM-DD' as a *local* date (avoids the UTC shift of new Date(str)). */
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

/** Calendar days elapsed from a to b, excluding weekends (the market's closed then). */
function tradingDaysBetween(a, b) {
  const d1 = parseYmd(a), d2 = parseYmd(b);
  if (d2 < d1) return -tradingDaysBetween(b, a);
  let count = 0;
  const cur = new Date(d1);
  while (cur < d2) {
    cur.setDate(cur.getDate() + 1);
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

/* ---- formatting ---- */

function fmtMoney(n, { sign = false } = {}) {
  const abs = Math.abs(n);
  const s = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lead = n < 0 ? '-' : (sign && n > 0 ? '+' : '');
  return `${lead}${CURRENCY}${s}`;
}
function fmtNum(n, dp = 2) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
function cls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero'; }

/* ---- trade math ---- */

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

/** Trading days held: entry date (t.entryDate if set, else t.date) to exit date (t.exitDate, or
 *  `today` if still open — pass an explicit ymd() string so this stays deterministic in tests).
 *  null when the trade is closed but has no recorded exit date (legacy data). */
function daysInTrade(t, today) {
  const entry = t.entryDate || t.date;
  if (isOpenTrade(t)) return tradingDaysBetween(entry, today);
  if (!t.exitDate) return null;
  return tradingDaysBetween(entry, t.exitDate);
}

/** 5% below entry for longs, 5% above for shorts (a short's stop must sit above entry — that's
 *  the losing direction for a short — so a flat "subtract 5%" would be wrong on that side). */
function computeDefaultStop(entry, side, pct = 0.05) {
  if (!isFinite(entry) || entry <= 0) return null;
  return side === 'short' ? entry * (1 + pct) : entry * (1 - pct);
}

function calcUnrealized(side, avgCost, qty, price) {
  if (price == null || !qty) return null;
  return (side === 'short' ? (avgCost - price) : (price - avgCost)) * qty;
}

/* ---- position math ---- */

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

/** True if a closed trade row was auto-generated from a position trim. */
function isPositionTrade(t) { return t.positionId != null; }

function trimToTrade(pos, event, avgCostBefore, uid) {
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
    positionId: pos.id,
    tags: pos.tags || '',
    notes: `From position ${pos.symbol}${event.note ? ' — ' + event.note : ''}`,
  };
}

/** One-time upgrade path for trades saved before positionId existed, when the link was encoded
 *  as a "position:<id>" substring inside the free-text tags field. Leaves everything else as-is. */
function migratePositionId(t) {
  if (t.positionId != null || typeof t.tags !== 'string') return t;
  const m = t.tags.match(/(?:^|,)position:([^,]+)/);
  return m ? Object.assign({}, t, { positionId: m[1] }) : t;
}

/* ---- cross-device sync ---- */

/** Union-merge two arrays of {id,...} records by id — never drops a record either side has.
 *  This is the whole fix for the data-loss bug: no sync path should ever be able to silently
 *  delete data just because one side happened to be empty or stale. Cloud wins on id conflicts.
 *
 *  `deletedIds` (optional Set/array of ids) is the tombstone list: an id the user actually
 *  chose to delete is excluded even if a stale local or cloud copy still has it. Without this,
 *  an intentional delete could "resurrect" the next time this device (or another one with an
 *  older cached copy) syncs, since a plain union merge has no way to distinguish "never existed
 *  here" from "existed and was removed on purpose." */
function mergeById(local, cloud, deletedIds) {
  const map = new Map();
  (local || []).forEach(item => { if (item && item.id != null) map.set(item.id, item); });
  (cloud || []).forEach(item => { if (item && item.id != null) map.set(item.id, item); });
  if (deletedIds) for (const id of deletedIds) map.delete(id);
  return Array.from(map.values());
}

window.TradeMath = {
  CURRENCY, ymd, parseYmd, daysBetween, tradingDaysBetween,
  fmtMoney, fmtNum, cls,
  isOpenTrade, pnlOf, rOf, daysInTrade, computeDefaultStop, calcUnrealized,
  sortedEvents, derivePosition, isPositionTrade, trimToTrade, migratePositionId,
  mergeById,
};
})();
