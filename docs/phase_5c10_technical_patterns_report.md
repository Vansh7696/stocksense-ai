# StockSense AI — Phase 5C.10 Technical Pattern & Breakout Engine Implementation Report

**Milestone:** Phase 5C.10: Advanced Technical Analysis & Pattern Recognition Engine
**Date:** November 18, 2026
**Status:** COMPLETE & VERIFIED
**Repository Branch:** `feature/phase-5c-ml-training`
**Full-Stack Test Suite Status:** 949 / 949 Tests Passing (100% Pass Rate)

---

## 1. Executive Summary

Phase 5C.10 completes the quantitative technical analysis infrastructure of **StockSense AI**, introducing an institutional-grade, zero-look-ahead bias pattern recognition and breakout detection engine.

The engine operates across all three microservice layers:
1. **Python AI/ML Service**: Vectorized candlestick pattern recognition algorithms, local extrema pivot detection, price cluster aggregation for Support & Resistance (S/R) zones, and momentum/breakout trigger detection.
2. **Node.js/Express Backend**: Multi-tier API controller (`GET /api/stocks/:id/patterns`) with strict JWT authentication, input validation, Redis caching (300-second TTL), and seamless integration with PostgreSQL historical candles.
3. **React Frontend**: Dynamic `TechnicalPatternsCard` integrated into the stock prediction dashboard featuring an interactive technical stance gauge, candlestick pattern visualizer, dual-column S/R zone breakdown, active breakout alerts, and key technical momentum snapshot.

---

## 2. Candlestick Pattern Recognition Engine

The pattern recognition engine implements mathematical definitions for classical Japanese candlestick formations, evaluating both the real body ($|Close - Open|$) and shadows relative to the total bar range ($High - Low$) and short-term prior trend direction ($Close_{t-1} - Close_{t-6}$):

| Pattern Name | Type | Mathematical Condition & Detection Logic | Confidence Score |
| :--- | :--- | :--- | :--- |
| **Hammer** | Bullish Reversal | Lower shadow $\ge 2.0 \times \text{body}$, upper shadow $\le 0.15 \times \text{range}$, prior trend $< 0$ | 0.84 |
| **Shooting Star** | Bearish Reversal | Upper shadow $\ge 2.0 \times \text{body}$, lower shadow $\le 0.15 \times \text{range}$, prior trend $> 0$ | 0.84 |
| **Bullish Engulfing** | Bullish Reversal | Prev bar red ($C_{t-1} < O_{t-1}$), current bar green ($C_t > O_t$), $O_t \le C_{t-1}$ and $C_t \ge O_{t-1}$ | 0.88 |
| **Bearish Engulfing** | Bearish Reversal | Prev bar green ($C_{t-1} > O_{t-1}$), current bar red ($C_t < O_t$), $O_t \ge C_{t-1}$ and $C_t \le O_{t-1}$ | 0.88 |
| **Doji** | Neutral Indecision | Candle body $\le 0.08 \times \text{range}$ with non-zero total range | 0.72 |
| **Morning Star** | Bullish Reversal | 3-bar structure: tall red candle $\to$ small star body gapped low $\to$ tall green candle penetrating $\ge 50\%$ into bar 1 | 0.91 |
| **Evening Star** | Bearish Reversal | 3-bar structure: tall green candle $\to$ small star body gapped high $\to$ tall red candle penetrating $\ge 50\%$ into bar 1 | 0.91 |
| **Three White Soldiers** | Bullish Continuation | 3 consecutive tall green candles with consecutively higher closes and opens within prior body | 0.93 |
| **Three Black Crows** | Bearish Continuation | 3 consecutive tall red candles with consecutively lower closes and opens within prior body | 0.93 |

---

## 3. Support & Resistance Zone Clustering

Support and Resistance levels are computed mathematically through local extrema clustering:
1. **Local Extrema Detection**: Local pivot highs and lows are identified using rolling symmetric windows ($w = 5$ bars before and after), strictly excluding the final bar to eliminate incomplete peak bias.
2. **Tolerance Band Aggregation**: Extrema within a relative price tolerance of $1.5\%$ are clustered together.
3. **Volume-Weighted Pricing**: Central level price is calculated via volume-weighted average:
   $$\bar{P}_{\text{cluster}} = \frac{\sum_{i} P_i \cdot V_i}{\sum_{i} V_i}$$
4. **Classification & Proximity**: Levels below current closing price are classified as `SUPPORT`, while levels above are classified as `RESISTANCE`. Distance percentage is computed as:
   $$\text{Distance}(\%) = \frac{\bar{P}_{\text{cluster}} - Close_{\text{current}}}{Close_{\text{current}}} \times 100$$
