"""
StockSense AI — Baseline Classifiers Engine
Deterministic benchmark models for 3-class stock return direction forecasting:
1. MajorityClassifier — Naive frequency-based majority benchmark.
2. MomentumBaseline — Rule-based momentum thresholding benchmark.
Classes: DOWN (-1), NEUTRAL (0), UP (+1).
"""

from typing import Dict, List, Optional, Tuple, Any, Sequence, Union
import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar

from app.schemas.baselines import (
    MajorityClassifierMetadata,
    MomentumBaselineMetadata,
)
from app.services.metrics import (
    CLASS_LABELS,
    CLASS_NAMES,
    LABEL_TO_INDEX,
    INDEX_TO_LABEL,
    validate_and_normalize_probabilities,
)

# Canonical ordering of class labels
CANONICAL_LABELS: Tuple[int, int, int] = (-1, 0, 1)

# Approved Phase 5B feature allowlist index for return_1d
RETURN_1D_FEATURE_NAME: str = "return_1d"
RETURN_1D_ALLOWLIST_INDEX: int = 15  # Index in APPROVED_FEATURE_ALLOWLIST (23 features)


class MajorityClassifier:
    """
    Deterministic majority-class baseline classifier.

    Requirements & Behavior:
    - Fits exclusively on training target labels y_train.
    - Identifies the empirical mode (most frequent class) from y_train.
    - Deterministic tie-breaking priority: NEUTRAL (0) > UP (+1) > DOWN (-1).
      (Note: This priority order is an engineering implementation decision to ensure
      deterministic behavior; the original Phase 5C.3 design document did not specify
      a tie-breaking rule for training class frequency ties.)
    - Predicts the fitted majority class for all input observations.
    - Outputs constant 3-class probability estimates matching training empirical frequencies:
      Column 0: P(DOWN), Column 1: P(NEUTRAL), Column 2: P(UP).
    - Zero data leakage: ignores X features completely, never inspects validation or test labels.
    """

    def __init__(
        self,
        horizon: Optional[int] = None,
        tie_breaker_priority: Optional[List[int]] = None,
    ):
        self.horizon = horizon
        self.tie_breaker_priority = tie_breaker_priority or [0, 1, -1]
        self.majority_class_: Optional[int] = None
        self.class_frequencies_: Optional[Dict[int, float]] = None
        self.n_samples_: Optional[int] = None
        self.tie_broken_: bool = False
        self.is_fitted_: bool = False

    def fit(
        self,
        X: Any,
        y: Optional[Union[Sequence[int], np.ndarray, pd.Series]] = None,
    ) -> "MajorityClassifier":
        """
        Fits the majority classifier on training target labels.

        Args:
            X: Input features or target labels (if y is None).
            y: Target labels in {-1, 0, 1}.

        Returns:
            Fitted MajorityClassifier instance.
        """
        if y is None:
            # Called as fit(y)
            labels = np.asarray(X)
        else:
            labels = np.asarray(y)
            # If X is provided, validate length consistency
            x_arr = np.asarray(X)
            if len(x_arr) != len(labels):
                raise ValueError(
                    f"Sample count mismatch: X has {len(x_arr)} rows, y has {len(labels)} labels."
                )

        if labels.size == 0:
            raise ValueError("Cannot fit MajorityClassifier on empty training labels (size=0).")

        if labels.ndim != 1:
            raise ValueError(f"Target labels y must be 1D (got ndim={labels.ndim}).")

        if not np.all(np.isfinite(labels)):
            raise ValueError("Target labels contain non-finite values (NaN or Inf).")

        labels_int = labels.astype(np.int64)
        unique_labels = set(np.unique(labels_int))
        unapproved = unique_labels - set(CANONICAL_LABELS)
        if unapproved:
            raise ValueError(
                f"Unapproved labels detected in training targets: {sorted(list(unapproved))}. "
                f"Allowed labels: {list(CANONICAL_LABELS)}."
            )

        n_total = len(labels_int)
        self.n_samples_ = n_total

        # Count frequencies for all 3 classes (handles missing classes safely with count=0)
        counts: Dict[int, int] = {k: 0 for k in CANONICAL_LABELS}
        for lbl in labels_int:
            counts[lbl] += 1

        self.class_frequencies_ = {k: float(counts[k] / n_total) for k in CANONICAL_LABELS}

        # Determine majority class with deterministic tie-breaking
        max_count = max(counts.values())
        candidates = [k for k, cnt in counts.items() if cnt == max_count]

        if len(candidates) == 1:
            self.majority_class_ = candidates[0]
            self.tie_broken_ = False
        else:
            # Break tie deterministically using priority order
            self.majority_class_ = next(k for k in self.tie_breaker_priority if k in candidates)
            self.tie_broken_ = True

        self.is_fitted_ = True
        return self

    def predict(self, X: Any) -> np.ndarray:
        """
        Predicts the majority class for all observations in X.

        Args:
            X: Input features or array of observations.

        Returns:
            1D array of shape (N,) containing majority_class_.
        """
        if not self.is_fitted_:
            raise ValueError("MajorityClassifier is not fitted. Call fit() before predicting.")

        n_samples = len(X) if hasattr(X, "__len__") else np.asarray(X).shape[0]
        if n_samples == 0:
            raise ValueError("Cannot predict on empty input (size=0).")

        return np.full(n_samples, self.majority_class_, dtype=np.int64)

    def predict_proba(self, X: Any) -> np.ndarray:
        """
        Returns constant empirical class probabilities for each observation in X.

        Column ordering:
            Index 0: DOWN (-1)
            Index 1: NEUTRAL (0)
            Index 2: UP (+1)

        Args:
            X: Input features or array of observations.

        Returns:
            2D array of shape (N, 3) where each row is [P(DOWN), P(NEUTRAL), P(UP)].
        """
        if not self.is_fitted_:
            raise ValueError("MajorityClassifier is not fitted. Call fit() before predicting.")

        n_samples = len(X) if hasattr(X, "__len__") else np.asarray(X).shape[0]
        if n_samples == 0:
            raise ValueError("Cannot predict on empty input (size=0).")

        prob_row = np.array(
            [self.class_frequencies_[-1], self.class_frequencies_[0], self.class_frequencies_[1]],
            dtype=np.float64,
        )
        return np.tile(prob_row, (n_samples, 1))

    def get_metadata(self) -> MajorityClassifierMetadata:
        """Returns structured Pydantic audit metadata."""
        if not self.is_fitted_:
            raise ValueError("MajorityClassifier is not fitted. No metadata available.")

        return MajorityClassifierMetadata(
            majority_class=self.majority_class_,
            class_frequencies={
                "DOWN": self.class_frequencies_[-1],
                "NEUTRAL": self.class_frequencies_[0],
                "UP": self.class_frequencies_[1],
            },
            training_samples=self.n_samples_,
            tie_broken=self.tie_broken_,
            tie_breaker_priority=self.tie_breaker_priority,
            horizon=self.horizon,
        )


