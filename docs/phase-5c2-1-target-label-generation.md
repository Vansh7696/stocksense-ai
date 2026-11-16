# StockSense AI — Phase 5C.2.1: Executable Target-Label Generation Report

**Document Reference**: `docs/phase-5c2-1-target-label-generation.md`<br>
**Phase**: Phase 5C.2.1 — ML Data-Engineering Milestone<br>
**Branch**: `feature/phase-5c-ml-training`<br>
**Date**: November 12, 2026<br>
**Status**: **IMPLEMENTED & VERIFIED — READY FOR ARCHITECTURAL REVIEW**

---

## 1. Executive Summary & Objective

In quantitative financial machine learning, predicting theoretical Close-to-Close returns ($r_{t+h}^{\text{c2c}} = (C_{t+h} - C_t) / C_t$) introduces catastrophic look-ahead bias because predictions generated after market close cannot retroactively execute at that day's closing price. Furthermore, overnight opening price gaps distort short-horizon returns, causing more than $26.9\%$ of 1-day direction labels to invert between theoretical and real-world execution.

**Phase 5C.2.1** implements a production-grade, mathematically pure data-engineering pipeline in the Python ML microservice that:
1. Formulates **executable forward returns** using the next trading session's opening price ($O_{t+1}$) as the entry proxy and horizon close ($C_{t+h}$) as the exit proxy across 1, 3, and 5 trading-day horizons.
2. Implements a centralized, empirical 3-class target labeling schedule (`DOWN`, `NEUTRAL`, `UP`).
3. Uses pure sequential trading-session indices rather than calendar-day arithmetic, seamlessly supporting special weekend sessions (e.g. Saturday Budget sessions and Sunday Diwali Muhurat sessions).
4. Strictly isolates each stock and exchange listing (guaranteeing NSE and BSE series never cross-contaminate).
5. Enforces zero look-ahead bias: future prices are confined strictly to target labeling and never pollute the Phase 5B feature matrix.
6. Records comprehensive audit exclusions for missing, invalid, or boundary observations.

This milestone is strictly restricted to data engineering; no machine learning models were trained, tuned, or backtested.

---

## 2. Approved Executable Target-Return Mathematical Formulation

### 2.1 The Prediction & Execution Timeline

The prediction and execution cycle follows the actual operational workflow of Indian equity markets (NSE / BSE):

```
Session t Close (15:30 IST)     ML Compute Window (16:30 - 18:00 IST)     Session t+1 Open (09:15 IST)     Session t+h Close (15:30 IST)
+-------------------------------+-----------------------------------------+--------------------------------+------------------------------+
| Session t ends; Ct settles    | Indicators & 23 features computed       | Next trading session enters    | Target position squares off  |
| Features Xt use data <= t     | Predictions published                   | Position enters at Ot+1 proxy  | Position exits at Ct+h proxy |
+-------------------------------+-----------------------------------------+--------------------------------+------------------------------+
```

### 2.2 Mathematical Formulas

#### Primary Production Target (Executable Open-to-Close Return):

$$R(t, h) = \left( \frac{C_{t+h} - O_{t+1}}{O_{t+1}} \right) \times 100\% \quad \text{for } h \in \{1, 3, 5\}$$

Where:
- $t$: Sequential index of the signal trading session.
- $O_{t+1}$: Opening auction clearing price of the next trading session (entry proxy).
- $C_{t+h}$: Closing settlement price of trading session $t+h$ (exit proxy).
- $h$: Prediction horizon in trading sessions ($1$, $3$, or $5$).
- $R(t, h)$: Executable percentage return.

#### Academic Benchmark Mode (Close-to-Close Return):

$$R_{\text{c2c}}(t, h) = \left( \frac{C_{t+h} - C_t}{C_t} \right) \times 100\% \quad \text{for } h \in \{1, 3, 5\}$$

Where:
- $C_t$: Closing price of session $t$ (theoretical instantaneous entry).
- Retained exclusively for academic baseline comparisons against legacy quantitative literature.

---

## 3. Centralized Target Thresholds & Classification Rules

### 3.1 Initial Empirical Research Thresholds

Threshold configuration is centralized in `ml-service/app/config.py` (`TargetSettings`) and referenced by `TargetThresholdConfig` in `ml-service/app/schemas/targets.py`. Hardcoded thresholds are not duplicated across the codebase.

