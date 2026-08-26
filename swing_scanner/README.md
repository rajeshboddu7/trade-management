# Swing Scanner

Screens a ticker universe for four technical setups, ranks results by
relative strength / sector-theme leadership, and writes a CSV report.
Built to be run twice a week: **Friday after close** and **Tuesday after
close**.

## What it screens for

1. **IPO-high breakout/consolidation** — stock has spent 3+ months below the
   high it set in its first ~3 months of trading, and is now breaking out of
   or tightening up just under that level.
2. **Downtrend reversal** — a sequence of lower highs/lower lows, followed by
   a higher low, followed by reclaiming and holding above the last lower
   high (the level that capped the prior bounce).
3. **52-week/all-time-high consolidation with volume dry-up** — price within
   10% of its high, average volume contracting, and daily range (ATR%)
   contracting — the classic low-volatility pause near highs.
4. **Trend continuation breakout** — price above its 50-day average, which
   is above its 150-day average (established uptrend), making a fresh
   ~20-day high with volume that ISN'T drying up (the inverse of pattern
   3's volume-contraction test), and not already overextended (>60%) above
   its 50-day average. This is the mirror image of pattern 3: an active
   breakout rather than a quiet base near highs.

Every match is also tagged with:
- Relative strength percentile vs SPY (3mo/6mo blend)
- Sector leader flag (top 30% RS within its sector)
- Leading-theme flag (in one of the strongest-RS industries this period —
  this is how "leading themes" gets picked up without hardcoding a theme
  list that goes stale)
- Earnings-within-14-days flag (catalyst risk/opportunity heads-up)

All thresholds live in `config.py` — nothing is hardcoded in the pattern
logic, so tune freely (e.g. loosen `ZIGZAG_MIN_PCT` if pattern 2 feels too
strict, or lower `MIN_AVG_DOLLAR_VOL` for smaller-cap names).

## 1. Install

```bash
pip install -r requirements.txt
```

## 2. Build your universe

The scanner needs a starting list of tickers — it does not crawl the whole
market on its own (that would be extremely slow against Yahoo's free
endpoints, and you already have better sources for a raw universe):

- **ThinkorSwim Stock Hacker**: run a coarse filter (e.g. price > $20, avg
  volume > 500k, listed > X months) and export the symbol list.
- **Deepvue**: export any of its pre-built universes (e.g. "all stocks with
  RS rating > 70") as a starting pool.
- **Finviz**: free screener export also works.

Save the list as a one-column CSV with header `ticker` (see
`universe_sample.csv`). Aim for 300–800 tickers — enough to find real
candidates without the run taking forever on free data.

## 3. Run it

```bash
python scanner.py --universe my_universe.csv
```

Output: `reports/scan_YYYY-MM-DD_Day.csv`, plus a top-15 preview printed to
the console. Open the CSV in Excel/Sheets, or pull it into Deepvue/ToS to
pull up charts on the matches for visual confirmation before trading.

**Important**: treat this as a shortlist generator, not a signal. The
pattern logic is a mechanical approximation of chart reading — always
glance at the actual chart on ToS/Deepvue before acting on a match,
especially for pattern 2 (downtrend reversal), which is the hardest to
encode reliably.

## 4. Deliver results to the trade-management website

The scanner can push its matches straight into the "Scanner" tab of the
trade-management web app (`../index.html`), so you see the latest run there
without opening a CSV. It writes into the same Supabase `app_state` table
the site already uses for trades/positions/prefs, under the key `scanner`
— scoped to your account by the same row-level-security policy.

Set two environment variables (the same email/password you use to sign
into the site):

```bash
# Mac/Linux
export SCANNER_SUPABASE_EMAIL="you@example.com"
export SCANNER_SUPABASE_PASSWORD="your-site-password"
```

```powershell
# Windows (PowerShell) -- set as a permanent user env var so Task Scheduler sees it too
[Environment]::SetEnvironmentVariable("SCANNER_SUPABASE_EMAIL", "you@example.com", "User")
[Environment]::SetEnvironmentVariable("SCANNER_SUPABASE_PASSWORD", "your-site-password", "User")
```

If these aren't set, `scanner.py` just prints a notice and skips delivery
— the CSV report still gets written either way. Never commit these values
to git; they're read from the environment only.

Once set, every run of `scanner.py` pushes its full match list (ticker,
patterns matched, RS percentile, sector/theme leadership, earnings flag,
sector/industry, last close) to Supabase, and the "Scanner" tab on the site
shows it after you sign in.

## 5. Scheduled to run automatically Tue/Fri after close

Already set up via Windows Task Scheduler — `run_scanner.bat` fires every
**Tuesday and Friday at 4:30 PM** (30 min after the 4pm ET close, so Yahoo's
EOD data has settled), no need to remember to run it by hand.

Check its status any time:
```powershell
schtasks /query /tn "TradeManagement Swing Scanner" /v /fo list
```

Change the time/days:
```powershell
schtasks /change /tn "TradeManagement Swing Scanner" /st 17:00
```

Turn it off (e.g. before a vacation) / back on:
```powershell
schtasks /change /tn "TradeManagement Swing Scanner" /disable
schtasks /change /tn "TradeManagement Swing Scanner" /enable
```

**Caveat:** it was created without a stored Windows password, so it only
fires while you're logged into Windows at 4:30 PM — it won't run against a
locked screen saver or signed-out session, but a locked (screen-locked, still
logged-in) session is fine. If you want it to run even when signed out
entirely, re-create it with `/RU <username> /RP <password>` (Task Scheduler
will prompt for the Windows account password, not the Supabase one) — that
wasn't set up automatically since it means storing your Windows login
credential in Task Scheduler's credential vault.

**On a Mac/Linux machine instead**, use cron:
```bash
crontab -e
```
```
30 16 * * 2,5 cd /path/to/scanner && /usr/bin/python3 scanner.py --universe my_universe.csv >> reports/log.txt 2>&1
```
`2,5` = Tuesday and Friday. Adjust the hour if your machine isn't on ET.

## Files

| File | Purpose |
|---|---|
| `config.py` | All tunable thresholds |
| `data_fetch.py` | Pulls OHLCV + sector/industry/earnings via yfinance |
| `patterns.py` | The 3 pattern detectors (ZigZag pivots, IPO base logic, vol/ATR dry-up) |
| `rs_rank.py` | Relative strength, sector leadership, leading-theme tagging |
| `scanner.py` | Orchestrates everything, writes the report |
| `supabase_push.py` | Pushes matches to the trade-management website's Supabase backend |
| `universe_sample.csv` | Example input format |

## Known limitations

- **yfinance is free but not enterprise-grade.** Occasional missing fields
  (sector/industry/earnings date) or rate-limit slowdowns on large
  universes. If this becomes a bottleneck, swap `data_fetch.py` for a paid
  provider (Polygon, EODHD, Finnhub) — nothing else needs to change.
- **News/catalyst detection here is limited to earnings-date proximity.**
  Real catalyst scanning (upgrades, unusual options activity, FDA
  approvals, contract wins) needs a news/options-flow API and isn't
  included — for now, use ToS's news feed or Deepvue's catalyst view on the
  shortlist the scanner produces.
- **Pattern detection is heuristic, not perfect chart recognition.**
  Thresholds in `config.py` are reasonable starting points, not tuned to
  your specific win rate — expect to adjust them after a few weeks of
  comparing matches against what you'd have picked manually.