class MomentumBaseline:
    """
    Rule-based momentum baseline classifier.

    Methodology:
    - Uses the raw, unscaled return_1d feature available at prediction time.
    - Fits an empirical volatility threshold delta_h strictly on training observations:
      delta_h = std(return_1d_train, ddof=1)
      where ddof=1 produces the standard unbiased sample standard deviation.
    - Deterministic classification rule:
      UP (+1)       if return_1d > +delta_h
      DOWN (-1)     if return_1d < -delta_h
      NEUTRAL (0)   otherwise (-delta_h <= return_1d <= +delta_h)
    - 3-class Softmax Probability Estimates (Approved Piecewise Distance Scores):
      Section 4.2 of Phase 5C.3 design:
      s_UP      = return_1d - delta_h
      s_DOWN    = -return_1d - delta_h
      s_NEUTRAL = delta_h - |return_1d|
      Logits are scaled by calibrated temperature tau in [0.1, 10.0]:
      P(k) = exp(s_k / tau) / sum_j exp(s_j / tau)
    - Hard prediction and probability argmax consistency:
      predict(X) == argmax(predict_proba(X)) for all finite returns and delta_h >= 0,
      with deterministic tie handling where NEUTRAL wins boundary ties.
    - Temperature Calibration:
      tau is fit strictly on training data by minimizing training negative log-likelihood
      using SciPy bounded 1D optimization over [0.1, 10.0].
      If optimization fails or returns non-finite values, falls back deterministically to tau=1.0.
    """

    def __init__(
        self,
        horizon: Optional[int] = None,
        optimize_temperature: bool = True,
        default_temperature: float = 1.0,
        feature_name: str = RETURN_1D_FEATURE_NAME,
    ):
        self.horizon = horizon
        self.optimize_temperature = optimize_temperature
        self.default_temperature = float(default_temperature)
        self.feature_name = feature_name

        self.threshold_delta_: Optional[float] = None
        self.temperature_: Optional[float] = None
        self.training_mean_return_: Optional[float] = None
        self.training_std_return_: Optional[float] = None
        self.n_samples_: Optional[int] = None
        self.optimization_success_: bool = False
        self.optimization_nll_: Optional[float] = None
        self.optimizer_candidate_temperature_: Optional[float] = None
        self.optimizer_candidate_nll_: Optional[float] = None
        self.endpoint_lower_nll_: Optional[float] = None
        self.endpoint_upper_nll_: Optional[float] = None
        self.selected_candidate_type_: Optional[str] = None
        self.is_constant_return_: bool = False
        self.is_fitted_: bool = False

    def _extract_return_feature(self, X: Any) -> np.ndarray:
        """
        Robustly extracts the 1D raw return feature from various input formats:
        DataFrame, Series, 1D array, or 2D array.
        """
        if isinstance(X, pd.DataFrame):
            if self.feature_name in X.columns:
                r_series = X[self.feature_name]
            else:
                raise ValueError(
                    f"Required feature '{self.feature_name}' not found in DataFrame columns: {list(X.columns)[:5]}..."
                )
            r_arr = r_series.to_numpy(dtype=np.float64)
        elif isinstance(X, pd.Series):
            r_arr = X.to_numpy(dtype=np.float64)
        elif isinstance(X, np.ndarray):
            if X.ndim == 1:
                r_arr = X.astype(np.float64)
            elif X.ndim == 2:
                if X.shape[1] == 1:
                    r_arr = X[:, 0].astype(np.float64)
                elif X.shape[1] == 23:
                    # Approved 23 engineered features matrix from Phase 5B
                    r_arr = X[:, RETURN_1D_ALLOWLIST_INDEX].astype(np.float64)
                else:
                    raise ValueError(
                        f"Cannot extract '{self.feature_name}' from 2D array of shape {X.shape}. "
                        f"Pass a DataFrame with '{self.feature_name}' or a 1D return array."
                    )
            else:
                raise ValueError(f"Expected 1D or 2D array, got ndim={X.ndim}.")
        elif isinstance(X, (list, tuple)):
            r_arr = np.asarray(X, dtype=np.float64)
            if r_arr.ndim != 1:
                raise ValueError(f"Expected 1D sequence of returns, got shape {r_arr.shape}.")
        else:
            raise TypeError(f"Unsupported feature input type: {type(X)}")

        if r_arr.size == 0:
            raise ValueError("Return feature array is empty (size=0).")

        if not np.all(np.isfinite(r_arr)):
            raise ValueError("Return feature contains non-finite values (NaN or Inf).")

        return r_arr

    def fit(
        self,
        X: Any,
        y: Union[Sequence[int], np.ndarray, pd.Series],
    ) -> "MomentumBaseline":
        """
        Fits the momentum threshold delta_h and calibrates temperature tau on training data.

        Args:
            X: Training features containing raw return_1d.
            y: Training ground-truth target labels in {-1, 0, 1}.

        Returns:
            Fitted MomentumBaseline instance.
        """
        r_train = self._extract_return_feature(X)
        y_train = np.asarray(y)

        if len(r_train) != len(y_train):
            raise ValueError(
                f"Sample count mismatch: X has {len(r_train)} returns, y has {len(y_train)} labels."
            )

        if y_train.ndim != 1:
            raise ValueError(f"Target labels y must be 1D (got ndim={y_train.ndim}).")

        if not np.all(np.isfinite(y_train)):
            raise ValueError("Target labels contain non-finite values (NaN or Inf).")

        y_train_int = y_train.astype(np.int64)
        unique_labels = set(np.unique(y_train_int))
        unapproved = unique_labels - set(CANONICAL_LABELS)
        if unapproved:
            raise ValueError(
                f"Unapproved labels detected in training targets: {sorted(list(unapproved))}. "
                f"Allowed labels: {list(CANONICAL_LABELS)}."
            )

        n_train = len(r_train)
        self.n_samples_ = n_train
        self.training_mean_return_ = float(np.mean(r_train))

        # 1. Calculate threshold delta_h using ddof=1 sample standard deviation
        # If n_train == 1, sample std is undefined (ddof=1 gives NaN), handle safely
        if n_train < 2:
            raw_std = 0.0
        else:
            raw_std = float(np.std(r_train, ddof=1))

        self.training_std_return_ = raw_std

        # Handle zero-variance / constant return edge cases safely
        if raw_std <= 1e-12:
            self.threshold_delta_ = 0.0
            self.is_constant_return_ = True
        else:
            self.threshold_delta_ = raw_std
            self.is_constant_return_ = False

        # 2. Calibrate Softmax Temperature tau on training data
        if self.optimize_temperature and not self.is_constant_return_ and n_train >= 2:
            # One-hot encode y_train: col 0 = DOWN, col 1 = NEUTRAL, col 2 = UP
            y_onehot = np.zeros((n_train, 3), dtype=np.float64)
            for i, val in enumerate(y_train_int):
                y_onehot[i, LABEL_TO_INDEX[val]] = 1.0

            delta = self.threshold_delta_

            def nll_objective(tau: float) -> float:
                probs = self._compute_probabilities(r_train, delta, tau)
                # Clip to prevent log(0) during numerical optimization
                probs_clipped = np.clip(probs, 1e-15, 1.0 - 1e-15)
                probs_norm = probs_clipped / probs_clipped.sum(axis=1, keepdims=True)
                return -float(np.mean(np.sum(y_onehot * np.log(probs_norm), axis=1)))

            try:
                res = minimize_scalar(
                    nll_objective,
                    bounds=(0.1, 10.0),
                    method="bounded",
                )

                # Explicitly evaluate NLL at lower and upper interval endpoints
                tau_lower = 0.1
                nll_lower = float(nll_objective(tau_lower))

                tau_upper = 10.0
                nll_upper = float(nll_objective(tau_upper))

                self.endpoint_lower_nll_ = nll_lower
                self.endpoint_upper_nll_ = nll_upper

                candidates = []
                if res.success and np.isfinite(res.x):
                    tau_opt = float(res.x)
                    nll_opt = float(res.fun)
                    self.optimizer_candidate_temperature_ = tau_opt
                    self.optimizer_candidate_nll_ = nll_opt
                    candidates.append(("optimizer_interior", tau_opt, nll_opt))
                else:
                    self.optimizer_candidate_temperature_ = None
                    self.optimizer_candidate_nll_ = None

                candidates.append(("lower_endpoint", tau_lower, nll_lower))
                candidates.append(("upper_endpoint", tau_upper, nll_upper))

                # Explicit candidate comparison: select the candidate with strictly lowest NLL
                best_type, best_tau, best_nll = min(candidates, key=lambda c: c[2])

                self.temperature_ = best_tau
                self.optimization_nll_ = best_nll
                self.selected_candidate_type_ = best_type
                self.optimization_success_ = True
            except Exception:
                self.temperature_ = self.default_temperature
                self.optimization_success_ = False
                self.optimization_nll_ = None
                self.optimizer_candidate_temperature_ = None
                self.optimizer_candidate_nll_ = None
                self.endpoint_lower_nll_ = None
                self.endpoint_upper_nll_ = None
                self.selected_candidate_type_ = "default_fallback"
        else:
            self.temperature_ = self.default_temperature
            self.optimization_success_ = True
            self.optimization_nll_ = None
            self.optimizer_candidate_temperature_ = None
            self.optimizer_candidate_nll_ = None
            self.endpoint_lower_nll_ = None
            self.endpoint_upper_nll_ = None
            self.selected_candidate_type_ = "constant_fallback"

        self.is_fitted_ = True
        return self

    def _compute_probabilities(
        self,
        r: np.ndarray,
        delta: float,
        tau: float,
    ) -> np.ndarray:
        """
        Computes 3-class softmax probability estimates using approved piecewise distance scores:
            s_DOWN    = -r - delta_h
            s_NEUTRAL = delta_h - |r|
            s_UP      = +r - delta_h
        Logits are scaled by temperature tau > 0:
            P(k) = exp(s_k / tau) / sum_j exp(s_j / tau)

        Column ordering:
            Index 0: DOWN (-1)
            Index 1: NEUTRAL (0)
            Index 2: UP (+1)
        """
        eff_tau = tau if (tau is not None and tau > 0.0) else self.default_temperature

        s_down = -r - delta
        s_neutral = delta - np.abs(r)
        s_up = r - delta

        logits = np.column_stack([s_down, s_neutral, s_up]) / eff_tau

        # Numerically stable softmax
        max_logits = np.max(logits, axis=1, keepdims=True)
        exp_logits = np.exp(logits - max_logits)
        probs = exp_logits / exp_logits.sum(axis=1, keepdims=True)
        return probs

    def predict(self, X: Any) -> np.ndarray:
        """
        Predicts discrete 3-class directional labels for observations in X.

        Rule:
            UP (+1)     if return_1d > +delta_h
            DOWN (-1)   if return_1d < -delta_h
            NEUTRAL (0) otherwise (-delta_h <= return_1d <= +delta_h)

        Args:
            X: Input features containing raw return_1d.

        Returns:
            1D array of shape (N,) containing labels in {-1, 0, 1}.
        """
        if not self.is_fitted_:
            raise ValueError("MomentumBaseline is not fitted. Call fit() before predicting.")

        r = self._extract_return_feature(X)
        delta = self.threshold_delta_

        preds = np.zeros(len(r), dtype=np.int64)
        preds[r > delta] = 1
        preds[r < -delta] = -1
        return preds

    def predict_from_proba(self, probs: np.ndarray) -> np.ndarray:
        """
        Computes discrete class predictions from probability estimates using
        deterministic tie handling where NEUTRAL (0) wins boundary ties.

        Args:
            probs: 2D array of shape (N, 3) where columns are [DOWN, NEUTRAL, UP].

        Returns:
            1D array of shape (N,) containing labels in {-1, 0, 1}.
        """
        return deterministic_argmax_with_neutral_tie(probs)

    def predict_proba(self, X: Any) -> np.ndarray:
        """
        Computes 3-class softmax heuristic probability estimates for observations in X.

        Column ordering:
            Index 0: DOWN (-1)
            Index 1: NEUTRAL (0)
            Index 2: UP (+1)

        Args:
            X: Input features containing raw return_1d.

        Returns:
            Normalized 2D array of shape (N, 3).
        """
        if not self.is_fitted_:
            raise ValueError("MomentumBaseline is not fitted. Call fit() before predicting.")

        r = self._extract_return_feature(X)
        probs = self._compute_probabilities(r, self.threshold_delta_, self.temperature_)
        return validate_and_normalize_probabilities(probs, expected_samples=len(r))

    def get_metadata(self) -> MomentumBaselineMetadata:
        """Returns structured Pydantic audit metadata."""
        if not self.is_fitted_:
            raise ValueError("MomentumBaseline is not fitted. No metadata available.")

        return MomentumBaselineMetadata(
            horizon=self.horizon,
            threshold_delta=self.threshold_delta_,
            temperature=self.temperature_,
            training_samples=self.n_samples_,
            training_mean_return=self.training_mean_return_,
            training_std_return=self.training_std_return_,
            optimization_success=self.optimization_success_,
            optimization_nll=self.optimization_nll_,
            optimizer_candidate_temperature=self.optimizer_candidate_temperature_,
            optimizer_candidate_nll=self.optimizer_candidate_nll_,
            endpoint_lower_nll=self.endpoint_lower_nll_,
            endpoint_upper_nll=self.endpoint_upper_nll_,
            selected_candidate_type=self.selected_candidate_type_,
            feature_name=self.feature_name,
            metadata={
                "optimizer_candidate_temperature": self.optimizer_candidate_temperature_,
                "optimizer_candidate_nll": self.optimizer_candidate_nll_,
                "endpoint_lower_nll": self.endpoint_lower_nll_,
                "endpoint_upper_nll": self.endpoint_upper_nll_,
                "selected_candidate_type": self.selected_candidate_type_,
            },
        )


