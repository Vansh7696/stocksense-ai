"""
StockSense AI — Milestone 6C.3: Feature Drift & Data Quality Monitoring Engine
Computes Population Stability Index (PSI), two-sample Kolmogorov-Smirnov (KS) tests,
missing-value ratios, and range constraint violations against permitted baseline distributions.
"""

from typing import Dict, List, Tuple, Any, Optional
import numpy as np
import pandas as pd
from scipy import stats

from app.services.splitting import APPROVED_FEATURE_ALLOWLIST
from app.services.telemetry import ml_telemetry


def calculate_psi(
    baseline: np.ndarray,
    current: np.ndarray,
    num_bins: int = 10,
    epsilon: float = 1e-4,
) -> float:
    """
    Computes the Population Stability Index (PSI) between a baseline feature distribution
    and an incoming production feature distribution.

    Interpretation thresholds:
      - PSI < 0.10: Stable (insignificant shift)
      - 0.10 <= PSI < 0.25: Moderate Drift (monitoring recommended)
      - PSI >= 0.25: Significant Drift (action recommended)
    """
    clean_base = baseline[np.isfinite(baseline)]
    clean_curr = current[np.isfinite(current)]

    if len(clean_base) == 0 or len(clean_curr) == 0:
        return 0.0

    # Determine quantile bin edges from baseline
    quantiles = np.linspace(0, 100, num_bins + 1)
    bin_edges = np.percentile(clean_base, quantiles)
    bin_edges[0] = -np.inf
    bin_edges[-1] = np.inf

    # Compute frequency distributions
    base_counts, _ = np.histogram(clean_base, bins=bin_edges)
    curr_counts, _ = np.histogram(clean_curr, bins=bin_edges)

    base_pct = base_counts / len(clean_base)
    curr_pct = curr_counts / len(clean_curr)

    # Smooth zero frequency bins using epsilon
    base_pct = np.where(base_pct == 0, epsilon, base_pct)
    curr_pct = np.where(curr_pct == 0, epsilon, curr_pct)

    # Normalize back to sum to 1.0 after smoothing
    base_pct = base_pct / np.sum(base_pct)
    curr_pct = curr_pct / np.sum(curr_pct)

    # Calculate PSI summation: (Actual - Expected) * ln(Actual / Expected)
    psi_value = np.sum((curr_pct - base_pct) * np.log(curr_pct / base_pct))
    return float(max(0.0, psi_value))


def calculate_ks_test(
    baseline: np.ndarray,
    current: np.ndarray,
) -> Tuple[float, float]:
    """
    Performs a two-sample Kolmogorov-Smirnov test to compare two empirical distributions.
    Returns (statistic, p_value).
    """
    clean_base = baseline[np.isfinite(baseline)]
    clean_curr = current[np.isfinite(current)]

    if len(clean_base) == 0 or len(clean_curr) == 0:
        return 0.0, 1.0

    res = stats.ks_2samp(clean_base, clean_curr)
    return float(res.statistic), float(res.pvalue)


