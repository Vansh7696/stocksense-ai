# StockSense AI — Phase 5C.3: Baseline Model Training, Model Registry, and Controlled Test Evaluation

**Document Reference:** `docs/phase-5c3-baseline-model-training-and-evaluation.md`<br>
**Phase:** Phase 5C.3 — Baseline Model Training & Controlled Final Evaluation<br>
**Branch:** `feature/phase-5c-ml-training`<br>
**Git HEAD:** `947a3aa26e347b1c3c0270b1d8964bb155797873`<br>
**Date:** November 16, 2026<br>
**Status:** **IMPLEMENTED, AUDITED, AND COMPLETED**

---

## 1. Executive Summary & Architecture

### 1.1 Objective
Phase 5C.3 completes the baseline machine learning stage of StockSense AI. Building upon the verified target labeling engine (Phase 5C.2.1) and purged chronological splitting infrastructure (Phase 5C.2.2), this milestone implements:
1. A rigorous, leakage-safe **Evaluation Metrics Engine** supporting balanced multi-class metrics, cross-entropy log loss, multiclass Brier score, and catastrophic directional error accounting.
2. Two canonical benchmark baselines: the **Majority Classifier** (empirical mode prior) and the **Momentum Baseline** (calibrated distance-from-threshold softmax).
3. A **Multinomial Logistic Regression (L2)** classifier trained across three prediction horizons ($h \in \{1, 3, 5\}$ sessions), tuned via chronological validation.
4. An atomic, tamper-evident **Model Registry** managing serialized model bundles, sidecar metadata, and lifecycle governance states.
5. A strictly quarantined **Controlled Final Test Evaluation** engine protected by state guards, followed by a detached cryptographic integrity manifest.

### 1.2 Microservice Architecture & Subpackage Layout
The ML service encapsulates all components within modular schemas, domain services, and facade re-exports:

```
ml-service/
├── app/
│   ├── schemas/
│   │   ├── metrics.py               # ClassificationMetrics, CatastrophicErrorRecord
│   │   ├── baselines.py             # Majority & Momentum schemas and configurations
│   │   ├── logistic_regression.py   # Hyperparameter and grid search schemas
│   │   ├── registry.py              # ModelStatus, ModelProvenance, ModelRegistryMetadata
│   │   └── evaluation.py            # EvaluationGuardRecord, FinalTestEvaluationReport, IntegrityManifest
│   ├── services/
│   │   ├── metrics.py               # compute_classification_metrics()
│   │   ├── baselines.py             # MajorityClassifier, MomentumBaseline
│   │   ├── logistic_regression.py   # MultinomialLogisticRegression, tuning pipeline
│   │   ├── registry.py              # ModelRegistry, atomic staging, artifact serialization
│   │   └── evaluation.py            # EvaluationGuard, execute_controlled_test_evaluation()
│   └── ml/                          # Facade subpackages re-exported at app.ml.*
│       ├── metrics.py
│       ├── baselines.py
│       ├── logistic_regression.py
│       ├── registry.py
│       └── evaluation.py
├── data/
│   └── historical_candles_5stocks.json  # Canonical 5-stock 3-year historical dataset fixture
└── models/
    ├── registry/                    # Model directories (metadata.json tracked; model.joblib ignored)
    │   ├── logistic_regression_h1_v1.0.0/
    │   ├── logistic_regression_h3_v1.0.0/
    │   └── logistic_regression_h5_v1.0.0/
    └── evaluations/                 # Immutable evaluation experiment records
        └── eval_phase_5c3_final_test_20261116/
            ├── guard.json
            ├── evaluation_report.json
            └── integrity_manifest.json
```

---

## 2. Dataset and Feature Specification

### 2.1 Canonical Dataset Fixture
- **File Path:** `ml-service/data/historical_candles_5stocks.json`
- **File Size:** 676 KB
- **Dataset SHA-256 Digest:** `d75a0e0f4e94c0991bbca71e911333b1944e7f064d8f4dd712cffa1688b97170`
- **Equities Included:** 5 highly liquid National Stock Exchange (NSE) equities: `RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`.
- **Trading Session Span:** September 2, 2024 to November 9, 2026 (544 clean trading sessions; 743 raw candles per equity).

### 2.2 Accounting Across Data Pipeline Stages

