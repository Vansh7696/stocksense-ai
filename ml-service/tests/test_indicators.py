"""
StockSense AI — Technical Indicators Unit & Numerical Accuracy Test Suite
Validates mathematical correctness, warm-up period enforcement, zero look-ahead bias,
and edge case resilience (flat prices, zero volume, invalid OHLCV).
"""

import pytest
import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone

from app.services.indicators import (
    calculate_sma,
    calculate_ema,
    calculate_rsi,
    calculate_macd,
    calculate_bollinger_bands,
    calculate_atr,
    calculate_returns,
    calculate_rolling_volatility,
    calculate_volume_sma,
    calculate_relative_volume,
    TechnicalAnalysisEngine,
)


def generate_synthetic_candles(n: int = 100, trend: float = 0.5, base_price: float = 100.0) -> list:
    """
    Generates synthetic deterministic OHLCV candles strictly for unit testing.
    Never persisted to database.
    """
    candles = []
    base_time = datetime(2025, 1, 1, 9, 15, tzinfo=timezone.utc)
    price = base_price

    for i in range(n):
        time_str = (base_time + timedelta(days=i)).isoformat()
        wave = np.sin(i / 5.0) * 3.0
        c = round(price + (i * trend) + wave, 2)
        o = round(c - 0.5, 2)
        h = round(max(o, c) + 1.5, 2)
        l = round(min(o, c) - 1.2, 2)
        v = int(100000 + (i % 20) * 5000)

        candles.append({
            "timestamp": time_str,
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": v,
        })

    return candles


# -----------------------------------------------------------------------------
# 1. Simple Moving Average (SMA) Tests
# -----------------------------------------------------------------------------
class TestSMA:
    def test_sma_calculation_accuracy(self):
        prices = np.array([10.0, 20.0, 30.0, 40.0, 50.0])
        sma3 = calculate_sma(prices, 3)

        assert np.isnan(sma3[0])
        assert np.isnan(sma3[1])
        assert sma3[2] == pytest.approx(20.0)  # (10 + 20 + 30) / 3
        assert sma3[3] == pytest.approx(30.0)  # (20 + 30 + 40) / 3
        assert sma3[4] == pytest.approx(40.0)  # (30 + 40 + 50) / 3

    def test_sma_warmup_periods(self):
        prices = np.arange(1.0, 31.0)  # 30 points
        sma20 = calculate_sma(prices, 20)

        # First 19 entries must be NaN
        assert np.all(np.isnan(sma20[:19]))
        # 20th entry (index 19) must be valid
        assert not np.isnan(sma20[19])
        assert sma20[19] == pytest.approx(np.mean(prices[:20]))

    def test_sma_insufficient_data(self):
        prices = np.array([10.0, 20.0, 30.0])
        sma20 = calculate_sma(prices, 20)
        assert len(sma20) == 3
        assert np.all(np.isnan(sma20))


# -----------------------------------------------------------------------------
# 2. Exponential Moving Average (EMA) Tests
# -----------------------------------------------------------------------------
class TestEMA:
    def test_ema_calculation_accuracy(self):
        # Using known series to verify multiplier and initial SMA seed
        prices = np.array([10.0, 11.0, 12.0, 13.0, 14.0])
        period = 3
        multiplier = 2.0 / (3.0 + 1.0)  # 0.5

        ema3 = calculate_ema(prices, period)

        # Indices 0, 1 must be NaN
        assert np.isnan(ema3[0])
        assert np.isnan(ema3[1])

        # Index 2 is seeded with SMA(10, 11, 12) = 11.0
        assert ema3[2] == pytest.approx(11.0)

        # Index 3: 13.0 * 0.5 + 11.0 * 0.5 = 12.0
        assert ema3[3] == pytest.approx(12.0)

        # Index 4: 14.0 * 0.5 + 12.0 * 0.5 = 13.0
        assert ema3[4] == pytest.approx(13.0)

    def test_ema_warmup_periods(self):
        prices = np.ones(60) * 100.0
        ema50 = calculate_ema(prices, 50)

        assert np.all(np.isnan(ema50[:49]))
        assert ema50[49] == pytest.approx(100.0)
        assert ema50[59] == pytest.approx(100.0)


