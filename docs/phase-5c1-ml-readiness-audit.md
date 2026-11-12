# StockSense AI — Phase 5C.1: Machine Learning Readiness Audit

**Document Reference**: `docs/phase-5c1-ml-readiness-audit.md`<br>
**Phase**: Phase 5C.1 – ML Readiness Audit & Data Feasibility<br>
**Branch**: `feature/phase-5c-ml-training`<br>
**Audit Date**: November 10, 2026<br>
**Auditor**: Antigravity Quantitative ML Architecture Agent<br>
**Audit Status**: **CERTIFIED READINESS AUDIT COMPLETE (INCLUDES METHODOLOGICAL CLARIFICATIONS ADDENDUM)**

---

## Executive Summary

This audit assesses the technical, statistical, and architectural readiness of the **StockSense AI** historical dataset and feature engineering pipeline for supervised machine learning model development.

The objective is to formulate and train predictive models that estimate the probability of upward ($+1$), neutral ($0$), and downward ($-1$) price action for Indian equities across **1, 3, and 5 trading days** ($h \in \{1, 3, 5\}$).

```
+---------------------------------------------------------------------------------------------------+
|                                 PHASE 5C.1 ML AUDIT SCORECARD                                     |
+---------------------------------------------------------------------------------------------------+
| Primary Equities Analyzed       | 5 NSE Flagships (RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK)      |
| Raw Stored Daily Candles        | 3,715 candles (743 per stock, Nov 12, 2023 – Nov 9, 2026)       |
| Warm-Up Truncation (drop_na)    | 199 rows dropped per stock (SMA_200 warm-up period)             |
| Clean Feature Rows per Stock    | 544 clean rows (2,720 pooled observations)                      |
| Usable Labeled Rows (h=1)       | 543 rows per stock (2,715 pooled training rows)                 |
| Usable Labeled Rows (h=3)       | 541 rows per stock (2,705 pooled training rows)                 |
| Usable Labeled Rows (h=5)       | 539 rows per stock (2,695 pooled training rows)                 |
| Engineered Feature Dimensions   | 23 scale-invariant features                                     |
| Feature Missing Values (NaN)    | Exactly 0 NaNs after warm-up drop                               |
| Overlapping Label Correlation   | Lag-1 target autocorr: h=1: 0.03 | h=3: +0.66 | h=5: +0.80      |
| Cross-Stock Intra-Sector Corr   | TCS <-> INFY: r = 0.753 | HDFCBANK <-> ICICIBANK: r = 0.531       |
| Cross-Validation Protocol       | Purged Group TimeSeries Split + Embargo (No Random Split)       |
+---------------------------------------------------------------------------------------------------+
```

---

## 1. Current Dataset Structure and Feature Availability

### 1.1 Underlying Relational Data Store
All raw candlestick data resides in PostgreSQL 16 under the `historical_prices` table:
- **Price Precision**: Stored as PostgreSQL `DECIMAL(14, 4)` and mapped to native strings in Express and floats in Python to prevent IEEE-754 precision loss.
- **Volume**: Stored as PostgreSQL `BIGINT`, serialized explicitly as string/int to avoid 64-bit integer truncation.
- **Timestamps**: Stored as UTC `TIMESTAMPTZ` with strict midnight-aligned `00:00:00 IST` semantics (`18:30:00 UTC` preceding day).
- **Session Alignment**: Exactly 743 sessions across all 5 stocks spanning November 12, 2023 (Muhurat session) to November 9, 2026. All five stocks possess 100% identical clean timestamps.
- **Special Weekend Sessions in Clean Dataset**: The 544 clean feature dates (indices 0 to 543) contain exactly three verified weekend/special trading sessions:
  - Clean Index 106: `2025-02-01` (Union Budget 2025 Saturday special session)
  - Clean Index 352: `2026-02-01` (Union Budget 2026 Sunday special session)
  - Clean Index 542: `2026-11-08` (Diwali Muhurat Trading 2026 Sunday evening session)

### 1.2 Feature Engineering Pipeline (`FeatureEngineeringPipeline`)
The Python feature extraction pipeline in `ml-service/app/services/features.py` produces **23 scale-invariant numerical features**:

| # | Feature Name | Mathematical Definition | Property & Bounding |
| :--- | :--- | :--- | :--- |
| 1 | `price_to_sma20` | $(C_t - \text{SMA}_{20}) / \text{SMA}_{20}$ | Relative moving average distance; dimensionless ratio |
| 2 | `price_to_sma50` | $(C_t - \text{SMA}_{50}) / \text{SMA}_{50}$ | Medium-term trend deviation ratio |
| 3 | `price_to_sma200` | $(C_t - \text{SMA}_{200}) / \text{SMA}_{200}$ | Long-term regime relative position ratio |
| 4 | `price_to_ema12` | $(C_t - \text{EMA}_{12}) / \text{EMA}_{12}$ | Fast exponential distance ratio |
| 5 | `price_to_ema26` | $(C_t - \text{EMA}_{26}) / \text{EMA}_{26}$ | Slow exponential distance ratio |
| 6 | `price_to_ema50` | $(C_t - \text{EMA}_{50}) / \text{EMA}_{50}$ | Intermediate exponential distance ratio |
| 7 | `rsi_14` | $100 - [100 / (1 + \text{RS}_{14})]$ | Standard Wilder RSI bounded in $[0, 100]$ |
| 8 | `rsi_normalized` | $(\text{RSI}_{14} - 50.0) / 50.0$ | Centered oscillator strictly bounded in $[-1.0, +1.0]$ |
| 9 | `rsi_slope_5` | $(\text{RSI}_t - \text{RSI}_{t-5}) / 5.0$ | 5-session momentum velocity of RSI |
| 10 | `macd_hist` | $\text{MACD Line} - \text{Signal Line}$ | Raw convergence/divergence spread |
| 11 | `macd_hist_normalized` | $\text{MACD Hist}_t / C_t$ | Price-normalized, scale-invariant MACD momentum |
| 12 | `bb_percent_b` | $(C_t - \text{Lower}) / (\text{Upper} - \text{Lower})$ | Position within Bollinger envelope; centered at 0.5 |
| 13 | `bb_zscore` | $(C_t - \text{Middle}) / \sigma_{20}$ | Standard deviations from 20-day mean |
| 14 | `bb_bandwidth` | $(\text{Upper} - \text{Lower}) / \text{Middle}$ | Normalized channel width; volatility expansion metric $\ge 0$ |
| 15 | `atr_pct` | $(\text{ATR}_{14} / C_t) \times 100\%$ | Normalized Average True Range percentage |
| 16 | `return_1d` | $(C_t - C_{t-1}) / C_{t-1} \times 100\%$ | 1-session percentage return |
| 17 | `return_5d` | $(C_t - C_{t-5}) / C_{t-5} \times 100\%$ | 1-week percentage return |
| 18 | `return_21d` | $(C_t - C_{t-21}) / C_{t-21} \times 100\%$ | 1-month swing return |
| 19 | `volatility_20d` | $\text{std}(r_{1d, 20}) \times \sqrt{252}$ | Annualized 20-session historical return volatility % |
| 20 | `relative_volume_20` | $V_t / \text{VolSMA}_{20}(t)$ | Institutional volume ratio relative to 20-day baseline |
| 21 | `trend_alignment` | Stack score: $+1.0, +0.5, 0.0, -0.5, -1.0$ | Moving average hierarchy ($\text{SMA}_{20} \gtrless \text{SMA}_{50} \gtrless \text{SMA}_{200}$) |
| 22 | `ma_spread_50_200` | $(\text{SMA}_{50} - \text{SMA}_{200}) / \text{SMA}_{200}$ | Golden Cross / Death Cross macro spread ratio |
| 23 | `ma_spread_20_50` | $(\text{SMA}_{20} - \text{SMA}_{50}) / \text{SMA}_{50}$ | Fast moving average crossover spread ratio |

