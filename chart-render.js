/* Trade Management — daily-timeframe trade chart renderer.
   Draws a candlestick chart with entry/exit markers onto a <canvas>, entirely client-side
   (no external chart service, no CORS/screenshot issues). One trade = one image: while a
   trade is open the chart shows only the entry marker; once it closes, the SAME file gets
   re-rendered to also show the exit marker and gets overwritten in place (see app.js's
   generateTradeChart / uploadTradeChart) rather than kept as a second, now-redundant image. */
(() => {
'use strict';

const COLORS = {
  bg: '#12151a', grid: '#2e3540', axis: '#5b6472', title: '#e8eaf0',
  up: '#4caf82', down: '#d1685a', entry: '#5b8cff', exit: '#d59a52',
};

/** Index of the bar for `dateStr`, or the nearest earlier trading day if that exact date
 *  isn't in `bars` (weekend/holiday entry or exit dates land here). */
function nearestBarIndex(bars, dateStr) {
  const exact = bars.findIndex(b => b.date === dateStr);
  if (exact >= 0) return exact;
  let best = -1;
  for (let i = 0; i < bars.length; i++) if (bars[i].date <= dateStr) best = i;
  return best;
}

/** bars: [{date:'YYYY-MM-DD', open, high, low, close}], ascending by date.
 *  marks: { symbol, side, entryDate, entryPrice, exitDate, exitPrice }
 *  Returns a <canvas> element — call .toDataURL('image/png') or canvas.toBlob() on it. */
function renderTradeChart(bars, marks) {
  const W = 900, H = 480;
  const padL = 58, padR = 16, padT = 34, padB = 24;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = COLORS.title;
  ctx.font = 'bold 15px system-ui, sans-serif';
  ctx.fillText(`${marks.symbol || ''} · daily`, padL, 20);

  if (!bars.length) {
    ctx.fillStyle = COLORS.axis;
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('No chart data available for this trade.', padL, H / 2);
    return canvas;
  }

  const lo = Math.min(...bars.map(b => b.low));
  const hi = Math.max(...bars.map(b => b.high));
  const pad = (hi - lo) * 0.1 || hi * 0.02 || 1;
  const yMin = lo - pad, yMax = hi + pad;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xAt = i => padL + plotW * (bars.length === 1 ? 0.5 : i / (bars.length - 1));
  const yAt = v => padT + plotH * (1 - (v - yMin) / (yMax - yMin));

  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.axis;
  ctx.font = '11px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = yMin + (yMax - yMin) * (g / 4);
    const yy = yAt(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillText(v.toFixed(2), 4, yy + 3);
  }
  ctx.fillText(bars[0].date, padL, H - 6);
  ctx.textAlign = 'right';
  ctx.fillText(bars[bars.length - 1].date, W - padR, H - 6);
  ctx.textAlign = 'left';

  const cw = Math.max(1.5, (plotW / bars.length) * 0.62);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const up = b.close >= b.open;
    ctx.strokeStyle = ctx.fillStyle = up ? COLORS.up : COLORS.down;
    const cx = xAt(i);
    ctx.beginPath(); ctx.moveTo(cx, yAt(b.high)); ctx.lineTo(cx, yAt(b.low)); ctx.stroke();
    const bodyTop = yAt(Math.max(b.open, b.close)), bodyBot = yAt(Math.min(b.open, b.close));
    ctx.fillRect(cx - cw / 2, bodyTop, cw, Math.max(1, bodyBot - bodyTop));
  }

  function drawMarker(dateStr, price, label, color, dir) {
    const i = nearestBarIndex(bars, dateStr);
    if (i < 0 || price == null) return;
    const cx = xAt(i), cy = yAt(price);
    const tipY = cy + (dir === 'up' ? -4 : 4);
    const tailY = dir === 'up' ? cy + 22 : cy - 22;
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, tailY); ctx.lineTo(cx, tipY); ctx.stroke();
    ctx.beginPath();
    if (dir === 'up') { ctx.moveTo(cx - 4, cy - 8); ctx.lineTo(cx + 4, cy - 8); ctx.lineTo(cx, cy - 2); }
    else { ctx.moveTo(cx - 4, cy + 8); ctx.lineTo(cx + 4, cy + 8); ctx.lineTo(cx, cy + 2); }
    ctx.closePath(); ctx.fill();
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${label} ${price.toFixed(2)}`, cx, dir === 'up' ? tailY + 14 : tailY - 8);
    ctx.textAlign = 'left';
  }

  // Entry always marked below (upward arrow), exit always above (downward arrow) — this is
  // about position in time (first vs. second marker), not trade direction, so long and short
  // trades use the same convention.
  drawMarker(marks.entryDate, marks.entryPrice, 'ENTRY', COLORS.entry, 'up');
  drawMarker(marks.exitDate, marks.exitPrice, 'EXIT', COLORS.exit, 'down');

  return canvas;
}

window.ChartRender = { renderTradeChart, nearestBarIndex };
})();
