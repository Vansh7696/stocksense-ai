# StockSense AI — Phase 5C.4.4: Advanced Model Comparison and Validation-Stage Selection

**Document Version**: 1.0.0<br>
**Phase**: 5C.4.4<br>
**Date**: November 17, 2026<br>
**Status**: Completed — Validation-Stage Research Selection (Non-Production)<br>
**Target Git Branch**: `feature/phase-5c-ml-training`<br>
**Latest Committed Baseline (HEAD)**: `acd1b048d33b4685a5525b751171c714ca5f4329`<br>
**Canonical Dataset SHA-256**: `d75a0e0f4e94c0991bbca71e911333b1944e7f064d8f4dd712cffa1688b97170`

---

## 1. Executive Summary & Purpose

Phase 5C.4.4 conducts a systematic, reproducible, and leakage-safe comparison across nine trained predictive models spanning three distinct model families across three prediction horizons ($h=1, 3, 5$ trading days):
1. **Multinomial Logistic Regression (L2)**: Preserved historical linear baselines from Phase 5C.3.
2. **Random Forest Classifier**: Validation champions selected from the 324-configuration tuning campaign in Phase 5C.4.3.
3. **XGBoost Classifier**: Validation champions selected from the 486-configuration tuning campaign in Phase 5C.4.3.

The evaluation is conducted **strictly on frozen outer-validation metrics and artifacts**. No models were trained, retrained, tuned, or re-fitted during this phase. Model binaries were verified via cryptographic hashes and sidecar metadata without deserialization.

> [!WARNING]
> ### MANDATORY GOVERNANCE DIRECTIVE: NO MODEL IS APPROVED FOR PRODUCTION DEPLOYMENT
> All models evaluated in this report are **validation-stage research candidates** intended solely for comparative research and downstream simulation in Phase 6. The Phase 5C.3 held-out test partition (`2026-07-14` to `2026-11-09`) is permanently consumed and was **never loaded, accessed, or evaluated**. No candidate model may be activated for live production serving. True out-of-sample certification requires collecting genuinely new market observations occurring after `2026-11-09`.

---

## 2. Frozen Input Artifacts & Provenance Verification

All nine candidate models are verified against their cryptographic SHA-256 signatures, 23-feature allowlists, and horizon definitions prior to comparison:

| Horizon | Model Family | Candidate Identifier | Artifact Filename | Cryptographic SHA-256 Hash | Size (Bytes) | Hyperparameters Summary |
| :---: | :--- | :--- | :--- | :--- | :---: | :--- |
| **h1** | Logistic Regression | Phase 5C.3 Baseline | `model.joblib` | `5f35a9d74943747559c653af72eab9095ade4b8d5057e8d0aec778be0ea14f87` | 2,380 | $C=0.001$, penalty=`l2`, solver=`lbfgs` |
| **h1** | Random Forest | Champion #107 | `model.joblib` | `40b3c6f2499d681a8d0af0d12396c99689a35415fa543d3608f389f22889dd68` | 382,174 | $d=6, l=40, f=0.3, t=300$ |
| **h1** | XGBoost | Champion #147 | `model.joblib` | `de20b76f50ac3f755be689f9103799153f651b1fe953a3fc5268df9d6898d7fb` | 55,446 | $d=4, \eta=0.05, \lambda=5.0, \gamma=0.1, t=46$ |
| **h3** | Logistic Regression | Phase 5C.3 Baseline | `model.joblib` | `022b98bbd3c43963190ecd370199185d2ec1ac04bd425747d2bf00253323bb6f` | 2,398 | $C=0.001$, penalty=`l2`, solver=`lbfgs` |
| **h3** | Random Forest | Champion #18 | `model.joblib` | `4386cc1f5c0f7ae0bcab7c25b81adc8b20364798753c8e6b9017779d828a0af3` | 135,088 | $d=5, l=15, f=\text{sqrt}, t=100$ |
| **h3** | XGBoost | Champion #121 | `model.joblib` | `cd99702a67888c4cc449a82c58d2ee420d661229323bb883f052dbf839896dbc` | 15,661 | $d=2, \eta=0.05, \lambda=5.0, \gamma=0.5, t=26$ |
| **h5** | Logistic Regression | Phase 5C.3 Baseline | `model.joblib` | `c88b46e78ee2ea7f5eb0cd2a7c7ee137bb8835e647e49da5169205c622d22a52` | 2,394 | $C=0.001$, penalty=`l2`, solver=`lbfgs` |
| **h5** | Random Forest | Champion #33 | `model.joblib` | `31f38a811f91cec56135a1ce4d288693e5261a5a1922a317913a15ef32e0c57a` | 128,072 | $d=6, l=40, f=\text{sqrt}, t=100$ |
| **h5** | XGBoost | Champion #68 | `model.joblib` | `f416a10dbf07c7759a1ae71809bb4d4a1c891f167b588030cfa4ed5509793388` | 22,839 | $d=2, \eta=0.03, \lambda=5.0, \gamma=1.0, t=49$ |

