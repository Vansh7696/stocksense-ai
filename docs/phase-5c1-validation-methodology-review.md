# StockSense AI — Phase 5C.1 Validation Methodology Review: Purged Chronological Splitting

**Document Reference**: `docs/phase-5c1-validation-methodology-review.md`<br>
**Phase**: Phase 5C.1 – Clarification Addendum (Task 2)<br>
**Branch**: `feature/phase-5c-ml-training`<br>
**Date**: November 12, 2026<br>
**Status**: **METHODOLOGICAL REVIEW COMPLETE — REVISED PER ARCHITECTURAL REVIEW (AWAITING APPROVAL)**

---

## 1. Executive Summary & Objective

In quantitative machine learning applied to financial time series, naive cross-validation (such as randomized $k$-fold splitting) produces catastrophic look-ahead bias and severe performance overestimation. Standard chronological splitting without boundary safeguards also introduces **target leakage**, where forward-looking labels computed near partition boundaries incorporate future price observations from subsequent validation or test periods.

This document presents a rigorous methodological review of the **Purged Chronological Train/Validation/Test Validation Strategy** for **StockSense AI**, incorporating all clarifications required by architectural review:
1. Chronological partition allocation ($70\%$ Train, $15\%$ Validation, $15\%$ Test).
2. Date-based group partitioning across all five approved NSE equities (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`).
3. Mathematical mechanics of label-window overlap across 1, 3, and 5 trading-day horizons.
4. Definitive initial embargo policy: **$E = 0$ additional embargo dates** for the forward-only split, alongside formal definitions and rationale.
5. Concrete, index-based partitioning examples for $h \in \{1, 3, 5\}$, accurately reflecting next-open entry $O_{t+1}$ and exit $C_{t+h}$ (with sample $380$ entering at $O_{381}$, and sample $461$ entering at $O_{462}$).
6. Detailed verification of **both partition boundaries** (Train $\to$ Validation and Validation $\to$ Held-Out Test).
7. Clear distinction between **mathematical boundary reasoning** and **implementation-level verification**.
8. Protocol for isolating the held-out final test set during hyperparameter tuning and model selection.
9. Empirical taxonomy of verified calendar edge cases in the historical dataset (Diwali Muhurat sessions, Saturday budget sessions, holiday gaps).
10. Production unit test specifications to enforce leakage-free validation in Phase 5C.2.

---

## 2. Review of the Proposed 70% / 15% / 15% Chronological Split

### 2.1 Dataset Span & Clean Feature Dimensions
The StockSense AI historical database contains exactly **743 daily OHLCV candles** per approved stock across five approved equities (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`), totaling **3,715 raw historical candles** (November 12, 2023 to November 9, 2026 IST).

Following feature extraction and the non-negotiable **200-period indicator warm-up window** (removing 199 warm-up dates required for `price_to_sma200` and `ma_spread_50_200`), each stock contains exactly **544 clean feature rows** (indices $0$ to $543$ in the clean array, corresponding to raw candle indices $199$ to $742$):
- **First Clean Feature Date**: September 2, 2024 (IST)
- **Last Clean Feature Date**: November 9, 2026 (IST)
- **Total Clean Trading Dates**: $N = 544$ distinct aligned dates
- **Pooled Clean Stock-Day Observations**: Exactly **2,720 observations** ($544 \text{ dates} \times 5 \text{ stocks}$)
- **Pre-Purge Labeled Observations**:
  - Horizon $h=1$: **2,715 observations** ($543 \text{ dates} \times 5 \text{ stocks}$)
  - Horizon $h=3$: **2,705 observations** ($541 \text{ dates} \times 5 \text{ stocks}$)
  - Horizon $h=5$: **2,695 observations** ($539 \text{ dates} \times 5 \text{ stocks}$)
- **Cross-Stock Timestamp Alignment**: All five stocks possess **100% identical clean timestamps**.
- **Special Weekend Sessions in Clean Dataset**:
  - Clean Index 106: `2025-02-01` (Union Budget 2025 Saturday session)
  - Clean Index 352: `2026-02-01` (Union Budget 2026 Sunday session)
  - Clean Index 542: `2026-11-08` (Diwali Muhurat Trading 2026 Sunday evening session)

### 2.2 Boundary Partition Options
Dividing $544$ discrete trading dates into $70\%$, $15\%$, and $15\%$ produces fractional days ($544 \times 0.70 = 380.8$; $544 \times 0.15 = 81.6$). Two integer partitioning configurations exist:

