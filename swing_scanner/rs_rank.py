"""Relative strength vs SPY, sector leadership, and leading-theme tagging.

"Leading theme" is derived purely from RS data (top industries by median RS
this run) rather than a hardcoded theme list, so it doesn't go stale.
"""

import pandas as pd

import config


def _period_return(df: pd.DataFrame, lookback: int) -> float | None:
    if len(df) < lookback + 1:
        return None
    start = df["Close"].iloc[-lookback - 1]
    end = df["Close"].iloc[-1]
    if start == 0:
        return None
    return float(end / start - 1)


def compute_rs_scores(histories: dict[str, pd.DataFrame], spy_df: pd.DataFrame) -> dict[str, float]:
    """Blended RS score per ticker = weighted excess return vs SPY over 3mo/6mo."""
    spy_3m = _period_return(spy_df, config.RS_LOOKBACK_3M)
    spy_6m = _period_return(spy_df, config.RS_LOOKBACK_6M)

    scores = {}
    for ticker, df in histories.items():
        r3 = _period_return(df, config.RS_LOOKBACK_3M)
        r6 = _period_return(df, config.RS_LOOKBACK_6M)
        if r3 is None or r6 is None or spy_3m is None or spy_6m is None:
            continue
        excess_3m = r3 - spy_3m
        excess_6m = r6 - spy_6m
        scores[ticker] = (
            config.RS_WEIGHT_3M * excess_3m + config.RS_WEIGHT_6M * excess_6m
        )
    return scores


def compute_rs_percentiles(scores: dict[str, float]) -> dict[str, float]:
    """Percentile rank (0-100) of each ticker's RS score within the fetched universe."""
    if not scores:
        return {}
    s = pd.Series(scores)
    pct = s.rank(pct=True) * 100
    return pct.to_dict()


def compute_sector_leaders(
    scores: dict[str, float], sectors: dict[str, str | None]
) -> dict[str, bool]:
    """True if ticker is in the top SECTOR_LEADER_PCT of RS within its own sector."""
    by_sector: dict[str, list[str]] = {}
    for ticker, sector in sectors.items():
        if sector and ticker in scores:
            by_sector.setdefault(sector, []).append(ticker)

    leaders = {t: False for t in scores}
    for sector, tickers in by_sector.items():
        ranked = sorted(tickers, key=lambda t: scores[t], reverse=True)
        cutoff = max(1, int(len(ranked) * config.SECTOR_LEADER_PCT))
        for t in ranked[:cutoff]:
            leaders[t] = True
    return leaders


def compute_leading_themes(
    scores: dict[str, float], industries: dict[str, str | None]
) -> tuple[dict[str, bool], list[str]]:
    """Flags tickers in one of the strongest-RS industries this run.

    An industry's strength is its median RS score among tickers with data.
    Top LEADING_THEME_TOP_PCT of industries (by median RS, min 2 members)
    are "leading themes" -- this adapts run to run instead of a fixed list.
    """
    by_industry: dict[str, list[str]] = {}
    for ticker, industry in industries.items():
        if industry and ticker in scores:
            by_industry.setdefault(industry, []).append(ticker)

    medians = {
        ind: pd.Series([scores[t] for t in tickers]).median()
        for ind, tickers in by_industry.items()
        if len(tickers) >= 2
    }

    if not medians:
        return {t: False for t in scores}, []

    ranked_industries = sorted(medians, key=lambda i: medians[i], reverse=True)
    cutoff = max(1, int(len(ranked_industries) * config.LEADING_THEME_TOP_PCT))
    leading = set(ranked_industries[:cutoff])

    flags = {t: False for t in scores}
    for ind in leading:
        for t in by_industry[ind]:
            flags[t] = True

    return flags, sorted(leading)