### 1.3 Feature Collinearity Findings
An empirical correlation matrix across all 2,720 pooled feature rows reveals high collinearity ($|r| \ge 0.85$) among several feature pairs:
- **Redundant Linear Transforms ($r = 1.000$)**:
  - `bb_percent_b` $\leftrightarrow$ `bb_zscore` ($r = 1.0000$): Mathematically identical because $\%B = 0.5 + 0.25 \times Z$.
  - `rsi_14` $\leftrightarrow$ `rsi_normalized` ($r = 1.0000$): Exact linear rescaling.
- **High Moving Average Overlap**:
  - `price_to_sma50` $\leftrightarrow$ `price_to_ema50` ($r = 0.981$)
  - `price_to_sma20` $\leftrightarrow$ `price_to_ema26` ($r = 0.965$)
  - `price_to_sma20` $\leftrightarrow$ `price_to_ema12` ($r = 0.957$)
- **Indicator Overlap**:
  - `price_to_ema26` $\leftrightarrow$ `rsi_14` ($r = 0.953$)
  - `rsi_slope_5` $\leftrightarrow$ `return_5d` ($r = 0.872$)
  - `atr_pct` $\leftrightarrow$ `volatility_20d` ($r = 0.860$)

---

## 2. Target-Variable Definitions for 1, 3, and 5 Trading Days

### 2.1 Primary Executable Target vs. Alternative Research Benchmark

#### Primary Approved Executable Target ($R(t,h)$):
To eliminate look-ahead bias and ensure executable fidelity in live trading, the approved primary predictive target models the return from the **next session's open ($O_{t+1}$)** to the **horizon session's close ($C_{t+h}$)**:

$$R(t, h) = \left( \frac{C_{t+h} - O_{t+1}}{O_{t+1}} \right) \times 100\% \quad \text{for } h \in \{1, 3, 5\} \text{ trading sessions}$$

Where:
- **Signal Generation**: Strictly computed after session $t$ closes (between 16:30 and 18:00 IST), using only candlestick and indicator information available at or before session $t$ close ($[O_\tau, H_\tau, L_\tau, C_\tau, V_\tau]_{\tau \le t}$).
- **Entry Proxy**: Next trading session's opening auction price, $O_{t+1}$ (09:15 IST).
- **Exit Proxy**: Closing settlement price of the $h$-th trading session, $C_{t+h}$ (15:30 IST).

#### Alternative Close-to-Close Research Benchmark ($r_{t+h}^{\text{c2c}}$):
In academic quantitative literature, forward returns are frequently formulated as:

$$r_{t+h}^{\text{c2c}} = \left( \frac{C_{t+h} - C_t}{C_t} \right) \times 100\%$$

> [!NOTE]
> The Close-to-Close return is maintained strictly as an **alternative research benchmark** for diagnostic comparisons with external quantitative literature. Because entering at $C_t$ post-market close is physically impossible without retroactive execution, Close-to-Close is **not** the approved primary executable target (see Section 12.1 and `docs/phase-5c1-ml-clarification-addendum.md` for the empirical gap analysis).

### 2.2 Discrete 3-Class Categorization & Candidate Threshold Schedule
To prevent models from overfitting to meaningless market noise (e.g., $+0.02\%$ drift), price movements are mapped into three discrete classes using candidate threshold schedule $\theta_h$:

$$\text{Label}_{t, h}^{\text{exec}} = \begin{cases}
+1 \quad (\text{UPWARD}) & \text{if } R(t, h) > +\theta_h \\
0 \quad (\text{NEUTRAL}) & \text{if } -\theta_h \le R(t, h) \le +\theta_h \\
-1 \quad (\text{DOWNWARD}) & \text{if } R(t, h) < -\theta_h
\end{cases}$$

Candidate threshold schedule for the horizons:
- **1 Session ($h=1$)**: DOWN below $-0.50\%$, NEUTRAL $[-0.50\%, +0.50\%]$, UP above $+0.50\%$.
- **3 Sessions ($h=3$)**: DOWN below $-1.00\%$, NEUTRAL $[-1.00\%, +1.00\%]$, UP above $+1.00\%$.
- **5 Sessions ($h=5$)**: DOWN below $-1.50\%$, NEUTRAL $[-1.50\%, +1.50\%]$, UP above $+1.50\%$.

> [!IMPORTANT]
> These values ($\pm 0.50\%$, $\pm 1.00\%$, $\pm 1.50\%$) are **empirical candidate thresholds**, not proven optimal thresholds. Boundary equality is strictly handled such that the neutral deadband includes both endpoints $[-\theta_h, +\theta_h]$, while UP and DOWN are strictly exterior.

### 2.3 Diagnostic Benchmark Labeling Paradigms (Close-to-Close Research Baseline)
During initial Phase 5C.1 exploratory screening, the following baseline distributions were computed under the Close-to-Close research benchmark (with dynamic ATR evaluated as a secondary exploratory experiment):

