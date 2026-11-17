# StockSense AI — Phase 5C.4.3: Advanced Model Hyperparameter Tuning

**Document Reference:** `docs/phase-5c4-3-advanced-model-hyperparameter-tuning.md`<br>
**Phase:** Phase 5C.4.3 — Advanced Model Hyperparameter Tuning (Revision 1.1.0 — Post-Audit Corrections)<br>
**Branch:** `feature/phase-5c-ml-training`<br>
**Baseline Git Commit:** `acd1b048d33b4685a5525b751171c714ca5f4329`<br>
**Date:** November 17, 2026<br>
**Status:** **COMPLETED, RIGOROUSLY AUDITED & REGISTERED (ALL 311 TESTS PASSING)**

---

## 1. Executive Summary

Phase 5C.4.3 performs systematic, leakage-safe hyperparameter tuning for the two approved non-linear machine learning model families across all three independent prediction horizons ($h \in \{1, 3, 5\}$):

1. **Random Forest Classifier** (`RandomForestModel` wrapping `sklearn.ensemble.RandomForestClassifier`)
2. **XGBoost Classifier** (`XGBoostModel` wrapping `xgboost.XGBClassifier`)

Following the approved research and design specification (`docs/phase-5c4-1-advanced-ml-model-research-and-design.md`) and implementation (`docs/phase-5c4-2-advanced-model-implementation.md`), the entire search budget of **810 candidate configurations** was evaluated against chronological validation partitions using the approved 23 technical features.

### Core Operational & Methodological Achievements

- **Exact Search Budget Execution (810 Configurations):**
  - **Random Forest:** 108 configurations per horizon $\times$ 3 horizons = **324 candidate runs**.
  - **XGBoost:** 162 configurations per horizon $\times$ 3 horizons = **486 candidate runs**.
  - Total: **810 configurations** evaluated without omissions, duplicate runs, or convergence aborts.
- **Strict Data Quarantine Maintained:**
  - The held-out Phase 5C.3 test partition (trading-session dates `2026-07-14` to `2026-11-09`, 83 session dates, $N_{\text{te}} \in \{410, 400, 390\}$) remains **permanently quarantined and untouched**. Zero test observations entered feature scaling, model fitting, early stopping, or validation selection.
- **Chronological Inner-Validation & Horizon-Specific Purging:**
  - Outer nominal training partition (380 trading-session dates, `2024-09-02` to `2026-03-11`) was split chronologically into 80% nominal inner train (304 dates) and 20% nominal inner validation (76 dates).
  - Exactly the final $h$ dates of each partition were purged to prevent forward look-ahead return overlap ($t+h$), verified with automated boundary assertions (`validate_target_boundaries`).
- **Two-Stage XGBoost Early-Stopping & Full Refit Protocol:**
  - **Stage 1 (Inner Determination):** Fitted candidate on inner train with early stopping (patience = 15) against inner validation to capture optimal iteration $M^* = \text{best\_iteration}$ (0-based integer).
  - **Stage 2 (Full-Training Refit):** Refitted candidate on full outer training partition with fixed $n\_estimators = M^* + 1$ without early stopping (`early_stopping_rounds=None`).
  - **Stage 3 (Unbiased Outer Validation):** Scored refitted model on outer validation partition (`2026-03-12` to `2026-07-13`). Outer validation data was used strictly once for unbiased scoring.
- **Deterministic 7-Level Lexicographic Tie-Breaking:**
  - *Random Forest:* Balanced Accuracy $\downarrow \to$ Macro F1 $\downarrow \to$ Log Loss $\uparrow \to$ `max_depth` $\uparrow \to$ `min_samples_leaf` $\downarrow \to$ `n_estimators` $\uparrow \to$ `grid_index` $\uparrow$.
  - *XGBoost:* Balanced Accuracy $\downarrow \to$ Macro F1 $\downarrow \to$ Log Loss $\uparrow \to$ `max_depth` $\uparrow \to$ `reg_lambda` $\downarrow \to$ `gamma` $\downarrow \to$ `grid_index` $\uparrow$.
- **Experiment Isolation & Checkpoint Resumption:**
  - Entire campaign executed under isolated experiment directory `ml-service/models/tuning/phase_5c4_3/phase_5c4_3_tuning_campaign/`.
  - Atomic checkpoint persistence (`.tmp` $\to$ `os.replace`) protected each run against interruption.
  - Baseline Phase 5C.3 model artifacts (`ml-service/models/registry/logistic_regression_*`) were protected and left untouched.