| Horizon ($h$) | Holding Span | Negative Threshold ($-\theta_h$) | Positive Threshold ($+\theta_h$) | Neutral Buffer Width | DOWN Class ($< -\theta_h$) | NEUTRAL Class ($[-\theta_h, +\theta_h]$) | UP Class ($> +\theta_h$) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **$h = 1$** | 1 session | $-0.50\%$ | $+0.50\%$ | $1.00\%$ span | Return $< -0.50\%$ | $-0.50\% \le \text{Return} \le +0.50\%$ | Return $> +0.50\%$ |
| **$h = 3$** | 3 sessions | $-1.00\%$ | $+1.00\%$ | $2.00\%$ span | Return $< -1.00\%$ | $-1.00\% \le \text{Return} \le +1.00\%$ | Return $> +1.00\%$ |
| **$h = 5$** | 5 sessions | $-1.50\%$ | $+1.50\%$ | $3.00\%$ span | Return $< -1.50\%$ | $-1.50\% \le \text{Return} \le +1.50\%$ | Return $> +1.50\%$ |

### 3.2 Classification Boundary Conditions

The classification function `classify_target(return_pct, horizon, thresholds)` enforces exact mathematical boundaries:
- **`DOWN` (Label `-1`)**: Return is **strictly less than** the negative threshold ($R < -\theta_h$).
- **`NEUTRAL` (Label `0`)**: Return is **greater than or equal to** $-\theta_h$ **AND less than or equal to** $+\theta_h$ ($-\theta_h \le R \le +\theta_h$). The exact boundaries $-\theta_h$ and $+\theta_h$ belong to `NEUTRAL`.
- **`UP` (Label `+1`)**: Return is **strictly greater than** the positive threshold ($R > +\theta_h$).

> [!NOTE]
> **Heuristic Research Thresholds**: As established in Phase 5C.1, these symmetric round thresholds $\{0.50\%, 1.00\%, 1.50\%\}$ are empirical, heuristic research targets designed to provide wide neutral noise buffers. They are not optimized or guaranteed profitable trading rules.

---

## 4. Sequential Session-Indexing Strategy

### 4.1 Rejection of Calendar-Day Arithmetic

A core principle of this implementation is that **calendar-day arithmetic is strictly forbidden**:
- Financial markets do not trade continuously across calendar days.
- Adding calendar days (`signal_date + timedelta(days=1)`) breaks across weekends, national holidays, and irregular exchange trading calendars.
- In our sequential engine, if session $t$ is Friday, session $t+1$ is Monday (or Saturday if a special session occurred).

### 4.2 Special Trading Sessions in the Dataset

The 3-year historical dataset across the five approved NSE equities contains verified special trading sessions that are treated as authentic individual trading sessions:
1. **Clean Index 106 (`2025-02-01`)**: Union Budget 2025 Saturday special session.
2. **Clean Index 352 (`2026-02-01`)**: Union Budget 2026 Sunday special session.
3. **Clean Index 542 (`2026-11-08`)**: Diwali Muhurat Trading 2026 Sunday evening session.

Because the engine indexes purely by sequential session indices $[0, 1, \dots, N-1]$, these special sessions are handled naturally:
- If Friday close is session $t$, the Saturday Budget session is session $t+1$ (entry proxy).
- Monday's session is session $t+2$.

---

## 5. Data Validity & Missing-Data Handling Protocol

### 5.1 Strict Data Engineering Safeguards & Fail-Closed Session Verification

In accordance with Phase 5C data quality standards:
1. **Mandatory Calendar Verification**: The public target generation API (`POST /api/targets/generate`) and service require an explicitly verified `expected_sessions` calendar. When omitted, the system **fails closed** with an HTTP 422 Unprocessable Content error (or `ValueError` in Python), preventing silent row compression and bridging of missing sessions. A documented low-level internal mode (`allow_unverified_session_sequence: bool = False`) exists solely for isolated unit tests and cannot be triggered from the public API.
2. **Intermediate Trading Session Continuity**: For horizons $h > 1$, every intermediate session between signal $t$, entry $t+1$, and exit $t+h$ is checked against the verified exchange calendar in strict chronological order. If an intermediate trading session is missing, it is caught immediately and recorded as `MISSING_INTERMEDIATE_TRADING_SESSION`.
3. **Comprehensive OHLCV Geometry & Integrity Validation**:
   - Required fields: `["timestamp", "open", "high", "low", "close", "volume"]`.
   - Rejection of null, NaN, infinite, or non-numeric values.
   - Strictly positive price checks: `open > 0`, `high > 0`, `low > 0`, `close > 0`.
   - Non-negative volume check: `volume >= 0`.
   - Complete bar geometry: `high >= low`, `high >= open`, `high >= close`, `low <= open`, and `low <= close`.
   - All intermediate bars across $[t+1, t+h]$ are subjected to these same geometric constraints; any intermediate corruption aborts target generation for that horizon.