```
+---------------------------------------------------------------------------------------------------+
|               DIAGNOSTIC CLOSE-TO-CLOSE 3-CLASS RESEARCH BENCHMARK DISTRIBUTIONS                  |
+--------------------+------------------------------+------------------------------+----------------+
| Paradigm           | Horizon h=1                  | Horizon h=3                  | Horizon h=5    |
+--------------------+------------------------------+------------------------------+----------------+
| [A] Zero-Threshold | UP: 47.8% (1,298)            | UP: 47.0% (1,272)            | UP: 47.2% (1,272|
|     (theta = 0.0%) | DOWN: 51.9% (1,410)          | DOWN: 52.8% (1,427)          | DOWN: 52.5%(1,416|
|                    | NEUTRAL: 0.3% (7)            | NEUTRAL: 0.2% (6)            | NEUTRAL: 0.3%(7|
+--------------------+------------------------------+------------------------------+----------------+
| [B] Fixed Candidate| theta = +/- 0.50%            | theta = +/- 1.00%            | theta = +/- 1.50%|
|     (Candidate)    | UP: 29.8% (808)              | UP: 29.4% (796)              | UP: 26.5% (714)|
|                    | NEUTRAL: 35.7% (968)         | NEUTRAL: 37.1% (1,003)       | NEUTRAL: 42.1% (1,134)|
|                    | DOWN: 34.6% (939)            | DOWN: 33.5% (906)            | DOWN: 31.4% (847)|
+--------------------+------------------------------+------------------------------+----------------+
| [C] Dynamic ATR    | theta_t = 0.5 * ATR_pct(t)   | theta_t = 0.5 * ATR_pct(t)   | theta_t = 0.5 * ATR|
|     (Secondary     | Mean theta = 1.00%           | Mean theta = 1.00%           | Mean theta = 1.00%|
|      Experiment)   | UP: 19.0% (517)              | UP: 29.8% (807)              | UP: 33.2% (896)|
|                    | NEUTRAL: 58.9% (1,599)       | NEUTRAL: 35.4% (958)         | NEUTRAL: 27.8% (750)|
|                    | DOWN: 22.1% (599)            | DOWN: 34.8% (940)            | DOWN: 39.0% (1,049)|
+--------------------+------------------------------+------------------------------+----------------+
```

*Note*: The candidate discrete class counts for the primary executable target ($R(t,h)$) are analyzed in Section 12.1 and the clarification addendum, and remain provisional candidate figures pending Phase 5C.2 validation. Dynamic ATR thresholding is designated strictly as a secondary experiment.

---

## 3. Dataset Size and Empirical Class Distribution

### 3.1 Per-Stock Usable Observations

| Equity | Raw Candles | Warm-Up Drop | Clean Feature Rows | Labeled Rows ($h=1$) | Labeled Rows ($h=3$) | Labeled Rows ($h=5$) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RELIANCE** | 743 | 199 | 544 | 543 | 541 | 539 |
| **TCS** | 743 | 199 | 544 | 543 | 541 | 539 |
| **INFY** | 743 | 199 | 544 | 543 | 541 | 539 |
| **HDFCBANK** | 743 | 199 | 544 | 543 | 541 | 539 |
| **ICICIBANK** | 743 | 199 | 544 | 543 | 541 | 539 |
| **POOLED** | **3,715** | **995** | **2,720** | **2,715** | **2,705** | **2,695** |

### 3.2 Detailed Class Breakdown per Stock under Fixed Thresholds (Close-to-Close Benchmark)

> [!NOTE]
> **Diagnostic Research Benchmark Scope**: The per-stock breakdowns below reflect the alternative Close-to-Close research benchmark returns $r_{t+h}^{\text{c2c}}$ evaluated during initial exploratory screening. They confirm that candidate thresholds produce balanced distributions under baseline conditions. For the approved primary executable target $R(t,h)$, provisional candidate distributions are documented in Section 12.1 and `docs/phase-5c1-ml-clarification-addendum.md`, and remain subject to formal implementation verification in Phase 5C.2.

#### Horizon $h=1$ ($\theta = \pm 0.50\%$, Total $N=2,715$)
- **RELIANCE**: UP = 159 ($29.3\%$), NEUTRAL = 196 ($36.1\%$), DOWN = 188 ($34.6\%$)
- **TCS**: UP = 155 ($28.5\%$), NEUTRAL = 192 ($35.4\%$), DOWN = 196 ($36.1\%$)
- **INFY**: UP = 177 ($32.6\%$), NEUTRAL = 154 ($28.4\%$), DOWN = 212 ($39.0\%$)
- **HDFCBANK**: UP = 156 ($28.7\%$), NEUTRAL = 227 ($41.8\%$), DOWN = 160 ($29.5\%$)
- **ICICIBANK**: UP = 161 ($29.7\%$), NEUTRAL = 199 ($36.6\%$), DOWN = 183 ($33.7\%$)
- **Pooled Total**: UP = 808 ($29.8\%$), NEUTRAL = 968 ($35.7\%$), DOWN = 939 ($34.6\%$)

#### Horizon $h=3$ ($\theta = \pm 1.00\%$, Total $N=2,705$)
- **RELIANCE**: UP = 160 ($29.6\%$), NEUTRAL = 198 ($36.6\%$), DOWN = 183 ($33.8\%$)
- **TCS**: UP = 149 ($27.5\%$), NEUTRAL = 177 ($32.7\%$), DOWN = 215 ($39.7\%$)
- **INFY**: UP = 173 ($32.0\%$), NEUTRAL = 169 ($31.2\%$), DOWN = 199 ($36.8\%$)
- **HDFCBANK**: UP = 157 ($29.0\%$), NEUTRAL = 225 ($41.6\%$), DOWN = 159 ($29.4\%$)
- **ICICIBANK**: UP = 157 ($29.0\%$), NEUTRAL = 234 ($43.3\%$), DOWN = 150 ($27.7\%$)
- **Pooled Total**: UP = 796 ($29.4\%$), NEUTRAL = 1,003 ($37.1\%$), DOWN = 906 ($33.5\%$)

#### Horizon $h=5$ ($\theta = \pm 1.50\%$, Total $N=2,695$)
- **RELIANCE**: UP = 145 ($26.9\%$), NEUTRAL = 223 ($41.4\%$), DOWN = 171 ($31.7\%$)
- **TCS**: UP = 130 ($24.1\%$), NEUTRAL = 207 ($38.4\%$), DOWN = 202 ($37.5\%$)
- **INFY**: UP = 161 ($29.9\%$), NEUTRAL = 180 ($33.4\%$), DOWN = 198 ($36.7\%$)
- **HDFCBANK**: UP = 130 ($24.1\%$), NEUTRAL = 264 ($49.0\%$), DOWN = 145 ($26.9\%$)
- **ICICIBANK**: UP = 148 ($27.5\%$), NEUTRAL = 260 ($48.2\%$), DOWN = 131 ($24.3\%$)
- **Pooled Total**: UP = 714 ($26.5\%$), NEUTRAL = 1,134 ($42.1\%$), DOWN = 847 ($31.4\%$)

