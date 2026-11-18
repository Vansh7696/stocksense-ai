"""
StockSense AI — Explainability & Feature Attribution Engine (Phase 5C.8)
Provides mathematical interpretability for multi-horizon directional ML predictions:
1. Native Tree SHAP computation for XGBoost models via booster margin pred_contribs.
2. Tree Path Impurity Decomposition (Saabas algorithm) for Random Forest models.
3. Closed-form normalized weight attributions for regularized linear baselines.
4. Human-readable domain interpretations and directionality alignment for 23 technical features.
"""

from typing import Dict, List, Any, Optional, Tuple
import math
import numpy as np
import pandas as pd
import xgboost as xgb

from app.schemas.inference import DirectionalClass, FeatureAttribution, CLASS_LABEL_TO_INT
from app.services.splitting import APPROVED_FEATURE_ALLOWLIST


FEATURE_METADATA: Dict[str, Dict[str, str]] = {
    "price_to_sma20": {
        "display_name": "Price vs SMA 20",
        "category": "Trend",
        "unit": "ratio",
    },
    "price_to_sma50": {
        "display_name": "Price vs SMA 50",
        "category": "Trend",
        "unit": "ratio",
    },
    "price_to_sma200": {
        "display_name": "Price vs SMA 200 (Long-Term)",
        "category": "Trend",
        "unit": "ratio",
    },
    "price_to_ema12": {
        "display_name": "Price vs EMA 12",
        "category": "Trend",
        "unit": "ratio",
    },
    "price_to_ema26": {
        "display_name": "Price vs EMA 26",
        "category": "Trend",
        "unit": "ratio",
    },
    "price_to_ema50": {
        "display_name": "Price vs EMA 50",
        "category": "Trend",
        "unit": "ratio",
    },
    "rsi_14": {
        "display_name": "RSI (14-period)",
        "category": "Momentum",
        "unit": "index",
    },
    "rsi_normalized": {
        "display_name": "Normalized RSI",
        "category": "Momentum",
        "unit": "oscillator",
    },
    "rsi_slope_5": {
        "display_name": "5-Day RSI Momentum Slope",
        "category": "Momentum",
        "unit": "slope",
    },
    "macd_hist": {
        "display_name": "MACD Histogram",
        "category": "Momentum",
        "unit": "delta",
    },
    "macd_hist_normalized": {
        "display_name": "Normalized MACD Momentum",
        "category": "Momentum",
        "unit": "delta",
    },
    "bb_percent_b": {
        "display_name": "Bollinger %B",
        "category": "Volatility",
        "unit": "oscillator",
    },
    "bb_zscore": {
        "display_name": "Bollinger Distance Z-Score",
        "category": "Volatility",
        "unit": "zscore",
    },
    "bb_bandwidth": {
        "display_name": "Bollinger Bandwidth",
        "category": "Volatility",
        "unit": "bandwidth",
    },
    "atr_pct": {
        "display_name": "Average True Range %",
        "category": "Volatility",
        "unit": "percent",
    },
    "return_1d": {
        "display_name": "1-Day Return",
        "category": "Momentum",
        "unit": "return",
    },
    "return_5d": {
        "display_name": "5-Day Return",
        "category": "Momentum",
        "unit": "return",
    },
    "return_21d": {
        "display_name": "21-Day Monthly Return",
        "category": "Momentum",
        "unit": "return",
    },
    "volatility_20d": {
        "display_name": "20-Day Realized Volatility",
        "category": "Volatility",
        "unit": "percent",
    },
    "relative_volume_20": {
        "display_name": "Relative Volume (vs 20-Day SMA)",
        "category": "Volume",
        "unit": "multiple",
    },
    "trend_alignment": {
        "display_name": "Moving Average Trend Stack",
        "category": "Trend",
        "unit": "alignment",
    },
    "ma_spread_50_200": {
        "display_name": "MA Spread (50 vs 200)",
        "category": "Trend",
        "unit": "spread",
    },
    "ma_spread_20_50": {
        "display_name": "MA Spread (20 vs 50)",
        "category": "Trend",
        "unit": "spread",
    },
}


def generate_feature_interpretation(
    feature: str,
    value: float,
    contribution: float,
    predicted_label: DirectionalClass,
) -> str:
    """
    Generates domain-informed market interpretation for a feature's observed value and sign.
    """
    meta = FEATURE_METADATA.get(feature, {})
    disp = meta.get("display_name", feature)
    is_positive_support = contribution > 0

    if feature == "rsi_14":
        if value >= 70:
            regime = "overbought (>70)"
        elif value <= 30:
            regime = "oversold (<30)"
        else:
            regime = f"neutral momentum ({value:.1f})"
        action = f"supports {predicted_label.value}" if is_positive_support else f"dampens {predicted_label.value}"
        return f"{disp} at {value:.1f} reflects {regime}, which {action}."

    if feature.startswith("price_to_"):
        ref = feature.replace("price_to_", "").upper()
        rel = "above" if value > 0 else "below"
        pct = abs(value) * 100
        return f"Price is {pct:.2f}% {rel} its {ref}, indicating strong {rel}-mean bias."

    if feature in ("return_1d", "return_5d", "return_21d"):
        span = feature.split("_")[1].upper()
        sign = "+" if value >= 0 else ""
        return f"{span} cumulative return of {sign}{value * 100:.2f}% drives recent price acceleration."

    if feature == "relative_volume_20":
        if value > 1.2:
            vol_desc = "elevated institutional participation"
        elif value < 0.8:
            vol_desc = "light consolidation trading"
        else:
            vol_desc = "average volume alignment"
        return f"Volume is {value:.2f}x its 20-day average, showing {vol_desc}."

    if feature == "atr_pct":
        return f"True Range volatility at {value * 100:.2f}% of price bounds the expected move."

    if feature in ("ma_spread_50_200", "ma_spread_20_50"):
        state = "bullish golden spread" if value > 0 else "bearish compression spread"
        return f"Moving average spread at {value * 100:.2f}% confirms {state}."

    # Generic fallback
    direction_desc = f"reinforces {predicted_label.value}" if is_positive_support else f"opposes {predicted_label.value}"
    return f"{disp} of {value:.3f} {direction_desc}."