4. **No Candle Fabrication**: The engine never fabricates, interpolates, or synthesizes missing candles.
5. **No Silent Bridging**: Missing intermediate trading sessions are never bridged or ignored.
6. **No Candle Substitution**: A later available candle is never substituted for a missing required session.
7. **Exchange Separation**: NSE and BSE price series are never mixed or combined.
8. **No Silent Discards**: Every unlabelable observation generates an explicit `TargetExclusion` record detailing the reason and context.
9. **Provenance Tracking**: Stock symbol, stock ID, exchange ID, and session indices are preserved across all records.
10. **Deterministic Reproducibility**: Repeated execution on identical input produces identical outputs.

### 5.2 Handled Edge Cases & Audit Exclusion Reasons

| Failure Mode / Edge Case | Handled Behavior | Exclusion Reason Code |
| :--- | :--- | :--- |
| **Missing Session Calendar** | Request lacks verified calendar (fail-closed) | `ValueError` / HTTP 422 Validation Error |
| **Series End Truncation ($t+1 \ge N$)** | Cannot evaluate entry session | `MISSING_ENTRY_CANDLE` |
| **Horizon End Truncation ($t+h \ge N$)** | Cannot evaluate exit session | `MISSING_EXIT_CANDLE` |
| **Missing Entry Session** | Session $t+1$ absent from exchange calendar or candles | `MISSING_ENTRY_TRADING_SESSION` |
| **Missing Intermediate Session** | Intermediate trading day absent between $t+1$ and $t+h$ | `MISSING_INTERMEDIATE_TRADING_SESSION` |
| **Missing Exit Session** | Session $t+h$ absent from exchange calendar or candles | `MISSING_EXIT_TRADING_SESSION` |
| **Signal Date Unmatched** | Signal session timestamp not found in expected calendar | `SIGNAL_DATE_NOT_IN_EXPECTED_CALENDAR` |
| **Non-Positive Entry Price** | $O_{t+1} \le 0$ (prevents division by zero) | `NON_POSITIVE_OR_INVALID_ENTRY_PRICE` |
| **Non-Positive Exit Price** | $C_{t+h} \le 0$ | `NON_POSITIVE_OR_INVALID_EXIT_PRICE` |
| **Negative Volume** | Bar volume is strictly negative ($V < 0$) | `NEGATIVE_VOLUME` |
| **Missing Volume Column** | Input dataset missing required `volume` column | `MISSING_REQUIRED_VOLUME_COLUMN` |
| **NaN / Infinite Prices** | Bar contains `NaN` or `Inf` floating point values | `NAN_OHLCV_VALUE` / `INFINITE_OHLCV_VALUE` |
| **Inverted Bar ($H < L$)** | High price is strictly less than Low price | `INVALID_BAR_HIGH_LT_LOW` |
| **High < Open Bar ($H < O$)** | High price is strictly less than Open price | `INVALID_BAR_HIGH_LT_OPEN` |
| **High < Close Bar ($H < C$)** | High price is strictly less than Close price | `INVALID_BAR_HIGH_LT_CLOSE` |
| **Low > Open Bar ($L > O$)** | Low price is strictly greater than Open price | `INVALID_BAR_LOW_GT_OPEN` |
| **Low > Close Bar ($L > C$)** | Low price is strictly greater than Close price | `INVALID_BAR_LOW_GT_CLOSE` |
| **Corrupt Intermediate Bar** | Intermediate bar violates price positivity or geometry | `INVALID_INTERMEDIATE_SESSION_PRICES` |
| **Malformed Candle Timestamp** | Timestamp is unparseable or violates ISO format | `INVALID_TIMESTAMP_FORMAT` |
| **Duplicate Timestamps** | Multiple bars for identical timestamp | `DEDUPLICATED_TIMESTAMP_KEEP_LAST` |
| **Out-of-Order Timestamps** | Chronological ordering violation | Automatically sorted ascending before indexing |

