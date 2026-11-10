"""
StockSense AI — Feature Engineering Pipeline
Constructs normalized, stationary, scale-invariant technical features
specifically designed for ML models (e.g. XGBoost, Random Forest, Neural Nets).

Separated strictly from model training. Guarantees zero look-ahead bias.
"""

import numpy as np
import pandas as pd
from typing import Dict, Any, List, Optional, Union
from app.services.indicators import TechnicalAnalysisEngine


class FeatureEngineeringPipeline:
    """
    Feature engineering pipeline that transforms raw OHLCV candles into
    an analytical feature matrix suitable for machine learning inference and training.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.indicator_engine = TechnicalAnalysisEngine(self.config)

    def extract_features(
        self,
        candles: Union[List[Dict[str, Any]], pd.DataFrame],
        drop_na: bool = False,
    ) -> Dict[str, Any]:
        """
        Transforms OHLCV candles into engineered features.

        Args:
            candles: List of candle dicts or DataFrame containing [timestamp, open, high, low, close, volume]
            drop_na: If True, drops initial rows with NaN values resulting from indicator warm-up.

        Returns:
            Dict containing:
                - feature_names: List of feature column names
                - features: List of row dictionaries with timestamps and computed features
                - total_rows: Number of output feature rows
                - metadata: Warm-up summary and configuration details
        """
        indicator_output = self.indicator_engine.compute(candles)
        raw = indicator_output["raw_arrays"]

        closes = raw["closes"]
        volumes = raw["volumes"]
        timestamps = indicator_output["indicators"]["timestamps"]
        n = len(closes)

        # 1. Price relative to SMAs: (Close - SMA) / SMA
        price_to_sma20 = self._safe_relative_diff(closes, raw["sma"]["sma_20"])
        price_to_sma50 = self._safe_relative_diff(closes, raw["sma"]["sma_50"])
        price_to_sma200 = self._safe_relative_diff(closes, raw["sma"]["sma_200"])

        # 2. Price relative to EMAs: (Close - EMA) / EMA
        price_to_ema12 = self._safe_relative_diff(closes, raw["ema"]["ema_12"])
        price_to_ema26 = self._safe_relative_diff(closes, raw["ema"]["ema_26"])
        price_to_ema50 = self._safe_relative_diff(closes, raw["ema"]["ema_50"])

        # 3. RSI Momentum Features
        rsi_14 = raw["rsi"]
        # Normalize RSI from [0, 100] to [-1.0, 1.0] centered at 50
        rsi_normalized = np.where(np.isnan(rsi_14), np.nan, (rsi_14 - 50.0) / 50.0)

        # 5-day slope/velocity of RSI (change over 5 days)
        rsi_slope_5 = np.full(n, np.nan, dtype=float)
        for i in range(5, n):
            if not np.isnan(rsi_14[i]) and not np.isnan(rsi_14[i - 5]):
                rsi_slope_5[i] = (rsi_14[i] - rsi_14[i - 5]) / 5.0

        # 4. MACD Features
        macd_line = raw["macd_line"]
        signal_line = raw["signal_line"]
        macd_hist = raw["macd_hist"]
        # Scale-invariant MACD histogram normalized by current closing price
        macd_hist_normalized = np.where(
            np.isnan(macd_hist) | (closes <= 0),
            np.nan,
            macd_hist / closes,
        )

        # 5. Bollinger Band Position
        bb_percent_b = raw["bb_pct_b"]
        bb_bandwidth = raw["bb_bandwidth"]

        # Z-score within Bollinger Bands: (Close - Middle) / (StdDev)
        # where StdDev = (Upper - Middle) / 2
        bb_upper = raw["bb_upper"]
        bb_middle = raw["bb_middle"]
        bb_zscore = np.full(n, np.nan, dtype=float)
        for i in range(n):
            if not np.isnan(bb_middle[i]) and not np.isnan(bb_upper[i]):
                std_dev = (bb_upper[i] - bb_middle[i]) / 2.0
                if std_dev > 1e-9:
                    bb_zscore[i] = (closes[i] - bb_middle[i]) / std_dev
                else:
                    bb_zscore[i] = 0.0

        # 6. ATR Percentage: ATR / Close
        atr = raw["atr"]
        atr_pct = np.where(np.isnan(atr) | (closes <= 0), np.nan, (atr / closes) * 100.0)

        # 7. Multi-Horizon Returns (1-day, 5-day, 21-day)
        return_1d = raw["daily_returns_pct"]
        return_5d = self._calculate_lag_return(closes, 5)
        return_21d = self._calculate_lag_return(closes, 21)

        # 8. Rolling Volatility
        volatility_20d = raw["rolling_vol_pct"]

        # 9. Relative Volume
        relative_volume = raw["rvol"]

        # 10. Trend Strength & Hierarchy Features
        trend_alignment = np.full(n, np.nan, dtype=float)
        ma_spread_50_200 = self._safe_relative_diff(raw["sma"]["sma_50"], raw["sma"]["sma_200"])
        ma_spread_20_50 = self._safe_relative_diff(raw["sma"]["sma_20"], raw["sma"]["sma_50"])

        sma20 = raw["sma"]["sma_20"]
        sma50 = raw["sma"]["sma_50"]
        sma200 = raw["sma"]["sma_200"]

        for i in range(n):
            if np.isnan(sma20[i]) or np.isnan(sma50[i]) or np.isnan(sma200[i]):
                continue
            # Alignment score: +1.0 for perfect bullish stack, -1.0 for perfect bearish stack
            if sma20[i] > sma50[i] > sma200[i]:
                trend_alignment[i] = 1.0
            elif sma20[i] < sma50[i] < sma200[i]:
                trend_alignment[i] = -1.0
            elif sma20[i] > sma50[i]:
                trend_alignment[i] = 0.5
            elif sma20[i] < sma50[i]:
                trend_alignment[i] = -0.5
            else:
                trend_alignment[i] = 0.0

        # Construct tabular DataFrame
        feature_dict = {
            "timestamp": timestamps,
            "close": closes,
            "volume": volumes,
            "price_to_sma20": price_to_sma20,
            "price_to_sma50": price_to_sma50,
            "price_to_sma200": price_to_sma200,
            "price_to_ema12": price_to_ema12,
            "price_to_ema26": price_to_ema26,
            "price_to_ema50": price_to_ema50,
            "rsi_14": rsi_14,
            "rsi_normalized": rsi_normalized,
            "rsi_slope_5": rsi_slope_5,
            "macd_hist": macd_hist,
            "macd_hist_normalized": macd_hist_normalized,
            "bb_percent_b": bb_percent_b,
            "bb_zscore": bb_zscore,
            "bb_bandwidth": bb_bandwidth,
            "atr_pct": atr_pct,
            "return_1d": return_1d,
            "return_5d": return_5d,
            "return_21d": return_21d,
            "volatility_20d": volatility_20d,
            "relative_volume_20": relative_volume,
            "trend_alignment": trend_alignment,
            "ma_spread_50_200": ma_spread_50_200,
            "ma_spread_20_50": ma_spread_20_50,
        }

        df_features = pd.DataFrame(feature_dict)

        if drop_na:
            df_features = df_features.dropna().reset_index(drop=True)

        feature_names = [col for col in df_features.columns if col not in ["timestamp", "close", "volume"]]

        # Convert to JSON-serializable list of dicts with clean rounding
        def _clean_val(v):
            if pd.isna(v) or np.isnan(v):
                return None
            return round(float(v), 5)

        records = []
        for _, row in df_features.iterrows():
            item = {"timestamp": str(row["timestamp"]), "close": round(float(row["close"]), 4)}
            for col in feature_names:
                item[col] = _clean_val(row[col])
            records.append(item)

        return {
            "total_rows": len(records),
            "feature_count": len(feature_names),
            "feature_names": feature_names,
            "features": records,
            "metadata": {
                "dropped_warmup_na": drop_na,
                "warmup_status": indicator_output["warmup_status"],
                "max_period_needed": indicator_output["max_period_needed"],
            },
        }

    @staticmethod
    def _safe_relative_diff(numerator: np.ndarray, denominator: np.ndarray) -> np.ndarray:
        """
        Computes (numerator - denominator) / denominator safely preventing divide-by-zero.
        """
        n = len(numerator)
        res = np.full(n, np.nan, dtype=float)
        for i in range(n):
            num = numerator[i]
            den = denominator[i]
            if np.isnan(num) or np.isnan(den) or den <= 0:
                continue
            res[i] = (num - den) / den
        return res

    @staticmethod
    def _calculate_lag_return(prices: np.ndarray, lag: int) -> np.ndarray:
        """
        Computes percentage return over a specified lag window: (P_t - P_{t-lag}) / P_{t-lag} * 100.
        """
        n = len(prices)
        res = np.full(n, np.nan, dtype=float)
        for i in range(lag, n):
            prev = prices[i - lag]
            curr = prices[i]
            if prev > 0:
                res[i] = ((curr - prev) / prev) * 100.0
            else:
                res[i] = 0.0
        return res