5. **Strength Normalization**: Level strength scales with touch frequency ($touch\_count \times 0.15 + 0.4$, capped at $1.0$).

---

## 4. Breakout & Momentum Signal Engine

Active technical signals are evaluated on each incoming bar:
- **Donchian Channel Breakouts (20-period)**:
  - Highest High Breakout: $Close_t > \max(High_{t-20 \dots t-1})$ with RVOL confirmation.
  - Lowest Low Breakdown: $Close_t < \min(Low_{t-20 \dots t-1})$ with RVOL confirmation.
- **RSI Regular Divergence**:
  - Bullish: Price prints lower low while 14-period RSI prints higher low ($RSI < 45$).
  - Bearish: Price prints higher high while 14-period RSI prints lower high ($RSI > 55$).
- **MACD Signal Crossovers**:
  - Bullish: MACD line crosses above 9-period Signal line ($MACD_{t-1} \le Signal_{t-1}$ and $MACD_t > Signal_t$).
  - Bearish: MACD line crosses below Signal line.
- **Volume-Confirmed Momentum Candle**:
  - $|Close_t - Close_{t-1}| \ge 1.5 \times ATR_{14}$ accompanied by $RVOL_{20} \ge 1.5$.

---

## 5. Composite Technical Stance Synthesis

The engine synthesizes all quantitative technical signals, candlestick structures, dynamic moving averages (SMA 20, 50, 200), and RSI into a bounded continuous score $S \in [-1.0, +1.0]$:

$$S = \text{clip}\left(\sum w_{\text{signals}} + \sum w_{\text{patterns}} + w_{\text{RSI}} + \sum w_{\text{SMA}}, -1.0, 1.0\right)$$

- $S \ge +0.40 \implies$ **STRONG_BULLISH**
- $+0.12 \le S < +0.40 \implies$ **BULLISH**
- $-0.12 < S < +0.12 \implies$ **NEUTRAL**
- $-0.40 < S \le -0.12 \implies$ **BEARISH**
- $S \le -0.40 \implies$ **STRONG_BEARISH**

---

## 6. End-to-End Test Suite Verification

| Subsystem | Test Suite | Tests Run | Pass Rate | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Python ML Microservice** | `ml-service/tests/` | 385 | 100% | **PASSED** |
| **Node.js Express Backend** | `backend/tests/` | 480 | 100% | **PASSED** |
| **React Frontend** | `frontend/tests/` | 84 | 100% | **PASSED** |
| **Frontend Production Build** | Vite production bundle | — | Clean build in 1.31s | **PASSED** |
| **Cumulative Stack** | Full repository verification | **949** | **100%** | **VERIFIED** |

---

## 7. Deliverables & Artifacts Generated

1. `ml-service/app/schemas/patterns.py` — Pydantic V2 schemas for technical patterns, S/R levels, breakout signals, and indicator snapshots.
2. `ml-service/app/services/patterns.py` — Vectorized pattern recognition, clustering, and stance synthesis engine.
3. `ml-service/app/api/patterns.py` — FastAPI router with `POST /api/patterns/analyze`.
4. `ml-service/tests/test_patterns.py` — 10 automated unit tests for pattern detection, clustering, and API validation.
5. `backend/src/services/mlClient.service.js` — Client integration for pattern analysis with timeout and telemetry.
6. `backend/src/controllers/pattern.controller.js` — Controller orchestrating candle retrieval, Redis caching (300s), and error logging.
7. `backend/src/routes/stock.routes.js` — Route registration `GET /api/stocks/:id/patterns` with `requireAuth`.
8. `backend/tests/patternApi.test.js` — 3 integration tests covering authentication, parameter validation, and Redis caching.
9. `frontend/src/services/api.js` — Frontend API client function `getStockPatterns`.
10. `frontend/src/utils/patterns.js` — Pure JavaScript formatting, gauge calculation, and badge metadata utilities.
11. `frontend/src/components/patterns/TechnicalPatternsCard.jsx` — Interactive UI card with stance gauge, candlestick patterns, S/R zones, and breakout triggers.
12. `frontend/src/components/patterns/index.js` — Component export.
13. `frontend/src/components/predictions/StockPredictionDashboard.jsx` — Concurrent multi-factor prediction dashboard integration.
14. `frontend/tests/patternUi.test.js` — 6 unit tests covering stance resolution, gauge math, score formatting, and API exports.
15. `docs/phase_5c10_technical_patterns_report.md` — Formal milestone engineering deliverable.
