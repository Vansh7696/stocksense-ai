"""
StockSense AI — Multinomial Logistic Regression & Hyperparameter Tuning Service
Leakage-safe, deterministic Multinomial L2 Logistic Regression classification
and hyperparameter tuning pipeline for 3-class stock return direction forecasting.

Target classes: DOWN (-1), NEUTRAL (0), UP (+1).
Internal solver encoding: DOWN = 0, NEUTRAL = 1, UP = 2.
"""

import time
from typing import Dict, List, Optional, Tuple, Any, Sequence, Union
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from app.schemas.logistic_regression import (
    LogisticRegressionHyperparameters,
    CandidateEvaluationRecord,
    LogisticRegressionTuningResult,
    LogisticRegressionModelMetadata,
)
from app.schemas.metrics import ClassificationMetrics
from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    StandardScaler,
)
from app.services.metrics import (
    CLASS_LABELS,
    CLASS_NAMES,
    LABEL_TO_INDEX,
    INDEX_TO_LABEL,
    compute_classification_metrics,
    validate_and_normalize_probabilities,
)

# Canonical 3-class target mappings
EXTERNAL_LABELS: Tuple[int, int, int] = (-1, 0, 1)
INTERNAL_CLASSES: Tuple[int, int, int] = (0, 1, 2)

EXTERNAL_TO_INTERNAL: Dict[int, int] = {-1: 0, 0: 1, 1: 2}
INTERNAL_TO_EXTERNAL: Dict[int, int] = {0: -1, 1: 0, 2: 1}

# Approved Hyperparameter Grid Specification
GRID_C_VALUES: Tuple[float, ...] = (0.001, 0.01, 0.1, 1.0, 10.0, 100.0)
GRID_CLASS_WEIGHTS: Tuple[Optional[str], ...] = (None, "balanced")


def get_logistic_regression_hyperparameter_grid(
    solver: str = "lbfgs",
    max_iter: int = 1000,
    tol: float = 1e-4,
    random_state: int = 42,
) -> List[LogisticRegressionHyperparameters]:
    """
    Constructs the approved 12-candidate hyperparameter grid.

    Grid combinations:
        C in [0.001, 0.01, 0.1, 1.0, 10.0, 100.0] (6 values)
        class_weight in [None, "balanced"] (2 values)
        Total candidates: 6 x 2 = 12

    Returns:
        List of 12 LogisticRegressionHyperparameters objects with explicit grid indices.
    """
    grid = []
    idx = 0
    for C in GRID_C_VALUES:
        for cw in GRID_CLASS_WEIGHTS:
            grid.append(
                LogisticRegressionHyperparameters(
                    C=C,
                    class_weight=cw,
                    solver=solver,
                    max_iter=max_iter,
                    tol=tol,
                    random_state=random_state,
                    grid_index=idx,
                )
            )
            idx += 1
    return grid


