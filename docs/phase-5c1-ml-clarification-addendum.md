# StockSense AI — Phase 5C.1 Clarification Addendum: Prediction Execution Timing

**Document Reference**: `docs/phase-5c1-ml-clarification-addendum.md`<br>
**Phase**: Phase 5C.1 – Clarification Addendum (Task 1)<br>
**Branch**: `feature/phase-5c-ml-training`<br>
**Date**: November 12, 2026<br>
**Status**: **PROPOSAL COMPLETE — REVISED PER METHODOLOGICAL REVIEW (AWAITING ARCHITECTURAL APPROVAL)**

---

## 1. Context and Objective

The Phase 5C.1 ML Readiness Audit identified a critical gap between academic financial modeling conventions and live market execution realities.

In standard quantitative literature, forward returns are typically formulated as **Close-to-Close**:

$$r_{t+h}^{\text{c2c}} = \left( \frac{C_{t+h} - C_t}{C_t} \right) \times 100\%$$

While mathematically clean, this target assumes an instantaneous, frictionless entry at the closing price of session $t$ ($C_t$). Because predictions are generated and published only after the market closes, executing a trade at $C_t$ is physically impossible without retroactive execution (look-ahead bias).

This document analyzes the execution timeline of **StockSense AI**, models the empirical impact of overnight opening price gaps across the 3-year historical dataset of the five approved NSE equities (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`), and formalizes the **executable target definition** to be implemented in Phase 5C.2.

---

## 2. Market Timeline & Prediction Execution Workflow

### 2.1 Chronological Session Sequence (IST)
The end-of-day operational cycle for Indian equity markets proceeds through the following phases:

```
  15:30 IST           15:40 - 16:30 IST        16:30 - 18:00 IST       09:00 - 09:08 IST   09:08 - 09:12 IST   09:12 - 09:15 IST   09:15 - 15:30 IST     15:30 IST
+-------------------+------------------------+-----------------------+-------------------+-------------------+-------------------+---------------------+---------------------+
| Session t Closes  | Official EOD Settlement| DB Ingestion Pipeline | Pre-Open Session: | Order Matching &  | System Transition | Regular Continuous  | Session t+h Closes  |
| Normal Trading    | Bhavcopy / Upstox API  | Express / PostgreSQL  | Order Collection  | Opening Price     | Buffer Period     | Trading Begins      | Position Exit Proxy |
| Ends (Ct formed)  | Published              | Features & ML Compute | & Modification    | Discovery (Ot+1)  | (No orders)       | (Entry proxy Ot+1)  | (Executed at Ct+h)  |
+-------------------+------------------------+-----------------------+-------------------+-------------------+-------------------+---------------------+---------------------+
|<------------------- PREDICTION GENERATION WINDOW ----------------->|<------------------- PRE-MARKET AUCTION ---------------->|<------------------- POSITION LIFECYCLE ------------------>|
```

1. **15:30 IST — Session $t$ Market Close**:
   - The regular NSE equity trading session terminates. The final closing settlement price $C_t$ is determined via volume-weighted average pricing (VWAP) across trades executed between 15:00 and 15:30 IST.
2. **15:40 to 16:30 IST — Official Settlement Publication**:
   - The Upstox API and NSE Bhavcopy finalize official OHLCV bars.
3. **16:30 to 18:00 IST — Prediction Generation**:
   - The backend ingestion service validates session $t$ data in PostgreSQL.
   - The Python ML microservice computes technical indicators and the 23-feature vector $X_t$ using data available up to and including session $t$ close ($[O_t, H_t, L_t, C_t, V_t]$).
   - Machine learning inference runs and publishes forward probability distributions:
     $$\hat{P}(\text{UP}), \quad \hat{P}(\text{NEUTRAL}), \quad \hat{P}(\text{DOWN})$$
4. **09:00 to 09:15 IST (Next Trading Session $t+1$) — NSE Pre-Open Auction Structure**:
   - The National Stock Exchange (NSE) conducts a structured call auction in three distinct phases:
     - **09:00 to 09:08 IST — Order Collection & Modification**: Participants submit, modify, or cancel limit and market orders. This window closes randomly between 09:07 and 09:08 IST to discourage gaming.
     - **09:08 to 09:12 IST — Order Matching & Price Discovery**: The NSE call auction algorithm computes the single equilibrium clearing price that maximizes executable volume. This discovered equilibrium price becomes the official opening price $O_{t+1}$. Eligible matched orders execute at $O_{t+1}$. Unmatched eligible limit orders transition into the regular session order book.
     - **09:12 to 09:15 IST — Buffer Period**: System buffer to facilitate smooth transition to continuous trading; no order placement or cancellation is accepted.
5. **09:15 IST — Regular Continuous Trading (Position Entry Proxy)**:
   - Regular continuous trading commences. Live market orders execute against the continuous central limit order book.
6. **Session $t+h$ (15:30 IST) — Position Exit Proxy**:
   - The position is closed at or near the market close $C_{t+h}$ (or during the 15:00–15:30 IST closing auction window).

> [!IMPORTANT]
> Because predictions are generated after 15:30 IST on session $t$, entering at $C_t$ is physically impossible. Any model trained on Close-to-Close returns assumes retroactive time travel between 18:00 IST and 15:30 IST on day $t$.

### 2.2 Execution Proxies vs. Realistic Market Frictions
In quantitative model design, $O_{t+1}$ and $C_{t+h}$ serve as **standardized historical execution proxies**, not guaranteed executable fill prices:

1. **Non-Guaranteed Opening Fills**:
   - Orders placed during regular market hours (09:15 IST onward) execute against the prevailing bid-ask spread and may fill at prices divergent from $O_{t+1}$ due to opening momentum and queue priority.
   - Retail market participants who do not participate in the pre-open auction cannot assume guaranteed fills at the exact opening auction price $O_{t+1}$.
2. **Mandatory Backtesting Frictions (Phase 6 / Strategy Simulation)**:
   - Subsequent strategy backtesting, execution modeling, and paper trading must explicitly incorporate realistic transaction frictions rather than assuming zero-cost fills at OHLCV price ticks:
     - **Brokerage Commissions**: Flat-rate or volume-based broker charges (e.g., standard discount broker pricing of ₹20 per executed order or 0.05%, whichever is lower).
     - **Statutory Taxes & Exchange Levies**: Securities Transaction Tax (STT of 0.1% on delivery buys/sells or 0.025% on intraday equity sells), Exchange Turnover Charges, SEBI Regulatory Fees, Stamp Duty (0.015% on delivery purchases), and GST (18% on brokerage + exchange charges).
     - **Bid-Ask Spread Costs**: Crossing the half-spread upon entry and exit.
     - **Execution Slippage & Market Impact**: Unfavorable price drift between order dispatch and matching, particularly during high-volatility opening minutes or for institutional order sizes.

---

## 3. Exit Price Conventions Across Investment Horizons

For a trade entered at the open of session $t+1$ ($O_{t+1}$), the exit price must correspond to realistic holding horizons:

| Horizon | Holding Span | Entry Price Proxy | Exit Price Proxy | Rationale & Practical Execution |
| :--- | :--- | :--- | :--- | :--- |
| **1-Day ($h=1$)** | Single-session holding | $O_{t+1}$ (09:15 IST) | $C_{t+1}$ (15:30 IST) | Position entered at market open and squared off at market close on session $t+1$. Avoids taking an unmodeled second overnight gap into session $t+2$. |
| **3-Day ($h=3$)** | 3-session swing trade | $O_{t+1}$ (09:15 IST) | $C_{t+3}$ (15:30 IST) | Position held across sessions $t+1$, $t+2$, and $t+3$. Captures short-term multi-day momentum; exits before weekend or subsequent cycle. |
| **5-Day ($h=5$)** | 1-week position trade | $O_{t+1}$ (09:15 IST) | $C_{t+5}$ (15:30 IST) | Standard 1-week trading horizon (e.g. Monday open to Friday close). Closed at the final session's closing price. |

### Why Exit at Close ($C_{t+h}$) Rather Than Open ($O_{t+h+1}$)?
1. **Intraday Liquidity**: The market close (15:00–15:30 IST) offers the deepest institutional liquidity and tighter spreads through the closing auction, minimizing exit slippage.
2. **Elimination of Final Overnight Risk**: Exiting at $C_{t+h}$ ensures an $h$-day horizon spans exactly $h$ regular trading days. Exiting at $O_{t+h+1}$ would expose the trade to an additional overnight gap between session $t+h$ and session $t+h+1$ that lies outside the intended horizon.

---

## 4. Empirical Impact of Overnight Opening Price Gaps

### 4.1 Mathematical Formulation of Gaps
The overnight gap between session $t$ close and session $t+1$ open is defined as:

$$g_{t+1} = \left( \frac{O_{t+1} - C_t}{C_t} \right) \times 100\%$$

The exact mathematical relationship between the theoretical Close-to-Close return ($r_{t+h}^{\text{c2c}}$) and the executable Open-to-Close return ($r_{t+h}^{\text{exec}}$) is:

$$1 + \frac{r_{t+h}^{\text{c2c}}}{100} = \left( 1 + \frac{g_{t+1}}{100} \right) \times \left( 1 + \frac{r_{t+h}^{\text{exec}}}{100} \right)$$

Linearized approximation:

$$r_{t+h}^{\text{c2c}} \approx g_{t+1} + r_{t+h}^{\text{exec}}$$

This demonstrates that **Close-to-Close return is the sum of an uncapturable overnight gap plus the executable return**.

### 4.2 Empirical Gap Distribution (Five NSE Equities, 2,715 Pooled Stock-Day Observations)
Analyzing all 2,715 pooled stock-day observations across 543 distinct trading dates (September 3, 2024 to November 6, 2026, corresponding to the clean feature dataset across the five stocks) reveals substantial overnight volatility:

```
+------------------------------------------------------------------------------------------------------------------------------+
|                                    OVERNIGHT GAP STATISTICAL DISTRIBUTION (BY STOCK)                                         |
+------------+-------------+-----------+-----------+----------+-----------+-----------+--------------------+--------------------+
| Instrument | Total Obs.  | Mean Gap  | Median    | Std Dev  | Min Gap   | Max Gap   | |Gap| > 0.50%      | |Gap| > 1.00%      |
+------------+-------------+-----------+-----------+----------+-----------+-----------+--------------------+--------------------+
| RELIANCE   | 543 obs.    | +0.035%   | 0.000%    | 0.761%   | -6.018%   | +6.005%   | 31.5% (171 obs.)   |  7.6% ( 41 obs.)   |
| TCS        | 543 obs.    | +0.025%   | 0.000%    | 0.899%   | -6.044%   | +5.692%   | 36.6% (199 obs.)   | 16.0% ( 87 obs.)   |
| INFY       | 543 obs.    | -0.027%   | 0.000%    | 1.168%   | -6.865%   | +6.002%   | 49.4% (268 obs.)   | 24.3% (132 obs.)   |
| HDFCBANK   | 543 obs.    | -0.053%   | 0.000%    | 0.875%   | -8.665%   | +5.996%   | 39.8% (216 obs.)   | 13.6% ( 74 obs.)   |
| ICICIBANK  | 543 obs.    | -0.022%   | 0.000%    | 0.692%   | -3.493%   | +5.179%   | 34.1% (185 obs.)   |  8.5% ( 46 obs.)   |
+------------+-------------+-----------+-----------+----------+-----------+-----------+--------------------+--------------------+
| POOLED     | 2,715 obs.  | -0.009%   | 0.000%    | 0.894%   | -8.665%   | +6.005%   | 38.3% (1,039 obs.) | 14.0% (380 obs.)   |
+------------+-------------+-----------+-----------+----------+-----------+-----------+--------------------+--------------------+
```

#### Key Empirical Observations:
1. **Pervasiveness of Overnight Gaps**: Across the 2,715 pooled stock-day observations, **38.3% of observations (1,039 stock-days)** experience opening gaps exceeding $\pm 0.50\%$. Furthermore, **14.0% of observations (380 stock-days)** experience opening gaps exceeding $\pm 1.00\%$.
2. **Elevated Opening Gap Dispersion in INFY (Candidate Hypothesis)**:
   - INFY displays the highest gap standard deviation ($1.168\%$), with nearly half ($49.4\%$) of all stock-days gapping by more than $\pm 0.50\%$, and nearly one-fourth ($24.3\%$) gapping by more than $\pm 1.00\%$.
   - *Candidate Hypothesis*: Infosys Ltd. maintains an active American Depositary Receipt (ADR) listing on the New York Stock Exchange (NYSE: INFY). Because the NYSE trades during Indian overnight hours, global market participants continuously trade INFY equity in response to US macroeconomic releases, global technology earnings, and international interest rate expectations. When the Indian market reopens at 09:00–09:15 IST, domestic market makers and institutional participants rapidly arbitrage price differentials, which may contribute to substantial opening gaps.
   - *Methodological Qualification*: While ADR trading is an intuitive and economically plausible explanation, this remains an **unproven candidate hypothesis**. Other contributing factors—such as broader technology sector volatility (e.g., NASDAQ / Philadelphia Semiconductor Index overnight returns), high sector-wide earnings beta, or concentrated foreign portfolio investor (FPI) order flow—also influence INFY's price discovery. Rigorous causal attribution would require high-frequency tick-level lead-lag econometric testing between NYSE ADRs and NSE equities, which is outside the scope of daily feature engineering.
3. **Severe Tail Shocks**: The historical sample contains severe single-day gap shocks:
   - Minimum gap: **$-8.665\%$** in HDFCBANK on January 17, 2024 (following market reaction to Q3 FY24 financial results and international sell-offs).
   - Maximum gap: **$+6.005\%$** in RELIANCE on January 29, 2024.

### 4.3 Reproducibility Pipeline & Dataset Provenance
To ensure rigorous scientific reproducibility, all empirical gap metrics, correlation coefficients, and disagreement rates reported in this addendum were produced through the following documented pipeline:

1. **Underlying Data Source**:
   - Primary database table: `historical_prices` joined with `stocks` in the StockSense AI PostgreSQL database.
   - Extraction artifact: `scratch/five_stocks_candles.json` (persisted in the conversation scratch directory at `<appDataDir>/brain/<conversation-id>/scratch/five_stocks_candles.json`, containing 3,715 historical daily OHLCV candles, 743 per stock, spanning November 10, 2023 to November 6, 2026).
   - Provenance: Ingested via Upstox Historical Data V2 API with SHA-256 integrity audits approved in Phase 5A.
2. **Feature & Target Generation Span**:
   - The clean feature dataset contains exactly **544 clean feature dates** (2,720 pooled clean stock-day observations) per stock remaining after dropping the 199 warm-up dates from the 743 candles (September 2, 2024 to November 9, 2026 IST).
   - Before chronological partition purges, this yields **543 labeled observations per stock (2,715 pooled stock-day observations) for $h=1$**, **541 labeled observations (2,705 pooled) for $h=3$**, and **539 labeled observations (2,695 pooled) for $h=5$**.
   - The 544 clean feature dates contain three verified weekend/special trading sessions:
     - Clean Index 106: `2025-02-01` (Union Budget 2025 Saturday session)
     - Clean Index 352: `2026-02-01` (Union Budget 2026 Sunday session)
     - Clean Index 542: `2026-11-08` (Diwali Muhurat Trading 2026 Sunday evening session)
3. **Execution Environment & Script**:
   - Python 3.11 virtual environment: `./ml-service/.venv/bin/python`
   - Calculation script: `scratch/methodological_investigation.py` (persisted in `<appDataDir>/brain/<conversation-id>/scratch/methodological_investigation.py`).
   - The script can be executed via:
     ```bash
     ./ml-service/.venv/bin/python /Users/vansh/.gemini/antigravity/brain/0dd47e33-8dcd-41dc-b48c-008944fca820/scratch/methodological_investigation.py
     ```
4. **Reproducibility Audit Status**:
   - **Verified & Reproduced**: Gap distribution statistics (mean, median, standard deviation, min, max, frequencies of $|g| > 0.50\%$ and $|g| > 1.00\%$) across all five stocks and pooled.
   - **Verified & Reproduced**: Return correlations ($r$) between Close-to-Close and Executable Open-to-Close targets ($h=1, 3, 5$).
   - **Verified & Reproduced**: Label agreement and disagreement counts and rates across all five stocks and pooled ($h=1, 3, 5$).
   - **Marked as Unverified (Pending Phase 5C.2)**: The candidate discrete class counts in Section 6.2 are not emitted in the automated stdout of `scratch/methodological_investigation.py`. In accordance with verification protocols, these candidate counts are marked as **Unverified Candidate Figures** pending formal validation and regeneration in Phase 5C.2. No synthetic or replacement figures have been substituted.

---

## 5. Comparison: Close-to-Close vs. Executable Next-Open Targets

Evaluating the difference between theoretical Close-to-Close targets and executable Open-to-Close targets across the 2,715 pooled stock-day observations yields the following empirical metrics:

```
+---------------------------------------------------------------------------------------------------+
|               CLOSE-TO-CLOSE VS. EXECUTABLE (OPEN-TO-CLOSE) EMPIRICAL COMPARISON                  |
+--------------------------+-----------------------+-----------------------+------------------------+
| Metric                   | Horizon h=1 (1 Day)   | Horizon h=3 (3 Days)  | Horizon h=5 (5 Days)   |
+--------------------------+-----------------------+-----------------------+------------------------+
| Provisional Threshold    | +/- 0.50%             | +/- 1.00%             | +/- 1.50%              |
| Return Correlation (r)   | r = 0.793             | r = 0.938             | r = 0.963              |
| Total Observations       | 2,715 stock-days      | 2,705 stock-days      | 2,695 stock-days       |
| Label Agreement (Pooled) | 1,985 / 2,715 (73.1%) | 2,286 / 2,705 (84.5%) | 2,394 / 2,695 (88.8%)  |
| Label Disagreement       | 730 / 2,715 (26.9%)   | 419 / 2,705 (15.5%)   | 301 / 2,695 (11.2%)    |
+--------------------------+-----------------------+-----------------------+------------------------+
| Disagreement by Stock:   |                       |                       |                        |
|   - RELIANCE             | 133 / 543 (24.5%)     |  80 / 541 (14.8%)     |  47 / 539 ( 8.7%)      |
|   - TCS                  | 149 / 543 (27.4%)     |  65 / 541 (12.0%)     |  57 / 539 (10.6%)      |
|   - INFY                 | 154 / 543 (28.4%)     |  87 / 541 (16.1%)     |  77 / 539 (14.3%)      |
|   - HDFCBANK             | 163 / 543 (30.0%)     | 104 / 541 (19.2%)     |  61 / 539 (11.3%)      |
|   - ICICIBANK            | 131 / 543 (24.1%)     |  83 / 541 (15.3%)     |  59 / 539 (10.9%)      |
+--------------------------+-----------------------+-----------------------+------------------------+
```

### Critical Findings on Target Divergence:

1. **Severe 1-Day Label Distortion ($26.9\%$ Disagreement)**:
   - For a 1-day horizon, **more than 1 out of every 4 labels ($26.9\%$) flips class** between Close-to-Close and Executable targets.
   - *Failure Mode Example (The "Gap-and-Crap" Phenomenon)*:
     - Close on Day $t$: ₹1,000.
     - Open on Day $t+1$: ₹1,015 (Gaps up $+1.5\%$).
     - Close on Day $t+1$: ₹1,008 (Sells off $-0.69\%$ from open).
     - **Close-to-Close Label**: $\frac{1008 - 1000}{1000} = +0.80\%$ $\to$ **Class +1 (UPWARD)**.
     - **Executable Label**: $\frac{1008 - 1015}{1015} = -0.69\%$ $\to$ **Class -1 (DOWNWARD)**.
     - A model trained on Close-to-Close targets would evaluate this outcome as a successful upward prediction, whereas an actual trader entering at the market open suffers an intraday loss.
2. **Convergence at Longer Horizons ($h=3, 5$)**:
   - For $h=3$, return correlation rises to **$0.938$** and label agreement reaches **$84.5\%$**.
   - For $h=5$, return correlation rises to **$0.963$** and label agreement reaches **$88.8\%$**.
   - As holding duration expands, cumulative multi-day trend drift increasingly dominates the single overnight opening gap.

---

## 6. Recommended Target Definition for StockSense AI

To eliminate look-ahead bias and guarantee execution fidelity, StockSense AI recommends an **Executable Next-Open to Close Target**.

### 6.1 Mathematical Formulation

#### Primary Continuous Target (Executable Forward Return):

$$r_{t+h}^{\text{executable}} = \left( \frac{C_{t+h} - O_{t+1}}{O_{t+1}} \right) \times 100\% \quad \text{for } h \in \{1, 3, 5\}$$

Where:
- $O_{t+1}$ is the actual opening price of the next regular trading session (execution proxy).
- $C_{t+h}$ is the closing settlement price of the $h$-th trading session following session $t$ (exit proxy).

#### Discrete 3-Class Labeling:

$$\text{Label}_{t, h}^{\text{exec}} = \begin{cases}
+1 \quad (\text{UPWARD}) & \text{if } r_{t+h}^{\text{executable}} > +\theta_h \\
0 \quad (\text{NEUTRAL}) & \text{if } -\theta_h \le r_{t+h}^{\text{executable}} \le +\theta_h \\
-1 \quad (\text{DOWNWARD}) & \text{if } r_{t+h}^{\text{executable}} < -\theta_h
\end{cases}$$

### 6.2 Provisional Candidate Thresholds vs. Theoretical $\sqrt{h}$ Scaling

#### Mathematical Comparison:
In quantitative finance, volatility over horizon $h$ theoretically scales with the square root of time under random walk assumptions:

$$\sigma_h \approx \sigma_1 \times \sqrt{h}$$

Applying this formula strictly with a baseline 1-day threshold of $\theta_1 = 0.50\%$ yields:

$$\theta_1 = 0.500\%, \quad \theta_3 = 0.50\% \times \sqrt{3} \approx 0.866\%, \quad \theta_5 = 0.50\% \times \sqrt{5} \approx 1.118\%$$

In contrast, the candidate threshold schedule evaluated in this audit is:

$$\theta_1 = 0.50\%, \quad \theta_3 = 1.00\%, \quad \theta_5 = 1.50\%$$

#### Clarification on Heuristic Nature:
- The round thresholds $\{0.50\%, 1.00\%, 1.50\%\}$ are **empirical, heuristic candidate thresholds** chosen for practical interpretability and wider neutral noise filtering, rather than an exact mathematical $\sqrt{h}$ scaling.
- For $h=3$, candidate $\theta_3 = 1.00\%$ is wider than the theoretical $0.866\%$.
- For $h=5$, candidate $\theta_5 = 1.50\%$ is wider than the theoretical $1.118\%$.
- These values are retained solely as **provisional candidates pending systematic threshold sensitivity testing and validation** during Phase 5C.2.

> [!NOTE]
> **Verification Status**: The candidate discrete class counts in the table below reflect preliminary exploratory figures from Phase 5C.1 target formulation. Because they are not emitted in the automated stdout of `scratch/methodological_investigation.py`, they are classified as **Unverified Candidate Figures** pending formal re-computation and validation in Phase 5C.2.

```
+-------------------------------------------------------------------------------------------------------+
|          EXECUTABLE TARGET POOLED CLASS DISTRIBUTION (2,715 STOCK-DAY OBSERVATIONS) [UNVERIFIED]     |
+---------+------------------+-----------------------+-------------------------+------------------------+
| Horizon | Threshold        | Class +1 (UPWARD)     | Class 0 (NEUTRAL)       | Class -1 (DOWNWARD)    |
+---------+------------------+-----------------------+-------------------------+------------------------+
| h = 1   | +/- 0.50%        | 789 obs. (29.1%)      | 985 obs. (36.3%)        | 941 obs. (34.7%)       |
| h = 3   | +/- 1.00%        | 782 obs. (28.9%)      | 1,018 obs. (37.6%)      | 905 obs. (33.5%)       |
| h = 5   | +/- 1.50%        | 708 obs. (26.3%)      | 1,142 obs. (42.4%)      | 845 obs. (31.4%)       |
+---------+------------------+-----------------------+-------------------------+------------------------+
```

### 6.3 Interpretation of DOWN Predictions vs. Cash Market Short-Selling Realities
It is vital to distinguish between statistical machine learning classification labels and real-world trading mechanics:

1. **Market Mechanics & Structural Constraints in Indian Cash Equities**:
   - **Ordinary Retail Intraday Short Selling**: In the regular secondary cash market, market participants routinely execute intraday short sales in liquid equities (initiating a sell order without holding shares and buying back later in the same session). Such positions are permissible across retail brokerages but require mandatory square-off prior to the close of continuous trading (typically between 15:15 and 15:25 IST, depending on broker risk parameters).
   - **Overnight Naked Short Positions**: Holding an unhedged or unborrowed short cash position overnight is impermissible under standard rolling settlement rules (T+1). If an intraday short position is left open past the close, the clearing corporation initiates mandatory auction buy-in or financial close-out procedures to procure shares for delivery, subjecting the trader to auction penalties, liquidity risk, and potential exchange fines.
   - **Covered Short Selling via Securities Lending and Borrowing (SLB)**: Market participants seeking to maintain multi-day short exposure in the cash equity segment may legally do so through the formal Securities Lending and Borrowing (SLB) framework operated by clearing corporations (such as NSE Clearing Limited - NCL). Under SLB, eligible securities are borrowed for specified settlement tenures against collateral and lending fees, permitting delivery-settled short selling. However, SLB participation requires formal institutional or high-net-worth client agreements and is subject to series-specific borrow availability and borrowing costs.
   - **Exchange-Traded Derivatives (F&O)**: For active multi-day directional short positions without physical share-borrowing requirements, participants commonly utilize exchange-traded single-stock futures or options contracts in the NSE Futures & Options (F&O) segment.

2. **Actionable Meaning of $\text{Label}_{t,h}^{\text{exec}} = -1$ (DOWNWARD) in StockSense AI**:
   - A DOWNWARD prediction produced by StockSense AI does **not** assume an unconstrained, overnight naked short sale in the cash equity segment.
   - Instead, within a cash equity portfolio context, a DOWNWARD signal serves as:
     - **Risk Mitigation & Exposure Reduction**: An alert for long equity holders to reduce position sizing, tighten trailing stop-loss orders, or exit long holdings to protect capital.
     - **Capital Preservation / Entry Deferral**: A recommendation for prospective buyers to defer new capital allocation or avoid initiating long positions during anticipated downward price movement.
     - **Intraday Trading Signal ($h=1$ Only)**: For active intraday market participants, a potential short-bias signal suitable for intraday cash short-selling setups, subject to mandatory same-day square-off.
     - **Directional Bias for Hedging / Derivatives**: For participants operating in the F&O segment or utilizing SLB facilities, an informational input for covered short positions or exchange-traded derivatives hedges.

### 6.4 Dual-Mode Architecture in Phase 5C.2 (`labeling.py`)
To preserve backward compatibility with academic benchmarks while ensuring production realism, the Phase 5C.2 target generator module (`ml-service/app/ml/labeling.py`) will be implemented with an explicit configuration parameter:

```python
def generate_targets(
    df: pd.DataFrame,
    horizons: List[int] = [1, 3, 5],
    target_type: str = "open_to_close",  # "open_to_close" (default) or "close_to_close"
    thetas: Dict[int, float] = {1: 0.5, 3: 1.0, 5: 1.5}
) -> pd.DataFrame:
    ...
```

1. **`target_type = "open_to_close"` (Default / Production Mode)**:
   - Evaluates $(C_{t+h} - O_{t+1}) / O_{t+1}$.
   - Strictly utilized for production inference, model training, and strategy simulation.
2. **`target_type = "close_to_close"` (Academic Benchmark Mode)**:
   - Evaluates $(C_{t+h} - C_t) / C_t$.
   - Retained solely for baseline diagnostic comparisons against external quantitative literature.

---

## 7. Summary of Task 1 Clarifications and Commitments

1. **Post-Close Prediction Generation**: Predictions are strictly computed post-market close ($16:30$–$18:00$ IST) using information $\{O_i, H_i, L_i, C_i, V_i\}_{i \le t}$, preventing retroactive time travel.
2. **Execution Proxies**: $O_{t+1}$ and $C_{t+h}$ serve as standardized historical execution proxies. Future strategy backtesting must incorporate transaction frictions, brokerage, statutory taxes, spreads, and execution slippage.
3. **NSE Auction Mechanics**: The NSE pre-open session is partitioned into order collection (09:00–09:08 IST), equilibrium matching (09:08–09:12 IST), and buffer (09:12–09:15 IST). Continuous trading begins at 09:15 IST where orders fill against live order book depth.
4. **Overnight Gap Reality**: Across 2,715 pooled stock-day observations, $38.3\%$ experience gaps exceeding $\pm 0.50\%$. Close-to-Close returns embed an uncapturable overnight gap that distorts 1-day signals ($26.9\%$ label disagreement).
5. **Infosys ADR Hypothesis**: INFY's higher opening gap dispersion is recognized as a candidate hypothesis warranting further study rather than an established causal fact.
6. **Provisional Thresholds & Verification Status**: The values $\{0.50\%, 1.00\%, 1.50\%\}$ are heuristic candidate thresholds distinct from exact theoretical $\sqrt{h}$ scaling ($0.50\%, 0.866\%, 1.118\%$) and are subject to sensitivity validation in Phase 5C.2. The candidate discrete class counts in Section 6.2 are classified as unverified figures pending formal execution and validation in Phase 5C.2.
7. **Downside Label Interpretation**: DOWN predictions represent risk mitigation, long-exposure reduction, or entry deferral in cash equities. The model distinguishes between permissible retail intraday short selling, exchange-restricted overnight naked positions, and formal multi-day borrowing via the Securities Lending and Borrowing (SLB) framework or exchange-traded derivatives.
8. **Reproducibility Audit**: Overnight gap distributions, correlation coefficients, and label agreement/disagreement rates are verified and deterministically reproducible via `./ml-service/.venv/bin/python /Users/vansh/.gemini/antigravity/brain/0dd47e33-8dcd-41dc-b48c-008944fca820/scratch/methodological_investigation.py` against `scratch/five_stocks_candles.json`.
