# Trade Management

A personal trade journal with a P/L calendar. No install, no server, no account —
plain HTML/CSS/JS, and all data stays in your browser's localStorage.

## Run it

Double-click `index.html`, or serve the folder:

```bash
python -m http.server 5599
```

then open http://localhost:5599

> Data is stored per-origin. If you open the file directly (`file://`) and later
> switch to `http://localhost`, each one keeps its own separate data. Pick one and
> stick with it — or move data across with Export/Import JSON.

## What's in it

**Calendar** — month grid where every day is colored by net P/L, with per-week
totals down the right side and month stats (P/L, trades, green days, best/worst
day) above. Click a day to see its trades in the side panel, or add one to that date.

**Trades** — sortable, filterable table of every trade. Search symbol/strategy/notes,
filter by date range, side, or win/loss. Click a row to edit.

**Stats** — net P/L, win rate, profit factor, expectancy, avg win/loss, payoff ratio,
max drawdown, avg R, day streaks, best/worst trade; a cumulative P/L curve, P/L by
month, and breakdowns by symbol, strategy, and weekday.

## Entering a trade

Date, symbol, side, quantity, entry, exit, fees are required-ish; stop loss,
strategy, tags, notes are optional. The dialog shows net P/L, % return, R-multiple,
and position size live as you type.

- **Net P/L** — `(exit − entry) × qty − fees` for longs, `(entry − exit) × qty − fees` for shorts.
- **R-multiple** — net P/L ÷ `|entry − stop| × qty`. Shows `—` when no stop is set.

## Data

Everything lives under the `tm.trades.v1` localStorage key. Use the `⋯` menu to:

- **Export JSON** — full backup; do this periodically, clearing browser site data wipes your trades.
- **Export CSV** — for Excel/Sheets.
- **Import JSON** — merges by trade id, so re-importing a backup won't duplicate rows.
- **Set currency** — the display symbol (default `₹`).
- **Load sample data** — ~100 fake trades to explore the UI. Erase all data to clear it.

## Shortcuts

`n` new trade · `←` / `→` previous / next month · `t` jump to today

## Files

- `index.html` — markup and the trade dialog
- `styles.css` — design tokens, light/dark themes, layout
- `app.js` — state, P/L math, calendar, table, stats, SVG charts, import/export
