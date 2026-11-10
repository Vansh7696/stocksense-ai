"""
StockSense AI — Technical Indicators Calculation Engine
Mathematically rigorous, zero look-ahead bias, vectorized technical indicators
for Indian Equities (NSE / BSE).
"""

import numpy as np
import pandas as pd
from typing import Dict, Any, List, Optional, Tuple, Union


def calculate_sma(prices: np.ndarray, period: int) -> np.ndarray:
    """
    Simple Moving Average (SMA).
    Calculates the unweighted mean of the previous N closing prices.

    Formula:
        SMA_N(t) = (1 / N) * sum_{i=0}^{N-1} P_{t-i}

    Warm-up:
        The first (period - 1) entries are NaN. Index (period - 1) is the first valid value.
    """
    if period <= 0:
        raise ValueError(f"SMA period must be a positive integer, got {period}")

    n = len(prices)
    if n < period:
        return np.full(n, np.nan, dtype=float)

    # Rolling backward-looking mean ensures zero look-ahead bias
    s = pd.Series(prices, dtype=float)
    return s.rolling(window=period, min_periods=period).mean().to_numpy()


def calculate_ema(prices: np.ndarray, period: int) -> np.ndarray:
    """
    Exponential Moving Average (EMA).
    Applies exponential weighting giving higher weight to recent prices.

    Formula:
        multiplier = 2 / (period + 1)
        EMA(t) = (Price(t) - EMA(t-1)) * multiplier + EMA(t-1)
               = Price(t) * multiplier + EMA(t-1) * (1 - multiplier)

    Seeding:
        Standard industry initialization: EMA at index (period - 1) is seeded
        with the SMA of the first N prices.

    Warm-up:
        The first (period - 1) entries are NaN.
    """
    if period <= 0:
        raise ValueError(f"EMA period must be a positive integer, got {period}")

    n = len(prices)
    result = np.full(n, np.nan, dtype=float)
    if n < period:
        return result

    multiplier = 2.0 / (period + 1.0)

    # Seed with initial SMA
    initial_sma = np.mean(prices[:period])
    result[period - 1] = initial_sma

    # Iterative calculation strictly forward in time (no look-ahead)
    prev_ema = initial_sma
    for i in range(period, n):
        curr_price = float(prices[i])
        if np.isnan(curr_price):
            result[i] = np.nan
            continue
        curr_ema = (curr_price * multiplier) + (prev_ema * (1.0 - multiplier))
        result[i] = curr_ema
        prev_ema = curr_ema

    return result


def calculate_rsi(prices: np.ndarray, period: int = 14) -> np.ndarray:
    """
    Relative Strength Index (RSI).
    Standard 14-period momentum oscillator using Wilder's Smoothed Moving Average (RMA).

    Formula:
        delta_t = Price_t - Price_{t-1}
        Gain = max(delta_t, 0), Loss = max(-delta_t, 0)
        Initial AvgGain = mean(Gains[1..period]), Initial AvgLoss = mean(Losses[1..period])
        Subsequent:
            AvgGain_t = (AvgGain_{t-1} * (period - 1) + Gain_t) / period
            AvgLoss_t = (AvgLoss_{t-1} * (period - 1) + Loss_t) / period
        RS = AvgGain / AvgLoss
        RSI = 100 - (100 / (1 + RS)) = 100 * (AvgGain / (AvgGain + AvgLoss))

    Edge cases:
        - AvgLoss == 0 and AvgGain == 0: RSI = 50.0 (perfectly flat market)
        - AvgLoss == 0 and AvgGain > 0: RSI = 100.0 (all up moves)
        - AvgGain == 0 and AvgLoss > 0: RSI = 0.0 (all down moves)

    Warm-up:
        First `period` entries (indices 0..period-1) are NaN.
        First valid RSI appears at index `period`.
    """
    if period <= 0:
        raise ValueError(f"RSI period must be a positive integer, got {period}")

    n = len(prices)
    result = np.full(n, np.nan, dtype=float)
    if n < period + 1:
        return result

    deltas = np.diff(prices)
    gains = np.maximum(deltas, 0.0)
    losses = np.maximum(-deltas, 0.0)

    # Initial average gain and loss (SMA of first `period` changes)
    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])

    if avg_loss == 0.0:
        result[period] = 100.0 if avg_gain > 0.0 else 50.0
    else:
        rs = avg_gain / avg_loss
        result[period] = 100.0 - (100.0 / (1.0 + rs))

    # Wilder's smoothing for subsequent periods
    for i in range(period, len(deltas)):
        gain = gains[i]
        loss = losses[i]

        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period

        idx = i + 1
        if avg_loss == 0.0:
            result[idx] = 100.0 if avg_gain > 0.0 else 50.0
        else:
            rs = avg_gain / avg_loss
            result[idx] = 100.0 - (100.0 / (1.0 + rs))

    return result