---

## 4. Missing Values, Outliers, and Potential Data-Quality Problems

### 4.1 Missing Values Audit
- **Warm-Up Phase (Rows 0 to 198)**: Features requiring 200 bars (e.g. `price_to_sma200`, `ma_spread_50_200`) naturally contain `NaN` values.
- **Production Clean Set (`drop_na=True`, Rows 199 to 742)**: Exactly **0 missing values** across all 2,720 rows and 23 feature columns. Verified empirically by running `df[feature_cols].isna().sum().sum() == 0`.

### 4.2 Distribution and $> 3\sigma$ Outlier Analysis

```
+---------------------------------------------------------------------------------------------------------+
|                                POOLED FEATURE STATISTICAL SUMMARY (N=2,720)                             |
+----------------------+---------+---------+----------+---------+---------+--------+-------+--------------+
| Feature              | Mean    | Std Dev | Min      | Median  | Max     | Skew   | Kurt  | >3sigma (Pct)|
+----------------------+---------+---------+----------+---------+---------+--------+-------+--------------+
| price_to_sma20       | -0.004  | 0.036   | -0.136   | -0.003  | +0.159  | +0.06  | +1.09 | 27 (0.99%)   |
| price_to_sma50       | -0.011  | 0.054   | -0.192   | -0.009  | +0.145  | -0.28  | +0.26 |  7 (0.26%)   |
| price_to_sma200      | -0.030  | 0.106   | -0.297   | -0.021  | +0.237  | -0.07  | -1.01 |  0 (0.00%)   |
| rsi_14               | 48.14   | 12.15   | 15.70    | 48.32   | 82.11   | -0.01  | -0.48 |  0 (0.00%)   |
| rsi_normalized       | -0.037  | 0.243   | -0.686   | -0.034  | +0.642  | -0.01  | -0.48 |  0 (0.00%)   |
| rsi_slope_5          | +0.010  | 2.000   | -8.187   | -0.058  | +7.098  | +0.08  | +0.32 | 10 (0.37%)   |
| macd_hist            | +0.013  | 9.519   | -42.235  | -0.175  | +53.562 | +0.26  | +4.03 | 56 (2.06%)   |
| macd_hist_normalized | +0.000  | 0.005   | -0.020   | -0.000  | +0.021  | +0.23  | +0.90 | 20 (0.74%)   |
| bb_percent_b         | +0.473  | 0.332   | -0.379   | +0.454  | +1.418  | +0.12  | -0.83 |  0 (0.00%)   |
| bb_bandwidth         | +0.094  | 0.050   | +0.022   | +0.082  | +0.339  | +1.44  | +2.88 | 44 (1.62%)   |
| atr_pct              | 1.993%  | 0.531%  | 1.087%   | 1.895%  | 3.885%  | +0.86  | +0.40 | 22 (0.81%)   |
| return_1d            | -0.027% | 1.470%  | -8.386%  | -0.048% | +11.60% | +0.30  | +4.13 | 38 (1.40%)   |
| return_5d            | -0.142% | 3.310%  | -12.44%  | -0.162% | +15.81% | +0.33  | +1.72 | 32 (1.18%)   |
| return_21d           | -0.712% | 6.478%  | -24.20%  | -0.494% | +23.23% | +0.04  | +0.74 | 27 (0.99%)   |
| volatility_20d       | 21.63%  | 7.58%   | 8.15%    | 20.28%  | 48.28%  | +0.81  | +0.42 | 27 (0.99%)   |
| relative_volume_20   | 1.013   | 0.493   | 0.054    | 0.915   | 8.862   | +3.30  | +30.47| 39 (1.43%)   |
| trend_alignment      | -0.129  | 0.840   | -1.000   | -0.500  | +1.000  | +0.27  | -1.67 |  0 (0.00%)   |
+----------------------+---------+---------+----------+---------+---------+--------+-------+--------------+
```

---

## 5. Potential Data Leakage and Overlapping-Label Problems

### 5.1 Backward Feature Causality (Zero Look-Ahead Bias)
The feature engineering engine is strictly backward-looking. For any timestamp $t$:
- SMAs, EMAs, RSI, and MACD strictly consume prices $\{C_i\}_{i \le t}$.
- Rolling volatility and ATR strictly consume historical bar ranges $\{H_i, L_i, C_i\}_{i \le t}$.

### 5.2 Overlapping Labels: The Serial Correlation Hazard
When predicting forward returns over horizons $h > 1$, consecutive daily observations share overlapping future price intervals:

$$\begin{aligned}
r_{t+3} &= \frac{C_{t+3} - C_t}{C_t} \quad \text{spans sessions } [t \to t+3] \\
r_{t+1+3} &= \frac{C_{t+4} - C_{t+1}}{C_{t+1}} \quad \text{spans sessions } [t+1 \to t+4]
\end{aligned}$$

These two labels share the price change occurring during the 2 sessions between $t+1$ and $t+3$.

#### Empirical Target Autocorrelations from Project Data:

| Target Horizon | Lag 1 Autocorr | Lag 2 Autocorr | Lag 3 Autocorr | Lag 4 Autocorr | Lag 5 Autocorr |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **$h=1$ (Daily)** | **$+0.002$** | $+0.045$ | $-0.038$ | $+0.031$ | $-0.011$ |
| **$h=3$ (Swing)** | **$+0.663$** | **$+0.354$** | $+0.010$ | $+0.008$ | $+0.003$ |
| **$h=5$ (Weekly)**| **$+0.804$** | **$+0.618$** | **$+0.398$** | **$+0.211$** | $+0.008$ |

Notice how empirical autocorrelations match theoretical expectations:
- For $h=3$: Theoretical lag 1 overlap is $(3-1)/3 = 0.667$; empirical autocorrelation is **$+0.663$**.
- For $h=5$: Theoretical lag 1 overlap is $(5-1)/5 = 0.800$; empirical autocorrelation is **$+0.804$**.

---

## 6. Recommended Chronological Train/Validation/Test Split with Purging and Embargo

To eliminate all forward and cross-sectional leakage, the project must implement a **Purged Group Time-Series Split with Embargo**.

