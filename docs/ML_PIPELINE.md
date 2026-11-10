# StockSense AI — Machine Learning Pipeline Architecture

## 1. Overview
The machine learning component of StockSense AI operates as an isolated Python FastAPI microservice. Its purpose is to deliver **probabilistic, explainable financial recommendations** with strict mitigation against common quantitative modeling flaws (look-ahead bias, data leakage, and uncalibrated probabilities).

## 2. Recommendation Classes
- **BUY**: Expected risk-adjusted positive drift exceeding transaction threshold over the 1–5 trading day horizon.
- **HOLD**: Expected returns within normal volatility band; adverse risk/reward for new entry.
- **SELL**: High probability of negative price action or technical breakdown.
- **NO SIGNAL**: Emitted whenever missing data, non-stationary market conditions, or low model confidence (< 60%) occurs.

## 3. Methodological Safeguards
- **Time-Series Cross Validation (Walk-Forward Split)**:
  Standard random train/test splits are strictly prohibited. Models are trained on chronological partitions $(t_0 \dots t_k)$ and tested strictly on future periods $(t_{k+1} \dots t_{k+n})$.
- **Feature Engineering Without Leakage**:
  All rolling metrics (e.g., 14-day RSI, 20-day SMA) use lagging shifts such that bar $t$ features only rely on data available strictly prior to the market close of bar $t$.
- **SHAP (SHapley Additive exPlanations)**:
  TreeSHAP is executed on XGBoost predictions to attribute the exact marginal contribution of each indicator (e.g., "+0.18 BUY confidence due to RSI oversold condition", "-0.09 due to negative sector sentiment").
- **FinBERT Sentiment Ingestion**:
  Pre-trained Hugging Face FinBERT model extracts polarity from headlines and corporate disclosures, generating numeric sentiment vectors bounded between $[-1.0, 1.0]$.