Every model strictly adheres to the approved 23-feature scale-invariant technical schema:
`price_to_sma20`, `price_to_sma50`, `price_to_sma200`, `price_to_ema12`, `price_to_ema26`, `price_to_ema50`, `rsi_14`, `rsi_normalized`, `rsi_slope_5`, `macd_hist`, `macd_hist_normalized`, `bb_percent_b`, `bb_zscore`, `bb_bandwidth`, `atr_pct`, `return_1d`, `return_5d`, `return_21d`, `volatility_20d`, `relative_volume_20`, `trend_alignment`, `ma_spread_50_200`, `ma_spread_20_50`.

---

## 3. Validation-Only Chronological Data Provenance

The canonical StockSense dataset (`canonical_5stocks_v1`, SHA-256: `d75a0e0f4e94...`) contains 743 raw daily candles per equity spanning `2023-11-12` to `2026-11-09`:
- **Warmup Window**: Indices 0 to 198 (199 sessions, ending `2024-08-30`) provide required lookback history for rolling 200-day indicators.
- **Clean Feature Calendar (`clean_calendar`)**: Indices 199 to 742 (exactly **544 trading sessions**, calendar indices 0 to 543 inclusive, `2024-09-02` to `2026-11-09`).

```
[--- RAW CANDLES: 743 Sessions (2023-11-12 to 2026-11-09) ---]
|-- Warmup: 199 Sessions --|-- CLEAN CALENDAR: 544 Sessions (2024-09-02 to 2026-11-09) --|
|   Indices [0 ... 198]    |  Train: 380 Sessions  |  Validation: 81  | Quarantined Test: 83 |
|   2023-11-12..2024-08-30 |  Indices [0 ... 379]  | Indices [380..460] |  Indices [461..543]  |
|   (Warmup / Dropped)     | 2024-09-02..2026-03-11| 2026-03-12..07-13 | 2026-07-14..2026-11-09|
```

### Partition Boundary Slicing and Horizon Purging
The comparison service operates **exclusively** on the outer validation partition:
- **Horizon $h=1$**: 80 retained sessions $\times$ 5 stocks = **400 samples** (`2026-03-12` to `2026-07-10`; session 460 is purged because its exit date $t+1$ touches `2026-07-14`).
- **Horizon $h=3$**: 78 retained sessions $\times$ 5 stocks = **390 samples** (`2026-03-12` to `2026-07-08`; sessions 458–460 are purged).
- **Horizon $h=5$**: 76 retained sessions $\times$ 5 stocks = **380 samples** (`2026-03-12` to `2026-07-06`; sessions 456–460 are purged).

Any attempt to supply observation dates on or after `2026-07-14` triggers a fail-closed `QuarantinedTestDataLeakageError`.

---

## 4. Eligibility Policy & Multi-Dimensional Classification Taxonomy

### 4.1 The Six Approved Quantitative Eligibility Gates

To prevent deploying unstable or pathological models, every candidate must simultaneously pass all six validation-stage gates:
1. **Catastrophic Directional Error Rate**: $\le 25.00\%$ of total validation samples ($N$).
2. **Balanced Accuracy**: $> 0.3333$ (superior to an uninformative 3-class random guesser).
3. **Macro F1-Score**: $\ge 0.2800$.
4. **Per-Class Recall**: Strictly $> 0.0500$ ($5.0\%$) for **every** individual class (`DOWN`, `NEUTRAL`, `UP`).
5. **Log Loss (Multiclass Cross-Entropy)**: $\le 1.1500$.
6. **Multiclass Brier Score**: $\le 0.7000$.

### 4.2 Threshold Interpretation & Financial Realities

