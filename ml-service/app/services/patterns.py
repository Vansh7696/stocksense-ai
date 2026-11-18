"""
StockSense AI — Advanced Technical Analysis & Pattern Recognition Engine
Zero look-ahead bias, vectorized candlestick pattern detection, Support/Resistance
clustering, and momentum/breakout signal synthesis for Indian Equities.
"""

import time
import numpy as np
import pandas as pd
from typing import List, Dict, Any, Optional, Tuple

from app.schemas.patterns import (
    PatternType,
    SignalSeverity,
    TechnicalStance,
    LevelType,
    CandlestickPatternMatch,
    SupportResistanceLevel,
    BreakoutSignal,
    IndicatorSnapshot,
    TechnicalAnalysisResponse,
)
from app.services.indicators import (
    calculate_sma,
    calculate_rsi,
    calculate_macd,
    calculate_atr,
    calculate_volume_sma,
    calculate_relative_volume,
)


class TechnicalPatternAnalyzer:
    """
    High-performance technical pattern recognition, support/resistance clustering,
    and momentum/breakout detection engine.
    """

    @classmethod
    def analyze(
        cls,
        candles: List[Dict[str, Any]],
        symbol: Optional[str] = None,
    ) -> TechnicalAnalysisResponse:
        """
        Execute full technical analysis pipeline on historical OHLCV candles.
        """
        start_time = time.perf_counter()

        if not candles or len(candles) < 20:
            return cls._generate_minimal_response(candles, start_time)

        # 1. Parse arrays ensuring chronological ordering
        df = pd.DataFrame(candles)
        if "timestamp" in df.columns:
            df["timestamp_dt"] = pd.to_datetime(df["timestamp"])
            df = df.sort_values("timestamp_dt").reset_index(drop=True)

        opens = df["open"].astype(float).to_numpy()
        highs = df["high"].astype(float).to_numpy()
        lows = df["low"].astype(float).to_numpy()
        closes = df["close"].astype(float).to_numpy()
        volumes = df["volume"].astype(float).to_numpy() if "volume" in df.columns else np.ones(len(closes))
        timestamps = df["timestamp"].astype(str).tolist() if "timestamp" in df.columns else [None] * len(closes)

        n = len(closes)

        # 2. Compute foundational technical indicators
        sma_20 = calculate_sma(closes, 20)
        sma_50 = calculate_sma(closes, 50) if n >= 50 else np.full(n, np.nan)
        sma_200 = calculate_sma(closes, 200) if n >= 200 else np.full(n, np.nan)

        rsi_14 = calculate_rsi(closes, 14)
        macd_line, macd_signal, macd_hist = calculate_macd(closes, 12, 26, 9)
        atr_14 = calculate_atr(highs, lows, closes, 14)
        vol_sma_20 = calculate_volume_sma(volumes, 20)
        rvol_20 = calculate_relative_volume(volumes, vol_sma_20)

        # Donchian 20-period channels (excluding current candle to prevent look-ahead)
        donchian_high = np.full(n, np.nan)
        donchian_low = np.full(n, np.nan)
        for i in range(20, n):
            donchian_high[i] = np.max(highs[i - 20 : i])
            donchian_low[i] = np.min(lows[i - 20 : i])

        # 3. Detect Candlestick Patterns
        patterns = cls._detect_candlestick_patterns(
            opens, highs, lows, closes, timestamps
        )

        # 4. Detect Support & Resistance Levels via Extrema Clustering
        sr_levels = cls._detect_support_resistance(
            highs, lows, closes, volumes
        )

        # 5. Detect Breakout and Momentum Signals
        signals = cls._detect_breakout_signals(
            closes, highs, lows, timestamps,
            rsi_14, macd_line, macd_signal,
            donchian_high, donchian_low,
            atr_14, rvol_20
        )

        # 6. Extract latest indicator snapshot
        last_idx = n - 1
        snapshot = IndicatorSnapshot(
            rsi=float(rsi_14[last_idx]) if not np.isnan(rsi_14[last_idx]) else None,
            macd_line=float(macd_line[last_idx]) if not np.isnan(macd_line[last_idx]) else None,
            macd_signal=float(macd_signal[last_idx]) if not np.isnan(macd_signal[last_idx]) else None,
            macd_histogram=float(macd_hist[last_idx]) if not np.isnan(macd_hist[last_idx]) else None,
            sma_20=float(sma_20[last_idx]) if not np.isnan(sma_20[last_idx]) else None,
            sma_50=float(sma_50[last_idx]) if not np.isnan(sma_50[last_idx]) else None,
            sma_200=float(sma_200[last_idx]) if not np.isnan(sma_200[last_idx]) else None,
            donchian_high_20=float(donchian_high[last_idx]) if not np.isnan(donchian_high[last_idx]) else None,
            donchian_low_20=float(donchian_low[last_idx]) if not np.isnan(donchian_low[last_idx]) else None,
            atr_14=float(atr_14[last_idx]) if not np.isnan(atr_14[last_idx]) else None,
            rvol_20=float(rvol_20[last_idx]) if not np.isnan(rvol_20[last_idx]) else None,
            close_price=float(closes[last_idx]),
        )

        # 7. Synthesize Overall Technical Stance & Score
        stance, score, summary = cls._synthesize_stance(
            snapshot, patterns, sr_levels, signals, n
        )

        duration_ms = round((time.perf_counter() - start_time) * 1000.0, 2)

        return TechnicalAnalysisResponse(
            stance=stance,
            technical_score=score,
            summary=summary,
            patterns=patterns,
            support_resistance=sr_levels,
            signals=signals,
            indicators=snapshot,
            total_candles_analyzed=n,
            meta={
                "computation_ms": duration_ms,
                "symbol": symbol,
                "latest_timestamp": timestamps[last_idx],
                "candles_count": n,
            },
        )

    # --------------------------------------------------------------------------
    # Candlestick Pattern Recognition
    # --------------------------------------------------------------------------
    @classmethod
    def _detect_candlestick_patterns(
        cls,
        opens: np.ndarray,
        highs: np.ndarray,
        lows: np.ndarray,
        closes: np.ndarray,
        timestamps: List[Optional[str]],
    ) -> List[CandlestickPatternMatch]:
        """
        Scan historical candles (focusing especially on recent bars) for key patterns.
        """
        n = len(closes)
        matches: List[CandlestickPatternMatch] = []

        # Analyze the last 30 bars or whole series if shorter
        eval_start = max(3, n - 30)

        for i in range(eval_start, n):
            o = opens[i]
            h = highs[i]
            l = lows[i]
            c = closes[i]
            t = timestamps[i]

            body = abs(c - o)
            rng = h - l
            if rng <= 1e-6:
                continue

            upper_shadow = h - max(o, c)
            lower_shadow = min(o, c) - l

            # Short-term prior trend direction using 5-period price momentum
            prior_trend = closes[i - 1] - closes[max(0, i - 6)]

            # 1. Doji
            if body / rng <= 0.08:
                matches.append(
                    CandlestickPatternMatch(
                        name="Doji",
                        code="DOJI",
                        pattern_type=PatternType.NEUTRAL,
                        bar_index=i,
                        timestamp=t,
                        price=float(c),
                        confidence=0.72,
                        description="Extreme indecision between buyers and sellers where open and close prices are virtually identical.",
                    )
                )

            # 2. Hammer (Bullish Reversal after downtrend)
            if (
                lower_shadow >= 2.0 * body
                and upper_shadow <= 0.15 * rng
                and prior_trend < 0
            ):
                matches.append(
                    CandlestickPatternMatch(
                        name="Hammer",
                        code="HAMMER",
                        pattern_type=PatternType.BULLISH,
                        bar_index=i,
                        timestamp=t,
                        price=float(c),
                        confidence=0.84,
                        description="Bullish reversal signal: Sellers drove prices lower during the session, but buyers aggressively rejected lower levels to close near the high.",
                    )
                )

            # 3. Shooting Star (Bearish Reversal after uptrend)
            if (
                upper_shadow >= 2.0 * body
                and lower_shadow <= 0.15 * rng
                and prior_trend > 0
            ):
                matches.append(
                    CandlestickPatternMatch(
                        name="Shooting Star",
                        code="SHOOTING_STAR",
                        pattern_type=PatternType.BEARISH,
                        bar_index=i,
                        timestamp=t,
                        price=float(c),
                        confidence=0.84,
                        description="Bearish reversal signal: Buyers pushed prices significantly higher, but selling pressure overwhelmed the rally to close near the lows.",
                    )
                )

            # 4. Bullish Engulfing (2-bar pattern)
            prev_o = opens[i - 1]
            prev_c = closes[i - 1]
            prev_body = abs(prev_c - prev_o)

            if (
                prev_c < prev_o  # Previous candle was bearish
                and c > o         # Current candle is bullish
                and o <= prev_c   # Opens at or below previous close
                and c >= prev_o   # Closes at or above previous open
                and body > prev_body
            ):
                matches.append(
                    CandlestickPatternMatch(
                        name="Bullish Engulfing",
                        code="BULLISH_ENGULFING",
                        pattern_type=PatternType.BULLISH,
                        bar_index=i,
                        timestamp=t,
                        price=float(c),
                        confidence=0.88,
                        description="High-conviction bullish reversal: The current green candle completely engulfs the prior red candle's real body, signaling overwhelming accumulation.",
                    )
                )

            # 5. Bearish Engulfing (2-bar pattern)
            if (
                prev_c > prev_o  # Previous candle was bullish
                and c < o         # Current candle is bearish
                and o >= prev_c   # Opens at or above previous close
                and c <= prev_o   # Closes at or below previous open
                and body > prev_body
            ):
                matches.append(
                    CandlestickPatternMatch(
                        name="Bearish Engulfing",
                        code="BEARISH_ENGULFING",
                        pattern_type=PatternType.BEARISH,
                        bar_index=i,
                        timestamp=t,
                        price=float(c),
                        confidence=0.88,
                        description="High-conviction bearish reversal: The current red candle completely engulfs the prior green candle's real body, showing heavy institutional distribution.",
                    )
                )

            # 6. Morning Star (3-bar pattern)
            if i >= 2:
                bar0_o, bar0_c = opens[i - 2], closes[i - 2]
                bar1_o, bar1_c = opens[i - 1], closes[i - 1]
                bar1_rng = highs[i - 1] - lows[i - 1]

                if (
                    bar0_c < bar0_o                                  # Bar 0 is red
                    and abs(bar1_c - bar1_o) <= 0.45 * abs(bar0_c - bar0_o)  # Bar 1 is small body
                    and c > o                                        # Bar 2 is green
                    and c >= (bar0_o + bar0_c) / 2.0                 # Closes above midpoint of Bar 0
                    and min(bar1_o, bar1_c) <= min(bar0_c, o)        # Bar 1 star is depressed
                ):
                    matches.append(
                        CandlestickPatternMatch(
                            name="Morning Star",
                            code="MORNING_STAR",
                            pattern_type=PatternType.BULLISH,
                            bar_index=i,
                            timestamp=t,
                            price=float(c),
                            confidence=0.91,
                            description="Classic 3-candle bottom reversal: Heavy selling halts into a star consolidation, followed by an aggressive bullish expansion penetrating the initial sell-off.",
                        )
                    )

            # 7. Evening Star (3-bar pattern)
            if i >= 2:
                bar0_o, bar0_c = opens[i - 2], closes[i - 2]
                bar1_o, bar1_c = opens[i - 1], closes[i - 1]

                if (
                    bar0_c > bar0_o                                  # Bar 0 is green
                    and abs(bar1_c - bar1_o) <= 0.45 * abs(bar0_c - bar0_o)  # Bar 1 is small body
                    and c < o                                        # Bar 2 is red
                    and c <= (bar0_o + bar0_c) / 2.0                 # Closes below midpoint of Bar 0
                    and max(bar1_o, bar1_c) >= max(bar0_c, o)        # Bar 1 star is elevated
                ):
                    matches.append(
                        CandlestickPatternMatch(
                            name="Evening Star",
                            code="EVENING_STAR",
                            pattern_type=PatternType.BEARISH,
                            bar_index=i,
                            timestamp=t,
                            price=float(c),
                            confidence=0.91,
                            description="Classic 3-candle top reversal: Rally slows into a high star consolidation, immediately followed by severe bearish breakdown through the prior rally midpoint.",
                        )
                    )

            # 8. Three White Soldiers (3 consecutive strong green bars)
            if i >= 2:
                c1, o1 = closes[i - 1], opens[i - 1]
                c2, o2 = closes[i - 2], opens[i - 2]
                if (
                    c > o and c1 > o1 and c2 > o2
                    and c > c1 > c2
                    and o > o1 and o1 > o2
                    and upper_shadow <= 0.25 * rng
                ):
                    matches.append(
                        CandlestickPatternMatch(
                            name="Three White Soldiers",
                            code="THREE_WHITE_SOLDIERS",
                            pattern_type=PatternType.BULLISH,
                            bar_index=i,
                            timestamp=t,
                            price=float(c),
                            confidence=0.93,
                            description="Sustained institutional bullish thrust: Three consecutive large bullish candles with consecutively higher closes and minimal upper wicks.",
                        )
                    )

            # 9. Three Black Crows (3 consecutive strong red bars)
            if i >= 2:
                c1, o1 = closes[i - 1], opens[i - 1]
                c2, o2 = closes[i - 2], opens[i - 2]
                if (
                    c < o and c1 < o1 and c2 < o2
                    and c < c1 < c2
                    and o < o1 and o1 < o2
                    and lower_shadow <= 0.25 * rng
                ):
                    matches.append(
                        CandlestickPatternMatch(
                            name="Three Black Crows",
                            code="THREE_BLACK_CROWS",
                            pattern_type=PatternType.BEARISH,
                            bar_index=i,
                            timestamp=t,
                            price=float(c),
                            confidence=0.93,
                            description="Severe institutional distribution: Three consecutive decisive bearish candles with consecutively lower closes and minimal lower wicks.",
                        )
                    )

        # Return latest patterns first
        matches.sort(key=lambda m: m.bar_index, reverse=True)
        return matches[:8]

    # --------------------------------------------------------------------------
    # Support & Resistance Clustering
    # --------------------------------------------------------------------------
    @classmethod
    def _detect_support_resistance(
        cls,
        highs: np.ndarray,
        lows: np.ndarray,
        closes: np.ndarray,
        volumes: np.ndarray,
        window: int = 5,
        tolerance_pct: float = 0.015,
    ) -> List[SupportResistanceLevel]:
        """
        Identify local pivot highs and lows, clustering nearby extrema into major S/R zones.
        """
        n = len(closes)
        if n < window * 2 + 1:
            return []

        current_close = float(closes[-1])
        pivots: List[Tuple[float, str, float]] = []  # (price, type, volume_weight)

        # Scan for local extrema excluding the final bars (to avoid incomplete peaks)
        for i in range(window, n - 1):
            is_peak = True
            is_trough = True
            h = highs[i]
            l = lows[i]

            for offset in range(1, window + 1):
                if highs[i - offset] >= h or (i + offset < n and highs[i + offset] >= h):
                    is_peak = False
                if lows[i - offset] <= l or (i + offset < n and lows[i + offset] <= l):
                    is_trough = False

            if is_peak:
                pivots.append((float(h), "HIGH", float(volumes[i])))
            if is_trough:
                pivots.append((float(l), "LOW", float(volumes[i])))

        if not pivots:
            return []

        # Cluster pivots within relative percentage distance
        clusters: List[List[Tuple[float, str, float]]] = []
        pivots.sort(key=lambda p: p[0])

        for p in pivots:
            price = p[0]
            matched = False
            for cluster in clusters:
                cluster_mean = sum(x[0] for x in cluster) / len(cluster)
                if abs(price - cluster_mean) / cluster_mean <= tolerance_pct:
                    cluster.append(p)
                    matched = True
                    break
            if not matched:
                clusters.append([p])

        levels: List[SupportResistanceLevel] = []
        for cluster in clusters:
            prices = [x[0] for x in cluster]
            weights = [max(1.0, x[2]) for x in cluster]
            total_weight = sum(weights)
            weighted_price = sum(p * w for p, w in zip(prices, weights)) / total_weight

            touch_count = len(cluster)
            range_min = float(min(prices))
            range_max = float(max(prices))

            # Classify as Support if below current close, Resistance if above
            level_type = LevelType.SUPPORT if weighted_price < current_close else LevelType.RESISTANCE
            dist_pct = ((weighted_price - current_close) / current_close) * 100.0

            # Normalized strength (1 touch = 0.5, 3 touches = 0.8, 5+ touches = 1.0)
            strength = round(min(1.0, 0.4 + (touch_count * 0.15)), 2)

            levels.append(
                SupportResistanceLevel(
                    level_type=level_type,
                    price=round(weighted_price, 2),
                    touch_count=touch_count,
                    strength=strength,
                    distance_pct=round(dist_pct, 2),
                    range_min=round(range_min, 2),
                    range_max=round(range_max, 2),
                )
            )

        # Separate support (descending - closest first) and resistance (ascending - closest first)
        supports = [l for l in levels if l.level_type == LevelType.SUPPORT]
        resistances = [l for l in levels if l.level_type == LevelType.RESISTANCE]

        supports.sort(key=lambda s: s.price, reverse=True)
        resistances.sort(key=lambda r: r.price)

        # Select top 3 closest supports and top 3 closest resistances
        final_levels = supports[:3] + resistances[:3]
        return final_levels

    # --------------------------------------------------------------------------
    # Breakout & Momentum Signals
    # --------------------------------------------------------------------------
    @classmethod
    def _detect_breakout_signals(
        cls,
        closes: np.ndarray,
        highs: np.ndarray,
        lows: np.ndarray,
        timestamps: List[Optional[str]],
        rsi: np.ndarray,
        macd_line: np.ndarray,
        macd_signal: np.ndarray,
        donchian_high: np.ndarray,
        donchian_low: np.ndarray,
        atr: np.ndarray,
        rvol: np.ndarray,
    ) -> List[BreakoutSignal]:
        """
        Identify active momentum and channel breakouts on recent candles.
        """
        n = len(closes)
        signals: List[BreakoutSignal] = []
        if n < 20:
            return signals

        curr = n - 1
        t = timestamps[curr]
        c = closes[curr]
        rvol_curr = rvol[curr] if not np.isnan(rvol[curr]) else 1.0

        # 1. Donchian Channel High Breakout
        if not np.isnan(donchian_high[curr]) and c > donchian_high[curr]:
            severity = SignalSeverity.STRONG if rvol_curr >= 1.5 else SignalSeverity.MODERATE
            signals.append(
                BreakoutSignal(
                    signal_type="DONCHIAN_HIGH_BREAKOUT",
                    label="Donchian 20-Day High Breakout",
                    bias=PatternType.BULLISH,
                    severity=severity,
                    indicator="Donchian Channel",
                    timestamp=t,
                    description=f"Close price (₹{c:.2f}) cleared the 20-day high channel (₹{donchian_high[curr]:.2f}) with RVOL at {rvol_curr:.1f}x.",
                )
            )

        # 2. Donchian Channel Low Breakdown
        if not np.isnan(donchian_low[curr]) and c < donchian_low[curr]:
            severity = SignalSeverity.STRONG if rvol_curr >= 1.5 else SignalSeverity.MODERATE
            signals.append(
                BreakoutSignal(
                    signal_type="DONCHIAN_LOW_BREAKDOWN",
                    label="Donchian 20-Day Low Breakdown",
                    bias=PatternType.BEARISH,
                    severity=severity,
                    indicator="Donchian Channel",
                    timestamp=t,
                    description=f"Close price (₹{c:.2f}) broke below the 20-day channel floor (₹{donchian_low[curr]:.2f}) with RVOL at {rvol_curr:.1f}x.",
                )
            )

        # 3. MACD Bullish / Bearish Crossover
        if (
            not np.isnan(macd_line[curr])
            and not np.isnan(macd_signal[curr])
            and not np.isnan(macd_line[curr - 1])
            and not np.isnan(macd_signal[curr - 1])
        ):
            if macd_line[curr - 1] <= macd_signal[curr - 1] and macd_line[curr] > macd_signal[curr]:
                signals.append(
                    BreakoutSignal(
                        signal_type="MACD_BULLISH_CROSSOVER",
                        label="MACD Bullish Signal Crossover",
                        bias=PatternType.BULLISH,
                        severity=SignalSeverity.STRONG if macd_line[curr] < 0 else SignalSeverity.MODERATE,
                        indicator="MACD (12,26,9)",
                        timestamp=t,
                        description="MACD line crossed decisively above the 9-period signal line, indicating accelerating upside momentum.",
                    )
                )
            elif macd_line[curr - 1] >= macd_signal[curr - 1] and macd_line[curr] < macd_signal[curr]:
                signals.append(
                    BreakoutSignal(
                        signal_type="MACD_BEARISH_CROSSOVER",
                        label="MACD Bearish Signal Crossover",
                        bias=PatternType.BEARISH,
                        severity=SignalSeverity.STRONG if macd_line[curr] > 0 else SignalSeverity.MODERATE,
                        indicator="MACD (12,26,9)",
                        timestamp=t,
                        description="MACD line crossed below the signal line, confirming a bearish momentum shift.",
                    )
                )

        # 4. RSI Regular Divergence (Lookback window 15 bars)
        if not np.isnan(rsi[curr]):
            lookback = min(15, n - 2)
            recent_closes = closes[curr - lookback : curr + 1]
            recent_rsi = rsi[curr - lookback : curr + 1]

            # Bullish divergence: price lower low, RSI higher low
            min_price_idx = int(np.argmin(recent_closes))
            if min_price_idx == len(recent_closes) - 1:  # Latest bar is lowest price
                # Check if RSI is higher than previous trough
                prior_rsi_min = float(np.min(recent_rsi[:-1]))
                if recent_rsi[-1] > prior_rsi_min + 3.0 and recent_rsi[-1] < 45.0:
                    signals.append(
                        BreakoutSignal(
                            signal_type="RSI_BULLISH_DIVERGENCE",
                            label="RSI Bullish Regular Divergence",
                            bias=PatternType.BULLISH,
                            severity=SignalSeverity.STRONG,
                            indicator="RSI (14)",
                            timestamp=t,
                            description=f"Price recorded a fresh lower low while RSI (14) printed a higher low ({recent_rsi[-1]:.1f} vs {prior_rsi_min:.1f}), signaling waning downward velocity.",
                        )
                    )

            # Bearish divergence: price higher high, RSI lower high
            max_price_idx = int(np.argmax(recent_closes))
            if max_price_idx == len(recent_closes) - 1:  # Latest bar is highest price
                prior_rsi_max = float(np.max(recent_rsi[:-1]))
                if recent_rsi[-1] < prior_rsi_max - 3.0 and recent_rsi[-1] > 55.0:
                    signals.append(
                        BreakoutSignal(
                            signal_type="RSI_BEARISH_DIVERGENCE",
                            label="RSI Bearish Regular Divergence",
                            bias=PatternType.BEARISH,
                            severity=SignalSeverity.STRONG,
                            indicator="RSI (14)",
                            timestamp=t,
                            description=f"Price printed a fresh higher high while RSI (14) printed a lower high ({recent_rsi[-1]:.1f} vs {prior_rsi_max:.1f}), warning of exhausted bullish momentum.",
                        )
                    )

        # 5. Volume-Confirmed Momentum Candle
        if not np.isnan(atr[curr]) and atr[curr] > 0 and rvol_curr >= 1.5:
            move = closes[curr] - closes[curr - 1]
            if abs(move) >= 1.5 * atr[curr]:
                bias = PatternType.BULLISH if move > 0 else PatternType.BEARISH
                signals.append(
                    BreakoutSignal(
                        signal_type="MOMENTUM_CONFIRMED",
                        label="High-Volume Institutional Thrust",
                        bias=bias,
                        severity=SignalSeverity.STRONG,
                        indicator="ATR & RVOL",
                        timestamp=t,
                        description=f"Expansion bar of {abs(move):.2f} pts (>1.5x ATR) backed by heavy volume ({rvol_curr:.1f}x RVOL).",
                    )
                )

        return signals

    # --------------------------------------------------------------------------
    # Synthesis & Stance Scoring
    # --------------------------------------------------------------------------
    @classmethod
    def _synthesize_stance(
        cls,
        indicators: IndicatorSnapshot,
        patterns: List[CandlestickPatternMatch],
        sr_levels: List[SupportResistanceLevel],
        signals: List[BreakoutSignal],
        n: int,
    ) -> Tuple[TechnicalStance, float, str]:
        """
        Aggregate patterns, indicators, S/R, and breakouts into a bounded [-1, 1] score.
        """
        score = 0.0

        # A. Signals contribution
        for s in signals:
            mult = 0.25 if s.severity == SignalSeverity.STRONG else 0.15
            score += mult if s.bias == PatternType.BULLISH else -mult

        # B. Recent patterns contribution (last 3 bars)
        for p in patterns[:3]:
            mult = 0.18 * p.confidence
            if p.pattern_type == PatternType.BULLISH:
                score += mult
            elif p.pattern_type == PatternType.BEARISH:
                score -= mult

        # C. RSI position
        if indicators.rsi is not None:
            if indicators.rsi > 70.0:
                score -= 0.10  # Overbought exhaustion pressure
            elif indicators.rsi < 30.0:
                score += 0.10  # Oversold bounce potential
            elif indicators.rsi >= 55.0:
                score += 0.12  # Bullish momentum zone
            elif indicators.rsi <= 45.0:
                score -= 0.12  # Bearish momentum zone

        # D. Moving Average Alignment
        c = indicators.close_price
        if indicators.sma_20 is not None:
            score += 0.10 if c > indicators.sma_20 else -0.10
        if indicators.sma_50 is not None:
            score += 0.08 if c > indicators.sma_50 else -0.08
        if indicators.sma_200 is not None:
            score += 0.12 if c > indicators.sma_200 else -0.12

        # Clamp between -1.0 and +1.0
        score = float(np.clip(score, -1.0, 1.0))
        score = round(score, 3)

        # Map to discrete stance
        if score >= 0.40:
            stance = TechnicalStance.STRONG_BULLISH
            summary = "Technical posture is strongly bullish across multi-timeframe moving averages, confirmed by active upside breakout signals and positive momentum."
        elif score >= 0.12:
            stance = TechnicalStance.BULLISH
            summary = "Technical setup leans bullish with price holding above key dynamic averages and constructive candlestick action."
        elif score <= -0.40:
            stance = TechnicalStance.STRONG_BEARISH
            summary = "Technical stance is decisively bearish under sustained downward distribution, moving average resistance, and breakdown triggers."
        elif score <= -0.12:
            stance = TechnicalStance.BEARISH
            summary = "Technical indicators suggest bearish vulnerability with overhead resistance caps and weakening momentum."
        else:
            stance = TechnicalStance.NEUTRAL
            summary = "Technical outlook remains balanced and range-bound, showing equilibrium between buyers and sellers within established support and resistance boundaries."

        return stance, score, summary

    @classmethod
    def _generate_minimal_response(
        cls, candles: List[Dict[str, Any]], start_time: float
    ) -> TechnicalAnalysisResponse:
        c = float(candles[-1]["close"]) if candles else 0.0
        duration_ms = round((time.perf_counter() - start_time) * 1000.0, 2)
        return TechnicalAnalysisResponse(
            stance=TechnicalStance.NEUTRAL,
            technical_score=0.0,
            summary="Insufficient historical candles to reliably compute multi-session technical patterns.",
            patterns=[],
            support_resistance=[],
            signals=[],
            indicators=IndicatorSnapshot(close_price=c),
            total_candles_analyzed=len(candles),
            meta={"computation_ms": duration_ms, "insufficient_data": True},
        )