def calculate_macd(
    prices: np.ndarray,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Moving Average Convergence Divergence (MACD).

    Formulas:
        MACD Line = EMA_fast(prices) - EMA_slow(prices)
        Signal Line = EMA_signal(MACD Line)
        MACD Histogram = MACD Line - Signal Line

    Warm-up:
        - MACD Line is valid from index (slow - 1).
        - Signal Line is valid from index (slow + signal - 2).
        - Histogram is valid from index (slow + signal - 2).
        (With 12, 26, 9: Signal & Histogram are valid starting at index 33, i.e., 34th candle).
    """
    if fast >= slow:
        raise ValueError(f"MACD fast period ({fast}) must be less than slow period ({slow})")

    n = len(prices)
    macd_line = np.full(n, np.nan, dtype=float)
    signal_line = np.full(n, np.nan, dtype=float)
    histogram = np.full(n, np.nan, dtype=float)

    if n < slow:
        return macd_line, signal_line, histogram

    ema_fast = calculate_ema(prices, fast)
    ema_slow = calculate_ema(prices, slow)

    # MACD Line is difference between fast and slow EMAs
    macd_line = ema_fast - ema_slow

    # Compute Signal Line: EMA(signal) over the valid portion of macd_line
    valid_start = slow - 1
    if n - valid_start >= signal:
        valid_macd = macd_line[valid_start:]
        signal_sub = calculate_ema(valid_macd, signal)
        signal_line[valid_start:] = signal_sub
        histogram = macd_line - signal_line

    return macd_line, signal_line, histogram


def calculate_bollinger_bands(
    prices: np.ndarray,
    period: int = 20,
    num_std: float = 2.0,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Bollinger Bands (BB).

    Formulas:
        Middle Band = SMA_period(prices)
        StdDev = Rolling population standard deviation of prices over period
        Upper Band = Middle Band + (num_std * StdDev)
        Lower Band = Middle Band - (num_std * StdDev)
        %B = (Price - Lower Band) / (Upper Band - Lower Band)
        Bandwidth = (Upper Band - Lower Band) / Middle Band

    Warm-up:
        First (period - 1) entries are NaN. Index (period - 1) is first valid.
    """
    if period <= 0:
        raise ValueError(f"Bollinger Bands period must be positive, got {period}")
    if num_std <= 0:
        raise ValueError(f"Bollinger Bands num_std must be positive, got {num_std}")

    n = len(prices)
    upper = np.full(n, np.nan, dtype=float)
    middle = np.full(n, np.nan, dtype=float)
    lower = np.full(n, np.nan, dtype=float)
    percent_b = np.full(n, np.nan, dtype=float)
    bandwidth = np.full(n, np.nan, dtype=float)

    if n < period:
        return upper, middle, lower, percent_b, bandwidth

    s = pd.Series(prices, dtype=float)
    middle = s.rolling(window=period, min_periods=period).mean().to_numpy()
    std = s.rolling(window=period, min_periods=period).std(ddof=0).to_numpy()

    upper = middle + (num_std * std)
    lower = middle - (num_std * std)

    # Safe calculation of bandwidth and %B to prevent division by zero on flat prices
    span = upper - lower
    valid_mask = ~np.isnan(middle)

    for i in range(n):
        if not valid_mask[i]:
            continue
        m = middle[i]
        sp = span[i]
        p = prices[i]

        bandwidth[i] = (sp / m) if m > 0 else 0.0
        percent_b[i] = ((p - lower[i]) / sp) if sp > 1e-9 else 0.5

    return upper, middle, lower, percent_b, bandwidth


def calculate_atr(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    period: int = 14,
) -> np.ndarray:
    """
    Average True Range (ATR).
    Measures market volatility using Welles Wilder's smoothing technique.

    Formulas:
        TR_0 = High_0 - Low_0
        TR_t = max(High_t - Low_t, |High_t - Close_{t-1}|, |Low_t - Close_{t-1}|)
        Initial ATR = mean(TR[0..period-1])
        Subsequent ATR_t = (ATR_{t-1} * (period - 1) + TR_t) / period

    Warm-up:
        First (period - 1) entries are NaN. First valid ATR is at index (period - 1).
    """
    if period <= 0:
        raise ValueError(f"ATR period must be positive, got {period}")

    n = len(close)
    atr = np.full(n, np.nan, dtype=float)
    if n < period:
        return atr

    # Compute True Range (TR)
    tr = np.zeros(n, dtype=float)
    tr[0] = float(high[0] - low[0])

    for i in range(1, n):
        h = float(high[i])
        l = float(low[i])
        prev_c = float(close[i - 1])
        tr[i] = max(h - l, abs(h - prev_c), abs(l - prev_c))

    # Initial ATR is simple average of first `period` TRs
    initial_atr = np.mean(tr[:period])
    atr[period - 1] = initial_atr

    # Wilder's smoothing
    prev_atr = initial_atr
    for i in range(period, n):
        curr_atr = (prev_atr * (period - 1) + tr[i]) / period
        atr[i] = curr_atr
        prev_atr = curr_atr

    return atr


def calculate_returns(prices: np.ndarray, percentage: bool = True) -> np.ndarray:
    """
    Daily Percentage or Fractional Returns.

    Formula:
        Return_t = (Price_t - Price_{t-1}) / Price_{t-1} [* 100 if percentage]

    Warm-up:
        Index 0 is NaN (requires a previous reference price).
    """
    n = len(prices)
    returns = np.full(n, np.nan, dtype=float)
    if n < 2:
        return returns

    mult = 100.0 if percentage else 1.0
    for i in range(1, n):
        prev = float(prices[i - 1])
        curr = float(prices[i])
        if prev > 0:
            returns[i] = ((curr - prev) / prev) * mult
        else:
            returns[i] = 0.0

    return returns


def calculate_rolling_volatility(
    returns: np.ndarray,
    window: int = 20,
    annualize: bool = True,
    trading_days: int = 252,
) -> np.ndarray:
    """
    Rolling Volatility.
    Sample standard deviation of daily returns over a rolling window, optionally annualized.

    Formula:
        Daily Volatility = std(Returns[t-window+1 .. t], ddof=1)
        Annualized Volatility = Daily Volatility * sqrt(trading_days)

    Warm-up:
        Requires `window` valid return entries. If returns has NaN at index 0,
        the first valid volatility value appears at index `window`.
    """
    if window <= 1:
        raise ValueError(f"Volatility window must be > 1, got {window}")

    n = len(returns)
    vol = np.full(n, np.nan, dtype=float)
    if n < window:
        return vol

    s = pd.Series(returns, dtype=float)
    rolling_std = s.rolling(window=window, min_periods=window).std(ddof=1).to_numpy()

    if annualize:
        annual_factor = np.sqrt(float(trading_days))
        vol = rolling_std * annual_factor
    else:
        vol = rolling_std

    return vol


def calculate_volume_sma(volume: np.ndarray, period: int = 20) -> np.ndarray:
    """
    Volume Simple Moving Average.

    Formula:
        VolSMA_N(t) = (1 / N) * sum_{i=0}^{N-1} Volume_{t-i}

    Warm-up:
        First (period - 1) entries are NaN.
    """
    if period <= 0:
        raise ValueError(f"Volume SMA period must be positive, got {period}")

    n = len(volume)
    if n < period:
        return np.full(n, np.nan, dtype=float)

    s = pd.Series(volume, dtype=float)
    return s.rolling(window=period, min_periods=period).mean().to_numpy()


def calculate_relative_volume(volume: np.ndarray, volume_sma: np.ndarray) -> np.ndarray:
    """
    Relative Volume (RVOL).
    Measures current bar's volume relative to its historical moving average.

    Formula:
        RVOL_t = Volume_t / VolSMA_t

    Edge cases:
        If VolSMA == 0: returns 0.0 without division by zero.
        If VolSMA is NaN: returns NaN.
    """
    n = len(volume)
    rvol = np.full(n, np.nan, dtype=float)

    for i in range(n):
        v_sma = volume_sma[i]
        if np.isnan(v_sma):
            continue
        if v_sma > 0:
            rvol[i] = float(volume[i]) / v_sma
        else:
            rvol[i] = 0.0

    return rvol


class TechnicalAnalysisEngine:
    """
    Comprehensive high-performance technical analysis calculator.
    Processes OHLCV candlestick records and produces aligned indicator series.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        cfg = config or {}
        self.sma_periods = cfg.get("sma_periods", [20, 50, 200])
        self.ema_periods = cfg.get("ema_periods", [12, 26, 50])
        self.rsi_period = cfg.get("rsi_period", 14)
        self.macd_fast = cfg.get("macd_fast", 12)
        self.macd_slow = cfg.get("macd_slow", 26)
        self.macd_signal = cfg.get("macd_signal", 9)
        self.bollinger_period = cfg.get("bollinger_period", 20)
        self.bollinger_std = cfg.get("bollinger_std", 2.0)
        self.atr_period = cfg.get("atr_period", 14)
        self.volatility_window = cfg.get("volatility_window", 20)
        self.volume_ma_period = cfg.get("volume_ma_period", 20)

    def compute(self, candles: Union[List[Dict[str, Any]], pd.DataFrame]) -> Dict[str, Any]:
        """
        Executes calculation across all 10 required technical indicators.
        Guarantees strict chronological alignment and zero future look-ahead.

        Returns dictionary of series, latest values, and metadata.
        """
        if isinstance(candles, pd.DataFrame):
            df = candles.copy()
        else:
            df = pd.DataFrame([c if isinstance(c, dict) else c.model_dump() for c in candles])

        total_candles = len(df)
        if total_candles == 0:
            raise ValueError("Cannot compute technical indicators on an empty candle dataset.")

        # Ensure required columns exist
        required_cols = ["timestamp", "open", "high", "low", "close", "volume"]
        missing = [c for c in required_cols if c not in df.columns]
        if missing:
            raise ValueError(f"Missing required OHLCV columns: {missing}")

        # Ensure chronological ordering ascending and deduplicate duplicate timestamps
        df = df.sort_values("timestamp").drop_duplicates(subset=["timestamp"], keep="last").reset_index(drop=True)

        # Extract numeric arrays
        timestamps = [str(t) for t in df["timestamp"]]
        opens = df["open"].to_numpy(dtype=float)
        highs = df["high"].to_numpy(dtype=float)
        lows = df["low"].to_numpy(dtype=float)
        closes = df["close"].to_numpy(dtype=float)
        volumes = df["volume"].to_numpy(dtype=float)

        # Validate basic candle sanity (High >= Low)
        invalid_bars = np.where(highs < lows)[0]
        if len(invalid_bars) > 0:
            raise ValueError(
                f"Invalid candle data: High price is less than Low price at indices {invalid_bars.tolist()[:5]}"
            )

        # 1. Simple Moving Averages (20, 50, 200)
        sma_results = {}
        for p in self.sma_periods:
            sma_results[f"sma_{p}"] = calculate_sma(closes, p)

        # 2. Exponential Moving Averages (12, 26, 50)
        ema_results = {}
        for p in self.ema_periods:
            ema_results[f"ema_{p}"] = calculate_ema(closes, p)

        # 3. Relative Strength Index (14)
        rsi_series = calculate_rsi(closes, self.rsi_period)

        # 4. MACD (12, 26, 9)
        macd_line, signal_line, macd_hist = calculate_macd(
            closes, self.macd_fast, self.macd_slow, self.macd_signal
        )

        # 5. Bollinger Bands (20, 2)
        bb_upper, bb_middle, bb_lower, bb_pct_b, bb_bandwidth = calculate_bollinger_bands(
            closes, self.bollinger_period, self.bollinger_std
        )

        # 6. Average True Range (14)
        atr_series = calculate_atr(highs, lows, closes, self.atr_period)

        # 7. Daily Percentage Returns
        daily_returns_pct = calculate_returns(closes, percentage=True)
        daily_returns_frac = calculate_returns(closes, percentage=False)

        # 8. Rolling Volatility (20-day annualized)
        rolling_vol_pct = calculate_rolling_volatility(
            daily_returns_pct, window=self.volatility_window, annualize=True
        )

        # 9. Volume Moving Average (20)
        vol_sma_series = calculate_volume_sma(volumes, self.volume_ma_period)

        # 10. Relative Volume (RVOL)
        rvol_series = calculate_relative_volume(volumes, vol_sma_series)

        # Determine overall warm-up status
        max_period_needed = max(
            max(self.sma_periods, default=20),
            max(self.ema_periods, default=26),
            self.macd_slow + self.macd_signal - 1,
            self.bollinger_period,
            self.volatility_window,
        )

        if total_candles >= max_period_needed:
            warmup_status = "READY"
        elif total_candles >= 20:
            warmup_status = "PARTIAL_WARMUP"
        else:
            warmup_status = "INSUFFICIENT_OBSERVATIONS"

        def _to_clean_list(arr: np.ndarray) -> List[Optional[float]]:
            return [None if np.isnan(v) else round(float(v), 4) for v in arr]

        indicators_payload = {
            "timestamps": timestamps,
            "close": [round(float(c), 4) for c in closes],
            "sma": {k: _to_clean_list(v) for k, v in sma_results.items()},
            "ema": {k: _to_clean_list(v) for k, v in ema_results.items()},
            "rsi": _to_clean_list(rsi_series),
            "macd": {
                "macd_line": _to_clean_list(macd_line),
                "signal_line": _to_clean_list(signal_line),
                "histogram": _to_clean_list(macd_hist),
            },
            "bollinger_bands": {
                "upper": _to_clean_list(bb_upper),
                "middle": _to_clean_list(bb_middle),
                "lower": _to_clean_list(bb_lower),
                "percent_b": _to_clean_list(bb_pct_b),
                "bandwidth": _to_clean_list(bb_bandwidth),
            },
            "atr": _to_clean_list(atr_series),
            "daily_returns_pct": _to_clean_list(daily_returns_pct),
            "rolling_volatility_pct": _to_clean_list(rolling_vol_pct),
            "volume_sma": _to_clean_list(vol_sma_series),
            "relative_volume": _to_clean_list(rvol_series),
        }

        # Latest snapshot
        last_idx = total_candles - 1
        latest_snapshot = {
            "timestamp": timestamps[last_idx],
            "close": round(float(closes[last_idx]), 4),
            "rsi": _to_clean_list(rsi_series)[last_idx],
            "macd_histogram": _to_clean_list(macd_hist)[last_idx],
            "bollinger_percent_b": _to_clean_list(bb_pct_b)[last_idx],
            "atr": _to_clean_list(atr_series)[last_idx],
            "daily_returns_pct": _to_clean_list(daily_returns_pct)[last_idx],
            "rolling_volatility_pct": _to_clean_list(rolling_vol_pct)[last_idx],
            "relative_volume": _to_clean_list(rvol_series)[last_idx],
        }
        for k, v in sma_results.items():
            latest_snapshot[k] = _to_clean_list(v)[last_idx]
        for k, v in ema_results.items():
            latest_snapshot[k] = _to_clean_list(v)[last_idx]

        return {
            "total_candles": total_candles,
            "warmup_status": warmup_status,
            "max_period_needed": max_period_needed,
            "indicators": indicators_payload,
            "latest": latest_snapshot,
            "raw_arrays": {
                "closes": closes,
                "highs": highs,
                "lows": lows,
                "volumes": volumes,
                "sma": sma_results,
                "ema": ema_results,
                "rsi": rsi_series,
                "macd_line": macd_line,
                "signal_line": signal_line,
                "macd_hist": macd_hist,
                "bb_upper": bb_upper,
                "bb_middle": bb_middle,
                "bb_lower": bb_lower,
                "bb_pct_b": bb_pct_b,
                "bb_bandwidth": bb_bandwidth,
                "atr": atr_series,
                "daily_returns_pct": daily_returns_pct,
                "daily_returns_frac": daily_returns_frac,
                "rolling_vol_pct": rolling_vol_pct,
                "vol_sma": vol_sma_series,
                "rvol": rvol_series,
            },
        }