def deterministic_argmax_with_neutral_tie(probs: np.ndarray) -> np.ndarray:
    """
    Computes 3-class predictions from probability matrix P of shape (N, 3):
        Column 0: P(DOWN), Column 1: P(NEUTRAL), Column 2: P(UP).

    Deterministic tie handling:
    At exact threshold boundaries where probabilities tie (r = +delta, r = -delta,
    or r = 0 with delta = 0), NEUTRAL (0) wins exact ties:
    - If P(NEUTRAL) >= max(P(DOWN), P(UP)): return 0 (NEUTRAL)
    - Else if P(UP) > P(DOWN): return +1 (UP)
    - Else: return -1 (DOWN)

    Exact floating-point equality (>=) is used with zero numerical tolerance.
    This ensures that when a directional probability genuinely exceeds neutral
    (e.g., when r = delta + epsilon for any epsilon > 0), the directional win
    is strictly preserved and never overridden by a tolerance band.

    Args:
        probs: 1D array of length 3 or 2D array of shape (N, 3).

    Returns:
        1D int64 array of shape (N,) with class labels in {-1, 0, 1}.
    """
    probs_arr = np.asarray(probs, dtype=np.float64)
    if probs_arr.ndim == 1:
        probs_arr = probs_arr.reshape(1, -1)
    if probs_arr.ndim != 2 or probs_arr.shape[1] != 3:
        raise ValueError(f"Expected probability array with 3 columns, got shape {probs_arr.shape}")

    p_down = probs_arr[:, 0]
    p_neutral = probs_arr[:, 1]
    p_up = probs_arr[:, 2]

    preds = np.zeros(len(probs_arr), dtype=np.int64)

    max_directional = np.maximum(p_down, p_up)
    neutral_wins = (p_neutral >= max_directional)

    up_wins = (~neutral_wins) & (p_up > p_down)
    down_wins = (~neutral_wins) & (p_down > p_up)

    preds[neutral_wins] = 0
    preds[up_wins] = 1
    preds[down_wins] = -1

    return preds
