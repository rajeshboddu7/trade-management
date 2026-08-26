"""The 3 pattern detectors. Each takes an OHLCV DataFrame (Open/High/Low/Close/Volume,
indexed by date ascending) and config, and returns a dict with at least a
``match: bool`` key plus whatever detail fields are useful for the report.

Pattern detection here is heuristic, not perfect chart recognition -- it is a
mechanical approximation meant to build a shortlist, not a signal.
"""

import numpy as np
import pandas as pd

import config


# ---------------------------------------------------------------------------
# Pattern 1: IPO-high breakout / consolidation
# ---------------------------------------------------------------------------

def detect_ipo_base(df: pd.DataFrame) -> dict:
    no_match = {"match": False}

    trading_days_per_month = 21
    ipo_window_days = config.IPO_WINDOW_MONTHS * trading_days_per_month
    min_below_days = config.MIN_MONTHS_BELOW_IPO_HIGH * trading_days_per_month
    max_lookback_days = config.IPO_MAX_LOOKBACK_MONTHS * trading_days_per_month

    if len(df) < ipo_window_days + min_below_days:
        return no_match
    if len(df) > max_lookback_days:
        # Enough history that this isn't a "recent IPO" setup anymore.
        return no_match

    ipo_window = df.iloc[:ipo_window_days]
    ipo_high = ipo_window["High"].max()

    post_window = df.iloc[ipo_window_days:]
    if len(post_window) < min_below_days:
        return no_match

    # Must have spent the required stretch below the IPO high before "now".
    below_high_days = int((post_window["Close"] < ipo_high).sum())
    if below_high_days < min_below_days:
        return no_match

    last_close = df["Close"].iloc[-1]
    breakout = last_close >= ipo_high * (1 + config.IPO_BREAKOUT_ABOVE_PCT)
    consolidating = (
        not breakout
        and last_close >= ipo_high * (1 - config.IPO_CONSOLIDATION_BELOW_PCT)
    )

    if not (breakout or consolidating):
        return no_match

    return {
        "match": True,
        "ipo_high": round(float(ipo_high), 2),
        "state": "breakout" if breakout else "consolidating",
        "pct_from_ipo_high": round(float(last_close / ipo_high - 1) * 100, 2),
    }


# ---------------------------------------------------------------------------
# Pattern 2: downtrend reversal (zigzag pivots)
# ---------------------------------------------------------------------------

def _zigzag_pivots(df: pd.DataFrame, min_pct: float) -> list[tuple[pd.Timestamp, float, str]]:
    """Simple zigzag: a new pivot registers once price retraces min_pct from
    the last extreme. Returns list of (date, price, 'H'|'L')."""
    highs = df["High"].values
    lows = df["Low"].values
    dates = df.index

    pivots = []
    if len(df) == 0:
        return pivots

    direction = None  # 'up' or 'down'
    last_extreme_idx = 0
    last_extreme_price = highs[0]
    last_extreme_is_high = True  # tentative

    for i in range(1, len(df)):
        if direction != "down":
            # tracking an up-swing extreme (a high)
            if highs[i] > last_extreme_price:
                last_extreme_price = highs[i]
                last_extreme_idx = i
            elif lows[i] <= last_extreme_price * (1 - min_pct):
                pivots.append((dates[last_extreme_idx], float(last_extreme_price), "H"))
                direction = "down"
                last_extreme_price = lows[i]
                last_extreme_idx = i

        if direction == "down":
            if lows[i] < last_extreme_price:
                last_extreme_price = lows[i]
                last_extreme_idx = i
            elif highs[i] >= last_extreme_price * (1 + min_pct):
                pivots.append((dates[last_extreme_idx], float(last_extreme_price), "L"))
                direction = "up"
                last_extreme_price = highs[i]
                last_extreme_idx = i
        elif direction is None:
            # still deciding initial direction
            if lows[i] <= last_extreme_price * (1 - min_pct):
                direction = "down"
                last_extreme_price = lows[i]
                last_extreme_idx = i

    return pivots


def detect_downtrend_reversal(df: pd.DataFrame) -> dict:
    no_match = {"match": False}

    pivots = _zigzag_pivots(df, config.ZIGZAG_MIN_PCT)
    if len(pivots) < 4:
        return no_match

    recent = pivots[-config.ZIGZAG_LOOKBACK_PIVOTS:]
    highs = [p for p in recent if p[2] == "H"]
    lows = [p for p in recent if p[2] == "L"]
    if len(highs) < 2 or len(lows) < 2:
        return no_match

    # Need: lower high, lower low, then a higher low (most recent low > prior low).
    h_prior, h_recent = highs[-2], highs[-1]
    lower_high = h_recent[1] < h_prior[1]

    l_prior, l_recent = lows[-2], lows[-1]
    lower_low = None
    higher_low = None
    if len(lows) >= 2:
        # find the "lower low" that follows the lower high, and a subsequent higher low
        lower_low = l_prior[1] < h_prior[1]  # sanity: low sits beneath the highs
        higher_low = l_recent[1] > l_prior[1]

    if not (lower_high and higher_low):
        return no_match

    reclaim_level = h_recent[1]  # the lower high that capped the prior bounce
    hold_window = df[df.index > l_recent[0]]
    if len(hold_window) < config.RECLAIM_HOLD_DAYS:
        return no_match

    above = hold_window["Close"] > reclaim_level
    # must currently be reclaiming/holding: last RECLAIM_HOLD_DAYS closes all above the level
    if len(above) < config.RECLAIM_HOLD_DAYS or not above.iloc[-config.RECLAIM_HOLD_DAYS:].all():
        return no_match

    last_close = df["Close"].iloc[-1]
    return {
        "match": True,
        "reclaim_level": round(float(reclaim_level), 2),
        "higher_low": round(float(l_recent[1]), 2),
        "pct_above_reclaim": round(float(last_close / reclaim_level - 1) * 100, 2),
    }