### 6.1 Split Ratios
- **Train Set**: 70% of chronological sessions (380 sessions).
- **Validation Set (Tuning & Early Stopping)**: 15% of sessions (81 sessions).
- **Test Set (Held-Out Final Evaluation)**: 15% of sessions (83 sessions).
- **Total Usable Span**: September 2, 2024 to November 9, 2026 (544 clean feature sessions).

### 6.2 Approved Purging and Embargo Policy
1. **Purging (End of Preceding Partitions — Strictly Mandatory)**:
   - For prediction horizon $h$, the final $h$ sample dates of each preceding partition (Train and Validation) must be purged to eliminate forward target leakage into the subsequent set.
   - Retained nominal partition ranges across 544 clean feature dates ($0 \le t \le 543$):
     - **Horizon $h=1$**: Retained Train `0–378` (1,895 obs.) | Retained Validation `380–459` (400 obs.) | Retained Test `461–542` (410 obs.)
     - **Horizon $h=3$**: Retained Train `0–376` (1,885 obs.) | Retained Validation `380–457` (390 obs.) | Retained Test `461–540` (400 obs.)
     - **Horizon $h=5$**: Retained Train `0–374` (1,875 obs.) | Retained Validation `380–455` (380 obs.) | Retained Test `461–538` (390 obs.)
   - Corresponding execution boundaries:
     - **Last training exit**: $C_{379}$ (End of Train partition)
     - **First validation entry**: $O_{381}$ (Session 381 open; features computed at session 380 close)
     - **Last validation exit**: $C_{460}$ (End of Validation partition)
     - **First test entry**: $O_{462}$ (Session 462 open; features computed at session 461 close)
2. **Approved Initial Embargo Policy ($E = 0$ Additional Dates)**:
   - For this strictly forward-only chronological split ($\text{Train} \to \text{Val} \to \text{Test}$), the approved initial policy uses **exactly zero additional embargo dates ($E = 0$)**.
   - **Rationale**: Feature lookback windows do not automatically require an embargo in this forward-only split. Feature calculations at session 380 causally use historical data ($\tau \le 380$), which is authentic to live forward trading. An arbitrary 21-day embargo would discard $26\%$ of the 81-day validation set without preventing any forward leakage.
   - Alternative cross-validation structures (such as Combinatorial Purged Cross-Validation / CPCV where training data follows test data in time) require a separate positive embargo buffer ($E > 0$).
   - *Status*: Mathematical boundary reasoning proves theoretical non-overlap; actual implementation-level leakage safety remains pending until automated unit tests execute against the implemented splitter in Phase 5C.2.

---

## 7. Recommended Baseline Models and Evaluation Metrics

### 7.1 Model Hierarchy
1. **Zero-Rule / Majority Baseline**: Predicts the dominant historical training class (NEUTRAL, $\sim 36\%$).
2. **Directional Momentum / Persistence Baseline**: Predicts forward return direction based on previous session return ($\text{sign}(r_{t-1})$).
3. **L2-Regularized Logistic Regression (ElasticNet)**: Linear baseline requiring standard scaling of features.
4. **Random Forest Classifier**: Ensembled shallow decision trees (100 estimators, max depth 4–5, min samples leaf 15).
5. **Calibrated Gradient Boosted Trees (XGBoost)**: Primary non-linear model with early stopping on validation loss.

### 7.2 Primary Evaluation Metrics
1. **Multi-Class Cross-Entropy / Log-Loss** (Confidence calibration).
2. **Macro F1-Score & Balanced Accuracy** (Unweighted class performance).
3. **One-vs-Rest ROC-AUC & PR-AUC** (Tail discrimination quality).
4. **Brier Score** (Probability calibration error).

---

## 8. Statistical Diversity of the Five NSE Equities

- **Sector Concentration**: 4 of the 5 stocks belong to only two sectors (IT and Banking).
- **Correlation Redundancy**: TCS and INFY exhibit a **$0.753$ return correlation**; HDFCBANK and ICICIBANK exhibit a **$0.531$ return correlation**.
- **Effective Degrees of Freedom**: The five equities behave effectively as $\sim 2.5$ independent assets.
- **Statistical Power**: Sufficient for prototype validation, ML pipeline architecture verification, and baseline algorithm sanity checking ($N = 2,715$ observations is adequate for shallow trees); insufficient for commercial claims or cross-market regime alpha generation.

---

## 9. Additional Data Required Before Production-Level Claims

1. **Benchmark & Macro Regimes**: NIFTY 50 Index OHLCV, India VIX Historical Data, NIFTY Bank/IT sector indices.
2. **Broader Equity Universe**: Minimum 20 to 50 liquid NSE equities covering diverse sectors.
3. **Longer Historical Depth (5–10 Years)**: Multi-regime data covering bear markets and sideways consolidation.
4. **Corporate Actions & Earnings Calendar**: Tracking of quarterly earnings dates, bonus/split announcements, and dividend ex-dates.
5. **Derivative & Microstructure Signals**: NSE F&O Open Interest (OI) and Put-Call Ratio (PCR).

---

## 10. Proposed Folder Structure and Implementation Sequence

### 10.1 Architecture Alignment
```
ml-service/
├── app/
│   ├── api/
│   │   ├── features.py          # Existing Phase 5B feature endpoint
│   │   ├── health.py            # Existing health check
│   │   ├── indicators.py        # Existing Phase 5B indicator endpoint
│   │   └── predictions.py       # Phase 5C inference endpoint (/api/predict)
│   ├── ml/                      # NEW: Core Machine Learning Engine
│   │   ├── __init__.py
│   │   ├── datasets.py          # Data loaders from PostgreSQL/JSON, array formatting
│   │   ├── labeling.py          # Multi-horizon target label generator (h=1, 3, 5)
│   │   ├── validation.py        # PurgedGroupTimeSeriesSplit with embargo engine
│   │   ├── baselines.py         # Majority, Momentum, and Logistic Regression baselines
│   │   ├── models.py            # Calibrated XGBoost & Random Forest classifier wrappers
│   │   ├── trainer.py           # Cross-validation training loop, hyperparameter tuning
│   │   ├── evaluation.py        # Multi-class Log-Loss, F1, Brier, calibration curves
│   │   └── explainability.py    # TreeSHAP feature importance & local attribution
│   ├── models/                  # NEW: Versioned Model Artifacts Store
│   │   ├── h1_xgboost.json      # Calibrated 1-day model artifact
│   │   ├── h3_xgboost.json      # Calibrated 3-day model artifact
│   │   ├── h5_xgboost.json      # Calibrated 5-day model artifact
│   │   └── metadata.json        # Training parameters, feature list, and evaluation metrics
│   ├── schemas/
│   │   ├── market_data.py       # Existing candle & indicator schemas
│   │   └── prediction.py        # NEW: Prediction request/response schemas
│   └── services/
│       ├── features.py          # Existing Phase 5B feature pipeline
│       └── indicators.py        # Existing Phase 5B indicator engine
├── requirements.txt             # Add scikit-learn and xgboost
└── tests/
    ├── test_labeling.py         # Unit tests for target generator & class balance
    ├── test_validation.py       # Unit tests for purged splitting & zero leakage
    └── test_models.py           # Unit tests for baseline & XGBoost training convergence
```