# -----------------------------------------------------------------------------
# 3. Relative Strength Index (RSI) Tests
# -----------------------------------------------------------------------------
class TestRSI:
    def test_rsi_constant_upward_trend(self):
        # 25 consecutive up days -> RSI should reach 100.0
        prices = np.linspace(100.0, 150.0, 25)
        rsi = calculate_rsi(prices, 14)

        # First 14 days are warm-up NaN
        assert np.all(np.isnan(rsi[:14]))
        # Day 14 (15th price) should be 100.0 since losses = 0
        assert rsi[14] == pytest.approx(100.0)
        assert rsi[-1] == pytest.approx(100.0)

    def test_rsi_constant_downward_trend(self):
        # 25 consecutive down days -> RSI should be 0.0
        prices = np.linspace(150.0, 100.0, 25)
        rsi = calculate_rsi(prices, 14)

        assert np.all(np.isnan(rsi[:14]))
        assert rsi[14] == pytest.approx(0.0)
        assert rsi[-1] == pytest.approx(0.0)

    def test_rsi_flat_prices_neutral(self):
        # Flat prices: no gain, no loss -> RSI must be 50.0 (neutral)
        prices = np.full(30, 2500.0)
        rsi = calculate_rsi(prices, 14)

        assert np.all(np.isnan(rsi[:14]))
        assert rsi[14] == pytest.approx(50.0)
        assert rsi[-1] == pytest.approx(50.0)

    def test_rsi_insufficient_data(self):
        prices = np.array([100.0, 101.0, 102.0])
        rsi = calculate_rsi(prices, 14)
        assert len(rsi) == 3
        assert np.all(np.isnan(rsi))


# -----------------------------------------------------------------------------
# 4. MACD Tests
# -----------------------------------------------------------------------------
class TestMACD:
    def test_macd_warmup_and_histogram(self):
        prices = np.linspace(100.0, 200.0, 50)
        macd_line, signal_line, histogram = calculate_macd(prices, 12, 26, 9)

        # MACD Line valid starting at index 25
        assert np.all(np.isnan(macd_line[:25]))
        assert not np.isnan(macd_line[25])

        # Signal line and histogram valid starting at index 25 + 9 - 1 = 33
        assert np.all(np.isnan(signal_line[:33]))
        assert not np.isnan(signal_line[33])
        assert np.all(np.isnan(histogram[:33]))
        assert not np.isnan(histogram[33])

        # Histogram is exactly MACD - Signal
        for i in range(33, 50):
            assert histogram[i] == pytest.approx(macd_line[i] - signal_line[i])

    def test_macd_flat_prices(self):
        # When price is constant, EMA fast == EMA slow -> MACD line == 0
        prices = np.full(60, 500.0)
        macd_line, signal_line, histogram = calculate_macd(prices, 12, 26, 9)

        assert macd_line[35] == pytest.approx(0.0)
        assert signal_line[35] == pytest.approx(0.0)
        assert histogram[35] == pytest.approx(0.0)


# -----------------------------------------------------------------------------
# 5. Bollinger Bands Tests
# -----------------------------------------------------------------------------
class TestBollingerBands:
    def test_bollinger_bands_properties(self):
        prices = np.array([
            10, 11, 12, 11, 10, 9, 8, 9, 10, 11,
            12, 13, 14, 13, 12, 11, 10, 11, 12, 13, 14, 15
        ], dtype=float)

        upper, middle, lower, percent_b, bandwidth = calculate_bollinger_bands(prices, 20, 2.0)

        # First 19 entries NaN
        assert np.all(np.isnan(middle[:19]))
        assert not np.isnan(middle[19])

        # Mathematical relationships: Upper >= Middle >= Lower
        for i in range(19, len(prices)):
            assert upper[i] >= middle[i]
            assert middle[i] >= lower[i]
            assert bandwidth[i] >= 0.0

    def test_bollinger_bands_flat_prices_safe_division(self):
        prices = np.full(30, 1500.0)
        upper, middle, lower, percent_b, bandwidth = calculate_bollinger_bands(prices, 20, 2.0)

        # Flat prices -> StdDev is 0 -> Upper == Middle == Lower
        assert upper[20] == pytest.approx(1500.0)
        assert middle[20] == pytest.approx(1500.0)
        assert lower[20] == pytest.approx(1500.0)
        assert bandwidth[20] == pytest.approx(0.0)
        # Safe percent_b on flat market should return neutral 0.5 without ZeroDivisionError
        assert percent_b[20] == pytest.approx(0.5)


# -----------------------------------------------------------------------------
# 6. Average True Range (ATR) Tests
# -----------------------------------------------------------------------------
class TestATR:
    def test_atr_warmup_and_values(self):
        # 20 bars with consistent 5-point range
        highs = np.array([105.0] * 20)
        lows = np.array([100.0] * 20)
        closes = np.array([102.0] * 20)

        atr = calculate_atr(highs, lows, closes, 14)

        # First 13 entries are NaN
        assert np.all(np.isnan(atr[:13]))
        # 14th entry (index 13) is 5.0
        assert atr[13] == pytest.approx(5.0)
        assert atr[19] == pytest.approx(5.0)

    def test_atr_gap_handling(self):
        # Test gap opening: prev close 100, current low 110, current high 115
        # TR should be 115 - 100 = 15.0 (greater than high - low of 5.0)
        highs = np.array([100.0] * 13 + [115.0])
        lows = np.array([95.0] * 13 + [110.0])
        closes = np.array([98.0] * 13 + [112.0])

        atr = calculate_atr(highs, lows, closes, 14)
        assert not np.isnan(atr[13])
        # TRs: first 13 are 5.0 each, 14th is max(5.0, |115 - 98| = 17, |110 - 98| = 12) = 17.0
        expected_atr = (13 * 5.0 + 17.0) / 14.0
        assert atr[13] == pytest.approx(expected_atr)