### 5.3 Strict Expected-Session Calendar Structural Validation Contract

To guarantee that invalid or ambiguous calendar sequences never corrupt session indexing:
1. **Strict Format Validation**: Each session date string must strictly match the ISO `YYYY-MM-DD` regex (`^\d{4}-\d{2}-\d{2}$`). Formats such as `YYYY/MM/DD`, `DD-MM-YYYY`, `YYYY-M-D`, or full ISO timestamps (`YYYY-MM-DDTHH:MM:SSZ`) are rejected.
2. **Calendar Date Realism**: Every date is parsed through `datetime.strptime(item, "%Y-%m-%d")` to reject impossible dates (e.g. `2025-02-31`, `2025-13-40`).
3. **No Duplicates**: Duplicate session dates are detected and rejected with a descriptive error specifying the offending duplicate date and index.
4. **Strict Ascending Order**: Dates must be in strictly ascending chronological order ($D_{i} > D_{i-1}$). Any equal or descending sequence is rejected.
5. **No Whitespace or Nulls**: Empty strings, whitespace-only strings, and strings with leading/trailing whitespace are rejected.
6. **Double-Layer Enforcement**: This validation is executed both at the public API boundary via Pydantic v2 `@field_validator` on `TargetGenerateRequest` (returning HTTP 422 Unprocessable Content) and internally within `TargetService.generate()` and `TargetService._build_session_index_map()` (raising `ValueError`).

### 5.4 Explicit Timestamp & Timezone Normalization Policy

Indian equity markets trade in the `Asia/Kolkata` timezone (UTC+05:30). Candle timestamps ingested from diverse sources (Bhavcopy, broker APIs, database records) may arrive in various representations:
1. **Canonical Representation**: Every candle timestamp is mapped to an exchange-local session date string in `Asia/Kolkata` (`YYYY-MM-DD`) and an `Asia/Kolkata` timezone-aware `datetime` object (`_sort_dt`) used for chronological ordering.
2. **Timezone Conversion**: Offset-aware and UTC timestamps are converted to `Asia/Kolkata` before extracting the trading session date:
   - Equivalent UTC morning (`2026-11-09T03:45:00Z`) and IST (`2026-11-09T09:15:00+05:30`) timestamps resolve to the exact same Indian market session date (`2026-11-09`).
   - Late UTC timestamps that correspond to midnight or next morning in India (e.g., `2026-11-08T18:30:00Z`, which is `2026-11-09 00:00:00 IST`) correctly cross the day boundary and resolve to `2026-11-09`.
   - UTC timestamps before the boundary (e.g., `2026-11-08T18:29:59Z`, which is `2026-11-08 23:59:59 IST`) resolve to `2026-11-08`.
   - Negative offset timestamps (e.g. US Eastern `2026-11-08T22:45:00-05:00`) convert to UTC `03:45:00` and IST `09:15:00` on `2026-11-09`.
3. **Naive Timestamps**: Naive timestamps without timezone information are localized directly to `Asia/Kolkata` per historical market convention (not silently assumed to be UTC).
4. **Date-Only Strings**: Plain `YYYY-MM-DD` strings are interpreted directly as local exchange session dates in `Asia/Kolkata` at midnight.
5. **Chronological Sorting by True Instant**: Candle records are sorted chronologically by their true UTC instant (`_sort_dt`), preventing incorrect string-based sorting when timestamps mix `Z`, `+05:30`, or date-only notations.
6. **Malformed Timestamp Exclusions**: Unparseable or malformed timestamps are not silently truncated or coerced; they are excluded with structured `INVALID_TIMESTAMP_FORMAT` audit records preserving the raw string and specific parsing error.

### 5.5 Critical Limitation: Authoritative Calendar Provenance Requirement

> [!WARNING]
> **Independent Calendar Provenance Required**:
> Missing trading sessions can **only** be detected if the absent session exists in the `expected_sessions` calendar. If an expected trading session is omitted from **both** the candle data and the `expected_sessions` list, the engine cannot infer its absence and will treat the remaining sessions as consecutive.
>
> Therefore, the `expected_sessions` calendar must always be sourced from an authoritative, independent exchange trading calendar (e.g., official NSE/BSE holiday schedules, `backend/src/utils/tradingCalendar.js`, or the verified 544-session reference calendar) and **never** derived solely from the timestamps present within the candle dataset being evaluated.

---