---

## 11. Original Audit Conclusion

The StockSense AI historical dataset of 3,715 candles across the 5 flagship NSE equities is technically sound, scale-invariant, and ready for model development under strict chronological purged splitting.

---

## 12. Methodological Clarifications Addendum (Post-Review Additions)

This section addresses specific methodological refinements requested during architectural review prior to Phase 5C.2 implementation.

### 12.1 Prediction Execution Timing & Executable Target Formulation

#### 12.1.1 Intended Prediction Generation Timestamp
In the StockSense AI architecture, predictions are strictly generated **after market close on trading session $t$**:
- Regular NSE trading closes at **15:30 IST**.
- Daily settlement prices and candle archives are published between 15:40 and 16:30 IST.
- Ingestion and data validation in PostgreSQL occur between **16:00 and 18:00 IST**.
- Feature calculation and ML inference execute on the completed session $t$ candlestick data $[O_t, H_t, L_t, C_t, V_t]$.

#### 12.1.2 The Execution Realism Flaw of Close-to-Close Targets
The theoretical Close-to-Close return:

$$r_{t+h}^{\text{c2c}} = \left( \frac{C_{t+h} - C_t}{C_t} \right) \times 100\%$$

assumes an entry price equal to the closing price of session $t$ ($C_t$). Because predictions are computed after 15:30 IST, entering at $C_t$ is physically impossible.

#### 12.1.3 Executable Target Formulation (Open-to-Close)
An executable trading model enters at the opening price of the next trading session $t+1$ ($O_{t+1}$), and exits at the closing price of session $t+h$ ($C_{t+h}$):

$$r_{t+h}^{\text{executable}} = \left( \frac{C_{t+h} - O_{t+1}}{O_{t+1}} \right) \times 100\%$$

- **1-Day Horizon ($h=1$)**: Entry at $O_{t+1}$ (09:15 IST), Exit at $C_{t+1}$ (15:30 IST). Pure intraday holding on session $t+1$.
- **3-Day Horizon ($h=3$)**: Entry at $O_{t+1}$ (09:15 IST), Exit at $C_{t+3}$ (15:30 IST). Swing position across 3 full sessions.
- **5-Day Horizon ($h=5$)**: Entry at $O_{t+1}$ (09:15 IST), Exit at $C_{t+5}$ (15:30 IST). 1-week position holding.

#### 12.1.4 Empirical Impact of Overnight Gaps ($C_t \to O_{t+1}$)
The overnight price gap is defined as:

$$g_{t+1} = \left( \frac{O_{t+1} - C_t}{C_t} \right) \times 100\%$$

The relationship between the theoretical and executable return is:

$$1 + \frac{r_{t+h}^{\text{c2c}}}{100} = \left(1 + \frac{g_{t+1}}{100}\right) \times \left(1 + \frac{r_{t+h}^{\text{executable}}}{100}\right)$$

Empirical analysis across all 2,715 sessions of our 5-stock dataset reveals:
- **Pooled Overnight Gap**: Mean = $-0.009\%$, Median = $0.000\%$, Standard Deviation = **$0.894\%$**, Min = $-8.665\%$, Max = $+6.005\%$.
- **Gap Frequency**: **$38.3\%$ of all trading sessions experience an overnight gap greater than $\pm 0.50\%$**, and **$14.0\%$ experience a gap greater than $\pm 1.00\%$**.
- In `INFY`, **$49.4\%$** of sessions gap by more than $0.50\%$, driven by overnight trading in US ADRs (NYSE: INFY).

```
+---------------------------------------------------------------------------------------------------+
|               CLOSE-TO-CLOSE VS. EXECUTABLE (OPEN-TO-CLOSE) TARGET COMPARISON                     |
+--------------------------+-----------------------+-----------------------+------------------------+
| Metric                   | Horizon h=1 (1 Day)   | Horizon h=3 (3 Days)  | Horizon h=5 (5 Days)   |
+--------------------------+-----------------------+-----------------------+------------------------+
| Return Correlation       | r = 0.793             | r = 0.938             | r = 0.963              |
| Label Agreement (Pooled) | 1,985 / 2,715 (73.1%) | 2,286 / 2,705 (84.5%) | 2,394 / 2,695 (88.8%)  |
| Label Disagreement       | 730 / 2,715 (26.9%)   | 419 / 2,705 (15.5%)   | 301 / 2,695 (11.2%)    |
+--------------------------+-----------------------+-----------------------+------------------------+
```

**Key Takeaway**: For $h=1$, more than **1 in 4 labels ($26.9\%$) flip or change classification** due to overnight gaps. Close-to-Close falsely attributes overnight opening gaps to the model's intraday predictive power. For $h=3$ and $h=5$, the correlation increases ($r \ge 0.938$), but overnight gap contamination remains material.

**Phase 5C.2 Specification**: The labeling module (`ml-service/app/ml/labeling.py`) must support both `target_type='close_to_close'` (for academic factor comparison) and `target_type='open_to_close'` (executable default for production backtesting).

---

### 12.2 Feature Stationarity Clarification

#### 12.2.1 Correction of Blanket Stationarity Assertion
The original audit described all 23 features as "stationary". Formal statistical unit root tests (e.g. Augmented Dickey-Fuller / ADF or KPSS tests) were not previously executed on all individual features across the historical dataset.

The accurate technical description is:
> The 23 engineered features are **price-scale invariant, dimensionless ratios, and normalized oscillators** constructed to eliminate absolute currency scale dependence. However, several rolling indicators exhibit **substantial serial persistence and multi-month regime clustering** rather than strict covariance stationarity.

#### 12.2.2 Empirical Feature Autocorrelation (Persistence Audit)
An empirical serial autocorrelation analysis across the 2,720 clean feature rows demonstrates wide variation in persistence:

