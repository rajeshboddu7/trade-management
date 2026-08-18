"""Converts a raw ThinkorSwim Stock Hacker export into the one-column
'ticker' CSV that scanner.py expects.

ToS exports have a couple of header/title lines before the real CSV header
row, and use '/' for share classes (e.g. BRK/B) where Yahoo/yfinance expects
'-' (BRK-B). This handles both.

Usage:
    python prepare_universe.py raw_universe/ToS_Export_16Aug2026.csv my_universe.csv
"""

import csv
import sys


def convert(raw_path: str, out_path: str) -> int:
    with open(raw_path, encoding="utf-8-sig", newline="") as f:
        lines = f.readlines()

    header_idx = next(
        i for i, line in enumerate(lines) if line.strip().startswith("Symbol,")
    )

    reader = csv.DictReader(lines[header_idx:])
    tickers = []
    seen = set()
    for row in reader:
        symbol = (row.get("Symbol") or "").strip().upper()
        if not symbol:
            continue
        symbol = symbol.replace("/", "-")
        if symbol not in seen:
            seen.add(symbol)
            tickers.append(symbol)

    tickers.sort()

    with open(out_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ticker"])
        for t in tickers:
            writer.writerow([t])

    return len(tickers)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python prepare_universe.py <raw_tos_export.csv> <out_universe.csv>")
        sys.exit(1)
    count = convert(sys.argv[1], sys.argv[2])
    print(f"Wrote {count} tickers to {sys.argv[2]}")
