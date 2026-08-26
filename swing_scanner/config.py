"""All tunable thresholds for the swing scanner. Nothing pattern-specific
lives outside this file, so tune here rather than in patterns.py."""

# --- Universe / liquidity filter ---------------------------------------
MIN_PRICE = 10.0
MIN_AVG_DOLLAR_VOL = 5_000_000       # 20-day avg price * volume
MIN_HISTORY_DAYS = 80                # skip tickers with too little history

# --- Data fetch -----------------------------------------------------------
# "max" (not e.g. "2y") so the true IPO/listing date is known -- a fixed
# window truncates old and young tickers to the same length, which makes
# mature stocks look like recent IPOs to pattern 1.
HISTORY_PERIOD = "max"
EARNINGS_WITHIN_DAYS = 14

# --- Pattern 1: IPO-high breakout / consolidation --------------------------
IPO_WINDOW_MONTHS = 3                # "first ~3 months of trading" window used to set the IPO high
MIN_MONTHS_BELOW_IPO_HIGH = 3        # must have spent 3+ months below that high
IPO_BREAKOUT_ABOVE_PCT = 0.0         # price above IPO high counts as breakout
IPO_CONSOLIDATION_BELOW_PCT = 0.05   # or within 5% below it counts as consolidation/tightening
IPO_MAX_LOOKBACK_MONTHS = 30         # ignore IPOs older than this (stale base, not a "recent" setup)

# --- Pattern 2: downtrend reversal (zigzag) ---------------------------------
ZIGZAG_MIN_PCT = 0.08                # min swing size (%) to register as a zigzag pivot
ZIGZAG_LOOKBACK_PIVOTS = 5           # how many recent pivots to examine for the LH/LL/HL structure
RECLAIM_HOLD_DAYS = 3                # days price must hold above the reclaimed lower-high level

# --- Pattern 3: 52-week/all-time-high consolidation with volume dry-up -----
NEAR_HIGH_PCT = 0.10                 # price within 10% of 52w/all-time high
VOL_SHORT_WINDOW = 10                # short avg-volume window
VOL_LONG_WINDOW = 50                 # long avg-volume window baseline
VOL_CONTRACTION_RATIO = 0.75         # short avg vol must be below this * long avg vol
ATR_PERIOD = 14
ATR_SHORT_WINDOW = 10
ATR_LONG_WINDOW = 50
ATR_CONTRACTION_RATIO = 0.80         # short ATR% must be below this * long ATR%

# --- Pattern 4: trend continuation breakout (rising volume) ----------------
TREND_SMA_FAST = 50                  # price must be above this...
TREND_SMA_SLOW = 150                 # ...which must be above this (uptrend structure)
TREND_MIN_MA_SEPARATION_PCT = 0.03   # ...by at least 3%, not just a bare crossover -- a decisive
                                      # trend, not an early/choppy one still sorting itself out
TREND_NEW_HIGH_WINDOW = 20           # "fresh high" lookback, in trading days
TREND_NEAR_NHIGH_PCT = 0.03          # within 3% of that window's high counts as "making it" --
                                      # actively at a fresh high, not one set a week or two ago
TREND_VOL_SHORT_WINDOW = 10
TREND_VOL_LONG_WINDOW = 50
TREND_VOL_EXPANSION_RATIO = 0.80     # short avg vol must be >= this * long avg vol -- i.e. NOT
                                      # in pattern 3's dry-up regime (ratio < 0.75). Calibrated
                                      # against real movers: by the time a stock is up double
                                      # digits over more than a few days, its breakout-day volume
                                      # spike has usually already faded back toward baseline, so
                                      # "not contracting" is a more realistic bar than "still
                                      # actively expanding".
TREND_MAX_EXT_ABOVE_MA50_PCT = 0.60  # don't chase a move already >60% above its 50-day MA

# --- Relative strength / leadership ----------------------------------------
RS_LOOKBACK_3M = 63                  # trading days (~3 months)
RS_LOOKBACK_6M = 126                 # trading days (~6 months)
RS_WEIGHT_3M = 0.4
RS_WEIGHT_6M = 0.6
SECTOR_LEADER_PCT = 0.30             # top 30% RS within its sector
LEADING_THEME_TOP_PCT = 0.20         # top 20% of industries by median RS

# --- Output -----------------------------------------------------------------
TOP_PREVIEW_N = 15
