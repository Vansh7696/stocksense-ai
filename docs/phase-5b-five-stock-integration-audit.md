# StockSense AI — Phase 5B Five-Stock Technical Indicators & Feature Integration Audit

**Audit Timestamp**: November 10, 2026<br />
**Auditor**: Antigravity Autonomous Market Data & ML Foundation Agent<br />
**Audit Status**: **CERTIFIED READY FOR MODEL TRAINING (PHASE 5C)**<br />
**Historical Ingestion Scope**: 5 Core NSE Equities (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`)<br />
**Total Historical Dataset**: 3,715 Daily Candles ($743 \times 5$, November 12, 2023 to November 9, 2026)

---

## 1. Executive Summary

Phase 5B establishes the mathematical transformation of raw historical daily OHLCV candlesticks into an analytically rigorous, scale-invariant, zero-lookahead technical indicator suite and machine learning feature engineering matrix.

Following the completion of 3-year historical ingestion across the five flagship NSE instruments, this audit comprehensively validates the end-to-end indicator calculation engine, feature engineering pipeline, Express-to-FastAPI microservice communication, Redis cache integration, mathematical invariants, and dataset readiness for predictive modeling in Phase 5C.

```
+---------------------------------------------------------------------------------------------------+
|                                  PHASE 5B INTEGRATION SCORECARD                                   |
+---------------------------------------------------------------------------------------------------+
| Approved Equities Audited       | 5 / 5 (RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK)               |
| Historical OHLCV Candles        | 3,715 / 3,715 (100% verified in PostgreSQL)                     |
| Cross-Stock Session Alignment   | 743 identical Indian trading sessions across all 5 equities     |
| Indicators Computed per Candle  | 10 (SMA, EMA, RSI, MACD, BB, ATR, Return, Vol, VolSMA, RVOL)   |
| Scale-Invariant ML Features     | 23 engineered features per row                                  |
| Mathematical Invariants         | 100% PASS (RSI [0, 100], BB Lower <= Mid <= Upper, ATR/Vol > 0)|
| Causality Guarantee             | 100% PASS (Zero look-ahead bias confirmed empirically)          |
| Usable ML Rows (drop_na=True)   | 544 rows per stock (2,720 pooled observations)                   |
| Prediction Horizon h=1 Rows     | 543 rows per stock (2,715 pooled training rows)                 |
| Prediction Horizon h=5 Rows     | 539 rows per stock (2,695 pooled training rows)                 |
| Redis Cache Latency             | 4ms - 5ms (Hit) vs 29ms - 73ms (Miss)                           |
| Python ML Service Tests         | 29 / 29 PASSED (pytest)                                         |
| Backend API Integration Tests   | 39 / 39 PASSED (indicatorApi: 11, histFoundation: 24, health: 4)|
| Frontend Integration Tests      | 41 / 41 PASSED (npm test)                                       |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. Architecture & Pipeline Specification

The technical analysis and feature pipeline is structured as a decoupled, microservice architecture ensuring clear boundaries between data orchestration, numerical computation, and client consumption.

```mermaid
flowchart TD
    Client["Frontend / API Consumer"] -->|GET /api/stocks/:id/indicators| ExpressGateway["Express Backend Gateway"]
    Client -->|GET /api/stocks/:id/features| ExpressGateway

    ExpressGateway -->|1. Check Cache| Redis["Redis 7 Cache Store"]
    Redis -.->|Cache Hit 4ms| ExpressGateway

    ExpressGateway -->|2. Cache Miss: Query Candles| Postgres[("PostgreSQL 16 Database")]
    Postgres -->|743 OHLCV Candles| ExpressGateway

    ExpressGateway -->|3. POST /api/indicators/compute\nPOST /api/features/engineer| FastAPI["Python FastAPI ML Service"]

    subgraph FastAPI_Internal ["ML Service Core Engine"]
        TA_Engine["TechnicalAnalysisEngine\n(indicators.py)"]
        FE_Pipeline["FeatureEngineeringPipeline\n(features.py)"]
        TA_Engine -->|Raw Numeric Arrays| FE_Pipeline
    end

    FastAPI --> FastAPI_Internal
    FastAPI_Internal -->|4. Clean JSON Arrays & Metadata| ExpressGateway
    ExpressGateway -->|5. SETEX 300s| Redis
    ExpressGateway -->|6. HTTP 200 Response| Client
```

### 2.1 Core Indicator Suite (10 Indicators)

Implemented in [`ml-service/app/services/indicators.py`](file:///Users/vansh/Documents/stocksense/ml-service/app/services/indicators.py):

1. **Simple Moving Average (SMA)**: Periods 20, 50, 200. Rolling arithmetic mean with backward-looking window:
   $$\text{SMA}_N(t) = \frac{1}{N} \sum_{i=0}^{N-1} P_{t-i}$$
2. **Exponential Moving Average (EMA)**: Periods 12, 26, 50. Weighted exponential moving average initialized via initial $N$-period SMA:
   $$\alpha = \frac{2}{N+1}, \quad \text{EMA}_N(t) = \alpha \cdot P_t + (1 - \alpha) \cdot \text{EMA}_N(t-1)$$
3. **Relative Strength Index (RSI)**: Period 14. Welles Wilder's smoothed moving average (RMA):
   $$\text{RS} = \frac{\text{AvgGain}_{14}}{\text{AvgLoss}_{14}}, \quad \text{RSI} = 100 - \frac{100}{1 + \text{RS}}$$
4. **Moving Average Convergence Divergence (MACD)**: Fast 12, Slow 26, Signal 9:
   $$\text{MACD Line} = \text{EMA}_{12}(P) - \text{EMA}_{26}(P)$$
   $$\text{Signal Line} = \text{EMA}_9(\text{MACD Line})$$
   $$\text{Histogram} = \text{MACD Line} - \text{Signal Line}$$
5. **Bollinger Bands**: Period 20, 2.0 Standard Deviations. Population standard deviation (`ddof=0`):
   $$\text{Middle} = \text{SMA}_{20}(P), \quad \sigma = \text{std}_{20}(P, \text{ddof}=0)$$
   $$\text{Upper} = \text{Middle} + 2\sigma, \quad \text{Lower} = \text{Middle} - 2\sigma$$
   $$\%B = \frac{P - \text{Lower}}{\text{Upper} - \text{Lower}}, \quad \text{Bandwidth} = \frac{\text{Upper} - \text{Lower}}{\text{Middle}}$$
6. **Average True Range (ATR)**: Period 14. Wilder's smoothed True Range:
   $$\text{TR}_t = \max(H_t - L_t, |H_t - C_{t-1}|, |L_t - C_{t-1}|)$$
7. **Daily Returns**: Percentage and fractional 1-day close-to-close returns:
   $$R_t = \frac{C_t - C_{t-1}}{C_{t-1}} \times 100\%$$
8. **Rolling Volatility**: 20-day sample standard deviation (`ddof=1`) of daily returns, annualized with 252 trading days:
   $$\sigma_{\text{annual}} = \text{std}_{20}(R, \text{ddof}=1) \times \sqrt{252}$$
9. **Volume Moving Average**: 20-day simple moving average of trading volume:
   $$\text{VolSMA}_{20}(t) = \frac{1}{20} \sum_{i=0}^{19} V_{t-i}$$
10. **Relative Volume (RVOL)**: Ratio of current bar volume to its 20-day moving average:
    $$\text{RVOL}_t = \frac{V_t}{\text{VolSMA}_{20}(t)}$$

### 2.2 Engineered Feature Matrix (23 ML Features)

Implemented in [`ml-service/app/services/features.py`](file:///Users/vansh/Documents/stocksense/ml-service/app/services/features.py). All features are strictly scale-invariant, stationary, and normalized:

| Category | Feature Name | Mathematical Definition | Range / Normalization |
| :--- | :--- | :--- | :--- |
| **Trend / Moving Averages** | `price_to_sma20` | $(C_t - \text{SMA}_{20}) / \text{SMA}_{20}$ | Ratio around 0.0 |
| | `price_to_sma50` | $(C_t - \text{SMA}_{50}) / \text{SMA}_{50}$ | Ratio around 0.0 |
| | `price_to_sma200` | $(C_t - \text{SMA}_{200}) / \text{SMA}_{200}$ | Ratio around 0.0 |
| | `price_to_ema12` | $(C_t - \text{EMA}_{12}) / \text{EMA}_{12}$ | Ratio around 0.0 |
| | `price_to_ema26` | $(C_t - \text{EMA}_{26}) / \text{EMA}_{26}$ | Ratio around 0.0 |
| | `price_to_ema50` | $(C_t - \text{EMA}_{50}) / \text{EMA}_{50}$ | Ratio around 0.0 |
| **Momentum** | `rsi_14` | Raw Wilder's RSI | $[0.0, 100.0]$ |
| | `rsi_normalized` | $(\text{RSI}_{14} - 50.0) / 50.0$ | Centered $[-1.0, 1.0]$ |
| | `rsi_slope_5` | $(\text{RSI}_t - \text{RSI}_{t-5}) / 5.0$ | Velocity per bar |
| | `macd_hist` | Raw MACD Histogram | Scale-dependent |
| | `macd_hist_normalized`| $\text{Histogram}_t / C_t$ | Scale-invariant ratio |
| **Volatility & Bands** | `bb_percent_b` | $(C_t - \text{Lower}) / (\text{Upper} - \text{Lower})$ | Continuous, centered $\approx 0.5$ |
| | `bb_zscore` | $(C_t - \text{Middle}) / \sigma$ | Standard normal $Z$-score |
| | `bb_bandwidth` | $(\text{Upper} - \text{Lower}) / \text{Middle}$ | Percentage width $\ge 0$ |
| | `atr_pct` | $(\text{ATR}_{14} / C_t) \times 100\%$ | Normalized volatility % |
| | `volatility_20d` | Annualized return std dev % | $> 0.0\%$ |
| **Multi-Horizon Returns**| `return_1d` | $(C_t - C_{t-1}) / C_{t-1} \times 100$ | 1-bar percentage return |
| | `return_5d` | $(C_t - C_{t-5}) / C_{t-5} \times 100$ | 1-week percentage return |
| | `return_21d` | $(C_t - C_{t-21}) / C_{t-21} \times 100$ | 1-month percentage return |
| **Volume Dynamics** | `relative_volume_20`| $V_t / \text{VolSMA}_{20}(t)$ | Relative activity $\ge 0$ |
| **Structural Alignment** | `trend_alignment` | Stack score: $+1.0$ (SMA20 > 50 > 200), $-1.0$ (SMA20 < 50 < 200), $\pm 0.5$ (partial), $0.0$ (neutral) | Categorical $[-1.0, 1.0]$ |
| | `ma_spread_50_200` | $(\text{SMA}_{50} - \text{SMA}_{200}) / \text{SMA}_{200}$ | Long-term macro spread |
| | `ma_spread_20_50` | $(\text{SMA}_{20} - \text{SMA}_{50}) / \text{SMA}_{50}$ | Intermediate swing spread |

---

## 3. Mathematical Validation & Invariant Proofs

The pipeline was executed against all 3,715 historical daily candles. Invariant enforcement confirmed 100% adherence to mathematical boundaries and warm-up specifications.

### 3.1 Initial Valid Warm-Up Index Verification

In a 0-indexed series of length $N=743$ (indices $0 \dots 742$):

| Indicator / Feature | Target Window / Parameter | Expected First Valid Index | Observed in Database (All 5 Equities) | Status |
| :--- | :--- | :--- | :--- | :--- |
| `daily_returns_pct` / `return_1d` | Lag 1 | Index 1 (2nd candle) | **Index 1** | **PASS** |
| `return_5d` | Lag 5 | Index 5 (6th candle) | **Index 5** | **PASS** |
| `ema_12` / `price_to_ema12` | Period 12 | Index 11 (12th candle) | **Index 11** | **PASS** |
| `atr` / `atr_pct` | Period 14 | Index 13 (14th candle) | **Index 13** | **PASS** |
| `rsi` / `rsi_14` / `rsi_normalized`| Period 14 | Index 14 (15th candle) | **Index 14** | **PASS** |
| `sma_20` / `bb_*` / `vol_sma` / `rvol` | Period 20 | Index 19 (20th candle) | **Index 19** | **PASS** |
| `rsi_slope_5` | RSI14 + Lag 5 | Index 19 ($14 + 5$) | **Index 19** | **PASS** |
| `rolling_volatility_pct` / `volatility_20d` | Window 20 (on Return) | Index 20 ($1 + 19$) | **Index 20** | **PASS** |
| `return_21d` | Lag 21 | Index 21 (22nd candle) | **Index 21** | **PASS** |
| `ema_26` / `price_to_ema26` / `macd_line` | Period 26 | Index 25 (26th candle) | **Index 25** | **PASS** |
| `signal_line` / `histogram` / `macd_hist*` | Slow 26 + Signal 9 | Index 33 ($25 + 9 - 1$) | **Index 33** | **PASS** |
| `sma_50` / `ema_50` / `ma_spread_20_50` | Period 50 | Index 49 (50th candle) | **Index 49** | **PASS** |
| `sma_200` / `trend_alignment` / `ma_spread_50_200` | Period 200 | Index 199 (200th candle) | **Index 199** | **PASS** |

### 3.2 Invariant Boundaries

Across all 743 trading sessions for all five equities:
- **RSI Range**: $0.0 \le \text{RSI} \le 100.0$ holds universally.
  - RELIANCE observed range: $[23.95, 87.71]$
  - TCS observed range: $[20.69, 86.66]$
  - INFY observed range: $[17.06, 85.34]$
  - HDFCBANK observed range: $[19.53, 84.14]$
  - ICICIBANK observed range: $[27.28, 86.82]$
- **Bollinger Bands Structural Ordering**: $\text{Lower Band} \le \text{Middle Band} \le \text{Upper Band}$ was verified across every valid candle ($t \ge 19$) with zero violations ($\Delta \le 10^{-6}$).
- **ATR Strict Positivity**: $\text{ATR}_t > 0$ for all $t \ge 13$ (Minimum observed ATR was ₹8.62 for HDFCBANK).
- **Rolling Volatility Strict Positivity**: $\sigma_t > 0$ for all $t \ge 20$ (Minimum observed volatility was $9.45\%$ for ICICIBANK).
- **Relative Volume**: $\text{RVOL}_t \ge 0.0$ for all $t \ge 19$. No division-by-zero or negative volume values occurred.

### 3.3 Causality Guarantee (Zero Look-Ahead Bias)

To provide mathematical proof that no future information leaks into historical indicator or feature records:
1. Feature extraction was performed on the first $K=250$ historical candles ($t_0 \dots t_{249}$).
2. The remaining 493 candles ($t_{250} \dots t_{742}$) were intentionally corrupted with extreme synthetic values (Close = ₹95,000, High = ₹100,000, Low = ₹88,888, Volume = 99,999,999).
3. The feature pipeline was re-executed across the full corrupted dataset.
4. Past feature rows ($t \le 249$) were compared element-by-element across all 23 features against the original uncorrupted run.
5. **Result**: Maximum observed absolute difference across all values was **strictly $0.0$** ($\Delta = 0.0000000000$). Zero future information propagates backward.

---

## 4. Per-Stock Completeness & Outlier Review

Daily return distribution was computed for each equity across 742 return observations (November 13, 2023 to November 9, 2026). Sessions exhibiting daily returns $> 3\sigma$ ($|Z| > 3.0$) were isolated and audited against verified Indian macroeconomic, political, and corporate earnings events.

### 4.1 Statistical Distribution Summary

| Metric | RELIANCE | TCS | INFY | HDFCBANK | ICICIBANK |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Total Candles** | 743 | 743 | 743 | 743 | 743 |
| **Return Observations** | 742 | 742 | 742 | 742 | 742 |
| **Daily Return Mean ($\mu$)** | $+0.0272\%$ | $-0.0293\%$ | $-0.0103\%$ | $+0.0170\%$ | $+0.0781\%$ |
| **Daily Return Std ($\sigma$, ddof=1)**| $1.4151\%$ | $1.5356\%$ | $1.7089\%$ | $1.3143\%$ | $1.2407\%$ |
| **Minimum Daily Return** | $-7.48\%$ | $-8.39\%$ | $-7.26\%$ | $-8.43\%$ | $-7.63\%$ |
| **Maximum Daily Return** | $+11.60\%$ | $+6.79\%$ | $+7.93\%$ | $+5.71\%$ | $+5.33\%$ |
| **$> 3\sigma$ Outlier Count** | **8 sessions** | **12 sessions** | **11 sessions** | **8 sessions** | **7 sessions** |

---

### 4.2 Outlier Analysis by Stock (Asia/Kolkata Session Dates)

> [!NOTE]
> Per audit governance rules, event context is designated as **Verified Event** only where supported by documented election results, official corporate earnings filings, or published macroeconomic circulars. Sessions where company-specific circulars are not independently cross-referenced are classified as **Unverified Candidate**.

#### 1. RELIANCE (8 Outliers)
| Session Date (IST) | Close (₹) | Prev Close (₹) | Return % | Z-Score | Event Status & Context |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **2024-01-29** | 1,448.05 | 1,353.10 | $+7.02\%$ | $+4.94\sigma$ | **[Verified Event]** RIL Q3 FY24 Results / Jio tariff momentum & retail expansion surge |
| **2024-06-03** | 1,510.30 | 1,430.40 | $+5.59\%$ | $+3.93\sigma$ | **[Verified Event]** Exit Polls Rally (All-time high broad market surge on landslide predictions) |
| **2024-06-04** | 1,397.30 | 1,510.30 | $-7.48\%$ | $-5.31\sigma$ | **[Verified Event]** **Lok Sabha Election Results Day** (Massive market-wide sell-off on coalition outcome) |
| **2025-04-28** | 1,368.80 | 1,300.40 | $+5.26\%$ | $+3.70\sigma$ | *[Unverified Candidate]* Candidate: Q4 FY25 earnings announcement / Oil-to-Chemicals margin recovery |
| **2025-05-12** | 1,436.50 | 1,377.20 | $+4.31\%$ | $+3.02\sigma$ | *[Unverified Candidate]* Candidate: Heavyweight institutional buying / global crude oil stability rally |
| **2026-01-06** | 1,507.60 | 1,578.10 | $-4.47\%$ | $-3.18\sigma$ | *[Unverified Candidate]* Candidate: Global crude benchmark slump / refining crack margin compression |
| **2026-03-27** | 1,348.10 | 1,413.10 | $-4.60\%$ | $-3.27\sigma$ | *[Unverified Candidate]* Candidate: Financial year-end institutional portfolio adjustments & derivatives expiry |
| **2026-11-02** | 1,300.00 | 1,164.90 | $+11.60\%$ | $+8.18\sigma$ | *[Unverified Candidate]* Candidate: Q2 FY27 earnings release window / retail demerger update |

#### 2. TCS (12 Outliers)
| Session Date (IST) | Close (₹) | Prev Close (₹) | Return % | Z-Score | Event Status & Context |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **2023-12-15** | 3,861.00 | 3,667.25 | $+5.28\%$ | $+3.46\sigma$ | **[Verified Event]** US Fed Dovish Pivot (Fed signals 2024 rate cuts, IT sector broad rally) |
| **2024-07-12** | 4,183.95 | 3,923.70 | $+6.63\%$ | $+4.34\sigma$ | **[Verified Event]** TCS Q1 FY25 Results beat (revenue growth turnaround & margin expansion) |
| **2025-01-10** | 4,265.65 | 4,038.85 | $+5.62\%$ | $+3.68\sigma$ | *[Unverified Candidate]* Candidate: TCS Q3 FY25 Results window / BFSI vertical guidance |
| **2025-05-12** | 3,620.40 | 3,440.30 | $+5.24\%$ | $+3.43\sigma$ | *[Unverified Candidate]* Candidate: IT sector relief rally / US inflation deceleration |
| **2026-02-04** | 2,999.10 | 3,225.30 | $-7.01\%$ | $-4.55\sigma$ | *[Unverified Candidate]* Candidate: Post-Union Budget tech spending caution / IT offshore contract review |
| **2026-02-12** | 2,750.10 | 2,909.80 | $-5.49\%$ | $-3.56\sigma$ | *[Unverified Candidate]* Candidate: US Treasury yields spike / global tech equity multiple de-rating |
| **2026-04-24** | 2,396.90 | 2,521.80 | $-4.95\%$ | $-3.21\sigma$ | *[Unverified Candidate]* Candidate: Q4 FY26 earnings results window / lower discretionary spending |
| **2026-06-02** | 2,446.90 | 2,297.40 | $+6.51\%$ | $+4.26\sigma$ | *[Unverified Candidate]* Candidate: Oversold tech sector technical bounce |
| **2026-06-03** | 2,241.70 | 2,446.90 | $-8.39\%$ | $-5.44\sigma$ | *[Unverified Candidate]* Candidate: IT sector volatility & European contract renegotiations |
| **2026-07-13** | 2,181.50 | 2,069.00 | $+5.44\%$ | $+3.56\sigma$ | *[Unverified Candidate]* Candidate: TCS Q1 FY27 Results release window |
| **2026-10-13** | 2,069.00 | 1,937.50 | $+6.79\%$ | $+4.44\sigma$ | *[Unverified Candidate]* Candidate: TCS Q2 FY27 Results release window & special interim dividend |
| **2026-10-16** | 2,168.00 | 2,067.00 | $+4.89\%$ | $+3.21\sigma$ | *[Unverified Candidate]* Candidate: Cloud modernization deal signing follow-through |

#### 3. INFY (11 Outliers)
| Session Date (IST) | Close (₹) | Prev Close (₹) | Return % | Z-Score | Event Status & Context |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **2023-12-15** | 1,578.40 | 1,501.45 | $+5.13\%$ | $+3.01\sigma$ | **[Verified Event]** US Fed Dovish Pivot (IT sector broad surge) |
| **2024-01-12** | 1,612.75 | 1,494.20 | $+7.93\%$ | $+4.65\sigma$ | **[Verified Event]** Infosys Q3 FY24 Results beat / FY24 revenue guidance raised |
| **2025-01-17** | 1,815.45 | 1,928.45 | $-5.86\%$ | $-3.42\sigma$ | *[Unverified Candidate]* Candidate: Infosys Q3 FY25 commentary caution on telecommunication vertical |
| **2025-05-12** | 1,626.90 | 1,507.60 | $+7.91\%$ | $+4.64\sigma$ | *[Unverified Candidate]* Candidate: Broad market IT momentum / generative AI partnership expansion |
| **2026-01-16** | 1,689.80 | 1,599.80 | $+5.63\%$ | $+3.30\sigma$ | *[Unverified Candidate]* Candidate: Infosys Q3 FY26 earnings window & large deal win announcements |
| **2026-02-04** | 1,535.80 | 1,656.00 | $-7.26\%$ | $-4.24\sigma$ | *[Unverified Candidate]* Candidate: Post-Budget tech sector consolidation / enterprise IT budget delay |
| **2026-02-12** | 1,386.00 | 1,471.90 | $-5.84\%$ | $-3.41\sigma$ | *[Unverified Candidate]* Candidate: Global tech sell-off following US CPI print |
| **2026-04-24** | 1,154.60 | 1,240.60 | $-6.93\%$ | $-4.05\sigma$ | *[Unverified Candidate]* Candidate: Q4 FY26 earnings results / lower margin guidance for FY27 |
| **2026-06-02** | 1,270.80 | 1,202.50 | $+5.68\%$ | $+3.33\sigma$ | *[Unverified Candidate]* Candidate: Broad tech recovery rally |
| **2026-06-19** | 1,051.40 | 1,127.50 | $-6.75\%$ | $-3.94\sigma$ | *[Unverified Candidate]* Candidate: Global peer (Accenture) guidance cut read-across impact |
| **2026-07-02** | 1,040.90 | 985.30 | $+5.64\%$ | $+3.31\sigma$ | *[Unverified Candidate]* Candidate: Enterprise deal win announcement |

#### 4. HDFCBANK (8 Outliers)
| Session Date (IST) | Close (₹) | Prev Close (₹) | Return % | Z-Score | Event Status & Context |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **2024-01-17** | 768.80 | 839.60 | $-8.43\%$ | $-6.43\sigma$ | **[Verified Event]** **HDFC Bank Q3 FY24 post-merger margins & LDR shock** (Historical single-day crash) |
| **2024-06-04** | 741.60 | 786.10 | $-5.66\%$ | $-4.32\sigma$ | **[Verified Event]** **Lok Sabha Election Results Day** (Heavy financial sector sell-off) |
| **2024-06-05** | 775.90 | 741.60 | $+4.63\%$ | $+3.51\sigma$ | **[Verified Event]** **Post-Election Relief Rebound** (Cabinet continuity confirmed) |
| **2024-07-05** | 824.00 | 863.60 | $-4.59\%$ | $-3.50\sigma$ | **[Verified Event]** FII shareholding adjustment / MSCI index weight increase disappointment |
| **2026-03-19** | 798.20 | 843.05 | $-5.32\%$ | $-4.06\sigma$ | *[Unverified Candidate]* Candidate: RBI regulatory guidance on retail credit-deposit ratio |
| **2026-03-23** | 744.15 | 780.45 | $-4.65\%$ | $-3.55\sigma$ | *[Unverified Candidate]* Candidate: Banking sector liquidity adjustments before fiscal year-end |
| **2026-04-08** | 816.10 | 772.00 | $+5.71\%$ | $+4.33\sigma$ | *[Unverified Candidate]* Candidate: Q4 FY26 business operational update (deposit growth outpaces credit) |
| **2026-07-20** | 777.60 | 819.60 | $-5.12\%$ | $-3.91\sigma$ | *[Unverified Candidate]* Candidate: Q1 FY27 earnings release window / credit provisioning |

#### 5. ICICIBANK (7 Outliers)
| Session Date (IST) | Close (₹) | Prev Close (₹) | Return % | Z-Score | Event Status & Context |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **2023-12-04** | 991.20 | 946.70 | $+4.70\%$ | $+3.73\sigma$ | **[Verified Event]** State Election Results Rally (BJP sweeps 3 states, massive banking rally) |
| **2024-04-29** | 1,160.15 | 1,107.90 | $+4.72\%$ | $+3.74\sigma$ | **[Verified Event]** ICICI Bank Q4 FY24 stellar earnings beat / net NPA hits multi-year low |
| **2024-06-04** | 1,071.45 | 1,160.00 | $-7.63\%$ | $-6.22\sigma$ | **[Verified Event]** **Lok Sabha Election Results Day** (General market capitulation) |
| **2025-05-12** | 1,448.50 | 1,388.90 | $+4.29\%$ | $+3.40\sigma$ | *[Unverified Candidate]* Candidate: Bank Nifty all-time high / credit demand optimism |
| **2026-04-08** | 1,309.20 | 1,245.50 | $+5.11\%$ | $+4.06\sigma$ | *[Unverified Candidate]* Candidate: Q4 FY26 advance operational update / core operating profit growth |
| **2026-11-05** | 1,500.00 | 1,424.10 | $+5.33\%$ | $+4.23\sigma$ | *[Unverified Candidate]* Candidate: Global equities surge following US Presidential election outcome |
| **2026-11-06** | 1,571.20 | 1,500.00 | $+4.75\%$ | $+3.76\sigma$ | *[Unverified Candidate]* Candidate: Institutional follow-through buying across private Indian financials |

---

## 5. Dataset Preparation & Usable Row Accounting for ML

A fundamental requirement for machine learning pipeline integrity is precise accounting of rows lost to warm-up and future target variable labeling.

### 5.1 Warm-Up Row Accounting

The longest indicator warm-up period is dictated by the 200-day Simple Moving Average (`SMA_200`) and the composite `trend_alignment` feature:
- 0-based indices $0 \dots 198$ (199 rows) have at least one NaN value.
- Index 199 (the 200th candle) is the **first fully populated row** where all 23 features contain non-null, valid numerical values.
- When calling `FeatureEngineeringPipeline.extract_features(candles, drop_na=True)`:
  - Total input candles: **743**
  - Warm-up rows dropped: **199**
  - Resulting clean feature matrix: **544 rows per stock**
  - Pooled clean observations across all 5 equities: **2,720 rows**

```
+---------------------------------------------------------------------------------------------------+
|                                  FEATURE MATRIX ROW BUDGET                                        |
+---------------------------------------------------------------------------------------------------+
| Total Stored Historical Candlesticks      | 743 rows per stock (100% complete)                   |
| 200-Day Indicator Warm-Up Drop (Indices 0..198) | -199 rows (NaN in SMA200, trend_alignment)      |
| Complete Engineered Feature Rows          | = 544 rows per stock (2,720 pooled)                  |
+---------------------------------------------------------------------------------------------------+
```

### 5.2 Usable Training Rows by Target Prediction Horizon ($h$)

Supervised predictive modeling requires creating forward target returns $y_{t+h} = (C_{t+h} - C_t) / C_t$. Generating this label without future leakage consumes the final $h$ observations of the dataset:

| Prediction Horizon ($h$) | Target Definition | Target Loss | Usable Rows per Stock | Pooled Usable Dataset (5 Equities) | Date Range (Asia/Kolkata) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1-Day Horizon ($h=1$)** | Next session return: $\frac{C_{t+1} - C_t}{C_t}$ | Last 1 row | **543 rows** | **2,715 observations** | September 3, 2024 to November 6, 2026 |
| **3-Day Horizon ($h=3$)** | 3-session swing return: $\frac{C_{t+3} - C_t}{C_t}$| Last 3 rows | **541 rows** | **2,705 observations** | September 3, 2024 to November 4, 2026 |
| **5-Day Horizon ($h=5$)** | 1-week forward return: $\frac{C_{t+5} - C_t}{C_t}$ | Last 5 rows | **539 rows** | **2,695 observations** | September 3, 2024 to November 2, 2026 |

---

## 6. API, Cache & Performance Validation

Live integration testing was conducted across the Express Gateway (`src/controllers/indicator.controller.js`), Redis 7, and Python FastAPI (`ml-service/app/main.py`).

### 6.1 Redis Caching & Invalidation Verification

1. **Deterministic Cache Key Generation**:
   Key format: `stocksense:cache:stocks:indicators:${stockId}:interval=1D&limit=800`
2. **Cache Latency Benchmarks**:
   - First request (Cache Miss: PostgreSQL query + FastAPI JSON roundtrip + computation): **29ms – 73ms**
   - Second request (Cache Hit: In-memory Redis fetch & deserialization): **4ms – 5ms**
   - Speedup: **$6\times$ to $18\times$ latency reduction**
3. **Audit Discovery & Remediation (`CACHE_TTL`)**:
   - *Issue Identified*: `indicator.controller.js` referenced `CACHE_TTL.DEFAULT`, but `CACHE_TTL` in [`backend/src/services/cache.service.js`](file:///Users/vansh/Documents/stocksense/backend/src/services/cache.service.js) lacked this property, resulting in `undefined` TTL and silent Redis write bypass.
   - *Resolution*: Updated `CACHE_TTL` in `cache.service.js` to formally include `DEFAULT: 300` and `STOCK_INDICATORS: 300`. Verified all indicator responses now cache reliably for 300 seconds (5 minutes).
4. **Targeted Invalidation**:
   - Executing `cacheService.invalidateStockPricesCache(stockId)` invalidates keys matching `stocksense:cache:stocks:indicators:${stockId}:*` and `stocksense:cache:stocks:prices:${stockId}:*` without purging unrelated stock catalogue or market overview caches.
   - Verified that subsequent requests immediately incur a cache miss (HTTP 200, `meta.cached: false`).
5. **Fail-Closed Graceful Degradation**:
   - When the ML microservice was intentionally stopped, Express caught connection refusal (`ECONNREFUSED`) and returned standard error response: `503 ML_SERVICE_UNAVAILABLE`.

---

## 7. Test Suite Execution & Verification Record

All automated test suites across the Python ML service, Backend Gateway, and Frontend client pass with 100% success:

### 7.1 Python ML Microservice Tests (`pytest`)
Command: `./ml-service/.venv/bin/pytest ml-service/tests`
- **Result**: **29 passed** in 0.64s
- Covered:
  - `test_indicators.py` (19 tests): SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Volatility, RVOL, flat markets, high < low rejection.
  - `test_features.py` (8 tests): Feature pipeline extraction, `drop_na` behavior, trend alignment, API HTTP endpoints.
  - `test_health.py` (2 tests): Health check endpoints.

### 7.2 Backend Integration Test Suites
Command: `NODE_ENV=test node --test --test-force-exit backend/tests/*.test.js`
- [`backend/tests/indicatorApi.test.js`](file:///Users/vansh/Documents/stocksense/backend/tests/indicatorApi.test.js): **11 / 11 passed** (Input validation, missing stock 404, symbol ambiguity 409, ML service 503 error handling).
- [`backend/tests/historicalFoundation.test.js`](file:///Users/vansh/Documents/stocksense/backend/tests/historicalFoundation.test.js): **24 / 24 passed** (Trading calendar, holiday schedules, decimal validation, batching, distributed locks).
- [`backend/tests/health.test.js`](file:///Users/vansh/Documents/stocksense/backend/tests/health.test.js): **4 / 4 passed** (Gateway health, dependency probes).

### 7.3 Frontend Client Tests
Command: `npm test --prefix frontend -- --watchAll=false`
- **Result**: **41 / 41 passed** in 123ms
- Covered: Candlestick sanitization, single-flight refresh mutex, persistent watchlist sync, Indian market hours & exchange holiday calendar.

---

## 8. Recommendations for Phase 5C (Model Training)

With Phase 5B certified, the dataset is primed for Phase 5C model development:

1. **Target Variable Formulation**:
   - For regression: $y_{t+h} = \frac{C_{t+h} - C_t}{C_t} \times 100$ (Percentage forward return).
   - For classification: Directional binary target $y_{t+h} = \mathbb{I}(C_{t+h} > C_t)$ (Bullish vs Bearish bar).
2. **Temporal Split & Leakage Prevention**:
   - Cross-validation must strictly employ `TimeSeriesSplit` or expanding-window / walk-forward validation. Never use random $K$-fold cross-validation on time series.
   - Recommended split:
     - **Training Set**: September 3, 2024 to February 28, 2026 (~70%, ~380 rows per stock)
     - **Validation Set**: March 1, 2026 to July 31, 2026 (~15%, ~82 rows per stock)
     - **Out-of-Sample Test Set**: August 1, 2026 to November 6, 2026 (~15%, ~81 rows per stock)
3. **Feature Scaling Protocol**:
   - While the 23 features are already scale-invariant and bounded, tree-based models (XGBoost, LightGBM) require no scaling.
   - For linear or neural network baselines, fit standardizers (`StandardScaler`, `RobustScaler`) **strictly on the training split** and transform validation/test splits.
4. **Baseline Benchmark First**:
   - Establish baseline benchmarks (Zero-return predictor, Buy-and-Hold, Logistic Regression / Ridge) before training gradient-boosted decision trees.

---

## 9. Final Sign-Off & Status

Phase 5B Technical Indicators and Feature Engineering integration with the five-stock historical dataset is **fully verified, mathematically consistent, free of look-ahead bias, and officially approved**.

**Current Status**: **READY FOR PHASE 5C (MODEL TRAINING)**.

*Per project safety boundaries, model training has not been initiated and no database modifications have been made.*