```
+-------------------------------------------------------------------------+
|                  FEATURE SERIAL PERSISTENCE AUDIT                       |
+----------------------+--------------------+-----------------------------+
| Feature Group        | Feature Name       | Mean Lag-1 Autocorr | Lag-5 |
+----------------------+--------------------+---------------------+-------+
| High Persistence     | ma_spread_50_200   | +0.9997             | +0.994|
| (Regime Tracking)    | ma_spread_20_50    | +0.9968             | +0.930|
|                      | price_to_sma200    | +0.9882             | +0.938|
|                      | atr_pct            | +0.9847             | +0.910|
|                      | bb_bandwidth       | +0.9832             | +0.742|
|                      | volatility_20d     | +0.9705             | +0.842|
|                      | macd_hist_norm     | +0.9670             | +0.555|
|                      | price_to_sma50     | +0.9625             | +0.804|
+----------------------+--------------------+---------------------+-------+
| Moderate Persistence | rsi_14 / rsi_norm  | +0.9213             | +0.643|
| (Oscillators/Returns)| price_to_sma20     | +0.9199             | +0.584|
|                      | bb_percent_b / Z   | +0.8687             | +0.456|
|                      | return_21d         | +0.9474             | +0.731|
|                      | return_5d          | +0.8032             | -0.003|
|                      | rsi_slope_5        | +0.7674             | -0.150|
+----------------------+--------------------+---------------------+-------+
| Low Persistence      | relative_volume_20 | +0.2244             | +0.031|
| (Stationary-like)    | return_1d          | -0.0052             | -0.011|
+----------------------+--------------------+---------------------+-------+
```

**Architectural Confirmation**: Feature formulas will **not** be modified. Tree-based models (XGBoost, Random Forest) split on rank and are robust to non-stationary feature distributions. For linear baseline models, features with extreme unit-root persistence (`ma_spread_50_200`, `price_to_sma200`) will be evaluated alongside first-differenced variants.

---

### 12.3 Purged Validation Architecture: Purge vs. Embargo

#### 12.3.1 Grouping Constraint by Trading Date
All five equities on calendar trading date $t$ must reside in the exact same cross-validation partition. Slicing rows independently per stock would leak cross-sectional market beta across folds.

#### 12.3.2 Operational Distinction: Purge vs. Embargo
1. **Purge (Backward Label Truncation — Strictly Mandatory)**:
   - *Purpose*: Eliminates training (or validation) bars whose forward target return label interval $[t+1, t+h]$ extends into or overlaps with the subsequent partition.
   - *Application*: Discards the final $h$ sample dates from the training partition and from the validation partition.
2. **Embargo (Approved Initial Policy: $E = 0$ Additional Dates)**:
   - *Policy*: For the initial strictly forward-only chronological split ($\text{Train} \to \text{Val} \to \text{Test}$), exactly **zero additional embargo dates ($E = 0$)** are applied.
   - *Rationale*: Feature lookback windows do not automatically require an embargo in this forward-only split. Feature calculations at session $380$ causally use historical prices ($\tau \le 380$), which is authentic to live forward trading. An arbitrary 21-day embargo based only on indicator lookback windows would discard $26\%$ of the 81-day validation set without preventing forward leakage.
   - *Alternative Schemes*: Cross-validation structures where training data follows test data in time (e.g., Combinatorial Purged Cross-Validation / CPCV) strictly mandate an embargo buffer ($E > 0$).

#### 12.3.3 Index-Based Partition Example for All Three Horizons
Given $N = 544$ clean feature sessions (indices $0 \dots 543$):
- **Base Chronological Slices**:
  - Training Window: Indices $0 \dots 379$ (380 sessions, $\sim 70\%$)
  - Validation Window: Indices $380 \dots 460$ (81 sessions, $\sim 15\%$)
  - Test Window: Indices $461 \dots 543$ (83 sessions, $\sim 15\%$)

```
+---------------------------------------------------------------------------------------------------------------------------------------------------+
|                                             EXACT PURGED PARTITION BOUNDARIES ACROSS HORIZONS                                                     |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
| Horizon | Retained Train Set | Last Train Exit  | First Val Entry  | Retained Val Set   | Last Val Exit    | First Test Entry | Retained Test Set |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
| **h=1** | Indices 0 to 378   | Close C(379)     | Open O(381)      | Indices 380 to 459 | Close C(460)     | Open O(462)      | Indices 461 to 542|
|         | (1,895 stock-days) | (End of Train)   | (Session 381)    | (400 stock-days)   | (End of Val)     | (Session 462)    | (410 stock-days)  |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
| **h=3** | Indices 0 to 376   | Close C(379)     | Open O(381)      | Indices 380 to 457 | Close C(460)     | Open O(462)      | Indices 461 to 540|
|         | (1,885 stock-days) | (End of Train)   | (Session 381)    | (390 stock-days)   | (End of Val)     | (Session 462)    | (400 stock-days)  |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
| **h=5** | Indices 0 to 374   | Close C(379)     | Open O(381)      | Indices 380 to 455 | Close C(460)     | Open O(462)      | Indices 461 to 538|
|         | (1,875 stock-days) | (End of Train)   | (Session 381)    | (380 stock-days)   | (End of Val)     | (Session 462)    | (390 stock-days)  |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
```

*Note on Execution Timing & Boundary Alignment*:
- Under the approved primary target $R(t,h) = (C_{t+h} - O_{t+1}) / O_{t+1}$, the first validation sample at index $380$ enters at **$O_{381}$** (not $O_{380}$), because features $X_{380}$ are formed at session $380$ close and trade execution occurs at session $381$ open.
- The last retained training sample ($t = 379 - h$) exits at **$C_{379}$**, which strictly precedes the first validation trade entry ($O_{381}$).
- Similarly, the last retained validation sample ($t = 460 - h$) exits at **$C_{460}$**, strictly preceding the first test trade entry at **$O_{462}$**.
- *Verification Status*: Mathematical boundary reasoning demonstrates zero price overlap across partitions. Implementation-level leakage safety remains pending until automated unit tests execute against the implemented splitter in Phase 5C.2.

---

### 12.4 Autocorrelation Methodology Clarification

#### 12.4.1 Exact Calculation Process
- Autocorrelations reported in Section 5.2 were calculated on **continuous percentage returns** $r_{t+h} = (C_{t+h} - C_t)/C_t \times 100\%$.
- Data was **sorted chronologically ascending by session timestamp and grouped strictly by stock** before calculating autocorrelation. No cross-stock interleaving was performed.
- Autocorrelations were computed using `pandas.Series.autocorr(lag=k)` for $k \in \{1, 2, 3, 4, 5\}$.