| Pipeline Stage | Sessions per Equity | 5 Equities Total | Description |
|---|:---:|:---:|---|
| **1. Raw Historical Candles** | 743 | **3,715** | Daily OHLCV candles parsed from exchange archives. |
| **2. Clean Feature Observations** | 544 | **2,720** | Observations remaining after 199 warmup sessions for 200-period SMA/indicators. |
| **3. Eligible Targets ($h=1$)** | 543 | **2,715** | Signals with complete $t+1$ forward price bars ($544 - 1 = 543$). |
| **4. Eligible Targets ($h=3$)** | 541 | **2,705** | Signals with complete $t+3$ forward price bars ($544 - 3 = 541$). |
| **5. Eligible Targets ($h=5$)** | 539 | **2,695** | Signals with complete $t+5$ forward price bars ($544 - 5 = 539$). |
| **6. Total Eligible Target Rows** | — | **8,115** | Sum of target rows across all three horizons ($2,715 + 2,705 + 2,695$). |

### 2.3 Approved Feature Allowlist (23 Scale-Invariant Indicators)
Models are restricted to exactly 23 features in `APPROVED_FEATURE_ALLOWLIST`, ensuring scale invariance across equities:
1. `price_to_sma20`
2. `price_to_sma50`
3. `price_to_sma200`
4. `price_to_ema12`
5. `price_to_ema26`
6. `price_to_ema50`
7. `rsi_14`
8. `rsi_normalized`
9. `rsi_slope_5`
10. `macd_hist`
11. `macd_hist_normalized`
12. `bb_percent_b`
13. `bb_zscore`
14. `bb_bandwidth`
15. `atr_pct`
16. `return_1d`
17. `return_5d`
18. `return_21d`
19. `volatility_20d`
20. `relative_volume_20`
21. `trend_alignment`
22. `ma_spread_50_200`
23. `ma_spread_20_50`

---

## 3. Baseline Benchmark Methodology

To establish rigorous performance floors, two independent baselines were implemented and strictly calibrated only on training data.

### 3.1 Majority Classifier
The Majority baseline models unconditional market prevalence:
- **Decision Rule:** Always predicts the historical mode class ($\hat{y} = 0$, `NEUTRAL`).
- **Probability Output:** Constant vector corresponding to the empirical training class priors:
  $$P(\text{class} = k) = \frac{N_{\text{train}, k}}{N_{\text{train}}}$$
- **Catastrophic Error Property:** Because it never predicts directional extremes (`UP` or `DOWN`), its catastrophic error rate is identically zero by construction ($0.00\%$).

### 3.2 Momentum Baseline
The Momentum baseline operationalizes the trend-following hypothesis using 1-day normalized returns ($r_{1d}$) relative to target thresholds ($\theta_h$):

1. **Piecewise Distance-from-Threshold Scores (Logits):**
   $$s_{\text{UP}} = r_{1d} - \theta_h$$
   $$s_{\text{DOWN}} = -r_{1d} - \theta_h$$
   $$s_{\text{NEUTRAL}} = \theta_h - |r_{1d}|$$

2. **Softmax Probabilities with Temperature Scaling:**
   $$P(k) = \frac{\exp(s_k / \tau)}{\sum_{j \in \{\text{DOWN}, \text{NEUTRAL}, \text{UP}\}} \exp(s_j / \tau)}$$

3. **Training-Only Temperature Optimization:**
   The temperature hyperparameter $\tau$ is bounded in $\tau \in [0.1, 10.0]$ and optimized strictly on training data by minimizing Negative Log-Likelihood (NLL) via `scipy.optimize.minimize_scalar(method='bounded')`.
   - Optimized Temperatures: $h=1: \tau = 1.7052$, $h=3: \tau = 3.6559$, $h=5: \tau = 6.4716$.

4. **Deterministic Hard Prediction & Parity:**
   Hard predictions strictly follow the approved threshold rule:
   $$\hat{y} = \begin{cases} +1 \ (\text{UP}) & \text{if } r_{1d} > \theta_h \\ -1 \ (\text{DOWN}) & \text{if } r_{1d} < -\theta_h \\ 0 \ (\text{NEUTRAL}) & \text{otherwise} \end{cases}$$
   Ties are broken deterministically in favor of `NEUTRAL`. The probability argmax matches the hard decision rule for all finite returns.

---

## 4. Multinomial Logistic Regression Methodology

Multinomial Logistic Regression models the posterior class probabilities under an $L_2$ regularization penalty:

$$P(y = k \mid \mathbf{x}) = \frac{\exp(\mathbf{w}_k^T \mathbf{x} + b_k)}{\sum_{j=1}^K \exp(\mathbf{w}_j^T \mathbf{x} + b_j)}$$

### 4.1 Regularization and Optimization
- **Algorithm:** Multinomial Logistic Regression ($L_2$ penalty).
- **Solver:** Limited-memory BFGS (`lbfgs`) for stable multi-class convex optimization.
- **Convergence Parameters:** Maximum iterations `max_iter = 1000`, tolerance `tol = 1e-4`, fixed random seed `random_state = 42`.
- **Feature Standardization:** Features are normalized via `StandardScaler(with_mean=True, with_std=True, ddof=0)`. The scaler is fitted strictly on $X_{\text{train}}$ and frozen during validation and test transformations. Zero-variance features are mapped to $\text{scale} = 1.0$.

---

## 5. Hyperparameter Tuning and Model Selection

### 5.1 Search Space
For each horizon $h \in \{1, 3, 5\}$, grid searches evaluated the full approved 12-candidate hyperparameter grid:
- Regularization strength $C \in \{0.001, 0.01, 0.1, 1.0, 10.0, 100.0\}$ (6 values)
- Class weighting $\text{class\_weight} \in \{\text{None}, \text{'balanced'}\}$ (2 values)
- Total candidate configurations evaluated per horizon: $6 \times 2 = 12$

### 5.2 Selection Criterion: Validation Balanced Accuracy
Due to financial class imbalance, **Validation Balanced Accuracy** (macro-averaged recall across DOWN, NEUTRAL, and UP) was enforced as the primary selection objective:

$$\text{Balanced Accuracy} = \frac{1}{3} \sum_{c \in \{-1, 0, 1\}} \text{Recall}_c$$

Raw accuracy was strictly rejected as an objective because unweighted models collapse toward the majority class while achieving high raw accuracy at the cost of zero directional utility.

### 5.3 Selected Candidate Configurations (Validation Results Only)

> [!NOTE]
> The metrics below represent strictly **Validation Partition** performance ($N_{\text{va}} = 400, 390, 380$) evaluated during Phase 5C.3.5 model selection. The held-out test partition remained strictly quarantined and unaccessed during this selection process.

| Horizon | Regularization $C$ | Class Weighting | Val Balanced Accuracy | Val Macro F1 | Val Log Loss | Val Raw Accuracy |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **$h=1$** | $0.001$ | `None` | **0.3870** | 0.3396 | 1.0882 | 0.3950 |
| **$h=3$** | $0.001$ | `balanced` | **0.3630** | 0.3041 | 1.0952 | 0.3821 |
| **$h=5$** | $0.010$ | `balanced` | **0.3587** | 0.2950 | 1.1464 | 0.3605 |

---

## 6. Training, Validation, and Test Partitioning

Partitioning strictly enforces the **PurgedChronologicalSplitter** protocol defined in Phase 5C.2.2:
- **Calendar Split:** 544 unique trading sessions divided into Nominal Train (380 dates, indices 0–379), Nominal Validation (81 dates, indices 380–460), and Nominal Held-Out Test (83 dates, indices 461–543).
- **Cross-Sectional Grouping:** Equities are grouped by date. All five equities on date $D_k$ reside in the same partition.
- **Boundary Purging:** The final $h$ trading sessions of Train and Validation are discarded to prevent target return overlap into subsequent partitions.
- **Embargo Window:** $E=0$ additional embargo sessions applied.

```
Calendar Dates Timeline (2024-09-02 to 2026-11-09)
├── Train Nominal:      2024-09-02 to 2026-03-11 (380 dates)
│   ├── h=1 Retained:   2024-09-02 to 2026-03-10 (379 dates, N_tr = 1,895)
│   ├── h=3 Retained:   2024-09-02 to 2026-03-06 (377 dates, N_tr = 1,885)
│   └── h=5 Retained:   2024-09-02 to 2026-03-04 (375 dates, N_tr = 1,875)
├── Validation Nominal: 2026-03-12 to 2026-07-13 (81 dates)
│   ├── h=1 Retained:   2026-03-12 to 2026-07-10 (80 dates, N_va = 400)
│   ├── h=3 Retained:   2026-03-12 to 2026-07-08 (78 dates, N_va = 390)
│   └── h=5 Retained:   2026-03-12 to 2026-07-06 (76 dates, N_va = 380)
└── Test Nominal:       2026-07-14 to 2026-11-09 (83 dates)
    ├── h=1 Retained:   2026-07-14 to 2026-11-06 (82 dates, N_te = 410)
    ├── h=3 Retained:   2026-07-14 to 2026-11-04 (80 dates, N_te = 400)
    └── h=5 Retained:   2026-07-14 to 2026-11-02 (78 dates, N_te = 390)
```