```
+-------------------------------------------------------------------------------------------------------------------------------+
|                                      CHRONOLOGICAL SPLIT CANDIDATE SPECIFICATIONS                                             |
+---------------+---------------+-----------------------+---------------------+----------------------+--------------------------+
| Configuration | Partition     | Date Count (Ratio)    | Clean Indices       | Calendar Date Span   | Pooled Obs. (5 Stocks)   |
+---------------+---------------+-----------------------+---------------------+----------------------+--------------------------+
| **Option A**  | Train Set     | 380 dates (69.85%)    | Index 0 to 379      | 2024-09-02 to 2026-03-11 | 1,900 stock-days     |
| *(Phase 5C.1  | Validation    |  81 dates (14.89%)    | Index 380 to 460    | 2026-03-12 to 2026-07-13 |   405 stock-days     |
|   Baseline)*  | Held-Out Test |  83 dates (15.26%)    | Index 461 to 543    | 2026-07-14 to 2026-11-09 |   415 stock-days     |
+---------------+---------------+-----------------------+---------------------+----------------------+--------------------------+
| **Option B**  | Train Set     | 380 dates (69.85%)    | Index 0 to 379      | 2024-09-02 to 2026-03-11 | 1,900 stock-days     |
| *(Balanced    | Validation    |  82 dates (15.07%)    | Index 380 to 461    | 2026-03-12 to 2026-07-14 |   410 stock-days     |
|   Symmetric)* | Held-Out Test |  82 dates (15.07%)    | Index 462 to 543    | 2026-07-15 to 2026-11-09 |   410 stock-days     |
+---------------+---------------+-----------------------+---------------------+----------------------+--------------------------+
```

#### Methodological Recommendation:
Both configurations maintain the required ratio. **Option A** matches the existing Phase 5C.1 audit baseline ($380 / 81 / 83$). **Option B** provides exact symmetry between Validation and Test ($82 / 82$). Either option is fully leakage-safe once purging is applied. Option A is tracked as the baseline reference in this document.

---

## 3. Date-Based Group Partitioning Across All Five Stocks

### 3.1 The Cross-Sectional Information Leakage Trap
A common failure mode in multi-asset financial machine learning is partitioning observations randomly or independently per asset.