## 6. Output Schemas & Data Contracts

### 6.1 `TargetGenerateRequest` Schema

The target generation endpoint (`POST /api/targets/generate`) enforces verified session calendars and strict schema contracts:

```python
class TargetGenerateRequest(BaseModel):
    candles: List[CandleData]                                  # Input OHLCV candle records
    stock_symbol: Optional[str] = None                         # Ticker identifier (e.g. 'RELIANCE')
    stock_id: Optional[str] = None                             # Stock UUID
    exchange_id: Optional[str] = None                          # Exchange ID (e.g. 'NSE', 'BSE')
    target_type: TargetType = TargetType.OPEN_TO_CLOSE         # Target formulation (default: open_to_close)
    horizons: List[int] = Field(default=[1, 3, 5])             # Evaluation horizons
    expected_sessions: Optional[List[str]] = Field(            # Verified exchange calendar (MANDATORY in API)
        default=None,
        description="Explicit sequence of expected trading session dates ('YYYY-MM-DD'). Fails closed if missing."
    )
    validate_intermediate: bool = True                         # Enforce intermediate bar validity
```

> [!IMPORTANT]
> **API Fail-Closed Policy**: If `expected_sessions` is `None` or empty in `TargetGenerateRequest`, the endpoint immediately aborts with HTTP 422 Unprocessable Content (`"expected_sessions calendar is mandatory for target generation"`). The low-level internal test parameter `allow_unverified_session_sequence` cannot be toggled via the public API.

### 6.2 `TargetRecord` Schema

Every valid signal and supported horizon produces a structured `TargetRecord`:

```python
class TargetRecord(BaseModel):
    stock_id: Optional[str]              # Unique stock UUID
    exchange_id: Optional[str]           # Exchange code (e.g. 'NSE', 'BSE')
    stock_symbol: str                    # Equity ticker (e.g. 'RELIANCE')
    signal_session_index: int            # Integer index t of signal session
    signal_date: str                     # Date string of signal session t close
    entry_session_index: int             # Integer index of entry session (t+1)
    entry_date: str                      # Date string of entry session
    entry_open_price: float              # Opening price proxy O[t+1]
    prediction_horizon: int              # Forward horizon h in trading sessions (1, 3, 5)
    exit_session_index: int              # Integer index of exit session (t+h)
    exit_date: str                       # Date string of exit session
    exit_close_price: float              # Closing price proxy C[t+h]
    executable_return_pct: float         # Percentage return ((C[t+h] - O[t+1]) / O[t+1]) * 100
    target_class: TargetClass            # Categorical class: DOWN, NEUTRAL, UP
    target_label: int                    # Integer class: -1, 0, +1
```

### 6.3 `TargetExclusion` Schema

```python
class TargetExclusion(BaseModel):
    stock_symbol: str                    # Equity ticker
    signal_session_index: int            # Session index t
    signal_date: str                     # Session date
    prediction_horizon: int              # Horizon h that could not be evaluated
    reason: str                          # Machine-readable error code
    details: Optional[Dict[str, Any]]    # Diagnostic parameters
```

---

## 7. Multi-Stock & Multi-Exchange Strict Isolation

To prevent cross-sectional leakage:
1. `TargetService.generate_multi_stock(candles_data)` partitions inputs into groups keyed deterministically by `(stock_symbol, exchange_id, stock_id)`.
2. Each group is sorted and evaluated in complete isolation.
3. Reliance on BSE (symbol `500325` or `RELIANCE` on BSE) is completely segregated from Reliance on NSE.
4. Intermediate sessions and session index counters never bleed across stocks.
5. **Exchange-Specific Calendar Isolation**:
   - When pooled candle datasets span multiple distinct exchanges (e.g. NSE and BSE), `generate_multi_stock` strictly forbids using a single flat `expected_sessions` calendar sequence, raising an explicit `ValueError` unless an exchange-specific mapping dictionary is provided (e.g., `expected_sessions={'NSE': [...], 'BSE': [...]}`).
   - BSE-specific trading sessions or idiosyncratic holidays can never influence NSE session indexing or continuity verification.

---

## 8. Leakage Prevention Evidence