---

## 7. Evaluation Metrics and Definitions

1. **Balanced Accuracy:** Macro-average of recall across all classes:
   $$\text{BalAcc} = \frac{1}{3} \left( \frac{M_{0,0}}{\sum_j M_{0,j}} + \frac{M_{1,1}}{\sum_j M_{1,j}} + \frac{M_{2,2}}{\sum_j M_{2,j}} \right)$$

2. **Macro Precision, Recall, and F1:** Arithmetic mean of per-class metrics without weighting by class support.

3. **Multi-class Log Loss:** Cross-entropy penalizing confident incorrect probability assignments:
   $$\text{LogLoss} = -\frac{1}{N} \sum_{i=1}^N \sum_{c \in \{-1, 0, 1\}} y_{i, c} \ln(p_{i, c})$$

4. **Multi-class Brier Score:** Mean squared probability calibration error:
   $$\text{Brier} = \frac{1}{N} \sum_{i=1}^N \sum_{c \in \{-1, 0, 1\}} (p_{i, c} - y_{i, c})^2$$

5. **Catastrophic Directional Error Rate:** Predictions where a directional move was predicted in direct opposition to the realized outcome:
   $$\text{Catastrophic Rate} = \frac{M_{0, 2} + M_{2, 0}}{N} = \frac{\text{Actual DOWN predicted UP} + \text{Actual UP predicted DOWN}}{N}$$

6. **Directional-Subset Catastrophic Rate:** Catastrophic errors normalized only by directional test samples ($N_{\text{DOWN}} + N_{\text{UP}}$):
   $$\text{Directional Catastrophic Rate} = \frac{M_{0, 2} + M_{2, 0}}{N_{\text{DOWN}} + N_{\text{UP}}}$$

---

## 8. Controlled Test Evaluation Results ($N_{\text{te}} = 410, 400, 390$)

Test evaluation was executed under experiment ID `eval_phase_5c3_final_test_20261116`. The test partition was unquarantined exactly once and permanently consumed.

### 8.1 Primary Evaluation Metrics Summary

| Metric | Horizon $h=1$ | Horizon $h=3$ | Horizon $h=5$ |
|---|:---:|:---:|:---:|
| **Model ID** | `logistic_regression_h1_v1.0.0` | `logistic_regression_h3_v1.0.0` | `logistic_regression_h5_v1.0.0` |
| **Hyperparameters** | $C=0.001$, `None` | $C=0.001$, `balanced` | $C=0.01$, `balanced` |
| **Test Observations ($N_{\text{te}}$)** | **410** | **400** | **390** |
| **Test Balanced Accuracy** | **0.3652** | **0.3345** | **0.3015** |
| *Validation Balanced Accuracy* | 0.3870 | 0.3630 | 0.3587 |
| *Generalization Delta ($\Delta_{\text{bal}}$)* | *-0.0218* | *-0.0286* | *-0.0571* |
| **Test Macro F1** | **0.3064** | **0.3282** | **0.2890** |
| *Validation Macro F1* | 0.3396 | 0.3041 | 0.2950 |
| *Generalization Delta ($\Delta_{\text{F1}}$)* | *-0.0332* | *+0.0241* | *-0.0059* |
| **Test Multi-class Log Loss** | **1.0966** | **1.1046** | **1.1318** |
| *Validation Log Loss* | 1.0882 | 1.0952 | 1.1464 |
| *Generalization Delta ($\Delta_{\text{loss}}$)* | *+0.0084* | *+0.0093* | *-0.0145* |
| **Test Raw Accuracy** | **0.3829** | **0.3300** | **0.2897** |
| *Validation Raw Accuracy* | 0.3950 | 0.3821 | 0.3605 |
| **Multiclass Brier Score** | **0.6641** | **0.6713** | **0.6879** |
| **Catastrophic Error Count (Rate)** | 61 (**14.88%**) | 131 (**32.75%**) | 119 (**30.51%**) |
| **Directional Subset Catastrophic Rate** | **22.85%** (61/267) | **50.19%** (131/261) | **50.21%** (119/237) |

