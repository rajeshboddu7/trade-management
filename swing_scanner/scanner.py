"""Orchestrates the swing scan: fetch -> filter -> pattern match -> RS rank -> CSV report."""

import argparse
import datetime as dt
import os
import sys

import pandas as pd

import config
import data_fetch
import patterns
import rs_rank
import supabase_push


def load_universe(path: str) -> list[str]:
    df = pd.read_csv(path)
    if "ticker" not in df.columns:
        raise ValueError(f"{path} must have a 'ticker' column")
    return [str(t).strip().upper() for t in df["ticker"].dropna().unique()]


def avg_dollar_volume(df: pd.DataFrame, window: int = 20) -> float:
    tail = df.tail(window)
    return float((tail["Close"] * tail["Volume"]).mean())


def passes_liquidity_filter(df: pd.DataFrame) -> bool:
    last_close = df["Close"].iloc[-1]
    if last_close < config.MIN_PRICE:
        return False
    if avg_dollar_volume(df) < config.MIN_AVG_DOLLAR_VOL:
        return False
    return True


def _progress(i: int, n: int, ticker: str, label: str) -> None:
    sys.stdout.write(f"\r{label}: {i}/{n} ({ticker.ljust(8)})")
    sys.stdout.flush()
    if i == n:
        sys.stdout.write("\n")


def run_scan(universe_path: str) -> pd.DataFrame:
    tickers = load_universe(universe_path)
    print(f"Loaded {len(tickers)} tickers from {universe_path}")

    print("Fetching SPY benchmark history...")
    spy_df = data_fetch.fetch_history("SPY")
    if spy_df is None:
        raise RuntimeError("Could not fetch SPY history -- aborting scan")

    print("Fetching universe price history...")
    histories = data_fetch.fetch_universe(
        tickers, progress_cb=lambda i, n, t: _progress(i, n, t, "history")
    )
    print(f"Fetched history for {len(histories)}/{len(tickers)} tickers")

    liquid = {t: df for t, df in histories.items() if passes_liquidity_filter(df)}
    print(f"{len(liquid)} tickers pass the liquidity/price filter")

    print("Fetching sector/industry/earnings profiles...")
    profiles = data_fetch.fetch_profiles(
        list(liquid.keys()), progress_cb=lambda i, n, t: _progress(i, n, t, "profiles")
    )

    sectors = {t: p["sector"] for t, p in profiles.items()}
    industries = {t: p["industry"] for t, p in profiles.items()}

    print("Computing relative strength...")
    rs_scores = rs_rank.compute_rs_scores(liquid, spy_df)
    rs_pct = rs_rank.compute_rs_percentiles(rs_scores)
    sector_leaders = rs_rank.compute_sector_leaders(rs_scores, sectors)
    theme_flags, leading_themes = rs_rank.compute_leading_themes(rs_scores, industries)
    if leading_themes:
        print(f"Leading themes this run: {', '.join(leading_themes)}")

    print("Running pattern detectors...")
    today = pd.Timestamp.now().normalize()
    rows = []
    for ticker, df in liquid.items():
        p1 = patterns.detect_ipo_base(df)
        p2 = patterns.detect_downtrend_reversal(df)
        p3 = patterns.detect_high_consolidation(df)

        matched = [
            name
            for name, res in (
                ("ipo_base", p1),
                ("downtrend_reversal", p2),
                ("high_consolidation", p3),
            )
            if res["match"]
        ]
        if not matched:
            continue

        earnings_date = profiles.get(ticker, {}).get("earnings_date")
        earnings_soon = False
        if earnings_date is not None:
            try:
                days_out = (pd.Timestamp(earnings_date).normalize() - today).days
                earnings_soon = 0 <= days_out <= config.EARNINGS_WITHIN_DAYS
            except Exception:
                earnings_soon = False

        rows.append(
            {
                "ticker": ticker,
                "patterns": ", ".join(matched),
                "ipo_base_detail": p1 if p1["match"] else "",
                "downtrend_reversal_detail": p2 if p2["match"] else "",
                "high_consolidation_detail": p3 if p3["match"] else "",
                "last_close": round(float(df["Close"].iloc[-1]), 2),
                "avg_dollar_vol_20d": round(avg_dollar_volume(df), 0),
                "sector": sectors.get(ticker),
                "industry": industries.get(ticker),
                "rs_percentile": round(rs_pct.get(ticker, 0), 1),
                "sector_leader": sector_leaders.get(ticker, False),
                "leading_theme": theme_flags.get(ticker, False),
                "earnings_within_14d": earnings_soon,
                "earnings_date": earnings_date,
            }
        )

    out_df = pd.DataFrame(rows)
    if not out_df.empty:
        out_df = out_df.sort_values(
            by=["rs_percentile", "sector_leader", "leading_theme"], ascending=False
        ).reset_index(drop=True)

    return out_df


def _json_safe(value):
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if pd.isna(value) if not isinstance(value, (list, dict)) else False:
        return None
    if hasattr(value, "item"):  # numpy scalar (bool_, int64, float64, ...)
        return value.item()
    return value


def build_cloud_payload(out_df: pd.DataFrame, universe_path: str) -> dict:
    records = [
        {k: _json_safe(v) for k, v in row.items()}
        for row in out_df.to_dict(orient="records")
    ]
    return {
        "generatedAt": dt.datetime.now().isoformat(),
        "universeFile": os.path.basename(universe_path),
        "matchCount": len(records),
        "matches": records,
    }


def main():
    parser = argparse.ArgumentParser(description="Swing scanner")
    parser.add_argument("--universe", required=True, help="Path to universe CSV with a 'ticker' column")
    args = parser.parse_args()

    out_df = run_scan(args.universe)

    os.makedirs("reports", exist_ok=True)
    stamp = dt.date.today().isoformat()
    day_name = dt.date.today().strftime("%A")
    out_path = os.path.join("reports", f"scan_{stamp}_{day_name}.csv")
    out_df.to_csv(out_path, index=False)

    print(f"\n{len(out_df)} matches. Report written to {out_path}\n")
    if not out_df.empty:
        preview_cols = [
            "ticker",
            "patterns",
            "rs_percentile",
            "sector_leader",
            "leading_theme",
            "earnings_within_14d",
            "sector",
        ]
        print(out_df[preview_cols].head(config.TOP_PREVIEW_N).to_string(index=False))

        print()
        pattern_labels = {
            "ipo_base": "IPO-high breakout/consolidation",
            "downtrend_reversal": "Downtrend reversal",
            "high_consolidation": "52w/ATH consolidation (vol dry-up)",
        }
        for key, label in pattern_labels.items():
            group = out_df[out_df["patterns"].str.contains(key)]
            tickers = ", ".join(group["ticker"])
            print(f"{label} ({len(group)}): {tickers if tickers else '-'}")

    supabase_push.push_results(build_cloud_payload(out_df, args.universe))


if __name__ == "__main__":
    main()