#### 12.4.2 Verification on Discrete 3-Class Target Labels
To verify whether serial correlation persists after thresholding into discrete labels ($\{-1, 0, +1\}$), autocorrelations were re-computed on the discrete classes under fixed thresholds:

```
+----------------------------------------------------------------------------------------------------+
|            AUTOCORRELATION COMPARISON: CONTINUOUS RETURNS VS. DISCRETE LABELS                      |
+---------+--------------------+----------------+----------------+-----------------+-----------------+
| Horizon | Target Type        | Lag 1 Autocorr | Lag 2 Autocorr | Lag 3 Autocorr  | Lag 4 Autocorr  |
+---------+--------------------+----------------+----------------+-----------------+-----------------+
| h = 1   | Continuous Return  | -0.036 to +0.03| -0.020 to +0.13| -0.119 to +0.01 | -0.045 to +0.09 |
|         | Discrete Label     | -0.049 to +0.02| -0.033 to +0.09| -0.125 to +0.01 | -0.050 to +0.05 |
+---------+--------------------+----------------+----------------+-----------------+-----------------+
| h = 3   | Continuous Return  | +0.646 to +0.68| +0.311 to +0.39| -0.062 to +0.06 | -0.059 to +0.09 |
|         | Discrete Label     | +0.511 to +0.56| +0.233 to +0.28| -0.082 to +0.02 | -0.087 to +0.04 |
+---------+--------------------+----------------+----------------+-----------------+-----------------+
| h = 5   | Continuous Return  | +0.784 to +0.82| +0.580 to +0.65| +0.363 to +0.45 | +0.140 to +0.26 |
|         | Discrete Label     | +0.628 to +0.68| +0.454 to +0.53| +0.265 to +0.37 | +0.103 to +0.22 |
+---------+--------------------+----------------+----------------+-----------------+-----------------+
```

**Result**: Discrete labels exhibit substantial serial correlation for $h=3$ (Lag 1 $\approx +0.54$) and $h=5$ (Lag 1 $\approx +0.66$, Lag 2 $\approx +0.50$).

#### 12.4.3 Correction Regarding "80% Accuracy" Claim
The phrase suggesting that random splitting "necessarily results in 80% accuracy" is retracted. Random splitting does not guarantee any specific accuracy level; rather, it **violates the assumption of independent and identically distributed (i.i.d.) observations**, causing future trajectory leakage between training and validation folds that invalidates statistical hypothesis testing.

---

### 12.5 Threshold Methodology & Dynamic Scaling Clarification

#### 12.5.1 Status of Fixed Candidate Thresholds (0.50%, 1.00%, 1.50%)
The selection of $\theta \in \{0.50\%, 1.00\%, 1.50\%\}$ for $h \in \{1, 3, 5\}$ represents **empirical, heuristic candidate thresholds** designed to provide practical interpretability and balanced neutral noise filtering.

Under theoretical square-root-of-time scaling ($\theta_h = \theta_1 \times \sqrt{h}$) from a 1-day base of $\theta_1 = 0.50\%$:
- $h=1$: $0.50\% \times \sqrt{1} = 0.500\%$
- $h=3$: $0.50\% \times \sqrt{3} \approx 0.866\%$ (candidate $1.00\%$ is wider)
- $h=5$: $0.50\% \times \sqrt{5} \approx 1.118\%$ (candidate $1.50\%$ is wider)

> [!IMPORTANT]
> The candidate thresholds $\{0.50\%, 1.00\%, 1.50\%\}$ are heuristic candidate values rather than exact mathematical $\sqrt{h}$ scaling. They are retained strictly as **provisional candidate thresholds pending systematic threshold sensitivity testing and validation** in Phase 5C.2. They must not be described as proven optimal thresholds.

#### 12.5.2 Secondary Experiment: Dynamic ATR Threshold Scaling
Dynamic volatility-based thresholding is designated strictly as a **secondary exploratory experiment**, not the approved initial target. In exploratory testing, dynamic thresholds were evaluated as:

$$\theta_{t, h} = 0.5 \times \text{ATR\_pct}_t \times \sqrt{h}$$

This secondary approach stabilized exploratory class balance (UP $\sim 20\%$, NEUTRAL $\sim 56\%$, DOWN $\sim 24\%$), but remains an experimental alternative to the primary candidate threshold schedule.

#### 12.5.3 Status of Transaction Friction (0.15%)
The $0.15\%$ transaction cost figure is explicitly designated as a **working modeling hypothesis**, not an established universal truth. In Indian equity trading, friction comprises:
1. Brokerage (0.00%–0.03% depending on broker).
2. Securities Transaction Tax (STT): 0.10% on delivery trades (both buy and sell), or 0.025% on intraday sell.
3. Exchange Turnover Charges: ~0.00345%.
4. SEBI Turnover Fee & Stamp Duty: ~0.0015%.
5. GST: 18% on brokerage and exchange charges.
6. Effective Bid-Ask Spread & Market Impact: 0.02%–0.08% for mega-caps.

Total friction varies between $0.05\%$ (intraday) and $0.25\%$ (delivery). The $0.15\%$ figure serves as a baseline hurdle for economic viability evaluation in Phase 5E, and must be validated through execution logging.

---

### 12.6 Data Scope and Statistical Limitations

#### 12.6.1 Prototype Feasibility vs. Production Claims
It is formally documented that:
> The current dataset—consisting of **five mega-cap NSE equities over three historical years (743 sessions, November 2023 to November 2026)**—provides a sound foundation for **controlled prototype development, pipeline debugging, baseline model training, and explainability verification**. It is **strictly insufficient** to support production-wide alpha claims, generalized equity predictions, or live capital allocation.

#### 12.6.2 Key Constraints Requiring Future Expansion
1. **Low Effective Asset Dimensionality**: TCS and INFY exhibit $r = 0.753$; HDFCBANK and ICICIBANK exhibit $r = 0.531$. The 5 assets represent effectively $\sim 2.5$ independent statistical factors.
2. **Single Regime Dominance**: The November 2023 – November 2026 sample period is largely characterized by an Indian equity bull market. Models trained solely on this window will not be calibrated for sustained bear markets or stagflationary regimes.
3. **Sector Exclusion**: High-volatility small-caps, mid-caps, pharmaceuticals, FMCG, infrastructure, and commodities are entirely absent.
4. **Prerequisites for Production Claims**:
   - Expansion to the full NIFTY 50 or NIFTY 100 universe.
   - Incorporation of NIFTY 50 and India VIX benchmark features.
   - 7–10 years of historical data covering the 2020 crash and 2022 rate hike cycles.
   - Explicit tracking of quarterly corporate earnings dates and board meetings.