- **Validation-Selected Champion Governance:**
  - All 6 champion models were serialized and registered in the experiment registry under `ModelStatus.VALIDATION_SELECTED`. Production endpoints remain deactivated pending future held-out test evaluation.

---

## 2. Dataset Chronological Partitions and Sample Accounting

The authentic 5-stock canonical fixture (`ml-service/data/historical_candles_5stocks.json`, SHA-256 `d75a0e0f4e94c0991bbca71e911333b1944e7f064d8f4dd712cffa1688b97170`) contains **544 trading-session dates** (`2024-09-02` to `2026-11-09`) from raw candle index 199 onward across RELIANCE, TCS, INFY, HDFCBANK, and ICICIBANK.

```
Total Clean Dataset: 544 trading-session dates (2,720 observations across 5 equities)
├── Outer Training Partition (Nominal 70%): 380 dates (2024-09-02 to 2026-03-11)
│   ├── Inner Training (80%): 304 dates (2024-09-02 to 2025-11-20)
│   │   ├── Retained: 304 - h dates
│   │   └── Purged:   h dates (boundary embargo before inner validation)
│   └── Inner Validation (20%): 76 dates (2025-11-21 to 2026-03-11)
│       ├── Retained: 76 - h dates
│       └── Purged:   h dates (boundary embargo before outer validation)
├── Outer Validation Partition (Nominal 15%): 81 dates (2026-03-12 to 2026-07-13)
│   ├── Retained: 81 - h dates
│   └── Purged:   h dates (boundary embargo before quarantined test)
└── Quarantined Test Partition (Nominal 15%): 83 dates (2026-07-14 to 2026-11-09) [QUARANTINED]
    └── Retained: 83 - h dates (STRICTLY FORBIDDEN / NEVER LOADED)
```

### Partition Observation Counts by Horizon ($N = 5 \times \text{dates}$)

| Partition | Horizon $h=1$ | Horizon $h=3$ | Horizon $h=5$ |
| :--- | :---: | :---: | :---: |
| **Inner Training (Retained)** | 303 dates (1,515 rows) | 301 dates (1,505 rows) | 299 dates (1,495 rows) |
| **Inner Validation (Retained)** | 75 dates (375 rows) | 73 dates (365 rows) | 71 dates (355 rows) |
| **Outer Training (Full Refit)** | 379 dates (1,895 rows) | 377 dates (1,885 rows) | 375 dates (1,875 rows) |
| **Outer Validation (Scoring)** | 80 dates (400 rows) | 78 dates (390 rows) | 76 dates (380 rows) |
| **Quarantined Test (Untouched)** | *82 dates (410 rows)* | *80 dates (400 rows)* | *78 dates (390 rows)* |

---

## 3. Hyperparameter Search Grids and Candidate Distributions

### Random Forest (108 Configurations per Horizon)

- `n_estimators`: `[100, 200, 300]` (3)
- `max_depth`: `[3, 4, 5, 6]` (4)
- `min_samples_leaf`: `[15, 25, 40]` (3)
- `max_features`: `["sqrt", "log2", 0.3]` (3)
- Fixed: `class_weight=None`, `bootstrap=True`, `random_state=42`, `n_jobs=4`

#### Validation Candidate Distribution Statistics

| Horizon | Mean Bal Acc $\pm$ Std | Min / 25% / Median / 75% / Max Bal Acc | Mean Macro F1 (Min – Max) | Mean Log Loss (Min – Max) | Total Wall Time |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **$h=1$** | $0.3368 \pm 0.0115$ | $0.3099$ / $0.3294$ / $0.3346$ / $0.3428$ / **$0.3694$** | $0.3063$ ($0.2441$ – $0.3538$) | $1.0926$ ($1.0901$ – $1.0993$) | $29.11$s |
| **$h=3$** | $0.3395 \pm 0.0118$ | $0.2968$ / $0.3332$ / $0.3417$ / $0.3469$ / **$0.3659$** | $0.3273$ ($0.2945$ – $0.3584$) | $1.1124$ ($1.0978$ – $1.1364$) | $26.68$s |
| **$h=5$** | $0.3416 \pm 0.0072$ | $0.3208$ / $0.3355$ / $0.3423$ / $0.3469$ / **$0.3591$** | $0.3070$ ($0.2934$ – $0.3307$) | $1.1397$ ($1.1150$ – $1.1986$) | $26.94$s |

---

### XGBoost (162 Configurations per Horizon)