This milestone generates target labels only. To guarantee zero look-ahead bias:
1. **Feature Separation**: The Phase 5B feature matrix extracted via `FeatureEngineeringPipeline.extract_features` does not contain future entry prices ($O_{t+1}$), future exit prices ($C_{t+h}$), returns ($R(t, h)$), or target classes.
2. **Mathematical Causality Test**: In `TestLeakageProtection.test_mutating_future_prices_leaves_past_features_unaltered`, all prices from session index 30 onward were multiplied by $10\times$. The engineered features for all sessions $t \le 29$ remained 100% bit-for-bit identical ($r = 1.000000000$).
3. **Temporal Alignment**: Signal features $X_t$ and targets $Y_{t, h}$ are paired strictly by signal session index $t$ and date $D_t$, preserving clean boundaries for subsequent chronological splitting.

---

## 9. Empirical Validation on 5-Stock Historical Dataset

Running the `TargetService` against the historical 3-year dataset (`scratch/five_stocks_candles.json`, 743 candles per stock, 3,715 total candles) and filtering for the **544 clean feature trading dates** (indices 199 to 742, following the 200-period indicator warm-up) yields the following empirical metrics:

```
+---------------------------------------------------------------------------------------------------------------+
|                      POOLED CLEAN EXECUTABLE TARGET DISTRIBUTION (5 EQUITIES, 544 CLEAN DATES)                |
+---------+-------------------+--------------------+--------------------+--------------------+------------------+
| Horizon | Pre-Purge Samples | Class 0 (NEUTRAL)  | Class -1 (DOWN)    | Class +1 (UP)      | Total Labeled    |
+---------+-------------------+--------------------+--------------------+--------------------+------------------+
| h = 1   | 543 dates x 5     | 1,023 obs. (37.7%) |   895 obs. (33.0%) |   797 obs. (29.4%) | 2,715 stock-days |
| h = 3   | 541 dates x 5     | 1,046 obs. (38.7%) |   892 obs. (33.0%) |   767 obs. (28.4%) | 2,705 stock-days |
| h = 5   | 539 dates x 5     | 1,161 obs. (43.1%) |   839 obs. (31.1%) |   695 obs. (25.8%) | 2,695 stock-days |
+---------+-------------------+--------------------+--------------------+--------------------+------------------+
| TOTAL   |                   | 3,230 obs. (39.8%) | 2,626 obs. (32.4%) | 2,259 obs. (27.8%) | 8,115 targets    |
+---------+-------------------+--------------------+--------------------+--------------------+------------------+
```

### Resolution of Phase 5C.1 Addendum Unverified Figures:
The candidate class distribution counts marked as unverified in Section 6.2 of `docs/phase-5c1-ml-clarification-addendum.md` are now replaced and validated with these exact, deterministically reproduced numbers:
- $h=1$: `NEUTRAL` 1,023 (37.7%), `DOWN` 895 (33.0%), `UP` 797 (29.4%). Total = 2,715.
- $h=3$: `NEUTRAL` 1,046 (38.7%), `DOWN` 892 (33.0%), `UP` 767 (28.4%). Total = 2,705.
- $h=5$: `NEUTRAL` 1,161 (43.1%), `DOWN` 839 (31.1%), `UP` 695 (25.8%). Total = 2,695.

---

## 10. Automated Test Suite & Verification Results

### 10.1 Test Coverage Summary

A dedicated test suite `ml-service/tests/test_targets.py` was created, implementing **60 comprehensive automated tests** across 12 test classes:

1. **Return Calculations (`TestReturnCalculations`, 7 tests)**:
   - `test_pure_function_executable_return_formula`
   - `test_pure_function_zero_return`
   - `test_pure_function_negative_return`
   - `test_pure_function_close_to_close_return`
   - `test_horizon_1_executable_calculation`
   - `test_horizon_3_executable_calculation`
   - `test_horizon_5_executable_calculation`

2. **Classification Boundaries (`TestClassificationBoundaries`, 5 tests)**:
   - `test_horizon_1_boundary_conditions` (exact $-0.50\%$, $-0.50001\%$, $+0.50\%$, $+0.50001\%$)
   - `test_horizon_3_boundary_conditions` (exact $-1.00\%$, $-1.0001\%$, $+1.00\%$, $+1.0001\%$)
   - `test_horizon_5_boundary_conditions` (exact $-1.50\%$, $-1.5001\%$, $+1.50\%$, $+1.5001\%$)
   - `test_unsupported_horizon_raises_error`
   - `test_invalid_return_value_raises_error`