In Indian equity markets, blue-chip equities (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`) share intense contemporaneous macroeconomic exposure:
- Benchmark market drift (Nifty 50, Bank Nifty, Nifty IT index beta).
- Monetary policy shocks (Reserve Bank of India MPC repo rate decisions).
- National fiscal announcements (Union Budget presentations, GDP data prints).
- Global macroeconomic developments (US Federal Reserve decisions, crude oil shocks).

If trading date $D_k$ was assigned to the **Train Set** for `RELIANCE` but to the **Validation Set** for `TCS` or `HDFCBANK`, the model would train on market-wide features and labels from day $D_k$ and then be evaluated on the very same day's market regime in the validation set. This constitutes severe cross-sectional leakage.

### 3.2 Non-Negotiable Group Partitioning Rule
All five stocks for trading date $D_k$ must strictly belong to the **exact same partition**:

$$\forall s \in \{\text{RELIANCE}, \text{TCS}, \text{INFY}, \text{HDFCBANK}, \text{ICICIBANK}\}, \quad \text{Partition}(s, D_k) \equiv \text{Partition}(D_k)$$

Because all five stocks possess **100% identical clean timestamp sequences** (544 dates verified in PostgreSQL), splitting is performed on the unique calendar dates, and the resulting date mask is joined across all assets.

---

## 4. Label-Window Overlap Mechanics Across Horizons

### 4.1 Forward-Looking Target Formulation
Under the executable convention approved in Task 1, the forward return for observation $t$ over horizon $h$ is:

$$r_{t+h}^{\text{executable}} = \left( \frac{C_{t+h} - O_{t+1}}{O_{t+1}} \right) \times 100\% \quad \text{for } h \in \{1, 3, 5\}$$

Each observation $t$ (generated at market close of session $t$) requires future prices spanning from session $t+1$ to session $t+h$:
- **Observation $t$ Feature Computation**: Generated post-close of session $t$ using information $\{O_\tau, H_\tau, L_\tau, C_\tau, V_\tau\}_{\tau \le t}$.
- **Entry Price Proxy**: $O_{t+1}$ (Opening price of the *next* trading session $t+1$).
- **Exit Price Proxy**: $C_{t+h}$ (Closing settlement price of session $t+h$).

### 4.2 Mathematical Overlap Analysis by Horizon

```
Observation Index:     t         t+1        t+2        t+3        t+4        t+5
Features computed at:  Close(t)  Close(t+1) Close(t+2) Close(t+3) Close(t+4) Close(t+5)
                     +---------+----------+----------+----------+----------+----------+
Horizon h = 1:       | Entry: Ot+1 ....... Exit: Ct+1 |
                     |         | Entry: Ot+2 ....... Exit: Ct+2 |
                     +---------+----------+----------+----------+----------+----------+
Horizon h = 3:       | Entry: Ot+1 ............................. Exit: Ct+3 |
                     |         | Entry: Ot+2 ............................. Exit: Ct+4 |
                     +---------+----------+----------+----------+----------+----------+
Horizon h = 5:       | Entry: Ot+1 ..................................................... Exit: Ct+5 |
                     +---------+----------+----------+----------+----------+----------+
```

1. **Horizon $h = 1$ (1 Trading Day)**:
   - Target for $t$ evaluates $[O_{t+1}, C_{t+1}]$.
   - Target for $t+1$ evaluates $[O_{t+2}, C_{t+2}]$.
   - **Internal Overlap**: Zero overlap between adjacent targets (the intervals $[O_{t+1}, C_{t+1}]$ and $[O_{t+2}, C_{t+2}]$ do not share any price bars).
   - **Boundary Overlap**: At the nominal partition boundary $T_{\text{train\_end}} = 379$, unpurged sample $379$ evaluates $[O_{380}, C_{380}]$. Because session $380$ is the first day of the validation set, sample $379$ directly consumes validation price data!
2. **Horizon $h = 3$ (3 Trading Days)**:
   - Target for $t$ evaluates $[O_{t+1}, C_{t+3}]$.
   - Target for $t+1$ evaluates $[O_{t+2}, C_{t+4}]$.
   - **Internal Overlap**: Adjacent targets share sessions $t+2$ and $t+3$ ($\frac{h-1}{h} = \frac{2}{3} \approx 66.7\%$ theoretical overlap, confirmed by empirical autocorrelation $r \approx +0.663$).
   - **Boundary Overlap**: Unpurged training samples $t \in \{377, 378, 379\}$ have exit prices $C_{380}, C_{381}, C_{382}$ extending 1, 2, and 3 sessions into the validation period.
3. **Horizon $h = 5$ (5 Trading Days)**:
   - Target for $t$ evaluates $[O_{t+1}, C_{t+5}]$.
   - Adjacent targets share 4 out of 5 sessions ($\frac{4}{5} = 80.0\%$ theoretical overlap, confirmed by empirical autocorrelation $r \approx +0.804$).
   - **Boundary Overlap**: Unpurged training samples $t \in \{375, \dots, 379\}$ have exit prices $C_{380}, \dots, C_{384}$ extending up to 5 sessions into the validation period.

---

## 5. Formal Definitions & Initial Embargo Policy

In quantitative finance literature (notably Marcos López de Prado, *Advances in Financial Machine Learning*, 2018), **Purging** and **Embargo** address two fundamentally different leakage pathways:

```
                                  PURGING                                          EMBARGO
                +-----------------------------------------+      +-----------------------------------------+
Aspect          | Discarding training bars at end of set  |      | Discarding initial bars of next set     |
Purpose         | Eliminate direct target label leakage   |      | Eliminate autoregressive feature memory |
Mechanism       | Remove samples whose labels touch test  |      | Blackout buffer after partition boundary|
Direction       | Applied to the PRECEDING partition      |      | Applied to the SUBSEQUENT partition     |
Initial Policy  | PURGE EXACTLY FINAL h SAMPLE DATES      |      | ZERO ADDITIONAL EMBARGO DATES (E = 0)   |
+---------------+-----------------------------------------+------+-----------------------------------------+
```

### 5.1 Purging (Strictly Mandatory)
- **Definition**: Purging removes observations from the end of a training (or validation) set whose forward target evaluation window $[t+1, t+h]$ extends across the partition boundary into the subsequent set.
- **Why it is Mandatory**: If purging is omitted, the model trains on labels derived directly from the validation period's actual prices. This creates direct mathematical target leakage, allowing the model to learn forward price action that it should only be evaluated against out-of-sample.

### 5.2 Exact Initial Embargo Policy: $E = 0$ Additional Dates
For the initial strictly chronological $\text{Train} \to \text{Validation} \to \text{Test}$ split of StockSense AI, the recommended policy is:
1. **Purge the final $h$ sample dates** of each preceding partition.
2. **Use zero additional embargo dates initially ($E = 0$)**.

#### Why $E = 0$ is Sufficient for this Forward-Only Split:
1. **Natural Arrow of Time**: In a forward-only chronological split, information flows unidirectionally forward. At the beginning of validation (session $380$), feature calculations (such as `rsi_14`, `volatility_20d`, or moving averages) utilize historical prices from sessions $\tau \le 380$. In live market execution, a trader standing at session $380$ causally has access to past historical prices. Utilizing past prices to compute current features is authentic, causal, and leakage-free.
2. **Purging Already Protects Future Targets**: Purging the final $h$ training samples guarantees that no training sample incorporates prices from session $380$ onward. Training labels are completely cut off at or before $C_{379}$.
3. **Statistical Power in Small Samples**: With only 81 validation dates, adding an arbitrary embargo buffer (e.g. 10 to 21 days) would discard $12\%$ to $26\%$ of the validation dataset without eliminating any forward look-ahead, unnecessarily starving model tuning and threshold validation of statistical significance.

#### When a Separate Embargo ($E > 0$) is Required:
In more complex cross-validation schemes—such as **Combinatorial Purged Cross-Validation (CPCV)** or walk-forward configurations where training folds *follow* testing folds in time—an embargo window ($E > 0$) becomes strictly mandatory. In those schemes, if an embargo is omitted, training features computed immediately after a test fold will embed past price history that was already evaluated as targets in the test fold, leaking test-fold information backwards into the model's training memory. Because StockSense AI begins with a strictly forward chronological split, $E = 0$ is methodologically sound.

---

## 6. Precise Index-Based Partitioning Examples Across Horizons

Let the 544 clean feature trading dates be indexed sequentially as $t \in [0, 543]$:
- **Nominal Train Partition**: Indices $0 \le t \le 379$ (380 dates, September 2, 2024 to March 11, 2026)
- **Nominal Validation Partition**: Indices $380 \le t \le 460$ (81 dates, March 12, 2026 to July 13, 2026)
- **Nominal Held-Out Test Partition**: Indices $461 \le t \le 543$ (83 dates, July 14, 2026 to November 9, 2026)

### 6.1 Horizon $h = 1$ Trading Day
- **Train Partition (Boundary 1)**:
  - Nominal indices: $0 \le t \le 379$.
  - For $t = 379$: Target evaluates $[O_{380}, C_{380}]$. Session $380$ is in the validation period $\to$ **Purge $t = 379$** (1 date discarded).
  - **Retained Effective Train Set**: Indices **$0 \le t \le 378$** (379 dates $\times$ 5 stocks = **1,895 observations**).
  - Last retained training sample $t = 378$ enters at $O_{379}$ and exits at **$C_{379}$** (the final closing price of the training partition).
- **Validation Partition (Boundary 2)**:
  - First validation sample $t = 380$ has features computed at close of session $380$ and enters at **$O_{381}$** (exiting at $C_{381}$).
  - For nominal end sample $t = 460$: Target evaluates $[O_{461}, C_{461}]$. Session $461$ is in the test period $\to$ **Purge $t = 460$** (1 date discarded).
  - **Retained Effective Validation Set**: Indices **$380 \le t \le 459$** (80 dates $\times$ 5 stocks = **400 observations**).
  - Last retained validation sample $t = 459$ enters at $O_{460}$ and exits at **$C_{460}$** (the final closing price of the validation partition).
- **Held-Out Test Partition**:
  - First test sample $t = 461$ has features computed at close of session $461$ and enters at **$O_{462}$** (exiting at $C_{462}$).
  - Last test sample $t = 543$ lacks forward session $544$ $\to$ Truncated (82 test dates $\times$ 5 stocks = **410 observations**).

### 6.2 Horizon $h = 3$ Trading Days
- **Train Partition (Boundary 1)**:
  - Samples $t \in \{377, 378, 379\}$ have exit prices $C_{380}, C_{381}, C_{382}$ in Validation $\to$ **Purge $\{377, 378, 379\}$** (3 dates discarded).
  - **Retained Effective Train Set**: Indices **$0 \le t \le 376$** (377 dates $\times$ 5 stocks = **1,885 observations**).
  - Last retained training sample $t = 376$ enters at $O_{377}$ and exits at **$C_{379}$** (the final closing price of the training partition).
- **Validation Partition (Boundary 2)**:
  - First validation sample $t = 380$ enters at **$O_{381}$** and exits at $C_{383}$.
  - Samples $t \in \{458, 459, 460\}$ have exit prices $C_{461}, C_{462}, C_{463}$ in Test $\to$ **Purge $\{458, 459, 460\}$** (3 dates discarded).
  - **Retained Effective Validation Set**: Indices **$380 \le t \le 457$** (78 dates $\times$ 5 stocks = **390 observations**).
  - Last retained validation sample $t = 457$ enters at $O_{458}$ and exits at **$C_{460}$** (the final closing price of the validation partition).
- **Held-Out Test Partition**:
  - First test sample $t = 461$ enters at **$O_{462}$** and exits at $C_{464}$.
  - Last 3 test bars ($t \in \{541, 542, 543\}$) lack complete forward data $\to$ Truncated (80 test dates $\times$ 5 stocks = **400 observations**).

### 6.3 Horizon $h = 5$ Trading Days
- **Train Partition (Boundary 1)**:
  - Samples $t \in \{375, \dots, 379\}$ have exit prices $C_{380}, \dots, C_{384}$ in Validation $\to$ **Purge $\{375, 376, 377, 378, 379\}$** (5 dates discarded).
  - **Retained Effective Train Set**: Indices **$0 \le t \le 374$** (375 dates $\times$ 5 stocks = **1,875 observations**).
  - Last retained training sample $t = 374$ enters at $O_{375}$ and exits at **$C_{379}$** (the final closing price of the training partition).
- **Validation Partition (Boundary 2)**:
  - First validation sample $t = 380$ enters at **$O_{381}$** and exits at $C_{385}$.
  - Samples $t \in \{456, \dots, 460\}$ have exit prices $C_{461}, \dots, C_{465}$ in Test $\to$ **Purge $\{456, 457, 458, 459, 460\}$** (5 dates discarded).
  - **Retained Effective Validation Set**: Indices **$380 \le t \le 455$** (76 dates $\times$ 5 stocks = **380 observations**).
  - Last retained validation sample $t = 455$ enters at $O_{456}$ and exits at **$C_{460}$** (the final closing price of the validation partition).
- **Held-Out Test Partition**:
  - First test sample $t = 461$ enters at **$O_{462}$** and exits at $C_{466}$.
  - Last 5 test bars ($t \in \{539, \dots, 543\}$) lack complete forward data $\to$ Truncated (78 test dates $\times$ 5 stocks = **390 observations**).

### 6.4 Comprehensive Exact Partitioning Matrix

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

---

## 7. Mathematical Boundary Reasoning on Zero Target Leakage

> [!IMPORTANT]
> **Clarification of Proof Status**: The derivations in this section constitute **mathematical boundary reasoning**—demonstrating that under the specified integer index definitions, the set of prices consumed by preceding targets has empty intersection with subsequent target intervals. **Actual implementation-level leakage safety** will only be formally established once the automated unit and integration tests defined in Section 10 execute green against the implemented Python code in Phase 5C.2.

### 7.1 Train-to-Validation Boundary Verification
Let nominal Train span $[0, T_{\text{train\_end}}]$ where $T_{\text{train\_end}} = 379$, and nominal Validation begin at $T_{\text{val\_start}} = 380$.
- Under purging of the last $h$ sample dates, the effective training set terminates at index:
  $$t_{\text{train\_max}} = T_{\text{train\_end}} - h$$
- The latest price required by any training target is the exit price of $t_{\text{train\_max}}$:
  $$\text{Exit}_{\text{train\_last}} = C_{t_{\text{train\_max}} + h} = C_{(T_{\text{train\_end}} - h) + h} = C_{T_{\text{train\_end}}} = C_{379}$$
- The first validation sample is $t = T_{\text{val\_start}} = 380$. Its trade entry occurs at:
  $$\text{Entry}_{\text{val\_first}} = O_{T_{\text{val\_start}} + 1} = O_{380 + 1} = O_{381}$$
- Chronological ordering of price formation:
  $$C_{379} \quad (\text{15:30 IST, Day 379}) \quad < \quad O_{380} \quad \le \quad C_{380} \quad < \quad O_{381} \quad (\text{09:15 IST, Day 381})$$
- Therefore, the latest price observation consumed by any training target ($C_{379}$) strictly precedes the formation of the first validation feature bar (session $380$) and the first validation trade entry ($O_{381}$).
- Target price intersection is empty:
  $$\mathcal{P}_{\text{train\_targets}} \cap \mathcal{P}_{\text{val\_targets}} = \emptyset$$

### 7.2 Validation-to-Test Boundary Verification
Let nominal Validation span $[T_{\text{val\_start}}, T_{\text{val\_end}}]$ where $T_{\text{val\_end}} = 460$, and nominal Held-Out Test begin at $T_{\text{test\_start}} = 461$.
- Under purging of the last $h$ sample dates, effective validation terminates at:
  $$t_{\text{val\_max}} = T_{\text{val\_end}} - h$$
- The latest price required by any validation target is:
  $$\text{Exit}_{\text{val\_last}} = C_{t_{\text{val\_max}} + h} = C_{(T_{\text{val\_end}} - h) + h} = C_{T_{\text{val\_end}}} = C_{460}$$
- The first test sample is $t = T_{\text{test\_start}} = 461$. Its trade entry occurs at:
  $$\text{Entry}_{\text{test\_first}} = O_{T_{\text{test\_start}} + 1} = O_{461 + 1} = O_{462}$$
- Chronological ordering:
  $$C_{460} \quad (\text{15:30 IST, Day 460}) \quad < \quad O_{461} \quad \le \quad C_{461} \quad < \quad O_{462} \quad (\text{09:15 IST, Day 462})$$
- All validation targets exit at or before $C_{460}$. Zero validation labels access prices from session $461$ onward.
- Target price intersection is empty:
  $$\mathcal{P}_{\text{val\_targets}} \cap \mathcal{P}_{\text{test\_targets}} = \emptyset$$

---

## 8. Held-Out Test Set Quarantine Protocol

To guarantee that the final model evaluation reflects genuine out-of-sample generalization without "p-hacking" or data snooping, the Test Set must be strictly quarantined throughout Phase 5C:

```
+----------------------------------------------------------------------------------------------------------+
|                                  MODEL DEVELOPMENT & VALIDATION LIFECYCLE                                |
+------------------------------------+------------------------------------+--------------------------------+
| TRAIN SET (380 dates)              | VALIDATION SET (81 dates)          | HELD-OUT TEST SET (83 dates)   |
| (Indices 0 to 379 - h)             | (Indices 380 to 460 - h)           | (Indices 461 to 543 - h)       |
+------------------------------------+------------------------------------+--------------------------------+
| - Model Parameter Learning         | - Hyperparameter Optimization      | STRICTLY QUARANTINED:          |
| - StandardScaler.fit()             | - Architecture Comparison          | - Zero access during tuning    |
| - Gradient Boosting Tree Splitting | - Early Stopping Monitoring        | - Zero access for early stop   |
| - Feature Ablation Training        | - Threshold Sensitivity Analysis   | - Single final evaluation ONLY |
| - Loss Minimization                | - Champion Model Selection         |   after champion is frozen     |
+------------------------------------+------------------------------------+--------------------------------+
```

### 8.1 Operational Rules for Test Set Quarantine
1. **Feature Scaler Isolation**:
   - `StandardScaler` (or `RobustScaler`) must be fitted **exclusively on the effective Train set**:
     ```python
     scaler.fit(X_train)
     X_train_scaled = scaler.transform(X_train)
     X_val_scaled = scaler.transform(X_val)
     X_test_scaled = scaler.transform(X_test)
     ```
   - Fitting the scaler on pooled `[X_train, X_val, X_test]` or fitting on `X_test` independently is strictly prohibited.
2. **Early Stopping Isolation**:
   - Early stopping callbacks for XGBoost (`early_stopping_rounds=20`) must monitor `eval_set=[(X_val, y_val)]`. The test set must never be passed to `eval_set`.
3. **Single-Shot Final Evaluation**:
   - The test set shall be evaluated **exactly once** at the conclusion of Phase 5C, after a single champion model configuration is finalized. Results are reported without subsequent retrospective parameter adjustments.

---

## 9. Empirical Edge Case Taxonomy in the Historical Dataset

An audit of the exact 743 historical candles (and 544 clean feature bars) identified four specific market calendar edge cases that the validation pipeline must accommodate:

### 9.1 Verified Weekend Trading Sessions in the Dataset
In Indian equity markets, the exchange occasionally schedules trading on weekends for national budget announcements or disaster recovery (DR) drills. Direct querying of the dataset reveals seven weekend sessions in the 743-candle history, with **three falling within the clean feature period**:

```
+---------------------------------------------------------------------------------------------------------------+
|                               VERIFIED WEEKEND SESSIONS IN THE 544 CLEAN DATASET                              |
+------------+-------------+-----------+-----------+------------+-----------------------------------------------+
| Clean Idx  | Date (IST)  | Day       | REL. Close| REL. Volume| Operational Context & Cause                   |
+------------+-------------+-----------+-----------+------------+-----------------------------------------------+
| **106**    | 2025-02-01  | Saturday  | ₹1,264.00 |  7,110,701 | Union Budget 2025 Special Trading Session     |
| **352**    | 2026-02-01  | Sunday    | ₹1,347.00 |  9,714,528 | Union Budget 2026 Special Trading Session     |
| **542**    | 2026-11-08  | Sunday    | ₹1,324.00 |  4,174,389 | Diwali Muhurat Trading 2026 (1-Hour Session)  |
+------------+-------------+-----------+-----------+------------+-----------------------------------------------+
```

#### Implications for Validation:
- These sessions represent **valid, exchange-cleared trading sessions** with official OHLCV settlement.
- **Index-Based vs. Calendar-Day Arithmetic**: Because sessions are non-contiguous in calendar time, target horizons must be calculated using **sequential integer trading index offsets** ($t+1, t+h$), **never calendar-day deltas** (`date + timedelta(days=h)`).
- Session $542$ (Diwali Muhurat 2026) falls near the very end of the Test set (clean index 542). Because it has drastically shortened trading duration (1 hour) and idiosyncratic liquidity, it should be recognized during test evaluation.

### 9.2 Stock-Specific Missing Candles (Robustness Provision)
- **Current Dataset Reality**: As audited in Phase 5A, all five approved stocks have **exactly 743 candles with 100% identical timestamps**. Zero missing candles exist.
- **Future Automated Pipeline Safeguard**: If an individual stock experiences an unannounced suspension or trading halt in future ingested batches, a calendar-date inner-join or explicit date-index reindexing must be applied to ensure that missing stock observations do not de-synchronize index alignment across the cohort.

### 9.3 Multi-Day Public Holiday Spans
- Indian markets experience clusters of consecutive public holidays (e.g., Holi, Diwali, Independence Day, Gandhi Jayanti). A 3-day holding period entering on a Thursday prior to a long weekend may encompass 5 to 6 calendar days. Sequential indexing ($t+1, \dots, t+h$) correctly models this holding duration in active market sessions.

---

## 10. Recommended Production Unit Tests for Phase 5C.2

To guarantee that the validation implementation in Phase 5C.2 is provably leakage-free, the following suite of automated unit tests is recommended for `ml-service/tests/test_validation.py`:

```python
import pytest
import numpy as np
import pandas as pd

def test_temporal_monotonicity():
    """Verify that split timestamps are strictly monotonic and non-overlapping."""
    # max(train_timestamps) < min(val_timestamps) < max(val_timestamps) < min(test_timestamps)
    assert train_dates.max() < val_dates.min()
    assert val_dates.max() < test_dates.min()

def test_cross_sectional_partition_integrity():
    """Verify that all stocks for any given date belong to the identical partition."""
    for date, group in pooled_df.groupby('date'):
        partitions = group['partition'].unique()
        assert len(partitions) == 1, f"Date {date} split across multiple partitions: {partitions}"

def test_purging_zero_target_leakage():
    """Verify that no training label references validation prices, and no val label references test prices."""
    for h in [1, 3, 5]:
        train_sub, val_sub, test_sub = get_purged_splits(df, horizon=h)

        # Max exit price date in train must be <= max date in train partition
        max_train_exit_date = train_sub['exit_date'].max()
        min_val_entry_date = val_sub['entry_date'].min()
        assert max_train_exit_date < min_val_entry_date, (
            f"Target leakage at h={h}: Train exit date {max_train_exit_date} >= Val entry date {min_val_entry_date}"
        )

        # Max exit price date in val must be <= max date in val partition
        max_val_exit_date = val_sub['exit_date'].max()
        min_test_entry_date = test_sub['entry_date'].min()
        assert max_val_exit_date < min_test_entry_date, (
            f"Target leakage at h={h}: Val exit date {max_val_exit_date} >= Test entry date {min_test_entry_date}"
        )

def test_scaler_fit_isolation():
    """Verify that StandardScaler fits strictly on train and transforms val/test."""
    scaler = fit_scaler(X_train)
    # Check that scaler mean_ and scale_ match X_train exactly
    np.testing.assert_allclose(scaler.mean_, X_train.mean(axis=0))

def test_feature_causality():
    """Verify that feature vectors X_t contain zero forward information from t+1 onward."""
    for stock_df in stock_data:
        # Recompute features on truncated slice [0:k] and verify identical values at k
        k = 300
        full_feat = compute_features(stock_df).iloc[k]
        trunc_feat = compute_features(stock_df.iloc[:k+1]).iloc[k]
        pd.testing.assert_series_equal(full_feat, trunc_feat)
```

---

## 11. Distinction Between Verified Facts, Boundary Reasoning, and Implementation Verification

In accordance with Phase 5C auditing standards, the table below explicitly delineates verified empirical database facts, mathematical boundary reasoning, and pending implementation-level verifications:

```
+-------------------------------------------------------------------------------------------------------------------------------+
|                        VERIFIED FACTS vs. MATHEMATICAL REASONING vs. IMPLEMENTATION VERIFICATION                              |
+---------------------------------------+---------------------------------------+-----------------------------------------------+
| VERIFIED EMPIRICAL FACTS              | MATHEMATICAL BOUNDARY REASONING       | PENDING IMPLEMENTATION VERIFICATION           |
| (Direct Database Audit)               | (Theoretical Design Proof)            | (Phase 5C.2 Automated Unit Tests)             |
+---------------------------------------+---------------------------------------+-----------------------------------------------+
| 1. Exactly 743 candles per stock.     | 1. Discarding final h training bars   | 1. Automated pytest confirmation that         |
| 2. Exactly 544 clean feature bars     |    guarantees latest price is C(379), |    implemented splitter produces exact sample |
|    post 200-period warmup.            |    which precedes validation O(381).  |    sizes (1895, 1885, 1875 for Train).        |
| 3. Clean dates span 2024-09-02 to     | 2. Discarding final h validation bars | 2. Automated assertion that no target         |
|    2026-11-09 IST.                    |    guarantees latest price is C(460), |    exit date violates partition boundaries.   |
| 4. 100% identical clean timestamps    |    which precedes test O(462).        | 3. Pytest verification that StandardScaler    |
|    across all 5 approved stocks.      | 3. E = 0 additional embargo dates is  |    fit parameters match X_train exactly.      |
| 5. 3 weekend trading sessions in      |    sufficient for forward-only split. | 4. Pytest verification of zero feature        |
|    clean dataset (Budget '25, '26,    | 4. Date-grouped masks eliminate cross-|    leakage across truncated input slices.     |
|    and Muhurat '26).                  |    sectional market-regime leakage.   |                                               |
+---------------------------------------+---------------------------------------+-----------------------------------------------+
```

---

## 12. Summary of Findings & Commitments

1. **Partition Specification**: The $70\% / 15\% / 15\%$ chronological split corresponds to **380 Train dates** (Sep 2, 2024 to Mar 11, 2026), **81 Validation dates** (Mar 12, 2026 to Jul 13, 2026), and **83 Held-Out Test dates** (Jul 14, 2026 to Nov 9, 2026).
2. **Cross-Sectional Integrity**: Date-based group splitting guarantees that all five stocks for any single session reside in the exact same partition, preventing cross-asset market regime leakage.
3. **Execution Price Alignment**: Under the agreed target $R(t,h) = (C_{t+h} - O_{t+1}) / O_{t+1}$, the first validation sample at index $380$ enters at **$O_{381}$** (not $O_{380}$), and the first test sample at index $461$ enters at **$O_{462}$** (not $O_{461}$).
4. **Purging is Non-Negotiable**: For horizon $h$, the last $h$ sample dates of Train and Validation must be purged:
   - $h=1$: Purge 1 date ($t=379$ in Train, $t=460$ in Val) $\implies$ Retain Train $0 \dots 378$ (last exit $C_{379}$); Retain Val $380 \dots 459$ (last exit $C_{460}$).
   - $h=3$: Purge 3 dates ($t \in 377 \dots 379$ in Train, $t \in 458 \dots 460$ in Val) $\implies$ Retain Train $0 \dots 376$ (last exit $C_{379}$); Retain Val $380 \dots 457$ (last exit $C_{460}$).
   - $h=5$: Purge 5 dates ($t \in 375 \dots 379$ in Train, $t \in 456 \dots 460$ in Val) $\implies$ Retain Train $0 \dots 374$ (last exit $C_{379}$); Retain Val $380 \dots 455$ (last exit $C_{460}$).
5. **Exact Initial Embargo Policy**: Purge the final $h$ sample dates of each preceding partition and apply **$E = 0$ additional embargo dates initially**. This is sufficient for this forward-only chronological split because historical features are causal and validation sample size is constrained. More complex cross-validation schemes (e.g. CPCV) will require $E > 0$.
6. **Boundary Verification**: Mathematical boundary reasoning proves that all training target exits terminate at $C_{379} < O_{381}$, and all validation target exits terminate at $C_{460} < O_{462}$, eliminating price overlap at both boundaries.
7. **Proof Status Clarification**: Mathematical reasoning establishes design correctness; true implementation-level leakage safety will be certified upon execution of automated unit tests in Phase 5C.2.
8. **Test Quarantine**: The held-out test set must remain untouched during scaler fitting, hyperparameter search, and early stopping, evaluated exactly once on the frozen champion model.
9. **Calendar Robustness**: All target intervals must operate on sequential integer trading day index steps ($t+h$) to natively accommodate weekend sessions (Budget, Muhurat) and multi-day holiday closures.