# -----------------------------------------------------------------------------
# 7. Returns and Volatility Tests
# -----------------------------------------------------------------------------
class TestReturnsAndVolatility:
    def test_daily_percentage_returns(self):
        prices = np.array([100.0, 105.0, 94.5])
        returns = calculate_returns(prices, percentage=True)

        assert np.isnan(returns[0])
        assert returns[1] == pytest.approx(5.0)   # (105 - 100) / 100 * 100 = 5%
        assert returns[2] == pytest.approx(-10.0) # (94.5 - 105) / 105 * 100 = -10%

    def test_rolling_volatility_annualized(self):
        # Generate 30 returns of constant 0.0 -> Volatility should be 0.0
        returns = np.zeros(30)
        vol = calculate_rolling_volatility(returns, window=20, annualize=True)

        assert np.all(np.isnan(vol[:19]))
        assert vol[19] == pytest.approx(0.0)
        assert vol[29] == pytest.approx(0.0)


# -----------------------------------------------------------------------------
# 8. Volume Moving Average & RVOL Tests
# -----------------------------------------------------------------------------
class TestVolumeIndicators:
    def test_volume_indicators_zero_volume_resilience(self):
        volumes = np.zeros(25)
        vol_sma = calculate_volume_sma(volumes, 20)
        rvol = calculate_relative_volume(volumes, vol_sma)

        assert np.all(np.isnan(vol_sma[:19]))
        assert vol_sma[19] == pytest.approx(0.0)
        # RVOL when volume_sma is 0.0 should safely return 0.0 (no division by zero)
        assert rvol[19] == pytest.approx(0.0)


# -----------------------------------------------------------------------------
# 9. Causality & No Look-Ahead Bias Guarantee
# -----------------------------------------------------------------------------
class TestCausalityNoLookahead:
    def test_future_data_leakage_prohibited(self):
        """
        Critical ML Integrity Test:
        Modifying future data at index T+1 must strictly NOT change indicator values at index T.
        """
        candles_a = generate_synthetic_candles(60, trend=0.5)
        candles_b = [dict(c) for c in candles_a]

        # Alter the last 10 candles dramatically in scenario B
        for i in range(50, 60):
            candles_b[i]["close"] = candles_b[i]["close"] * 5.0
            candles_b[i]["high"] = candles_b[i]["high"] * 5.0
            candles_b[i]["volume"] = candles_b[i]["volume"] * 10

        engine = TechnicalAnalysisEngine()
        res_a = engine.compute(candles_a)
        res_b = engine.compute(candles_b)

        # Check all indicators at index 49 (before the divergence)
        t_eval = 49

        # SMA checks
        for k in res_a["indicators"]["sma"]:
            assert res_a["indicators"]["sma"][k][t_eval] == pytest.approx(
                res_b["indicators"]["sma"][k][t_eval]
            )

        # EMA checks
        for k in res_a["indicators"]["ema"]:
            assert res_a["indicators"]["ema"][k][t_eval] == pytest.approx(
                res_b["indicators"]["ema"][k][t_eval]
            )

        # RSI check
        assert res_a["indicators"]["rsi"][t_eval] == pytest.approx(
            res_b["indicators"]["rsi"][t_eval]
        )

        # MACD checks
        for k in ["macd_line", "signal_line", "histogram"]:
            assert res_a["indicators"]["macd"][k][t_eval] == pytest.approx(
                res_b["indicators"]["macd"][k][t_eval]
            )

        # Bollinger Bands check
        for k in ["upper", "middle", "lower", "percent_b", "bandwidth"]:
            assert res_a["indicators"]["bollinger_bands"][k][t_eval] == pytest.approx(
                res_b["indicators"]["bollinger_bands"][k][t_eval]
            )

        # ATR check
        assert res_a["indicators"]["atr"][t_eval] == pytest.approx(
            res_b["indicators"]["atr"][t_eval]
        )

        # Volatility check
        assert res_a["indicators"]["rolling_volatility_pct"][t_eval] == pytest.approx(
            res_b["indicators"]["rolling_volatility_pct"][t_eval]
        )

        # RVOL check
        assert res_a["indicators"]["relative_volume"][t_eval] == pytest.approx(
            res_b["indicators"]["relative_volume"][t_eval]
        )