- `learning_rate`: `[0.01, 0.03, 0.05]` (3)
- `max_depth`: `[2, 3, 4]` (3)
- `subsample`: `[0.7, 0.85]` (2)
- `reg_lambda`: `[1.0, 5.0, 10.0]` (3)
- `gamma`: `[0.1, 0.5, 1.0]` (3)
- Fixed: `colsample_bytree=0.8`, `min_child_weight=15.0`, `objective="multi:softprob"`, `tree_method="hist"`, `early_stopping_rounds=15`, `random_state=42`, `n_jobs=4`

#### Validation Candidate Distribution Statistics

| Horizon | Mean Bal Acc $\pm$ Std | Min / 25% / Median / 75% / Max Bal Acc | Mean Macro F1 (Min – Max) | Mean Log Loss (Min – Max) | Optimal Iterations $M^*$ (Min / Med / Max) | Total Wall Time |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **$h=1$** | $0.3357 \pm 0.0134$ | $0.2939$ / $0.3271$ / $0.3364$ / $0.3414$ / **$0.3800$** | $0.3159$ ($0.2496$ – $0.3773$) | $1.1009$ ($1.0972$ – $1.1060$) | $18$ / $60.0$ / $199$ | $47.65$s |
| **$h=3$** | $0.3377 \pm 0.0072$ | $0.3251$ / $0.3333$ / $0.3342$ / $0.3401$ / **$0.3630$** | $0.1902$ ($0.1518$ – $0.3238$) | $1.1111$ ($1.1023$ – $1.1228$) | $0$ / $25.0$ / $120$ | $18.90$s |
| **$h=5$** | $0.3359 \pm 0.0059$ | $0.3282$ / $0.3333$ / $0.3333$ / $0.3358$ / **$0.3614$** | $0.1933$ ($0.1640$ – $0.2888$) | $1.1280$ ($1.1225$ – $1.1345$) | $1$ / $24.0$ / $151$ | $21.91$s |

---

## 4. Selected Champion Models & Hyperparameter Analysis

### Champion Configurations

| Horizon | Model Family | Grid Index | Selected Hyperparameters | Optimal Trees ($M^* \to \text{Refit}$) | Balanced Accuracy | Macro F1 | Log Loss | Fit Latency |
| :---: | :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **$h=1$** | **Random Forest** | `#107` | `n_estimators=300, max_depth=6, min_samples_leaf=40, max_features=0.3` | $300$ trees | $0.3694$ | $0.3521$ | $1.0915$ | $0.39$s |
| **$h=1$** | **XGBoost** | `#147` | `lr=0.05, max_depth=4, subsample=0.7, reg_lambda=5.0, gamma=0.1` | $M^*=45 \to 46$ trees | **$0.3800$** | **$0.3773$** | $1.0995$ | $0.38$s |
| **$h=3$** | **Random Forest** | `#18` | `n_estimators=100, max_depth=5, min_samples_leaf=15, max_features='sqrt'` | $100$ trees | **$0.3659$** | **$0.3584$** | $1.1163$ | $0.19$s |
| **$h=3$** | **XGBoost** | `#121` | `lr=0.05, max_depth=2, subsample=0.85, reg_lambda=5.0, gamma=0.5` | $M^*=25 \to 26$ trees | $0.3630$ | $0.3052$ | $1.1026$ | $0.13$s |
| **$h=5$** | **Random Forest** | `#33` | `n_estimators=100, max_depth=6, min_samples_leaf=40, max_features='sqrt'` | $100$ trees | $0.3591$ | $0.3265$ | $1.1385$ | $0.21$s |
| **$h=5$** | **XGBoost** | `#68` | `lr=0.03, max_depth=2, subsample=0.85, reg_lambda=5.0, gamma=1.0` | $M^*=48 \to 49$ trees | **$0.3614$** | $0.2881$ | $1.1305$ | $0.15$s |

### Champion Confusion Matrices (Outer Validation)

