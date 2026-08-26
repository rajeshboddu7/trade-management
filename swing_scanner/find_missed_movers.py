"""One-off analysis: which tickers rallied >10% since 2026-08-17 but never
appeared in any scan report, and why the pattern detectors missed them.

Not part of the scheduled pipeline -- run manually when investigating scan
coverage gaps.
"""

import csv
import glob
import sys

import pandas as pd

import config
import data_fetch
import patterns

ANCHOR_DATE = "2026-08-17"
MIN_GAIN_PCT = 10.0


def load_universe(path: str) -> list[str]:
    with open(path, newline="") as f:
        return [row["ticker"].strip().upper() for row in csv.DictReader(f) if row.get("ticker")]


def already_scanned_tickers(reports_glob: str) -> set[str]:
    seen = set()
    for path in glob.glob(reports_glob):
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                t = (row.get("ticker") or "").strip().upper()
                if t:
                    seen.add(t)
    return seen


def pct_since_anchor(df: pd.DataFrame, anchor: str) -> float | None:
    idx = df.index[df.index >= pd.Timestamp(anchor)]
    if len(idx) == 0:
        return None
    anchor_close = df.loc[idx[0], "Close"]
    last_close = df["Close"].iloc[-1]
    if anchor_close == 0:
        return None
    return float(last_close / anchor_close - 1) * 100


def explain_miss(df: pd.DataFrame) -> str:
    reasons = []

    ipo_window_days = config.IPO_WINDOW_MONTHS * 21
    max_lookback_days = config.IPO_MAX_LOOKBACK_MONTHS * 21
    if len(df) > max_lookback_days:
        reasons.append("ipo_base: too much history (not a recent-IPO setup, pattern only looks at listings <=30mo old)")
    else:
        reasons.append("ipo_base: n/a check skipped (short history)")

    lookback = min(len(df), 252)
    window_high = df["High"].iloc[-lookback:].max()
    last_close = df["Close"].iloc[-1]
    pct_from_high = (last_close / window_high - 1) * 100
    if pct_from_high < -config.NEAR_HIGH_PCT * 100:
        reasons.append(f"high_consolidation: {pct_from_high:.1f}% below 52w high, outside the {config.NEAR_HIGH_PCT*100:.0f}% near-high band")
    else:
        vol_short = df["Volume"].rolling(config.VOL_SHORT_WINDOW).mean().iloc[-1]
        vol_long = df["Volume"].rolling(config.VOL_LONG_WINDOW).mean().iloc[-1]
        if pd.notna(vol_short) and pd.notna(vol_long) and vol_long > 0:
            ratio = vol_short / vol_long
            if ratio >= config.VOL_CONTRACTION_RATIO:
                reasons.append(f"high_consolidation: volume EXPANDING not drying up (short/long={ratio:.2f}, needs <{config.VOL_CONTRACTION_RATIO}) -- this is what an active breakout looks like, pattern wants a quiet base instead")

    reasons.append("downtrend_reversal: requires a prior lower-high/lower-low/higher-low zigzag structure -- a straight-line uptrend with no meaningful pullback never forms this shape")

    return " | ".join(reasons)


def main():
    universe_path = sys.argv[1] if len(sys.argv) > 1 else "my_universe_2000_backup.csv"
    tickers = load_universe(universe_path)
    print(f"Universe: {len(tickers)} tickers from {universe_path}", flush=True)

    scanned = already_scanned_tickers("reports/scan_*.csv")
    print(f"Already appeared in some scan report: {len(scanned)} tickers", flush=True)

    movers = []
    for i, t in enumerate(tickers):
        df = data_fetch.fetch_history(t)
        if df is not None:
            pct = pct_since_anchor(df, ANCHOR_DATE)
            if pct is not None and pct >= MIN_GAIN_PCT:
                movers.append((t, pct, df))
        if (i + 1) % 100 == 0:
            print(f"...{i+1}/{len(tickers)}", flush=True)

    movers.sort(key=lambda x: -x[1])
    print(f"\n{len(movers)} tickers up >= {MIN_GAIN_PCT}% since {ANCHOR_DATE}", flush=True)

    missed = [(t, pct, df) for t, pct, df in movers if t not in scanned]
    print(f"{len(missed)} of those never appeared in any scan report:\n", flush=True)

    with open("missed_movers_report.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ticker", "pct_since_2026-08-17", "why_missed"])
        for t, pct, df in missed:
            reason = explain_miss(df)
            w.writerow([t, round(pct, 1), reason])
            print(f"{t:8s} +{pct:5.1f}%  {reason}")

    print("\nWrote missed_movers_report.csv")


if __name__ == "__main__":
    main()