---

### 8.2 Baseline Comparisons on Held-Out Test Data

| Horizon | Model | Balanced Accuracy | Macro F1 | Log Loss | $\Delta_{\text{bal}}$ vs Baseline | $\Delta_{\text{loss}}$ vs Baseline |
|:---:|---|:---:|:---:|:---:|:---:|:---:|
| **$h=1$** | **Logistic Regression** | **0.3652** | **0.3064** | **1.0966** | — | — |
| | Majority Baseline | 0.3333 | 0.1724 | 1.1015 | **+0.0319** | **-0.0049** |
| | Momentum Baseline | 0.3328 | 0.2954 | 1.1102 | **+0.0324** | **-0.0136** |
| **$h=3$** | **Logistic Regression** | **0.3345** | **0.3282** | **1.1046** | — | — |
| | Majority Baseline | 0.3333 | 0.1719 | 1.1070 | **+0.0012** | **-0.0024** |
| | Momentum Baseline | 0.3487 | 0.3125 | 1.1017 | **-0.0142** | **+0.0029** |
| **$h=5$** | **Logistic Regression** | **0.3015** | **0.2890** | **1.1318** | — | — |
| | Majority Baseline | 0.3333 | 0.1878 | 1.0986 | **-0.0318** | **+0.0332** |
| | Momentum Baseline | 0.3408 | 0.3132 | 1.0992 | **-0.0392** | **+0.0326** |

---

### 8.3 Detailed Test Confusion Matrices

- **$h=1$ ($N=410$):**
  $$\begin{pmatrix} 69 & 71 & 4 \\ 52 & 87 & 4 \\ 57 & 65 & 1 \end{pmatrix} \quad \begin{matrix} \text{Actual DOWN } (N=144) \\ \text{Actual NEUTRAL } (N=143) \\ \text{Actual UP } (N=123) \end{matrix}$$
  *(Columns: Predicted DOWN, NEUTRAL, UP)*
  - `DOWN`: Precision = 0.3876, Recall = 0.4792, F1 = 0.4286 (Support = 144)
  - `NEUTRAL`: Precision = 0.3901, Recall = 0.6084, F1 = 0.4754 (Support = 143)
  - `UP`: Precision = 0.1111, Recall = 0.0081, F1 = 0.0152 (Support = 123)

- **$h=3$ ($N=400$):**
  $$\begin{pmatrix} 45 & 22 & 71 \\ 40 & 32 & 67 \\ 60 & 8 & 55 \end{pmatrix} \quad \begin{matrix} \text{Actual DOWN } (N=138) \\ \text{Actual NEUTRAL } (N=139) \\ \text{Actual UP } (N=123) \end{matrix}$$
  - `DOWN`: Precision = 0.3103, Recall = 0.3261, F1 = 0.3180 (Support = 138)
  - `NEUTRAL`: Precision = 0.5161, Recall = 0.2302, F1 = 0.3184 (Support = 139)
  - `UP`: Precision = 0.2850, Recall = 0.4472, F1 = 0.3481 (Support = 123)

- **$h=5$ ($N=390$):**
  $$\begin{pmatrix} 35 & 30 & 63 \\ 52 & 32 & 69 \\ 56 & 7 & 46 \end{pmatrix} \quad \begin{matrix} \text{Actual DOWN } (N=128) \\ \text{Actual NEUTRAL } (N=153) \\ \text{Actual UP } (N=109) \end{matrix}$$
  - `DOWN`: Precision = 0.2448, Recall = 0.2734, F1 = 0.2583 (Support = 128)
  - `NEUTRAL`: Precision = 0.4638, Recall = 0.2092, F1 = 0.2883 (Support = 153)
  - `UP`: Precision = 0.2584, Recall = 0.4220, F1 = 0.3206 (Support = 109)

---

## 9. Model Registry, Metadata, and Artifact Provenance

