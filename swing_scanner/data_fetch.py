"""Pulls OHLCV + sector/industry/earnings via yfinance.

yfinance is free but not enterprise-grade -- individual tickers can fail or
come back with missing fields. Every function here is defensive: a failure
on one ticker returns None/empty rather than blowing up the whole run.
"""

import time

import pandas as pd
import yfinance as yf

import config


def fetch_history(ticker: str, period: str = config.HISTORY_PERIOD) -> pd.DataFrame | None:
    """Daily OHLCV for one ticker. Returns None on failure or too-short history."""
    try:
        df = yf.Ticker(ticker).history(period=period, interval="1d", auto_adjust=True)
    except Exception:
        return None

    if df is None or df.empty or len(df) < config.MIN_HISTORY_DAYS:
        return None

    df = df.rename(columns=str.title)
    df.index = pd.to_datetime(df.index).tz_localize(None)
    return df[["Open", "High", "Low", "Close", "Volume"]]


def fetch_profile(ticker: str) -> dict:
    """Sector, industry, and next earnings date. Missing fields degrade gracefully."""
    profile = {"sector": None, "industry": None, "earnings_date": None}
    try:
        info = yf.Ticker(ticker).get_info()
        profile["sector"] = info.get("sector")
        profile["industry"] = info.get("industry")
    except Exception:
        pass

    try:
        edates = yf.Ticker(ticker).get_earnings_dates(limit=4)
        if edates is not None and not edates.empty:
            future = edates.index[edates.index.tz_localize(None) >= pd.Timestamp.now()]
            if len(future) > 0:
                profile["earnings_date"] = future.min().tz_localize(None) if future.min().tzinfo else future.min()
    except Exception:
        pass

    return profile


def fetch_universe(tickers: list[str], pause: float = 0.0, progress_cb=None) -> dict[str, pd.DataFrame]:
    """Fetch history for every ticker in the universe, skipping failures."""
    out = {}
    for i, t in enumerate(tickers):
        df = fetch_history(t)
        if df is not None:
            out[t] = df
        if progress_cb:
            progress_cb(i + 1, len(tickers), t)
        if pause:
            time.sleep(pause)
    return out


def fetch_profiles(tickers: list[str], pause: float = 0.0, progress_cb=None) -> dict[str, dict]:
    out = {}
    for i, t in enumerate(tickers):
        out[t] = fetch_profile(t)
        if progress_cb:
            progress_cb(i + 1, len(tickers), t)
        if pause:
            time.sleep(pause)
    return out