> [!IMPORTANT]
> **PROVISIONAL RESEARCH GUARDRAIL CAVEAT**<br>
> The $25.0\%$ catastrophic directional error threshold is strictly a **heuristic operational sanity check** designed to filter out pathological bipolar bettor models that invert directional signals on validation data.
>
> A sub-25% catastrophic error rate **DOES NOT** prove financial profitability, positive expected value, capital preservation, or statistical superiority in financial execution. Actual economic viability can only be evaluated in Phase 6 through rigorous simulation incorporating an explicit trading policy, execution assumptions, position sizing, slippage models, and transaction costs.

### 4.3 Multi-Dimensional Classification Attributes

To avoid confusing operational concepts, each model is independently evaluated across four distinct fields:
- **Eligibility (`ELIGIBLE` / `INELIGIBLE`)**: Whether the candidate passes all six gates.
- **Preferred Research Candidate (`YES` / `NO`)**: The selected best-in-class eligible model to carry forward into Phase 6.
- **Historical Benchmark Retention (`YES` / `N/A`)**: Model retained in registry for longitudinal lineage and comparative failure analysis.
- **Production Readiness (`PROHIBITED`)**: Absolute non-production directive.

---

## 5. Complete Model Comparison & Validation Evidence

### 5.1 Horizon $h=1$ Detailed Comparison ($N = 400$)

True Support: `DOWN` = 145 ($36.25\%$), `NEUTRAL` = 121 ($30.25\%$), `UP` = 134 ($33.50\%$). Directional Support $S_{\text{dir}} = 279$.

#### Confusion Matrices (Actual [DOWN, NEU, UP] $\times$ Predicted [DOWN, NEU, UP])
- **Logistic Regression $h=1$**:
  $$\begin{pmatrix} 100 & 40 & 5 \\ 67 & 48 & 6 \\ 80 & 44 & 10 \end{pmatrix}$$