# ---------------------------------------------------------------------------
# Pattern 3: 52-week/all-time-high consolidation with volume dry-up
# ---------------------------------------------------------------------------

def _atr_pct(df: pd.DataFrame, period: int) -> pd.Series:
    prev_close = df["Close"].shift(1)
    tr = pd.concat(
        [
            df["High"] - df["Low"],
            (df["High"] - prev_close).abs(),
            (df["Low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr = tr.rolling(period).mean()
    return atr / df["Close"]


def detect_high_consolidation(df: pd.DataFrame) -> dict:
    no_match = {"match": False}

    lookback = min(len(df), 252)
    window_high = df["High"].iloc[-lookback:].max()
    last_close = df["Close"].iloc[-1]

    if last_close < window_high * (1 - config.NEAR_HIGH_PCT):
        return no_match

    vol_short = df["Volume"].rolling(config.VOL_SHORT_WINDOW).mean().iloc[-1]
    vol_long = df["Volume"].rolling(config.VOL_LONG_WINDOW).mean().iloc[-1]
    if pd.isna(vol_short) or pd.isna(vol_long) or vol_long == 0:
        return no_match
    vol_dryup = vol_short < vol_long * config.VOL_CONTRACTION_RATIO

    atr_pct = _atr_pct(df, config.ATR_PERIOD)
    atr_short = atr_pct.rolling(config.ATR_SHORT_WINDOW).mean().iloc[-1]
    atr_long = atr_pct.rolling(config.ATR_LONG_WINDOW).mean().iloc[-1]
    if pd.isna(atr_short) or pd.isna(atr_long) or atr_long == 0:
        return no_match
    atr_contracting = atr_short < atr_long * config.ATR_CONTRACTION_RATIO

    if not (vol_dryup and atr_contracting):
        return no_match

    return {
        "match": True,
        "window_high": round(float(window_high), 2),
        "pct_from_high": round(float(last_close / window_high - 1) * 100, 2),
        "vol_contraction_ratio": round(float(vol_short / vol_long), 2),
        "atr_contraction_ratio": round(float(atr_short / atr_long), 2),
    }


# ---------------------------------------------------------------------------
# Pattern 4: trend continuation breakout
# ---------------------------------------------------------------------------
# The mirror image of pattern 3: an established uptrend pushing to fresh
# highs with volume that ISN'T drying up, rather than a quiet base near old
# highs. Calibrated against real movers rather than guessed thresholds --
# volume typically normalizes back toward baseline within days of a breakout,
# so this checks for "not contracting" (the inverse of pattern 3's dry-up
# test), not "still actively expanding".

def detect_trend_continuation(df: pd.DataFrame) -> dict:
    no_match = {"match": False}

    if len(df) < config.TREND_SMA_SLOW:
        return no_match

    sma_fast = df["Close"].rolling(config.TREND_SMA_FAST).mean().iloc[-1]
    sma_slow = df["Close"].rolling(config.TREND_SMA_SLOW).mean().iloc[-1]
    last_close = df["Close"].iloc[-1]

    if pd.isna(sma_fast) or pd.isna(sma_slow):
        return no_match
    if not (last_close > sma_fast > sma_slow * (1 + config.TREND_MIN_MA_SEPARATION_PCT)):
        return no_match

    # Overextension guard: don't chase a move that's already run too far above its own trend.
    if last_close > sma_fast * (1 + config.TREND_MAX_EXT_ABOVE_MA50_PCT):
        return no_match

    window = df["High"].iloc[-config.TREND_NEW_HIGH_WINDOW:]
    window_high = window.max()
    if last_close < window_high * (1 - config.TREND_NEAR_NHIGH_PCT):
        return no_match

    vol_short = df["Volume"].rolling(config.TREND_VOL_SHORT_WINDOW).mean().iloc[-1]
    vol_long = df["Volume"].rolling(config.TREND_VOL_LONG_WINDOW).mean().iloc[-1]
    if pd.isna(vol_short) or pd.isna(vol_long) or vol_long == 0:
        return no_match
    vol_ratio = vol_short / vol_long
    if vol_ratio < config.TREND_VOL_EXPANSION_RATIO:
        return no_match

    return {
        "match": True,
        "sma_fast": round(float(sma_fast), 2),
        "sma_slow": round(float(sma_slow), 2),
        "pct_above_sma_fast": round(float(last_close / sma_fast - 1) * 100, 2),
        "window_high": round(float(window_high), 2),
        "vol_expansion_ratio": round(float(vol_ratio), 2),
    }