class PredictionExplainer:
    """
    High-performance feature attribution and decision transparency engine.
    """

    def __init__(self, top_n: int = 5):
        self.top_n = top_n

    def explain(
        self,
        model: Any,
        X_df: pd.DataFrame,
        predicted_class: int,
        predicted_label: DirectionalClass,
    ) -> List[FeatureAttribution]:
        """
        Decomposes model prediction into top feature attributions.

        :param model: Loaded model from registry (InferenceModel or model bundle wrapper)
        :param X_df: 1-row DataFrame containing the 23 technical features
        :param predicted_class: -1 (DOWN), 0 (NEUTRAL), or 1 (UP)
        :param predicted_label: DirectionalClass enum
        :return: List of FeatureAttribution objects sorted by absolute impact
        """
        feature_names = list(X_df.columns)
        X_values = X_df.values[0]

        # Extract underlying estimator and scaler
        estimator = getattr(model, "model_", getattr(model, "estimator", model))
        if hasattr(estimator, "model_"):
            estimator = estimator.model_

        # Map predicted class to class index:
        # Canonical classes are [-1, 0, 1] -> index 0 (DOWN), 1 (NEUTRAL), 2 (UP)
        class_idx_map = {-1: 0, 0: 1, 1: 2}
        target_class_idx = class_idx_map.get(predicted_class, 1)

        contributions: Optional[np.ndarray] = None

        # Strategy 1: Native XGBoost Tree SHAP
        if hasattr(estimator, "get_booster"):
            try:
                booster = estimator.get_booster()
                dm = xgb.DMatrix(X_df.values, feature_names=feature_names)
                raw_contribs = booster.predict(dm, pred_contribs=True)
                # raw_contribs shape: (1, n_classes, n_features + 1) or (1, n_features + 1)
                if len(raw_contribs.shape) == 3:
                    contributions = raw_contribs[0, target_class_idx, :-1]
                else:
                    contributions = raw_contribs[0, :-1]
            except Exception:
                contributions = None

        # Strategy 2: Random Forest Decision Path Impurity Decomposition (Saabas algorithm)
        if contributions is None and hasattr(estimator, "estimators_"):
            try:
                n_trees = len(estimator.estimators_)
                tree_contribs = np.zeros(len(feature_names), dtype=np.float64)
                X_mat = X_df.values.astype(np.float32)

                for tree in estimator.estimators_:
                    tree_obj = tree.tree_
                    paths = tree_obj.decision_path(X_mat).toarray()[0]
                    node_ids = np.where(paths > 0)[0]
                    for step in range(len(node_ids) - 1):
                        p = node_ids[step]
                        c = node_ids[step + 1]
                        feat = tree_obj.feature[p]
                        if feat >= 0:
                            p_prob = tree_obj.value[p][0, target_class_idx] / np.sum(tree_obj.value[p][0])
                            c_prob = tree_obj.value[c][0, target_class_idx] / np.sum(tree_obj.value[c][0])
                            tree_contribs[feat] += (c_prob - p_prob)

                contributions = tree_contribs / n_trees
            except Exception:
                contributions = None

        # Strategy 3: Linear model weights dot product fallback
        if contributions is None and hasattr(estimator, "coef_"):
            try:
                coef = estimator.coef_
                if len(coef.shape) == 2:
                    w = coef[target_class_idx]
                else:
                    w = coef
                # Contribution is weight * standardized or raw feature value
                contributions = w * X_values
            except Exception:
                contributions = None

        # Strategy 4: Feature importance variance fallback
        if contributions is None and hasattr(estimator, "feature_importances_"):
            try:
                importances = estimator.feature_importances_
                # Signed by difference from mean
                contributions = importances * (X_values - np.mean(X_values))
            except Exception:
                contributions = None

        if contributions is None:
            # Equal weight fallback in unexpected edge cases
            contributions = np.zeros(len(feature_names))

        # Build feature attribution records
        raw_attributions = []
        for i, feat in enumerate(feature_names):
            val = float(X_values[i])
            contrib = float(contributions[i])
            if not math.isfinite(contrib):
                contrib = 0.0

            # Direction supported by this feature
            if contrib > 0.0001:
                feature_dir = predicted_label
            elif contrib < -0.0001:
                # Opposing direction
                feature_dir = DirectionalClass.DOWN if predicted_label == DirectionalClass.UP else DirectionalClass.UP
            else:
                feature_dir = DirectionalClass.NEUTRAL

            meta = FEATURE_METADATA.get(feat, {})
            disp_name = meta.get("display_name", feat)
            interpretation = generate_feature_interpretation(feat, val, contrib, predicted_label)

            raw_attributions.append(
                FeatureAttribution(
                    feature=feat,
                    value=round(val, 4),
                    contribution=round(contrib, 6),
                    direction=feature_dir,
                    display_name=disp_name,
                    description=interpretation,
                )
            )

        # Sort by absolute contribution magnitude descending and return top_n
        raw_attributions.sort(key=lambda a: abs(a.contribution), reverse=True)
        return raw_attributions[: self.top_n]