class MultinomialLogisticRegression:
    """
    Leakage-safe Multinomial L2 Logistic Regression Classifier.

    Key Requirements:
    - L2 regularization controlled by parameter C.
    - Solver: lbfgs with max_iter=1000, tol=1e-4.
    - Target mapping:
      Input ground truth: DOWN = -1, NEUTRAL = 0, UP = +1
      Internal sklearn encoding: DOWN = 0, NEUTRAL = 1, UP = 2
      Output predictions: mapped back to {-1, 0, 1}
    - 3-Class Probabilities:
      Output shape (N, 3) where:
        Column 0: P(DOWN)
        Column 1: P(NEUTRAL)
        Column 2: P(UP)
    - Missing Class Resilience:
      If any class is unobserved in a training fold, probabilities are safely aligned
      to canonical 3-column shape (N, 3) with 0.0 for unobserved classes.
    """

    def __init__(
        self,
        C: float = 1.0,
        class_weight: Optional[str] = None,
        solver: str = "lbfgs",
        max_iter: int = 1000,
        tol: float = 1e-4,
        random_state: int = 42,
        horizon: Optional[int] = None,
        feature_names: Optional[List[str]] = None,
    ):
        self.C = float(C)
        self.class_weight = class_weight
        self.solver = solver
        self.max_iter = max_iter
        self.tol = tol
        self.random_state = random_state
        self.horizon = horizon
        self.feature_names = list(feature_names or APPROVED_FEATURE_ALLOWLIST)

        self.model_: Optional[LogisticRegression] = None
        self.classes_: Optional[np.ndarray] = None
        self.n_samples_: Optional[int] = None
        self.n_features_: Optional[int] = None
        self.is_fitted_: bool = False

    def _validate_and_extract_features(self, X: Any) -> np.ndarray:
        """Validates input feature matrix shape and finiteness."""
        if isinstance(X, pd.DataFrame):
            # Check column alignment if feature names provided
            missing = [f for f in self.feature_names if f not in X.columns]
            if missing:
                raise ValueError(f"Missing required features in DataFrame: {missing[:5]}")
            arr = X[self.feature_names].to_numpy(dtype=np.float64)
        elif isinstance(X, np.ndarray):
            arr = np.asarray(X, dtype=np.float64)
        else:
            arr = np.asarray(X, dtype=np.float64)

        if arr.size == 0 or arr.ndim != 2:
            raise ValueError(f"Feature matrix must be non-empty 2D array, got shape {arr.shape}")

        if arr.shape[1] != len(self.feature_names):
            raise ValueError(
                f"Feature dimension mismatch: expected {len(self.feature_names)} features, got {arr.shape[1]}"
            )

        if not np.all(np.isfinite(arr)):
            raise ValueError("Feature matrix contains non-finite values (NaN or Inf).")

        return arr

    def fit(
        self,
        X: Union[pd.DataFrame, np.ndarray],
        y: Union[Sequence[int], np.ndarray, pd.Series],
    ) -> "MultinomialLogisticRegression":
        """
        Fits multinomial L2 logistic regression on training observations.

        Args:
            X: 2D feature matrix (N, 23).
            y: Ground-truth target labels in {-1, 0, 1}.

        Returns:
            Fitted MultinomialLogisticRegression instance.
        """
        X_arr = self._validate_and_extract_features(X)
        y_arr = np.asarray(y)

        if y_arr.ndim != 1:
            raise ValueError(f"Target labels y must be 1D, got ndim={y_arr.ndim}")

        if len(X_arr) != len(y_arr):
            raise ValueError(f"Sample count mismatch: X has {len(X_arr)} rows, y has {len(y_arr)} labels")

        if not np.all(np.isfinite(y_arr)):
            raise ValueError("Target labels contain non-finite values (NaN or Inf).")

        y_int = y_arr.astype(np.int64)
        unique_labels = set(np.unique(y_int))
        unapproved = unique_labels - set(EXTERNAL_LABELS)
        if unapproved:
            raise ValueError(
                f"Unapproved labels detected in training targets: {sorted(list(unapproved))}. "
                f"Allowed labels: {list(EXTERNAL_LABELS)}."
            )

        # Map external labels {-1, 0, 1} to internal classes {0, 1, 2}
        y_internal = np.array([EXTERNAL_TO_INTERNAL[lbl] for lbl in y_int], dtype=np.int64)

        # Initialize scikit-learn LogisticRegression
        # In scikit-learn >= 1.8, penalty defaults to 'l2' controlled by C
        clf = LogisticRegression(
            C=self.C,
            class_weight=self.class_weight,
            solver=self.solver,
            max_iter=self.max_iter,
            tol=self.tol,
            random_state=self.random_state,
        )

        clf.fit(X_arr, y_internal)

        self.model_ = clf
        self.classes_ = clf.classes_
        self.n_samples_ = len(y_int)
        self.n_features_ = X_arr.shape[1]
        self.is_fitted_ = True

        return self

    def predict(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
        """
        Predicts discrete 3-class target labels {-1, 0, 1} for observations in X.

        Args:
            X: 2D feature matrix (N, 23).

        Returns:
            1D int64 array of shape (N,) containing labels in {-1, 0, 1}.
        """
        if not self.is_fitted_ or self.model_ is None:
            raise ValueError("Model is not fitted. Call fit() before predicting.")

        X_arr = self._validate_and_extract_features(X)
        preds_internal = self.model_.predict(X_arr)

        # Map internal {0, 1, 2} back to external {-1, 0, 1}
        preds_external = np.array([INTERNAL_TO_EXTERNAL[c] for c in preds_internal], dtype=np.int64)
        return preds_external

    def predict_proba(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
        """
        Predicts 3-class class probability distribution for observations in X.

        Column ordering:
            Index 0: DOWN (-1)
            Index 1: NEUTRAL (0)
            Index 2: UP (+1)

        Returns:
            Normalized 2D float64 array of shape (N, 3).
        """
        if not self.is_fitted_ or self.model_ is None:
            raise ValueError("Model is not fitted. Call fit() before predicting.")

        X_arr = self._validate_and_extract_features(X)
        raw_probs = self.model_.predict_proba(X_arr)

        # Align raw probabilities to canonical 3 classes [0=DOWN, 1=NEUTRAL, 2=UP]
        # Handles missing classes safely if a training subset had < 3 classes
        probs = np.zeros((len(X_arr), 3), dtype=np.float64)
        for internal_idx, class_val in enumerate(self.classes_):
            probs[:, class_val] = raw_probs[:, internal_idx]

        return validate_and_normalize_probabilities(probs, expected_samples=len(X_arr))

    def get_metadata(self) -> LogisticRegressionModelMetadata:
        """Returns structured audit metadata including fitted coefficients and intercepts."""
        if not self.is_fitted_ or self.model_ is None:
            raise ValueError("Model is not fitted. No metadata available.")

        clf = self.model_

        # Extract coefficients and intercepts per class: DOWN (0), NEUTRAL (1), UP (2)
        coef_dict: Dict[str, List[float]] = {}
        intercept_dict: Dict[str, float] = {}

        if len(self.classes_) == 3:
            for internal_cls, class_name in zip(INTERNAL_CLASSES, CLASS_NAMES):
                coef_dict[class_name] = [float(w) for w in clf.coef_[internal_cls]]
                intercept_dict[class_name] = float(clf.intercept_[internal_cls])
        else:
            # Handle binary/degenerate edge cases safely
            for internal_cls in INTERNAL_CLASSES:
                class_name = CLASS_NAMES[internal_cls]
                if internal_cls in self.classes_:
                    idx = list(self.classes_).index(internal_cls)
                    coef_dict[class_name] = [float(w) for w in clf.coef_[idx]]
                    intercept_dict[class_name] = float(clf.intercept_[idx])
                else:
                    coef_dict[class_name] = [0.0] * self.n_features_
                    intercept_dict[class_name] = 0.0

        return LogisticRegressionModelMetadata(
            horizon=self.horizon,
            C=self.C,
            class_weight=self.class_weight,
            solver=self.solver,
            max_iter=self.max_iter,
            tol=self.tol,
            training_samples=self.n_samples_,
            feature_names=self.feature_names,
            coefficients=coef_dict,
            intercepts=intercept_dict,
            classes=list(EXTERNAL_LABELS),
            metadata={
                "solver_iterations": int(clf.n_iter_[0]) if hasattr(clf, "n_iter_") else None,
                "classes_present_in_train": [int(c) for c in self.classes_],
            },
        )


def _lexicographic_candidate_key(
    record: Dict[str, Any],
) -> Tuple[float, float, float, float, int, int]:
    """
    Constructs the approved lexicographic sort key for hyperparameter candidate selection.

    Selection hierarchy:
    1. Highest balanced accuracy (-balanced_accuracy)
    2. Highest macro F1 (-macro_f1)
    3. Lowest log loss (log_loss)
    4. Smaller C (stronger regularization preference)
    5. class_weight=None preferred over 'balanced' (0 if None else 1)
    6. Original grid index (lowest index wins)
    """
    bal_acc = float(record["metrics"].balanced_accuracy)
    macro_f1 = float(record["metrics"].macro_f1)
    log_loss = float(record["metrics"].log_loss) if record["metrics"].log_loss is not None else float("inf")
    C = float(record["C"])
    cw_penalty = 0 if record["class_weight"] is None else 1
    grid_idx = int(record["grid_index"])

    return (-bal_acc, -macro_f1, log_loss, C, cw_penalty, grid_idx)


def tune_logistic_regression(
    X_train: Union[pd.DataFrame, np.ndarray],
    y_train: Union[Sequence[int], np.ndarray, pd.Series],
    X_val: Union[pd.DataFrame, np.ndarray],
    y_val: Union[Sequence[int], np.ndarray, pd.Series],
    horizon: int,
    feature_names: Optional[List[str]] = None,
) -> LogisticRegressionTuningResult:
    """
    Executes leakage-safe hyperparameter tuning for Multinomial Logistic Regression.

    Leakage Prevention Guarantees:
    - Signature strictly accepts only training and validation data (no test arguments).
    - StandardScaler is fitted exclusively on X_train.
    - X_train and X_val are transformed using that scaler. The scaler is NEVER refitted on X_val.
    - All 12 candidates are evaluated on X_val.
    - Candidate selection follows the approved deterministic lexicographic hierarchy.

    Args:
        X_train: Training feature matrix (N_train, 23).
        y_train: Training ground-truth targets (N_train,) in {-1, 0, 1}.
        X_val: Validation feature matrix (N_val, 23).
        y_val: Validation ground-truth targets (N_val,) in {-1, 0, 1}.
        horizon: Prediction horizon h in trading sessions (1, 3, or 5).
        feature_names: Optional list of 23 feature column names.

    Returns:
        LogisticRegressionTuningResult containing all candidate records and selected candidate.
    """
    if horizon not in (1, 3, 5):
        raise ValueError(f"Prediction horizon must be 1, 3, or 5 (got horizon={horizon})")

    features = list(feature_names or APPROVED_FEATURE_ALLOWLIST)

    # 1. Scaler Quarantine: Fit exclusively on X_train
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_val_scaled = scaler.transform(X_val)

    y_train_arr = np.asarray(y_train, dtype=np.int64)
    y_val_arr = np.asarray(y_val, dtype=np.int64)

    # 2. Generate 12 grid candidates
    grid = get_logistic_regression_hyperparameter_grid()

    candidate_records: List[CandidateEvaluationRecord] = []
    temp_dict_list: List[Dict[str, Any]] = []

    # 3. Fit each candidate on X_train_scaled and evaluate on X_val_scaled
    for param in grid:
        t0 = time.time()
        model = MultinomialLogisticRegression(
            C=param.C,
            class_weight=param.class_weight,
            solver=param.solver,
            max_iter=param.max_iter,
            tol=param.tol,
            random_state=param.random_state,
            horizon=horizon,
            feature_names=features,
        )
        model.fit(X_train_scaled, y_train_arr)

        # Predict discrete classes and probabilities on validation data
        val_preds = model.predict(X_val_scaled)
        val_probs = model.predict_proba(X_val_scaled)

        # Compute full validation metrics
        val_metrics = compute_classification_metrics(
            y_true=y_val_arr,
            y_pred=val_preds,
            y_prob=val_probs,
            horizon=horizon,
            model_name=f"LogisticRegression_C{param.C}_{param.class_weight}",
        )
        dt = float(time.time() - t0)

        temp_dict = {
            "grid_index": param.grid_index,
            "C": param.C,
            "class_weight": param.class_weight,
            "metrics": val_metrics,
            "fit_time_seconds": dt,
            "param": param,
        }
        temp_dict_list.append(temp_dict)

    # 4. Lexicographic selection ordering
    sorted_candidates = sorted(temp_dict_list, key=_lexicographic_candidate_key)
    best_candidate_dict = sorted_candidates[0]
    best_grid_idx = best_candidate_dict["grid_index"]

    rankings = [c["grid_index"] for c in sorted_candidates]

    # 5. Build CandidateEvaluationRecord list
    selected_record: Optional[CandidateEvaluationRecord] = None
    for c_dict in temp_dict_list:
        is_best = (c_dict["grid_index"] == best_grid_idx)
        rec = CandidateEvaluationRecord(
            grid_index=c_dict["grid_index"],
            C=c_dict["C"],
            class_weight=c_dict["class_weight"],
            metrics=c_dict["metrics"],
            is_selected=is_best,
            fit_time_seconds=c_dict["fit_time_seconds"],
        )
        candidate_records.append(rec)
        if is_best:
            selected_record = rec

    if selected_record is None:
        raise RuntimeError("Failed to resolve selected candidate record.")

    return LogisticRegressionTuningResult(
        horizon=horizon,
        candidates=candidate_records,
        selected_candidate=selected_record,
        selected_hyperparameters=best_candidate_dict["param"],
        selection_rankings=rankings,
        n_train_samples=len(y_train_arr),
        n_val_samples=len(y_val_arr),
        n_features=len(features),
        feature_names=features,
        scaler_mean=[float(m) for m in scaler.mean_],
        scaler_scale=[float(s) for s in scaler.scale_],
        metadata={
            "selection_hierarchy": [
                "1_balanced_accuracy_descending",
                "2_macro_f1_descending",
                "3_log_loss_ascending",
                "4_C_ascending",
                "5_class_weight_none_preferred",
                "6_grid_index_ascending",
            ],
            "grid_size": len(grid),
        },
    )