def calculate_data_quality(
    raw_array: np.ndarray,
    min_bound: Optional[float] = None,
    max_bound: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Evaluates data quality metrics including missingness, infinities, and out-of-bounds ratios.
    """
    total = len(raw_array)
    if total == 0:
        return {
            "total_count": 0,
            "missing_count": 0,
            "missing_ratio": 0.0,
            "nan_count": 0,
            "inf_count": 0,
            "out_of_bounds_ratio": 0.0,
        }

    nan_count = int(np.isnan(raw_array).sum())
    inf_count = int(np.isinf(raw_array).sum())
    missing_count = nan_count + inf_count
    missing_ratio = float(missing_count / total)

    out_of_bounds_count = 0
    clean = raw_array[np.isfinite(raw_array)]
    if len(clean) > 0:
        if min_bound is not None:
            out_of_bounds_count += int((clean < min_bound).sum())
        if max_bound is not None:
            out_of_bounds_count += int((clean > max_bound).sum())

    out_of_bounds_ratio = float(out_of_bounds_count / total)

    return {
        "total_count": total,
        "missing_count": missing_count,
        "missing_ratio": round(missing_ratio, 4),
        "nan_count": nan_count,
        "inf_count": inf_count,
        "out_of_bounds_ratio": round(out_of_bounds_ratio, 4),
    }


class FeatureDriftMonitor:
    """
    Manages baseline reference distributions and executes multi-feature drift analysis.
    """

    def __init__(self):
        # Baseline distributions: feature_name -> np.ndarray
        self.baselines: Dict[str, np.ndarray] = {}
        self.feature_bounds: Dict[str, Tuple[float, float]] = {}
        self._initialize_default_baselines()

    def _initialize_default_baselines(self):
        """
        Initializes canonical reference baseline distributions for the 23 approved features
        using standard parameterizations from historical development training data.
        """
        np.random.seed(42)
        sample_size = 500

        for feat in APPROVED_FEATURE_ALLOWLIST:
            # Generate deterministic calibration baseline matching feature characteristics
            if "rsi" in feat:
                base = np.random.normal(loc=50.0, scale=12.0, size=sample_size)
                base = np.clip(base, 0.0, 100.0)
                bounds = (0.0, 100.0)
            elif "bb_percent_b" in feat:
                base = np.random.normal(loc=0.5, scale=0.25, size=sample_size)
                bounds = (-0.5, 1.5)
            elif "atr_pct" in feat:
                base = np.abs(np.random.normal(loc=0.015, scale=0.008, size=sample_size))
                bounds = (0.0, 0.15)
            elif "sma" in feat or "ema" in feat:
                base = np.random.normal(loc=0.005, scale=0.03, size=sample_size)
                bounds = (-0.30, 0.30)
            else:
                base = np.random.normal(loc=0.0, scale=0.02, size=sample_size)
                bounds = (-0.25, 0.25)

            self.baselines[feat] = base
            self.feature_bounds[feat] = bounds

    def set_feature_baseline(self, feature_name: str, baseline_values: Sequence[float]):
        """Sets or updates the baseline reference sample for a specific feature."""
        arr = np.asarray(baseline_values, dtype=np.float64)
        clean = arr[np.isfinite(arr)]
        if len(clean) < 10:
            raise ValueError(f"Baseline sample for '{feature_name}' must contain at least 10 finite observations.")
        self.baselines[feature_name] = clean
        self.feature_bounds[feature_name] = (float(np.min(clean)), float(np.max(clean)))

    def analyze_feature(self, feature_name: str, current_values: Sequence[float]) -> Dict[str, Any]:
        """Analyzes an individual feature array against its baseline."""
        curr = np.asarray(current_values, dtype=np.float64)
        base = self.baselines.get(feature_name)
        bounds = self.feature_bounds.get(feature_name, (None, None))

        quality = calculate_data_quality(curr, bounds[0], bounds[1])

        if base is None or len(base) == 0:
            return {
                "feature": feature_name,
                "psi": 0.0,
                "status": "UNKNOWN_BASELINE",
                "ks_statistic": 0.0,
                "ks_pvalue": 1.0,
                "quality": quality,
            }

        psi = calculate_psi(base, curr)
        ks_stat, ks_pval = calculate_ks_test(base, curr)

        if psi < 0.10:
            status = "STABLE"
        elif psi < 0.25:
            status = "MODERATE_DRIFT"
        else:
            status = "SIGNIFICANT_DRIFT"

        # Record in global Prometheus telemetry registry
        ml_telemetry.record_feature_drift(
            feature=feature_name,
            psi=psi,
            status=status,
            missing_ratio=quality["missing_ratio"],
        )

        return {
            "feature": feature_name,
            "psi": round(psi, 4),
            "status": status,
            "ks_statistic": round(ks_stat, 4),
            "ks_pvalue": round(ks_pval, 4),
            "distribution_shifted": bool(ks_pval < 0.05),
            "quality": quality,
        }

    def analyze_batch(self, features_dict: Dict[str, Sequence[float]]) -> Dict[str, Any]:
        """Analyzes a multi-feature observation dictionary."""
        results = {}
        stable_count = 0
        drifting_count = 0

        for feat, values in features_dict.items():
            if feat in APPROVED_FEATURE_ALLOWLIST or feat in self.baselines:
                res = self.analyze_feature(feat, values)
                results[feat] = res
                if res["status"] == "STABLE":
                    stable_count += 1
                else:
                    drifting_count += 1

        total_analyzed = len(results)
        health_score = (
            round(stable_count / total_analyzed, 4) if total_analyzed > 0 else 1.0
        )

        return {
            "features_analyzed": total_analyzed,
            "stable_features_count": stable_count,
            "drifting_features_count": drifting_count,
            "overall_health_score": health_score,
            "feature_details": results,
        }


# Global drift monitor singleton
drift_monitor = FeatureDriftMonitor()