- **$h=1$ Random Forest Champion (#107, $N_{\text{val}}=400$):**
  $$\begin{bmatrix} \text{Actual} \backslash \text{Pred} & \text{DOWN} & \text{NEUTRAL} & \text{UP} \\ \text{DOWN} & 92 & 17 & 36 \\ \text{NEUTRAL} & 72 & 23 & 26 \\ \text{UP} & 70 & 26 & 38 \end{bmatrix}$$
- **$h=1$ XGBoost Champion (#147, $N_{\text{val}}=400$):**
  $$\begin{bmatrix} \text{Actual} \backslash \text{Pred} & \text{DOWN} & \text{NEUTRAL} & \text{UP} \\ \text{DOWN} & 73 & 41 & 31 \\ \text{NEUTRAL} & 55 & 40 & 26 \\ \text{UP} & 55 & 38 & 41 \end{bmatrix}$$
- **$h=3$ Random Forest Champion (#18, $N_{\text{val}}=390$):**
  $$\begin{bmatrix} \text{Actual} \backslash \text{Pred} & \text{DOWN} & \text{NEUTRAL} & \text{UP} \\ \text{DOWN} & 57 & 17 & 74 \\ \text{NEUTRAL} & 41 & 24 & 50 \\ \text{UP} & 49 & 14 & 64 \end{bmatrix}$$
- **$h=3$ XGBoost Champion (#121, $N_{\text{val}}=390$):**
  $$\begin{bmatrix} \text{Actual} \backslash \text{Pred} & \text{DOWN} & \text{NEUTRAL} & \text{UP} \\ \text{DOWN} & 33 & 103 & 12 \\ \text{NEUTRAL} & 23 & 86 & 6 \\ \text{UP} & 25 & 87 & 15 \end{bmatrix}$$
- **$h=5$ Random Forest Champion (#33, $N_{\text{val}}=380$):**
  $$\begin{bmatrix} \text{Actual} \backslash \text{Pred} & \text{DOWN} & \text{NEUTRAL} & \text{UP} \\ \text{DOWN} & 18 & 71 & 56 \\ \text{NEUTRAL} & 14 & 59 & 51 \\ \text{UP} & 23 & 35 & 53 \end{bmatrix}$$
- **$h=5$ XGBoost Champion (#68, $N_{\text{val}}=380$):**
  $$\begin{bmatrix} \text{Actual} \backslash \text{Pred} & \text{DOWN} & \text{NEUTRAL} & \text{UP} \\ \text{DOWN} & 4 & 92 & 49 \\ \text{NEUTRAL} & 2 & 83 & 39 \\ \text{UP} & 4 & 64 & 43 \end{bmatrix}$$

---

## 5. Comparative Validation Performance vs Phase 5C.3 Baselines

Comparing validation partition performance ($N_{\text{va}} \in \{400, 390, 380\}$, trading sessions `2026-03-12` to `2026-07-13`) between the advanced champions and the authentic Phase 5C.3 Logistic Regression baseline:

> [!NOTE]
> **Baseline Provenance & Disambiguation:**
> - The Logistic Regression baseline metrics below are extracted directly from the verified Phase 5C.3 model registry metadata sidecars (`ml-service/models/registry/logistic_regression_h{1,3,5}_v1.0.0/metadata.json`) and Section 5.3 of `docs/phase-5c3-baseline-model-training-and-evaluation.md`.
> - In Phase 5C.3, Majority and Momentum baselines were evaluated as frozen benchmarks on the held-out test partition. Because standalone validation-partition metrics for Majority and Momentum were not serialized into registry sidecars, they are explicitly marked **Unverified on Val** rather than substituting test metrics or speculative estimates.
> - Zero test observations from the quarantined Phase 5C.3 held-out test partition ($N_{\text{te}} \in \{410, 400, 390\}$) were accessed.

### Prediction Horizon $h=1$ (1 Trading Day, $\theta_1 = 0.50\%$, $N_{\text{val}}=400$)

| Model Family | Validation Balanced Accuracy | $\Delta_{\text{bal}}$ vs Verified LR Baseline | Validation Macro F1 | $\Delta_{\text{F1}}$ vs Verified LR Baseline | Validation Log Loss |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Verified Logistic Regression ($L_2$)** | **$0.3870$** | — | $0.3396$ | — | **$1.0882$** |
| **Random Forest Champion (`#107`)** | $0.3694$ | $-1.76$ pp | $0.3521$ | $+1.25$ pp | $1.0915$ |
| **XGBoost Champion (`#147`)** | $0.3800$ | $-0.70$ pp | **$0.3773$** | **$+3.77$ pp** | $1.0995$ |
| Majority / Momentum Baselines | *Unverified on Val* | — | *Unverified on Val* | — | — |

*Takeaway:* On the validation partition at $h=1$, Logistic Regression achieves a higher balanced accuracy ($0.3870$ vs $0.3800$). However, **XGBoost Champion #147 delivers a substantial $+3.77$ pp lift in Macro F1** ($0.3773$ vs $0.3396$), demonstrating substantially better directional balance across minority classes. Random Forest achieves the second-highest Macro F1 ($0.3521$).

---

### Prediction Horizon $h=3$ (3 Trading Days, $\theta_3 = 1.00\%$, $N_{\text{val}}=390$)

| Model Family | Validation Balanced Accuracy | $\Delta_{\text{bal}}$ vs Verified LR Baseline | Validation Macro F1 | $\Delta_{\text{F1}}$ vs Verified LR Baseline | Validation Log Loss |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Verified Logistic Regression ($L_2$)** | $0.3630$ | — | $0.3041$ | — | **$1.0952$** |
| **Random Forest Champion (`#18`)** | **$0.3659$** | **$+0.29$ pp** | **$0.3584$** | **$+5.43$ pp** | $1.1163$ |
| **XGBoost Champion (`#121`)** | $0.3630$ | $\pm 0.00$ pp (Tie) | $0.3052$ | $+0.11$ pp | $1.1026$ |
| Majority / Momentum Baselines | *Unverified on Val* | — | *Unverified on Val* | — | — |

*Takeaway:* **Random Forest Champion #18 is the clear winner at $h=3$**, outperforming Logistic Regression in both Balanced Accuracy ($0.3659$ vs $0.3630$, $+0.29$ pp lift) and Macro F1 ($0.3584$ vs $0.3041$, **$+5.43$ pp lift**). XGBoost matches Logistic Regression in Balanced Accuracy ($0.3630$).

---

### Prediction Horizon $h=5$ (5 Trading Days, $\theta_5 = 1.50\%$, $N_{\text{val}}=380$)

| Model Family | Validation Balanced Accuracy | $\Delta_{\text{bal}}$ vs Verified LR Baseline | Validation Macro F1 | $\Delta_{\text{F1}}$ vs Verified LR Baseline | Validation Log Loss |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Verified Logistic Regression ($L_2$)** | $0.3587$ | — | $0.2950$ | — | $1.1464$ |
| **Random Forest Champion (`#33`)** | $0.3591$ | $+0.04$ pp | **$0.3265$** | **$+3.15$ pp** | $1.1385$ |
| **XGBoost Champion (`#68`)** | **$0.3614$** | **$+0.27$ pp** | $0.2881$ | $-0.69$ pp | **$1.1305$** |
| Majority / Momentum Baselines | *Unverified on Val* | — | *Unverified on Val* | — | — |

*Takeaway:* **Both advanced models beat Logistic Regression in Balanced Accuracy at $h=5$** (XGBoost $0.3614$ and RF $0.3591$ vs LR $0.3587$), and both achieve lower validation log loss than Logistic Regression ($1.1305$ and $1.1385$ vs $1.1464$). Random Forest delivers the highest Macro F1 ($0.3265$, $+3.15$ pp lift).

---

## 6. Architectural and Engineering Verification

### Test Suite Execution
- **Dedicated Advanced Tuning Tests:** 14 unit and integration tests in `ml-service/tests/test_advanced_tuning.py`.
- **Full ML Test Suite:** **311 tests passed, 0 failures, 7 expected warnings**.
  - Python 3.14.9, scikit-learn 1.9.1, XGBoost 3.4.1.

### Verified Invariants
1. **Quarantine Integrity:** Zero access, inspection, or leakage of the permanently consumed Phase 5C.3 held-out test partition (`2026-07-14` to `2026-11-09`).
2. **Deterministic Reproducibility:** Fixed seeds (`random_state=42`) across all candidates and full cryptographic provenance recording (`ModelProvenance`).
3. **Artifact Isolation:** All tuning outputs reside under `ml-service/models/tuning/phase_5c4_3/phase_5c4_3_tuning_campaign/`. Baseline production models (`logistic_regression_*`) in `models/registry/` were completely protected.
4. **Lifecycle Governance:** All champions registered with status `VALIDATION_SELECTED`. None are marked `PRODUCTION_READY`.
5. **Git Working-Tree State:** The Git working tree is **not clean**: exactly 7 unstaged modified files and 6 untracked files are present, with 0 staged files. The user's pre-existing local modification in `docker-compose.yml` is strictly preserved and unstaged.

---

## 7. Next Steps (Phase 5C.4.4 Transition)

With Phase 5C.4.3 successfully concluded:
1. **Validation-Stage Comparison Only:** The Phase 5C.3 held-out test partition is permanently consumed and must never be reused. Phase 5C.4.4 may perform validation-stage model comparison and selection only across Random Forest, XGBoost, and Logistic Regression on the validation partition.
2. **Future Out-of-Sample Testing Requirements:** A future independent test requires genuinely new observations collected after the existing dataset cutoff (`2026-11-09`), governed by a new untouched evaluation protocol.
3. **Zero Production Promotion:** None of the models are promoted to `PRODUCTION_READY` pending formal, unquarantined evaluation on genuinely new market data.
