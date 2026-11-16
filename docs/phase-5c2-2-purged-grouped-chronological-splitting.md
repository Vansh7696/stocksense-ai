# StockSense AI — Phase 5C.2.2: Purged Grouped Chronological Splitting Report

**Document Reference**: `docs/phase-5c2-2-purged-grouped-chronological-splitting.md`<br>
**Phase**: Phase 5C.2.2 — Purged Grouped Chronological Splitting<br>
**Branch**: `feature/phase-5c-ml-training`<br>
**Date**: November 13, 2026<br>
**Status**: **IMPLEMENTED & VERIFIED — READY FOR ARCHITECTURAL REVIEW**

---

## 1. Executive Summary & Objective

In quantitative financial machine learning, standard random cross-validation ($k$-fold) or unpurged chronological splitting introduces catastrophic look-ahead bias and cross-sectional leakage. Forward-looking target labels computed near partition boundaries reference future price bars from subsequent evaluation folds, leading to severely inflated out-of-sample performance metrics.

**Phase 5C.2.2** implements a mathematically proven, leakage-free data-engineering pipeline for **Purged Grouped Chronological Splitting** in the Python ML microservice:
1. **Nominal Partition Allocation**: Partitions the 544 clean trading dates into $70\%$ Train (380 dates, Sep 2, 2024 to Mar 11, 2026), $15\%$ Validation (81 dates, Mar 12, 2026 to Jul 13, 2026), and $15\%$ Held-Out Test (83 dates, Jul 14, 2026 to Nov 9, 2026).
2. **Cross-Sectional Group Integrity**: Partitions strictly by calendar date groups. All five equities (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`) on any single trading date belong to the identical partition, eliminating cross-asset contemporaneous regime leakage.
3. **Horizon-Specific Boundary Purging**: For each horizon $h \in \{1, 3, 5\}$, purges exactly the final $h$ sample dates of Train and Validation partitions, guaranteeing that no training target references validation prices, and no validation target references test prices.
4. **Feature-Target Join Integrity**: Enforces strict 1-to-1 joins on `(stock_symbol, session_date)`, rejects duplicate keys, and explicitly strips all target labels, future prices, entry prices, and exit prices from the feature matrix $X$.
5. **Strict Scaler Quarantine**: Implements a scikit-learn-compatible `StandardScaler` that fits strictly on retained $X_{\text{train}}$ using population standard deviation ($\text{ddof}=0$), safely handles zero-variance features ($\text{scale}\_ = 1.0$), and is frozen to never refit or update on validation or test observations.
6. **Purge Accounting Isolation**: Keeps target-generation exclusions completely separate from split-boundary purges, preventing double counting.
7. **Zero Model Training**: Restricted strictly to data engineering; no ML models were trained, tuned, or backtested.

---

## 2. Mathematical Boundary Reasoning & Zero-Leakage Guarantee

### 2.1 The Execution Timeline at Partition Boundaries

Under the primary executable formulation:
$$R(t, h) = \left( \frac{C_{t+h} - O_{t+1}}{O_{t+1}} \right) \times 100\%$$

Each observation $t$ computes features at session $t$ close ($15:30$ IST), enters trade at session $t+1$ open ($09:15$ IST), and exits at session $t+h$ close ($15:30$ IST).

### 2.2 Train-to-Validation Boundary Purge ($t \le 379 - h$)
- Nominal Train terminates at session $T_{\text{train\_end}} = 379$ (`2026-03-11`).
- Nominal Validation commences at session $T_{\text{val\_start}} = 380$ (`2026-03-12`).
- The earliest validation sample $t = 380$ generates features at session $380$ close and enters trade at session $381$ open ($O_{381}$).
- The latest allowable price observation consumed by any training target is $C_{379}$ (the closing price of the final nominal training session).
- Because exit price is $C_{t+h}$, the condition $t + h \le 379$ requires $t \le 379 - h$.
- Purging the final $h$ sample dates of Train enforces:
  $$\max(\text{train\_exit\_date}) \le C_{379} < C_{380} = \text{val\_signal\_close} < O_{381} = \min(\text{val\_entry\_date})$$
  $$\mathcal{P}_{\text{train\_targets}} \cap \mathcal{P}_{\text{val\_targets}} = \emptyset$$

### 2.3 Validation-to-Test Boundary Purge ($t \le 460 - h$)
- Nominal Validation terminates at session $T_{\text{val\_end}} = 460$ (`2026-07-13`).
- Nominal Held-Out Test commences at session $T_{\text{test\_start}} = 461$ (`2026-07-14`).
- The earliest test sample $t = 461$ generates features at session $461$ close and enters trade at session $462$ open ($O_{462}$).
- Because exit price is $C_{t+h}$, the condition $t + h \le 460$ requires $t \le 460 - h$.
- Purging the final $h$ sample dates of Validation enforces:
  $$\max(\text{val\_exit\_date}) \le C_{460} < C_{461} = \text{test\_signal\_close} < O_{462} = \min(\text{test\_entry\_date})$$
  $$\mathcal{P}_{\text{val\_targets}} \cap \mathcal{P}_{\text{test\_targets}} = \emptyset$$

---

## 3. Scaler Correctness & Quarantine Protocol

To guarantee that feature scaling introduces zero look-ahead bias:
1. **Population Variance Formulation**:
   $$\mu_j = \frac{1}{M} \sum_{i=1}^M X_{i, j}, \quad \sigma_j = \sqrt{\frac{1}{M} \sum_{i=1}^M (X_{i, j} - \mu_j)^2} \quad (\text{ddof} = 0)$$
2. **Constant Feature Safety**:
   If a feature has zero variance ($\sigma_j = 0.0$ or NaN), `scale_` is set to $1.0$, producing scaled values of $0.0$ without division-by-zero or NaN corruption.
3. **Training Isolation**:
   - `StandardScaler.fit()` executes **strictly on retained $X_{\text{train}}$** ($M = 1,895$ for $h=1$; $1,885$ for $h=3$; $1,875$ for $h=5$).
   - `X_val` and `X_test` are transformed using the frozen parameters $(\mu_{\text{train}}, \sigma_{\text{train}})$.
   - `fit_transform_scaler()` never updates or refits parameters from validation or test data.

---

## 4. Feature-Target Join Integrity & Leakage Protection

1. **One-to-One Key Matching**:
   Features and targets are joined on `(stock_symbol, session_date)`.
2. **Duplicate Key Rejection**:
   Duplicate keys in features or targets raise an immediate `ValueError` detailing the duplicate records.
3. **Mandatory 23-Feature Allowlist Enforcement (Zero Arbitrary Fallback)**:
   The implementation strictly enforces `APPROVED_FEATURE_ALLOWLIST: Tuple[str, ...]`.
   - `split_features_and_targets()` requires an explicit `feature_names` list containing exactly the 23 unique approved engineered feature names. If `feature_names` is `None`, empty, or invalid, it immediately fails closed with an informative `ValueError`. It never falls back to selecting arbitrary DataFrame columns.
   - **Duplicate rejection**: Duplicate feature names in `feature_names` are explicitly rejected with `ValueError: Duplicate feature names detected in feature_names: [...]`.
   - **Partial list rejection**: Partial feature lists (e.g. fewer than 23 features) are strictly rejected with `ValueError: Partial feature list rejected: received X features, but exactly 23 approved engineered features are required. Missing approved engineered features: [...]`.
   - **Unapproved feature rejection**: Any requested column outside `APPROVED_FEATURE_ALLOWLIST` (such as synthetic future leaks, rogue columns, or unverified indicators) is explicitly rejected with `ValueError: Unapproved feature column(s) rejected: [...]`.
   - **Quarantine validation**: Any column matching future-derived prices or labels (`FUTURE_OR_TARGET_DERIVED_COLUMNS`), nominal price (`close`, `open`, `high`, `low`), volume, or metadata (`timestamp`, `session_date`, `stock_symbol`) is rejected by strict defense-in-depth validation.
   - **Input DataFrame verification**: All 23 approved engineered feature columns are strictly verified to exist in the input `features_df`; if any column is missing, it raises `ValueError: Requested approved engineered feature column(s) missing from features DataFrame: [...]`.
   - In `evaluate_multi_horizon_splits()`, `feature_names` defaults to the verified 23-feature allowlist, ensuring all multi-horizon evaluations operate strictly on approved engineered features.
4. **Cross-Sectional Group Masking**:
   Unique session dates are partitioned first, and the resulting date mask assigns all five stocks for any date $D_k$ to the identical partition.

---

## 5. Comprehensive Exact Partitioning Matrix

From the 544 clean dates, the integer index cutoffs ($380$ Train, $81$ Val, $83$ Test) and boundary purges produce exact observation counts across all three horizons:

```
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
| Horizon | Retained Train Set | Last Train Exit  | First Val Entry  | Retained Val Set   | Last Val Exit    | First Test Entry | Retained Test Set |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
| **h=1** | Indices 0 to 378   | Close C(379)     | Open O(381)      | Indices 380 to 459 | Close C(460)     | Open O(462)      | Indices 461 to 542|
|         | (1,895 stock-days) | (2026-03-11)     | (2026-03-13)     | (400 stock-days)   | (2026-07-13)     | (2026-07-15)     | (410 stock-days)  |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
| **h=3** | Indices 0 to 376   | Close C(379)     | Open O(381)      | Indices 380 to 457 | Close C(460)     | Open O(462)      | Indices 461 to 540|
|         | (1,885 stock-days) | (2026-03-11)     | (2026-03-13)     | (390 stock-days)   | (2026-07-13)     | (2026-07-15)     | (400 stock-days)  |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
| **h=5** | Indices 0 to 374   | Close C(379)     | Open O(381)      | Indices 380 to 455 | Close C(460)     | Open O(462)      | Indices 461 to 538|
|         | (1,875 stock-days) | (2026-03-11)     | (2026-03-13)     | (380 stock-days)   | (2026-07-13)     | (2026-07-15)     | (390 stock-days)  |
+---------+--------------------+------------------+------------------+--------------------+------------------+------------------+-------------------+
```

### Observation Accounting Table:

| Horizon | Pre-Purge Targets | Boundary Purged Train | Boundary Purged Val | Retained Train | Retained Val | Retained Test | Total Retained Targets |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **$h = 1$** | 2,715 | 5 ($1 \text{ date} \times 5$) | 5 ($1 \text{ date} \times 5$) | 1,895 (70.05%) | 400 (14.79%) | 410 (15.16%) | **2,705** |
| **$h = 3$** | 2,705 | 15 ($3 \text{ dates} \times 5$) | 15 ($3 \text{ dates} \times 5$) | 1,885 (70.47%) | 390 (14.58%) | 400 (14.95%) | **2,675** |
| **$h = 5$** | 2,695 | 25 ($5 \text{ dates} \times 5$) | 25 ($5 \text{ dates} \times 5$) | 1,875 (70.89%) | 380 (14.37%) | 390 (14.74%) | **2,645** |
| **TOTAL** | **8,115** | **45** | **45** | **5,655** | **1,170** | **1,200** | **8,025** |

### Retained Target Class Distribution Counts:
- **Horizon $h = 1$ (2,705 retained)**:
  - Train (1,895): `NEUTRAL` 756 (39.9%), `DOWN` 602 (31.8%), `UP` 537 (28.3%)
  - Val (400): `DOWN` 145 (36.2%), `UP` 134 (33.5%), `NEUTRAL` 121 (30.3%)
  - Test (410): `DOWN` 144 (35.1%), `NEUTRAL` 143 (34.9%), `UP` 123 (30.0%)
- **Horizon $h = 3$ (2,675 retained)**:
  - Train (1,885): `NEUTRAL` 784 (41.6%), `DOWN` 592 (31.4%), `UP` 509 (27.0%)
  - Val (390): `DOWN` 148 (37.9%), `UP` 127 (32.6%), `NEUTRAL` 115 (29.5%)
  - Test (400): `NEUTRAL` 139 (34.8%), `DOWN` 138 (34.5%), `UP` 123 (30.8%)
- **Horizon $h = 5$ (2,645 retained)**:
  - Train (1,875): `NEUTRAL` 864 (46.1%), `DOWN` 550 (29.3%), `UP` 461 (24.6%)
  - Val (380): `DOWN` 145 (38.2%), `NEUTRAL` 124 (32.6%), `UP` 111 (29.2%)
  - Test (390): `NEUTRAL` 153 (39.2%), `DOWN` 128 (32.8%), `UP` 109 (27.9%)

---

## 6. Automated Test Suite & Verification Results

A dedicated test suite [`ml-service/tests/test_splitting.py`](file:///Users/vansh/Documents/stocksense/ml-service/tests/test_splitting.py) contains **29 automated tests** across 6 test classes:

1. **Scaler Correctness & Quarantine (`TestScalerCorrectnessAndQuarantine`, 3 tests)**:
   - `test_population_standard_deviation_ddof_zero`: Population variance matches `ddof=0` exactly.
   - `test_constant_feature_handling`: Constant features handled safely with `scale_ = 1.0` without NaNs.
   - `test_fit_exclusively_on_retained_train_never_updates_on_val_or_test`: Frozen parameters never update on evaluation data.
2. **Feature-Target Join Integrity (`TestFeatureTargetJoinIntegrity`, 5 tests)**:
   - `test_one_to_one_join_enforced`: 1-to-1 join matches retained observation counts.
   - `test_reject_duplicate_feature_keys`: Rejects duplicate feature keys with `ValueError`.
   - `test_reject_duplicate_target_keys`: Rejects duplicate target keys with `ValueError`.
   - `test_explicit_exclusion_of_target_derived_columns_from_feature_matrix`: Zero target columns in $X$.
   - `test_cross_sectional_group_integrity_across_all_five_stocks`: All 5 stocks share identical partition per date.
3. **Purge Accounting & Boundary Leakage (`TestPurgeAccountingAndBoundaryLeakage`, 4 tests)**:
   - `test_zero_target_boundary_leakage_across_all_horizons`: $\max(\text{train exit}) < \min(\text{val entry})$ and $\max(\text{val exit}) < \min(\text{test entry})$.
   - `test_train_and_val_boundary_purges_reported_separately`: Reports $h \times 5$ purges per boundary.
   - `test_temporal_monotonicity_of_partitions`: $\max(\text{Train}) < \min(\text{Val}) < \max(\text{Val}) < \min(\text{Test})$.
   - `test_embargo_dates_parameter`: Setting $E > 0$ introduces blackout buffer to subsequent partitions.
4. **Horizon Isolation (`TestHorizonIsolation`, 1 test)**:
   - `test_horizon_isolation_bundles`: Generates isolated bundles for $h=1, 3, 5$ with 23 features.
5. **Historical Regression (`TestHistoricalDatasetSplittingRegression`, 2 tests)**:
   - `test_exact_observation_counts_and_boundaries_reproduced`: Bit-for-bit match on 8,025 retained observations, 90 purges, and class counts.
   - `test_functional_get_purged_splits_interface`: Functional wrapper produces identical subsets.
6. **Feature Allowlist Hardening & Rejection (`TestFeatureAllowlistHardening`, 14 tests)**:
   - `test_approved_feature_allowlist_composition`: Validates that `APPROVED_FEATURE_ALLOWLIST` contains exactly 23 unique approved engineered features with zero future-derived or nominal price leakage.
   - `test_split_features_and_targets_rejects_none_feature_names`: Rejects `None` feature_names explicitly (zero arbitrary fallback).
   - `test_split_features_and_targets_rejects_empty_feature_names`: Rejects empty lists/tuples with `ValueError`.
   - `test_split_features_and_targets_rejects_invalid_type_feature_names`: Rejects non-string and whitespace-only entries.
   - `test_split_features_and_targets_rejects_duplicate_feature_names`: Rejects duplicate feature names with explicit `ValueError`.
   - `test_split_features_and_targets_rejects_partial_feature_lists`: Rejects partial feature lists with fewer than 23 features.
   - `test_split_features_and_targets_rejects_unapproved_future_leak_columns`: Rejects rogue/future columns (e.g. `synthetic_future_leak`).
   - `test_split_features_and_targets_rejects_target_derived_columns_in_request`: Rejects `target_label` or forward returns.
   - `test_split_features_and_targets_rejects_nominal_price_columns_in_request`: Rejects nominal prices (`close`, `open`, etc.).
   - `test_split_features_and_targets_rejects_missing_column_in_dataframe`: Fails if any of the 23 approved feature columns is missing from input DataFrame.
   - `test_evaluate_multi_horizon_splits_defaults_to_all_23_approved_features`: Evaluates multi-horizon bundles with exact 23 approved engineered features.
   - `test_evaluate_multi_horizon_splits_rejects_unapproved_features`: Evaluates multi-horizon bundles failing closed on unapproved features.
   - `test_evaluate_multi_horizon_splits_rejects_duplicate_features`: Evaluates multi-horizon bundles failing closed on duplicate features.
   - `test_evaluate_multi_horizon_splits_rejects_partial_features`: Evaluates multi-horizon bundles failing closed on partial feature lists.

### Execution Results:
```bash
./ml-service/.venv/bin/pytest ml-service/tests/test_splitting.py -v
============================== 29 passed in 6.17s ==============================

./ml-service/.venv/bin/pytest ml-service/tests -v
======================= 118 passed, 3 warnings in 11.28s =======================

npm --prefix frontend test -- --run
ℹ tests 45 | pass 45 | fail 0 (228ms)

npm --prefix frontend run build
✓ built in 2.16s
```

---

## 7. Documented Limitations & Scope Constraints

1. **Forward-Only Baseline Assumption ($E = 0$)**:
   The baseline split uses $E = 0$ additional embargo dates because information flows strictly forward in time. If combinatorial purged cross-validation (CPCV) or walk-forward retraining where training follows test is implemented in future phases, a positive embargo buffer ($E > 0$) must be activated.
2. **Calendar Completeness Dependency**:
   Partition assignment relies on the aligned clean date array. As documented in Phase 5C.2.1, missing sessions omitted from both candles and calendar cannot be detected.
3. **Data-Engineering Scope**:
   This milestone produces partitioned feature and target tensors only. No machine learning models have been trained or tuned.