3. **Missing and Invalid Data Handling (`TestMissingAndInvalidData`, 8 tests)**:
   - `test_missing_entry_candle_at_series_end`
   - `test_missing_exit_candle_at_horizon_boundary`
   - `test_zero_entry_price_excluded`
   - `test_negative_price_excluded`
   - `test_nan_price_excluded`
   - `test_infinite_price_excluded`
   - `test_duplicate_timestamps_deduplicated_with_audit`
   - `test_out_of_order_timestamps_sorted_chronologically`

4. **Missing Trading Session Detection (`TestMissingTradingSessionDetection`, 6 tests)**:
   - `test_fail_closed_when_expected_sessions_missing_in_service`: Service raises `ValueError` if `expected_sessions` is omitted without testing override.
   - `test_api_request_without_expected_sessions_fails_closed`: API returns HTTP 422 Unprocessable Content when calendar is omitted.
   - `test_missing_intermediate_wednesday_detected`: Catches missing Wednesday between Tuesday entry and Thursday exit.
   - `test_missing_intermediate_session_for_h3_and_h5`: Excludes missing intermediate sessions with `MISSING_INTERMEDIATE_TRADING_SESSION`.
   - `test_weekend_budget_and_muhurat_sessions_in_expected_calendar`: Special weekend sessions cleanly supported when in calendar.
   - `test_market_holidays_excluded_from_expected_sessions`: Legitimate holidays absent from calendar pass smoothly without exclusion.

5. **Comprehensive OHLCV Validation (`TestComprehensiveOHLCVValidation`, 8 tests)**:
   - `test_negative_volume_rejected` (`NEGATIVE_VOLUME`)
   - `test_missing_volume_column_rejected` (`MISSING_REQUIRED_VOLUME_COLUMN`)
   - `test_high_lower_than_open_rejected` (`INVALID_BAR_HIGH_LT_OPEN`)
   - `test_high_lower_than_close_rejected` (`INVALID_BAR_HIGH_LT_CLOSE`)
   - `test_low_higher_than_open_rejected` (`INVALID_BAR_LOW_GT_OPEN`)
   - `test_low_higher_than_close_rejected` (`INVALID_BAR_LOW_GT_CLOSE`)
   - `test_intermediate_candle_geometry_failure_aborts_horizon`: Corrupt intermediate bar aborts horizon target generation.
   - `test_existing_valid_candles_continue_to_pass`: Valid candles pass geometry checks with 0 false exclusions.

6. **Isolation and Reproducibility (`TestIsolationAndReproducibility`, 3 tests)**:
   - `test_nse_and_bse_isolation_same_symbol` (RELIANCE NSE vs BSE)
   - `test_multi_stock_independence` (TCS and INFY isolated)
   - `test_deterministic_reproducibility` (Bit-for-bit identical repeated execution)

7. **Leakage Protection (`TestLeakageProtection`, 3 tests)**:
   - `test_feature_matrix_never_contains_future_prices`
   - `test_mutating_future_prices_leaves_past_features_unaltered`
   - `test_functional_generate_targets_interface`

8. **FastAPI Endpoints (`TestTargetsAPIEndpoint`, 2 tests)**:
   - `test_post_targets_generate_success_with_expected_sessions`
   - `test_post_targets_generate_insufficient_candles`

9. **Historical Dataset Regression (`TestHistoricalDatasetRegression`, 1 test)**:
   - `test_historical_8115_targets_reproduced_with_verified_calendar`: Reproduces exactly 8,115 targets and 45 exclusions across 5 equities.

10. **Strict Calendar Validation (`TestStrictCalendarValidation`, 7 tests)**:
    - `test_reject_duplicate_dates_service_and_api`: Fails closed on duplicate dates in both service (`ValueError`) and API (HTTP 422).
    - `test_reject_unsorted_dates_service_and_api`: Rejects unsorted or non-chronological sequences in service and API.
    - `test_reject_invalid_date_formats_service_and_api`: Rejects non-ISO formats (`YYYY/MM/DD`, `DD-MM-YYYY`, `YYYY-M-D`).
    - `test_reject_impossible_calendar_dates_service_and_api`: Rejects impossible calendar dates (e.g. `2025-02-31`, `2025-13-01`).
    - `test_reject_empty_or_whitespace_strings_service_and_api`: Rejects empty strings, whitespace strings, and padded strings.
    - `test_reject_empty_calendar_list_service_and_api`: Rejects empty calendar list input (`[]`).
    - `test_reject_non_string_entries_service_and_api`: Rejects non-string types in calendar list.

