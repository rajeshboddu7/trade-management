"""Filters the raw ToS Stock Hacker export down to a liquid, tradable universe.

Replaces the "convert everything" approach in prepare_universe.py with three
liquidity/quality filters, so the scanner runs against ~500-800 names instead
of ~2000, per the README's recommended universe size.

Criteria (see README for rationale):
  - price          >= MIN_PRICE       (avoid penny-stock noise/slippage)
  - avg volume     >= MIN_VOLUME      (ensure fills without moving the price)
  - market cap     >= MIN_MARKET_CAP  (avoid illiquid micro-cap gap risk)
  - drop 5+ letter tickers ending in Y or F (Nasdaq's ADR/foreign-listing
    suffix convention) -- these are OTC/foreign primary listings most
    brokers can't fill cleanly and yfinance often can't fetch reliably.

Usage:
    python filter_universe.py raw_universe/ToS_Export_16Aug2026.csv my_universe.csv
"""

import csv
import sys

MIN_PRICE = 10.0
MIN_VOLUME = 1_000_000
MIN_MARKET_CAP = 300_000_000  # $300M


def parse_market_cap(raw: str) -> float | None:
    raw = raw.strip().replace(",", "")
    if not raw or raw == "<empty>":
        return None
    if raw.endswith(" M"):
        return float(raw[:-2]) * 1_000_000
    if raw.endswith(" B"):
        return float(raw[:-2]) * 1_000_000_000
    return None


def is_otc_foreign_suffix(symbol: str) -> bool:
    return len(symbol) >= 5 and symbol[-1] in ("Y", "F")


def filter_universe(raw_path: str, out_path: str) -> dict:
    with open(raw_path, encoding="utf-8-sig", newline="") as f:
        lines = f.readlines()

    header_idx = next(
        i for i, line in enumerate(lines) if line.strip().startswith("Symbol,")
    )
    reader = csv.DictReader(lines[header_idx:])

    kept = []
    seen = set()
    dropped = {"price": 0, "volume": 0, "market_cap": 0, "otc_suffix": 0, "bad_data": 0}

    for row in reader:
        symbol = (row.get("Symbol") or "").strip().upper().replace("/", "-")
        if not symbol or symbol in seen:
            continue

        if is_otc_foreign_suffix(symbol):
            dropped["otc_suffix"] += 1
            continue

        try:
            price = float(row["Last"])
            volume = int(row["Volume"].replace(",", ""))
        except (ValueError, KeyError):
            dropped["bad_data"] += 1
            continue

        market_cap = parse_market_cap(row.get("Market Cap", ""))
        if market_cap is None:
            dropped["bad_data"] += 1
            continue

        if price < MIN_PRICE:
            dropped["price"] += 1
            continue
        if volume < MIN_VOLUME:
            dropped["volume"] += 1
            continue
        if market_cap < MIN_MARKET_CAP:
            dropped["market_cap"] += 1
            continue

        seen.add(symbol)
        kept.append(symbol)

    kept.sort()

    with open(out_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ticker"])
        for t in kept:
            writer.writerow([t])

    return {"kept": len(kept), "dropped": dropped}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python filter_universe.py <raw_tos_export.csv> <out_universe.csv>")
        sys.exit(1)
    stats = filter_universe(sys.argv[1], sys.argv[2])
    print(f"Kept {stats['kept']} tickers -> {sys.argv[2]}")
    print("Dropped:", stats["dropped"])