- **Random Forest $h=1$ (#107)**:
  $$\begin{pmatrix} 92 & 17 & 36 \\ 72 & 23 & 26 \\ 70 & 26 & 38 \end{pmatrix}$$
- **XGBoost $h=1$ (#147)**:
  $$\begin{pmatrix} 73 & 41 & 31 \\ 55 & 40 & 26 \\ 55 & 38 & 41 \end{pmatrix}$$

#### Performance Breakdown ($h=1$)

| Metric | Logistic Regression (L2) | Random Forest (#107) | XGBoost (#147) | Preferred Choice |
| :--- | :---: | :---: | :---: | :---: |
| **Balanced Accuracy** | **0.3870** | 0.3694 | 0.3800 | Highest: LR |
| **Raw Accuracy** | **0.3950** | 0.3825 | 0.3850 | Highest: LR |
| **Macro Precision** | **0.4149** | 0.3739 | 0.3845 | Highest: LR |
| **Macro Recall** | **0.3870** | 0.3694 | 0.3800 | Highest: LR |
| **Macro F1** | 0.3396 | 0.3521 | **0.3773** | **Highest: XGBoost (+3.77%)** |
| **Log Loss** | **1.0882** | 1.0915 | 1.0995 | Lowest: LR |
| **Brier Score** | **0.6598** | 0.6621 | 0.6670 | Lowest: LR |
| **Catastrophic Errors** | 85 (21.25%) | 106 (26.50%) | 86 (21.50%) | Lowest: LR / XGB |
| **Directional Subset Cat Rate** | 30.47% | 37.99% | 30.82% | Lowest: LR / XGB |
| **DOWN Recall / Precision** | 68.97% / 40.49% | 63.45% / 39.32% | 50.34% / 39.89% | Balanced: XGB |
| **NEUTRAL Recall / Precision** | 39.67% / 36.36% | 19.01% / 34.85% | 33.06% / 33.61% | Balanced: LR / XGB |
| **UP Recall / Precision** | **7.46%** / 47.62% | 28.36% / 38.00% | **30.60%** / 41.84% | **Balanced: XGBoost** |
| **Predicted Distribution** | 247 / 132 / 21 | 234 / 66 / 100 | 183 / 119 / 98 | **Aligned: XGBoost** |
| **Eligibility** | **ELIGIBLE** | **INELIGIBLE** (Cat rate 26.5%) | **ELIGIBLE** | LR and XGB pass |
| **Selection Decision** | Historical Benchmark | Rejected | **PREFERRED CANDIDATE** | **XGBoost Selected** |

*Selection Analysis*: While Logistic Regression $h=1$ passes all six eligibility gates, it suffers from severe UP prediction suppression (predicting UP only 21 times out of 400 sessions, $5.25\%$, with $7.46\%$ recall). XGBoost #147 achieves superior Macro F1 ($0.3773$), balanced market sensitivity (`DOWN` $50.34\%$, `NEUTRAL` $33.06\%$, `UP` $30.60\%$), and passes the provisional catastrophic error guardrail ($21.50\%$). Random Forest #107 is ineligible due to exceeding the catastrophic error ceiling ($26.50\%$).

---

### 5.2 Horizon $h=3$ Detailed Comparison ($N = 390$)

True Support: `DOWN` = 148 ($37.95\%$), `NEUTRAL` = 115 ($29.49\%$), `UP` = 127 ($32.56\%$). Directional Support $S_{\text{dir}} = 275$.

#### Confusion Matrices (Actual [DOWN, NEU, UP] $\times$ Predicted [DOWN, NEU, UP])
- **Logistic Regression $h=3$**:
  $$\begin{pmatrix} 76 & 2 & 70 \\ 58 & 1 & 56 \\ 54 & 1 & 72 \end{pmatrix}$$
- **Random Forest $h=3$ (#18)**:
  $$\begin{pmatrix} 57 & 17 & 74 \\ 41 & 24 & 50 \\ 49 & 14 & 64 \end{pmatrix}$$
- **XGBoost $h=3$ (#121)**:
  $$\begin{pmatrix} 33 & 103 & 12 \\ 23 & 86 & 6 \\ 25 & 87 & 15 \end{pmatrix}$$

#### Performance Breakdown ($h=3$)

| Metric | Logistic Regression (L2) | Random Forest (#18) | XGBoost (#121) | Preferred Choice |
| :--- | :---: | :---: | :---: | :---: |
| **Balanced Accuracy** | 0.3630 | **0.3659** | 0.3630 | Comparable (~36.4%) |
| **Raw Accuracy** | **0.3821** | 0.3718 | 0.3436 | Highest: LR |
| **Macro Precision** | 0.3393 | 0.3882 | **0.3912** | Highest: XGBoost |
| **Macro Recall** | 0.3630 | **0.3659** | 0.3630 | Comparable |
| **Macro F1** | 0.3041 | **0.3584** | 0.3052 | Highest: RF |
| **Log Loss** | **1.0952** | 1.1163 | 1.1026 | Lowest: LR |
| **Brier Score** | **0.6635** | 0.6781 | 0.6692 | Lowest: LR |
| **Catastrophic Errors** | 124 (31.79%) | 123 (31.54%) | **37 (9.49%)** | **Lowest: XGBoost (-70%)** |
| **Directional Subset Cat Rate** | 45.09% | 44.73% | **13.45%** | **Lowest: XGBoost** |
| **DOWN Recall / Precision** | 51.35% / 40.43% | 38.51% / 38.78% | 22.30% / 40.74% | Highest: LR |
| **NEUTRAL Recall / Precision** | **0.87%** / 25.00% | 20.87% / 43.64% | **74.78%** / 31.16% | **Highest: XGBoost** |
| **UP Recall / Precision** | 56.69% / 36.36% | 50.39% / 34.04% | 11.81% / 45.45% | Highest: LR / RF |
| **Predicted Distribution** | 188 / 4 / 198 | 147 / 55 / 188 | 81 / 276 / 33 | **Conservative: XGBoost** |
| **Eligibility** | **INELIGIBLE** (Cat 31.8%, NEU 0.9%) | **INELIGIBLE** (Cat 31.5%) | **ELIGIBLE** | **Sole Eligible Model** |
| **Selection Decision** | Rejected | Rejected | **PREFERRED CANDIDATE** | **XGBoost Selected** |

*Selection Analysis*: XGBoost #121 is the **sole eligible candidate** at horizon $h=3$. It reduces catastrophic directional errors by $>70\%$ compared to LR and RF (37 errors vs 124 and 123), maintaining a $9.49\%$ catastrophic error rate. It exhibits high NEUTRAL prediction frequency ($74.78\%$ NEUTRAL recall, predicting NEUTRAL on $70.77\%$ of instances), resulting in lower directional market exposure and fewer active trades during multi-day consolidation. Both LR and RF fail the $25.0\%$ catastrophic error ceiling, and LR suffers complete NEUTRAL collapse ($0.87\%$ recall).

---

### 5.3 Horizon $h=5$ Detailed Comparison ($N = 380$)

True Support: `DOWN` = 145 ($38.16\%$), `NEUTRAL` = 124 ($32.63\%$), `UP` = 111 ($29.21\%$). Directional Support $S_{\text{dir}} = 256$.

#### Confusion Matrices (Actual [DOWN, NEU, UP] $\times$ Predicted [DOWN, NEU, UP])
- **Logistic Regression $h=5$**:
  $$\begin{pmatrix} 74 & 2 & 69 \\ 60 & 2 & 62 \\ 49 & 1 & 61 \end{pmatrix}$$
- **Random Forest $h=5$ (#33)**:
  $$\begin{pmatrix} 18 & 71 & 56 \\ 14 & 59 & 51 \\ 23 & 35 & 53 \end{pmatrix}$$
- **XGBoost $h=5$ (#68)**:
  $$\begin{pmatrix} 4 & 92 & 49 \\ 2 & 83 & 39 \\ 4 & 64 & 43 \end{pmatrix}$$

#### Performance Breakdown ($h=5$)

| Metric | Logistic Regression (L2) | Random Forest (#33) | XGBoost (#68) | Preferred Choice |
| :--- | :---: | :---: | :---: | :---: |
| **Balanced Accuracy** | 0.3587 | 0.3591 | **0.3614** | Highest: XGBoost |
| **Raw Accuracy** | **0.3605** | 0.3421 | 0.3421 | Highest: LR |
| **Macro Precision** | **0.3740** | 0.3387 | 0.3585 | Highest: LR |
| **Macro Recall** | 0.3587 | 0.3591 | **0.3614** | Highest: XGBoost |
| **Macro F1** | 0.2950 | **0.3265** | 0.2881 | **Highest: RF (+3.15%)** |
| **Log Loss** | 1.1464 | 1.1385 | **1.1305** | Lowest: XGBoost |
| **Brier Score** | 0.6904 | 0.6912 | **0.6868** | Lowest: XGBoost |
| **Catastrophic Errors** | 118 (31.05%) | 79 (20.79%) | **53 (13.95%)** | Lowest: XGBoost |
| **Directional Subset Cat Rate** | 46.09% | 30.86% | **20.70%** | Lowest: XGBoost |
| **DOWN Recall / Precision** | 51.03% / 40.44% | **12.41%** / 32.73% | **2.76%** / 40.00% | **Compliant: RF (12.4%)** |
| **NEUTRAL Recall / Precision** | **1.61%** / 40.00% | 47.58% / 35.76% | 66.94% / 34.73% | Balanced: RF / XGB |
| **UP Recall / Precision** | 54.95% / 31.77% | 47.75% / 33.12% | 38.74% / 32.82% | Balanced: RF / XGB |
| **Predicted Distribution** | 183 / 5 / 192 | 55 / 165 / 160 | 10 / 239 / 131 | Balanced: RF |
| **Eligibility** | **INELIGIBLE** (Cat 31.1%, NEU 1.6%) | **ELIGIBLE** | **INELIGIBLE** (DOWN 2.8%) | **Sole Eligible Model** |
| **Selection Decision** | Rejected | **PREFERRED CANDIDATE** | Rejected | **Random Forest Selected** |

*Selection Analysis*: Random Forest #33 is the **sole eligible candidate** at horizon $h=5$. It achieves the highest Macro F1 ($0.3265$), complies with the provisional catastrophic error guardrail ($20.79\%$), and satisfies the per-class recall floor (`DOWN` recall is $12.41\% > 5.00\%$). In contrast, XGBoost #68 suffers from severe downside blindness: its `DOWN` recall collapsed to **$2.76\%$** (identifying only 4 out of 145 down instances), disqualifying it from eligibility under Criterion 4. Logistic Regression $h=5$ is ineligible due to catastrophic errors ($31.05\%$) and NEUTRAL collapse ($1.61\%$).

---

## 6. Corrected Unified Decision Table (All 9 Models)

| Horizon | Model Family | Candidate | Bal Acc | Macro F1 | Log Loss | Brier | Cat Rate (Total) | Cat Count | Per-Class Recalls (DOWN / NEU / UP) | Eligibility | Failed Criteria | Selection Decision | Preferred Candidate | Benchmark Retention | Production Readiness |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- | :---: | :---: | :---: |
| **h1** | Logistic Regression | Phase 5C.3 Baseline | 0.3870 | 0.3396 | 1.0882 | 0.6598 | 21.25% | 85 | 69.0% / 39.7% / 7.5% | **ELIGIBLE** | None (Passes all 6) | Historical Benchmark | NO | YES | PROHIBITED |
| **h1** | Random Forest | Champion #107 | 0.3694 | 0.3521 | 1.0915 | 0.6621 | 26.50% | 106 | 63.4% / 19.0% / 28.4% | **INELIGIBLE** | Catastrophic directional error rate 26.50% exceeds 25.00% limit | Rejected | NO | YES | PROHIBITED |
| **h1** | XGBoost | Champion #147 | 0.3800 | 0.3773 | 1.0995 | 0.6670 | 21.50% | 86 | 50.3% / 33.1% / 30.6% | **ELIGIBLE** | None (Passes all 6) | Preferred Research Candidate | **YES** | N/A | PROHIBITED |
| **h3** | Logistic Regression | Phase 5C.3 Baseline | 0.3630 | 0.3041 | 1.0952 | 0.6635 | 31.79% | 124 | 51.4% / 0.9% / 56.7% | **INELIGIBLE** | Catastrophic directional error rate 31.79% exceeds 25.00% limit; Failed class recall floor (<= 5.00%): ['NEUTRAL'] | Rejected | NO | YES | PROHIBITED |
| **h3** | Random Forest | Champion #18 | 0.3659 | 0.3584 | 1.1163 | 0.6781 | 31.54% | 123 | 38.5% / 20.9% / 50.4% | **INELIGIBLE** | Catastrophic directional error rate 31.54% exceeds 25.00% limit | Rejected | NO | YES | PROHIBITED |
| **h3** | XGBoost | Champion #121 | 0.3630 | 0.3052 | 1.1026 | 0.6692 | 9.49% | 37 | 22.3% / 74.8% / 11.8% | **ELIGIBLE** | None (Passes all 6) | Preferred Research Candidate | **YES** | N/A | PROHIBITED |
| **h5** | Logistic Regression | Phase 5C.3 Baseline | 0.3587 | 0.2950 | 1.1464 | 0.6904 | 31.05% | 118 | 51.0% / 1.6% / 55.0% | **INELIGIBLE** | Catastrophic directional error rate 31.05% exceeds 25.00% limit; Failed class recall floor (<= 5.00%): ['NEUTRAL'] | Rejected | NO | YES | PROHIBITED |
| **h5** | Random Forest | Champion #33 | 0.3591 | 0.3265 | 1.1385 | 0.6912 | 20.79% | 79 | 12.4% / 47.6% / 47.7% | **ELIGIBLE** | None (Passes all 6) | Preferred Research Candidate | **YES** | N/A | PROHIBITED |
| **h5** | XGBoost | Champion #68 | 0.3614 | 0.2881 | 1.1305 | 0.6868 | 13.95% | 53 | 2.8% / 66.9% / 38.7% | **INELIGIBLE** | DOWN recall <= 5.00% (2.76%) | Rejected | NO | YES | PROHIBITED |

---

## 7. Provisional Latency Benchmark Audit

The following inference latencies reflect local developer workstation conditions and are **provisional**:
- **Environment**: Apple Silicon (ARM64), macOS 26.6.2, Python 3.14.9, scikit-learn 1.9.1, XGBoost 3.4.1, NumPy 2.5.4, Joblib 1.6.0.
- **Methodology**: 10 warm-up runs followed by 100 timed iterations using monotonic `time.perf_counter()`. End-to-end pipeline includes 23-feature schema verification and scaling.

| Candidate Model | Estimator Architecture | Batch ($N=400$) Mean $\pm$ Std | Batch Median [Min, Max] | Single ($N=1$) Mean $\pm$ Std | Single Median [Min, Max] |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Logistic Regression $h=1$** | Linear Model (2.4 KB) | $0.73 \pm 0.03\text{ ms}$ | $0.72\text{ ms } [0.70, 0.99]$ | $0.560 \pm 0.033\text{ ms}$ | $0.552\text{ ms } [0.541, 0.838]$ |
| **Random Forest $h=1$ (#107)** | 300 Trees (382 KB) | $61.37 \pm 8.57\text{ ms}$ | $63.34\text{ ms } [50.52, 79.55]$ | $51.57 \pm 2.66\text{ ms}$ | $51.45\text{ ms } [44.88, 73.76]$ |
| **XGBoost $h=1$ (#147)** | 46 Trees (55 KB) | $1.11 \pm 0.09\text{ ms}$ | $1.08\text{ ms } [1.05, 1.56]$ | $0.704 \pm 0.079\text{ ms}$ | $0.687\text{ ms } [0.667, 1.173]$ |
| **Logistic Regression $h=3$** | Linear Model (2.4 KB) | $0.72 \pm 0.02\text{ ms}$ | $0.72\text{ ms } [0.71, 0.88]$ | $0.571 \pm 0.025\text{ ms}$ | $0.568\text{ ms } [0.543, 0.797]$ |
| **Random Forest $h=3$ (#18)** | 100 Trees (135 KB) | $27.00 \pm 0.87\text{ ms}$ | $27.48\text{ ms } [25.10, 27.92]$ | $27.38 \pm 2.10\text{ ms}$ | $27.09\text{ ms } [23.55, 38.60]$ |
| **XGBoost $h=3$ (#121)** | 26 Trees (16 KB) | $1.22 \pm 0.34\text{ ms}$ | $1.07\text{ ms } [0.90, 2.39]$ | $0.843 \pm 0.193\text{ ms}$ | $0.807\text{ ms } [0.643, 1.685]$ |
| **Logistic Regression $h=5$** | Linear Model (2.4 KB) | $0.92 \pm 0.44\text{ ms}$ | $0.76\text{ ms } [0.72, 4.10]$ | $0.582 \pm 0.099\text{ ms}$ | $0.555\text{ ms } [0.543, 1.249]$ |
| **Random Forest $h=5$ (#33)** | 100 Trees (128 KB) | $27.79 \pm 2.10\text{ ms}$ | $27.65\text{ ms } [23.85, 41.12]$ | $27.51 \pm 2.52\text{ ms}$ | $27.33\text{ ms } [24.43, 47.63]$ |
| **XGBoost $h=5$ (#68)** | 49 Trees (23 KB) | $0.99 \pm 0.10\text{ ms}$ | $0.97\text{ ms } [0.94, 1.64]$ | $0.696 \pm 0.077\text{ ms}$ | $0.680\text{ ms } [0.664, 1.162]$ |

*Caveat*: Single-sample inference latency is dominated by Python-level DataFrame overhead and schema checks rather than matrix operations. All candidate models operate well within the real-time daily bar budget ($< 500\text{ ms}$). Latency is not used as a primary selection disqualifier.

---

## 8. Known Limitations & Research Weaknesses

1. **Downside Sensitivity at $h=5$**:
   The selected candidate Random Forest #33 maintains a $12.41\%$ DOWN recall. While compliant ($> 5.0\%$), it indicates that multi-day short signals are sparse. In sustained bear regimes, long exits or short entries may experience lag. Phase 6 backtesting must incorporate asymmetric penalty weighting or macro-trend filters.
2. **Neutral Prediction Frequency at $h=3$**:
   XGBoost #121 exhibits a $9.49\%$ catastrophic error rate primarily by predicting NEUTRAL on $70.77\%$ of instances ($74.78\%$ NEUTRAL recall). In live execution, this high NEUTRAL prediction frequency reduces directional market exposure, which lowers opposite-direction position risk during consolidation periods but may limit trade participation during rapid trend continuations.
3. **Provisional Latency Character**:
   Workstation measurements are subject to thread scheduling variance and background CPU loads. Production latency benchmarks must be re-measured inside isolated container environments.

---

## 9. Requirements for Future Independent Out-of-Sample Testing

Because the Phase 5C.3 held-out test partition (`2026-07-14` to `2026-11-09`) was permanently consumed during baseline testing, it cannot serve as an uncompromised test set for advanced models:
1. **Virgin Dataset Requirement**: Final out-of-sample certification requires recording genuinely new market trading sessions occurring **after `2026-11-09`**.
2. **Protocol Pre-Registration**: Feature computation parameters, entry/exit price conventions, and performance thresholds must be locked prior to ingesting new market data.
3. **Execution Simulation**: Model probabilities must drive a realistic order book simulation with commissions, slippage, and position limits in Phase 6.

---

*Phase 5C.4.4 validation-stage comparison is complete. Artifacts, schemas, services, and tests are verified.*