11. **Timestamp & Timezone Policy (`TestTimestampAndTimezonePolicy`, 7 tests)**:
    - `test_normalize_equivalent_instants`: Confirms equivalent UTC (`03:45Z`) and IST (`09:15+05:30`) map to identical date (`2026-11-09`).
    - `test_normalize_late_utc_instant_crosses_day_boundary`: Late UTC instant (`18:30Z`) properly resolves to next day (`2026-11-09 IST`).
    - `test_normalize_negative_offset`: Negative offset instants (`22:45-05:00`) properly convert to next-day IST session.
    - `test_normalize_naive_timestamp`: Naive timestamps localized to `Asia/Kolkata`.
    - `test_normalize_date_only_string`: Plain `YYYY-MM-DD` strings preserved as session dates.
    - `test_malformed_timestamp_generates_exclusion`: Malformed timestamps produce `INVALID_TIMESTAMP_FORMAT` exclusion records.
    - `test_mixed_timestamp_format_chronological_sorting`: True instant sorting prevents corruption when sorting mixed ISO notations.

12. **Exchange Calendar Isolation (`TestExchangeCalendarIsolation`, 3 tests)**:
    - `test_multi_exchange_flat_calendar_rejected`: Multi-exchange datasets with a flat list calendar are rejected with `ValueError`.
    - `test_multi_exchange_separate_calendars_isolated`: Multi-exchange datasets with dictionary mapping (`{'NSE': [...], 'BSE': [...]}`) processed in complete isolation.
    - `test_bse_calendar_does_not_affect_nse_indices`: Verifies BSE trading schedule anomalies cannot corrupt NSE session indices.

### 10.2 Test Execution Results

```bash
./ml-service/.venv/bin/pytest ml-service/tests
```
**Results:** `89 passed, 3 warnings in 6.47s` (100% pass rate across entire ML service suite, 60/60 target tests passing).

---

## 11. Known Limitations & Regulatory Disclaimers

1. **Authoritative Calendar Provenance Limitation**: As noted in Section 5.5, missing trading sessions can only be detected if present in `expected_sessions`. If a session is absent from both candles and the calendar, the engine treats the sequence as continuous. The expected calendar must originate from an authoritative exchange source.
2. **Historical Execution Proxies**: Historical $O_{t+1}$ and $C_{t+h}$ prices are analytical proxies based on recorded daily Bhavcopy clearing prices. They do not represent guaranteed fills for live market orders, which are subject to order book depth, opening volatility, and broker dispatch latency.
3. **Phase 5A Unadjusted Historical Data**: As documented in the Phase 5A audit, historical prices reflect nominal traded prices unadjusted for dividends, stock splits, or bonus issues.
4. **Execution Frictions Omitted**: Target percentage returns do not incorporate brokerage charges, statutory levies (STT, GST, SEBI turnover fees, stamp duty), bid-ask half-spread crossing costs, or execution slippage. These frictions must be introduced in subsequent backtesting (Phase 6).
5. **DOWN Prediction Interpretation**: A `DOWN` prediction does not constitute an instruction for overnight naked short-selling in the cash segment (which is prohibited under Indian T+1 rolling settlement). It represents an exposure-reduction or risk-mitigation signal in cash equities, an intraday short-bias signal ($h=1$ with mandatory same-day square-off), or an input for exchange-traded derivatives (F&O) or Securities Lending and Borrowing (SLB) arrangements.
6. **Research Only**: These labels are algorithmic target definitions for statistical model training and research, not financial advice or actionable trading recommendations.
3. **Execution Frictions Omitted**: Target percentage returns do not incorporate brokerage charges, statutory levies (STT, GST, SEBI turnover fees, stamp duty), bid-ask half-spread crossing costs, or execution slippage. These frictions must be introduced in subsequent backtesting (Phase 6).
4. **DOWN Prediction Interpretation**: A `DOWN` prediction does not constitute an instruction for overnight naked short-selling in the cash segment (which is prohibited under Indian T+1 rolling settlement). It represents an exposure-reduction or risk-mitigation signal in cash equities, an intraday short-bias signal ($h=1$ with mandatory same-day square-off), or an input for exchange-traded derivatives (F&O) or Securities Lending and Borrowing (SLB) arrangements.
5. **Research Only**: These labels are algorithmic target definitions for statistical model training and research, not financial advice or actionable trading recommendations.