### 9.1 Registry Architecture
Model persistence is governed by `ModelRegistry` in [registry.py](file:///Users/vansh/Documents/stocksense/ml-service/app/services/registry.py):
1. **Atomic Staging:** Artifacts (`model.joblib`) and sidecars (`metadata.json`) are written into temporary staging directories on the same filesystem (`tempfile.mkdtemp(prefix=".staging_...", dir=self.registry_dir)`) and published atomically using POSIX `os.replace`.
2. **Failure Cleanup:** Staging directories are guaranteed to be cleaned up on failure, preventing partial publications.
3. **Overwrite Guard:** Destination collision is rejected unless explicitly authorized (`overwrite=True`).
4. **Bundling:** `model.joblib` bundles the fitted estimator, fitted `StandardScaler`, feature list, class names, horizon, version, hyperparameters, and dynamic creation timestamp into a single zlib-compressed package.

### 9.2 Model Registration, Hardening Refitting, and Parameter Determinism
During Phase 5C.3.6, the validation-selected models were originally trained and registered. Subsequently, in Phase 5C.3.6.1 (Model Registry Hardening), the registry was refactored to enforce atomic staging directories, failure rollback, and dynamic UTC timestamps inside serialized joblib bundles. To publish the official models through this hardened pipeline, `register_selected_logistic_regression_models(version="1.0.0", overwrite=True)` was re-executed.

- **Refitting Reality vs. Reserialization:** Rather than deserializing and repacking the initial Phase 5C.3.6 `.joblib` files, this function re-instantiated and refitted fresh `StandardScaler` and `MultinomialLogisticRegression` estimators strictly on the training partition ($N_{\text{tr}} = 1895, 1885, 1875$).
- **Binary Identity vs. Mathematical Determinism:** Because `overwrite=True` replaced the previous physical binary files on disk, raw file binary identity against the initial Phase 5C.3.6 registration cannot be established. However, because the dataset fixture (SHA-256 `d75a0e0f...`), 23-feature allowlist, chronological training partitions, and hyperparameter seeds (`random_state=42`) were identical, the refitted estimators produced bit-for-bit identical validation predictions (`max_prob_diff = 0.00e+00`) and identical validation metrics to 16 decimal places. The procedural and functional equivalence is fully proven.

### 9.3 Registry Metadata & Cryptographic Hashes

| Horizon | Model Identifier | Registry Status | Artifact SHA-256 Digest | Size |
|:---:|---|:---:|---|:---:|
| **$h=1$** | `logistic_regression_h1_v1.0.0` | `test_evaluated` | `5f35a9d74943747559c653af72eab9095ade4b8d5057e8d0aec778be0ea14f87` | 2,380 B |
| **$h=3$** | `logistic_regression_h3_v1.0.0` | `test_evaluated` | `022b98bbd3c43963190ecd370199185d2ec1ac04bd425747d2bf00253323bb6f` | 2,395 B |
| **$h=5$** | `logistic_regression_h5_v1.0.0` | `test_evaluated` | `c88b46e78ee2ea7f5eb0cd2a7c7ee137bb8835e647e49da5169205c622d22a52` | 2,395 B |

- **Lifecycle Governance Rule:** Models transition to `ModelStatus.TEST_EVALUATED` upon completion of test evaluation. **Models are strictly prohibited from being labeled `PRODUCTION_READY`.**

---

## 10. Evaluation Guard and Detached Integrity Manifest

### 10.1 Evaluation Guard State Machine & Quarantine Enforcement
Test execution lifecycle is governed by `EvaluationGuard` in [evaluation.py](file:///Users/vansh/Documents/stocksense/ml-service/app/services/evaluation.py):
- States: `not_evaluated` $\rightarrow$ `evaluation_in_progress` $\rightarrow$ `evaluated`.
- **Final Test Evaluation (Phase 5C.3.7):** The authentic held-out test partition ($N_{\text{te}} = 410, 400, 390$) was unquarantined and evaluated under experiment ID `eval_phase_5c3_final_test_20261116`.
- **Tamper Resistance:** Once `state` reaches `evaluated`, the test partition is permanently consumed. Any subsequent attempt to re-evaluate under the same experiment ID fails closed with `EvaluationAlreadyCompletedError`.

### 10.2 Detached Cryptographic Integrity Manifest (Phase 5C.3.7.1)
During initial execution in Phase 5C.3.7, `evaluation_report.json` was hashed (`7860335b...`), written to `guard.json`, and then rewritten to embed the finalized guard record. This caused the disk digest of `evaluation_report.json` to shift to `1dccb491...`.

In Phase 5C.3.7.1, a **documentation-only and non-destructive integrity correction** was executed:
- **Strict Quarantine Maintained:** No test inference was executed, no models were retrained, and no test metrics were regenerated.
- Both `evaluation_report.json` and `guard.json` were preserved without modification.
- A detached manifest was generated at `ml-service/models/evaluations/eval_phase_5c3_final_test_20261116/integrity_manifest.json`.
- The manifest links:
  - Experiment ID: `eval_phase_5c3_final_test_20261116`
  - Final Report SHA-256: `1dccb491faeb871f10f84f1d5f6f2c04557172be01df1f7e7160f2489aad6fcb` (Size: 25,867 B)
  - Pre-finalization Digest: `7860335bbc825c6886de34cc74448881bcc95993a4ec64d52aa6171473e3b932`
  - Guard SHA-256: `2c254429c036a39cdf7459e31f2b9fd187f5f71cedf3da25e33976abaf00b368` (Size: 1,039 B)
  - Model Artifact Hashes: `5f35a9...`, `022b98...`, `c88b46...`
  - Dataset SHA-256: `d75a0e0f4e94c0991bbca71e911333b1944e7f064d8f4dd712cffa1688b97170`
- External Manifest SHA-256: `c80051c9497291292c390a2cad5f5d9be69831556ae20beaa5e34991ca9f1c83`.
- Verified via `verify_detached_integrity_manifest()` with zero file tampering detected.

---

## 11. Limitations, Risks, and Scientific Realism

Quantitative evaluation reveals critical limitations that govern how these models must be interpreted:

1. **Small Equity Universe (5 Equities):**
   The dataset contains only five large-cap Indian equities. Cross-sectional diversity is low, and idiosyncratic shocks in a single stock significantly impact partition loss metrics.

2. **Horizon-Dependent Performance Deterioration:**
   - At $h=1$, Logistic Regression demonstrates a modest edge over baselines (+3.19 percentage points in balanced accuracy over Majority, and +3.24 percentage points over Momentum).
   - At $h=3$, performance drops to random chance levels (0.3345 balanced accuracy vs. 0.3333 random chance).
   - At $h=5$, performance deteriorates below random chance (0.3015 balanced accuracy vs. 0.3333 random chance), trailing the Majority baseline by -3.18 percentage points and Momentum by -3.92 percentage points in balanced accuracy.
   - Balanced accuracy and probability-based loss metrics generally deteriorate as the forecast horizon increases. However, not every metric changes monotonically: Macro F1 improves from 0.3064 at h=1 to 0.3282 at h=3 before declining to 0.2890 at h=5. The experiment does not establish an underlying causal mechanism.

3. **High Catastrophic Directional Error Rates:**
   In the directional subset, catastrophic misclassifications reach **50.19% at $h=3$** and **50.21% at $h=5$**. The model frequently predicts `UP` on bars that drop by more than $\theta_h$, or `DOWN` on bars that rally by more than $\theta_h$.

4. **Distribution Shift Across Market Regimes:**
   Validation balanced accuracy dropped between $-0.0218$ and $-0.0571$ upon transition to held-out test data, reflecting non-stationary market dynamics between early 2026 and late 2026.

5. **No Production Readiness or Trading Signal Deployment:**
   **Under no circumstances are these baseline models production-ready trading strategies.** They are architectural anchors developed to validate the end-to-end data, registry, and evaluation infrastructure.

6. **Zero Real-Money Execution:**
   These models must never be connected to live brokerage execution engines, automated order routing systems, or real-money portfolios.

---

## 12. Milestone Completion Status and Next Steps

### 12.1 Phase 5C.3 Status
- **Overall Status:** **COMPLETED, FULLY AUDITED, AND FORMALLY VERIFIED**
- **Unit and Integration Tests:** 254 passed in 22.94s (ML service), 45 passed in 158ms (frontend).
- **Git Status:** 31 files ready for staging (4 modified tracked files, 27 untracked implementation files; zero `.joblib` binaries tracked).

### 12.2 Transition to Phase 5C.4
With linear and heuristic baselines established and cryptographically evaluated on quarantined test data, Phase 5C.3 concludes. Next phases can explore:
1. **Non-Linear Models:** Gradient Boosted Decision Trees (LightGBM / XGBoost) with non-linear feature interactions.
2. **Feature Expansion:** Macroeconomic factors, sector indices, and order flow metrics.
3. **Inference Pipeline:** Integration of `RegisteredInferenceModel` into real-time prediction serving endpoints with runtime monitoring and drift detection.
