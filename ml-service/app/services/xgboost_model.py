"""
StockSense AI — XGBoost Model Service
Domain wrapper and model factory for XGBoost gradient boosted classification
on the approved 23 technical features with direct raw feature ingestion and
nested inner early-stopping support.
"""

import os
import json
import time
from typing import Dict, List, Optional, Any, Union, Sequence, Tuple, Callable
import numpy as np
import pandas as pd

from app.services.splitting import APPROVED_FEATURE_ALLOWLIST
from app.services.metrics import (
    compute_classification_metrics,
    validate_and_normalize_probabilities,
)
from app.schemas.xgboost_model import (
    XGBoostHyperparameters,
    XGBoostCandidateRecord,
    XGBoostTuningResult,
    XGBoostModelMetadata,
)

# Optional / safe import of xgboost
xgb = None
XGBClassifier = None
XGBOOST_AVAILABLE = False
_XGBOOST_IMPORT_ERROR: Optional[Exception] = None

try:
    import xgboost as xgb
    from xgboost import XGBClassifier
    XGBOOST_AVAILABLE = True
except (ImportError, OSError) as exc:
    _XGBOOST_IMPORT_ERROR = exc
except Exception as exc:
    if "XGBoost" in type(exc).__name__:
        _XGBOOST_IMPORT_ERROR = exc
    else:
        raise


class XGBoostDependencyError(RuntimeError):
    """Raised when XGBoost functionality is requested but xgboost is not available."""
    pass


# Canonical 3-class label mappings
EXTERNAL_LABELS = (-1, 0, 1)
INTERNAL_CLASSES = (0, 1, 2)
CLASS_NAMES = ("DOWN", "NEUTRAL", "UP")
EXTERNAL_TO_INTERNAL = {-1: 0, 0: 1, 1: 2}
INTERNAL_TO_EXTERNAL = {0: -1, 1: 0, 2: 1}


class XGBoostModel:
    """
    Domain service wrapping XGBoost's XGBClassifier.

    Guarantees:
    - Direct ingestion of the raw 23 approved technical features without scaling.
    - Strict validation of input column presence, ordering, and finiteness.
    - Class mapping between external labels {-1, 0, 1} and internal indices {0, 1, 2}.
    - Inner-validation early stopping support for Phase 5C.4.3 without outer validation double-use.
    - Aligned 3-class probability distributions of shape (N, 3) [DOWN, NEUTRAL, UP].
    """

    def __init__(
        self,
        learning_rate: float = 0.03,
        max_depth: int = 3,
        subsample: float = 0.85,
        reg_lambda: float = 5.0,
        gamma: float = 0.5,
        colsample_bytree: float = 0.8,
        min_child_weight: float = 15.0,
        objective: str = "multi:softprob",
        num_class: int = 3,
        n_estimators: int = 200,
        random_state: int = 42,
        eval_metric: str = "mlogloss",
        early_stopping_rounds: Optional[int] = 15,
        n_jobs: int = -1,
        horizon: Optional[int] = None,
        feature_names: Optional[List[str]] = None,
    ):
        self.learning_rate = float(learning_rate)
        self.max_depth = int(max_depth)
        self.subsample = float(subsample)
        self.reg_lambda = float(reg_lambda)
        self.gamma = float(gamma)
        self.colsample_bytree = float(colsample_bytree)
        self.min_child_weight = float(min_child_weight)
        self.objective = str(objective)
        self.num_class = int(num_class)
        self.n_estimators = int(n_estimators)
        self.random_state = int(random_state)
        self.eval_metric = str(eval_metric)
        self.early_stopping_rounds = int(early_stopping_rounds) if early_stopping_rounds is not None else None
        self.n_jobs = int(n_jobs)
        self.horizon = horizon
        self.feature_names = list(feature_names or APPROVED_FEATURE_ALLOWLIST)

        self.algorithm_name = "XGBoost Classifier (Gradient Boosting)"
        self.solver = "exact"
        self.model_: Any = None
        self.classes_: Optional[np.ndarray] = None
        self.observed_classes_: Optional[List[int]] = None
        self.external_to_contiguous_: Optional[Dict[int, int]] = None
        self.contiguous_to_external_: Optional[Dict[int, int]] = None
        self.n_samples_: Optional[int] = None
        self.n_features_: Optional[int] = None
        self.best_iteration_: Optional[int] = None
        self.is_fitted_: bool = False

    @property
    def best_iteration(self) -> Optional[int]:
        """Returns the 0-based best_iteration determined via early stopping, or None."""
        return self.best_iteration_

    def _validate_and_extract_features(self, X: Any) -> np.ndarray:
        """Validates input feature matrix shape, presence, ordering, and finiteness."""
        if isinstance(X, pd.DataFrame):
            if X.columns.duplicated().any():
                dup_cols = X.columns[X.columns.duplicated()].unique().tolist()
                raise ValueError(f"Input DataFrame contains duplicate feature columns: {dup_cols}")
            if len(X.columns) != len(self.feature_names):
                raise ValueError(
                    f"Input DataFrame column count mismatch: expected {len(self.feature_names)}, got {len(X.columns)}"
                )
            missing = [f for f in self.feature_names if f not in X.columns]
            if missing:
                raise ValueError(f"Missing required features in DataFrame: {missing[:5]}")
            unexpected = [c for c in X.columns if c not in self.feature_names]
            if unexpected:
                raise ValueError(f"Unexpected features in DataFrame not in schema: {unexpected[:5]}")
            arr = X[self.feature_names].to_numpy(dtype=np.float64)
        elif isinstance(X, np.ndarray):
            arr = np.asarray(X, dtype=np.float64)
        else:
            arr = np.asarray(X, dtype=np.float64)

        if arr.size == 0 or arr.ndim != 2:
            raise ValueError(f"Feature matrix must be a non-empty 2D array, got shape {arr.shape}")

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
        eval_set: Optional[List[Tuple[Union[pd.DataFrame, np.ndarray], Union[Sequence[int], np.ndarray]]]] = None,
        early_stopping_rounds: Optional[int] = None,
    ) -> "XGBoostModel":
        """
        Fits XGBoost classifier directly on raw training features.

        Args:
            X: 2D feature matrix (N, 23).
            y: Ground-truth target labels in {-1, 0, 1}.
            eval_set: Optional list of (X_val, y_val) evaluation pairs for inner validation early stopping.
            early_stopping_rounds: Optional early stopping rounds overriding instance default.

        Returns:
            Fitted XGBoostModel instance.
        """
        if not XGBOOST_AVAILABLE or XGBClassifier is None:
            msg = (
                "XGBoost is not available in the current environment. "
                "Please install 'xgboost>=2.1.0' as declared in ml-service/requirements.txt "
                "and ensure OpenMP runtime (libomp) is installed on your system."
            )
            if _XGBOOST_IMPORT_ERROR is not None:
                raise XGBoostDependencyError(f"{msg} Cause: {_XGBOOST_IMPORT_ERROR}") from _XGBOOST_IMPORT_ERROR
            raise XGBoostDependencyError(msg)

        X_arr = self._validate_and_extract_features(X)
        y_arr = np.asarray(y)

        if y_arr.ndim != 1:
            raise ValueError(f"Target labels y must be 1D, got ndim={y_arr.ndim}")

        if len(X_arr) != len(y_arr):
            raise ValueError(f"Sample count mismatch: X has {len(X_arr)} rows, y has {len(y_arr)} labels")

        if not np.all(np.isfinite(y_arr)):
            raise ValueError("Target labels contain non-finite values (NaN or Inf).")

        y_int = y_arr.astype(np.int64)
        unique_labels = sorted(list(set(np.unique(y_int))))
        unapproved = set(unique_labels) - set(EXTERNAL_LABELS)
        if unapproved:
            raise ValueError(
                f"Unapproved labels detected in training targets: {sorted(list(unapproved))}. "
                f"Allowed labels: {list(EXTERNAL_LABELS)}."
            )

        if len(unique_labels) < 2:
            raise ValueError(
                f"XGBoost training requires at least 2 distinct classes in training partition, "
                f"got {len(unique_labels)}: {unique_labels}. Cannot fit classification model on single-class data."
            )

        # Deterministic contiguous class mapping {0, ..., K-1} for observed classes
        self.observed_classes_ = unique_labels
        self.external_to_contiguous_ = {ext: i for i, ext in enumerate(unique_labels)}
        self.contiguous_to_external_ = {i: ext for i, ext in enumerate(unique_labels)}
        y_internal = np.array([self.external_to_contiguous_[lbl] for lbl in y_int], dtype=np.int64)
        n_classes = len(unique_labels)

        # Process eval_set if provided (for inner early stopping)
        processed_eval_set = None
        if eval_set is not None:
            processed_eval_set = []
            for ev_X, ev_y in eval_set:
                ev_X_arr = self._validate_and_extract_features(ev_X)
                ev_y_arr = np.asarray(ev_y)

                if ev_y_arr.ndim != 1:
                    raise ValueError(f"eval_set target labels must be 1D, got ndim={ev_y_arr.ndim}")

                if len(ev_X_arr) != len(ev_y_arr):
                    raise ValueError(
                        f"eval_set sample count mismatch: X has {len(ev_X_arr)} rows, y has {len(ev_y_arr)} labels"
                    )

                if not np.all(np.isfinite(ev_y_arr)):
                    raise ValueError("eval_set target labels contain non-finite values (NaN or Inf).")

                ev_y_int = ev_y_arr.astype(np.int64)
                unapproved_ev = set(np.unique(ev_y_int)) - set(EXTERNAL_LABELS)
                if unapproved_ev:
                    raise ValueError(
                        f"Unapproved labels detected in eval_set targets: {sorted(list(unapproved_ev))}. "
                        f"Allowed labels: {list(EXTERNAL_LABELS)}."
                    )

                unobserved_ev = set(np.unique(ev_y_int)) - set(self.observed_classes_)
                if unobserved_ev:
                    raise ValueError(
                        f"eval_set contains classes {sorted(list(unobserved_ev))} that were not observed "
                        f"in training partition {self.observed_classes_}. Cannot evaluate on unseen classes."
                    )

                ev_y_internal = np.array([self.external_to_contiguous_[lbl] for lbl in ev_y_int], dtype=np.int64)
                processed_eval_set.append((ev_X_arr, ev_y_internal))

        es_rounds = early_stopping_rounds if early_stopping_rounds is not None else self.early_stopping_rounds

        # Initialize XGBClassifier with contiguous num_class
        clf = XGBClassifier(
            learning_rate=self.learning_rate,
            max_depth=self.max_depth,
            subsample=self.subsample,
            reg_lambda=self.reg_lambda,
            gamma=self.gamma,
            colsample_bytree=self.colsample_bytree,
            min_child_weight=self.min_child_weight,
            objective=self.objective,
            num_class=n_classes,
            n_estimators=self.n_estimators,
            random_state=self.random_state,
            eval_metric=self.eval_metric,
            early_stopping_rounds=es_rounds if processed_eval_set is not None else None,
            tree_method="hist",
            n_jobs=self.n_jobs,
        )

        if processed_eval_set is not None:
            clf.fit(X_arr, y_internal, eval_set=processed_eval_set, verbose=False)
            self.best_iteration_ = getattr(clf, "best_iteration", None)
        else:
            clf.fit(X_arr, y_internal, verbose=False)
            self.best_iteration_ = None

        self.model_ = clf
        self.classes_ = np.array(self.observed_classes_, dtype=np.int64)
        self.n_samples_ = len(y_int)
        self.n_features_ = X_arr.shape[1]
        self.is_fitted_ = True

        return self

    def predict(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
        """
        Predicts discrete 3-class target labels in {-1, 0, 1}.

        Args:
            X: 2D feature matrix (N, 23).

        Returns:
            1D int64 array of shape (N,) containing labels in {-1, 0, 1}.
        """
        if not self.is_fitted_ or self.model_ is None or self.contiguous_to_external_ is None:
            raise ValueError("Model is not fitted. Call fit() before predicting.")

        X_arr = self._validate_and_extract_features(X)
        preds_internal = self.model_.predict(X_arr)
        if preds_internal.ndim == 2:
            preds_internal = np.argmax(preds_internal, axis=1)

        preds_external = np.array([self.contiguous_to_external_[int(c)] for c in preds_internal], dtype=np.int64)
        return preds_external

    def predict_proba(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
        """
        Predicts 3-class probability distribution of shape (N, 3):
        [P(DOWN), P(NEUTRAL), P(UP)].
        """
        if not self.is_fitted_ or self.model_ is None or self.external_to_contiguous_ is None:
            raise ValueError("Model is not fitted. Call fit() before predicting.")

        X_arr = self._validate_and_extract_features(X)
        raw_probs = self.model_.predict_proba(X_arr)
        raw_probs = np.asarray(raw_probs, dtype=np.float64)

        # Canonical mapping: -1 -> col 0 (DOWN), 0 -> col 1 (NEUTRAL), +1 -> col 2 (UP)
        CANONICAL_INDEX = {-1: 0, 0: 1, 1: 2}
        probs = np.zeros((len(X_arr), 3), dtype=np.float64)

        for ext_lbl, contig_idx in self.external_to_contiguous_.items():
            canon_col = CANONICAL_INDEX[ext_lbl]
            probs[:, canon_col] = raw_probs[:, contig_idx]

        return validate_and_normalize_probabilities(probs, expected_samples=len(X_arr))

    def get_metadata(self) -> XGBoostModelMetadata:
        """Returns structured audit metadata for the XGBoost instance."""
        importances: Optional[Dict[str, float]] = None
        if self.is_fitted_ and self.model_ is not None and hasattr(self.model_, "feature_importances_"):
            importances = {
                feat: float(imp)
                for feat, imp in zip(self.feature_names, self.model_.feature_importances_)
            }

        return XGBoostModelMetadata(
            horizon=self.horizon,
            learning_rate=self.learning_rate,
            max_depth=self.max_depth,
            subsample=self.subsample,
            reg_lambda=self.reg_lambda,
            gamma=self.gamma,
            colsample_bytree=self.colsample_bytree,
            min_child_weight=self.min_child_weight,
            n_estimators=self.n_estimators,
            best_iteration=self.best_iteration_,
            objective=self.objective,
            random_state=self.random_state,
            feature_importances=importances,
        )


def create_xgboost_model(
    config: Optional[XGBoostHyperparameters] = None,
    horizon: Optional[int] = None,
    feature_names: Optional[List[str]] = None,
    n_jobs: int = -1,
) -> XGBoostModel:
    """
    Factory function instantiating a configured XGBoostModel.
    """
    if not XGBOOST_AVAILABLE or XGBClassifier is None:
        msg = (
            "XGBoost is not available in the current environment. "
            "Please install 'xgboost>=2.1.0' as declared in ml-service/requirements.txt "
            "and ensure OpenMP runtime (libomp) is installed on your system."
        )
        if _XGBOOST_IMPORT_ERROR is not None:
            raise XGBoostDependencyError(f"{msg} Cause: {_XGBOOST_IMPORT_ERROR}") from _XGBOOST_IMPORT_ERROR
        raise XGBoostDependencyError(msg)

    if config is None:
        config = XGBoostHyperparameters()

    return XGBoostModel(
        learning_rate=config.learning_rate,
        max_depth=config.max_depth,
        subsample=config.subsample,
        reg_lambda=config.reg_lambda,
        gamma=config.gamma,
        colsample_bytree=config.colsample_bytree,
        min_child_weight=config.min_child_weight,
        objective=config.objective,
        num_class=config.num_class,
        n_estimators=config.n_estimators,
        random_state=config.random_state,
        eval_metric=config.eval_metric,
        early_stopping_rounds=config.early_stopping_rounds,
        n_jobs=n_jobs,
        horizon=horizon,
        feature_names=feature_names,
    )


XGB_GRID_LEARNING_RATE = [0.01, 0.03, 0.05]
XGB_GRID_MAX_DEPTH = [2, 3, 4]
XGB_GRID_SUBSAMPLE = [0.7, 0.85]
XGB_GRID_REG_LAMBDA = [1.0, 5.0, 10.0]
XGB_GRID_GAMMA = [0.1, 0.5, 1.0]


def get_xgboost_search_grid() -> List[XGBoostHyperparameters]:
    """
    Generates the exact approved 162 candidate configurations for XGBoost.
    Grid specification:
    - learning_rate: [0.01, 0.03, 0.05] (3)
    - max_depth: [2, 3, 4] (3)
    - subsample: [0.7, 0.85] (2)
    - reg_lambda: [1.0, 5.0, 10.0] (3)
    - gamma: [0.1, 0.5, 1.0] (3)
    - Fixed: colsample_bytree=0.8, min_child_weight=15.0, objective="multi:softprob",
             num_class=3, random_state=42, n_estimators=200, eval_metric="mlogloss",
             early_stopping_rounds=15
    Total: 3 * 3 * 2 * 3 * 3 = 162 configurations per horizon.
    """
    grid: List[XGBoostHyperparameters] = []
    idx = 0

    for lr in XGB_GRID_LEARNING_RATE:
        for depth in XGB_GRID_MAX_DEPTH:
            for sub in XGB_GRID_SUBSAMPLE:
                for reg_lam in XGB_GRID_REG_LAMBDA:
                    for gam in XGB_GRID_GAMMA:
                        grid.append(
                            XGBoostHyperparameters(
                                learning_rate=lr,
                                max_depth=depth,
                                subsample=sub,
                                reg_lambda=reg_lam,
                                gamma=gam,
                                colsample_bytree=0.8,
                                min_child_weight=15.0,
                                objective="multi:softprob",
                                num_class=3,
                                n_estimators=200,
                                random_state=42,
                                eval_metric="mlogloss",
                                early_stopping_rounds=15,
                                grid_index=idx,
                            )
                        )
                        idx += 1

    return grid


def _lexicographic_xgb_sort_key(
    record: XGBoostCandidateRecord,
) -> Tuple[float, float, float, int, float, float, int]:
    """
    Deterministic tie-break hierarchy for XGBoost model selection:
    1. Highest balanced accuracy (-bal_acc)
    2. Highest macro F1 (-macro_f1)
    3. Lowest log loss (log_loss)
    4. Lower max_depth (max_depth)
    5. Higher reg_lambda (-reg_lambda)
    6. Higher gamma (-gamma)
    7. Lower grid_index (grid_index)
    """
    bal_acc = float(record.metrics.balanced_accuracy)
    macro_f1 = float(record.metrics.macro_f1)
    log_loss = float(record.metrics.log_loss)
    max_depth = int(record.hyperparameters.max_depth)
    reg_lambda = float(record.hyperparameters.reg_lambda)
    gamma = float(record.hyperparameters.gamma)
    grid_idx = int(record.grid_index) if record.grid_index is not None else 0

    return (-bal_acc, -macro_f1, log_loss, max_depth, -reg_lambda, -gamma, grid_idx)


def tune_xgboost(
    X_in_tr: Union[pd.DataFrame, np.ndarray],
    y_in_tr: Union[Sequence[int], np.ndarray, pd.Series],
    X_in_val: Union[pd.DataFrame, np.ndarray],
    y_in_val: Union[Sequence[int], np.ndarray, pd.Series],
    X_full_tr: Union[pd.DataFrame, np.ndarray],
    y_full_tr: Union[Sequence[int], np.ndarray, pd.Series],
    X_val: Union[pd.DataFrame, np.ndarray],
    y_val: Union[Sequence[int], np.ndarray, pd.Series],
    horizon: int,
    feature_names: Optional[List[str]] = None,
    n_jobs: int = -1,
    checkpoint_path: Optional[str] = None,
    experiment_id: Optional[str] = None,
    progress_callback: Optional[Callable[[int, int, XGBoostCandidateRecord], None]] = None,
    grid: Optional[List[XGBoostHyperparameters]] = None,
) -> XGBoostTuningResult:
    """
    Systematically tunes XGBoost across the approved 162 candidate configurations using
    the rigorous two-stage early-stopping and full-training refit protocol.

    Protocol:
    - Stage 1: Fit on raw inner training partition with early stopping (patience=15)
               evaluated against inner validation fold. Captures optimal round M*.
    - Stage 2: Refit candidate on full outer training partition with fixed n_estimators = M* + 1
               without early stopping.
    - Stage 3: Evaluate on outer validation partition to produce unbiased validation metrics.

    Guarantees:
    - Zero double-use of outer validation data for early stopping.
    - Deterministic tie-breaking using the approved 7-level hierarchy.
    - Incremental atomic checkpoint persistence and interruption recovery.
    - Progress reporting callback support.

    Args:
        X_in_tr: Inner training features (N_in_tr, 23).
        y_in_tr: Inner training labels in {-1, 0, 1}.
        X_in_val: Inner validation features (N_in_val, 23).
        y_in_val: Inner validation labels in {-1, 0, 1}.
        X_full_tr: Full outer training features (N_full_tr, 23).
        y_full_tr: Full outer training labels in {-1, 0, 1}.
        X_val: Outer validation features (N_val, 23).
        y_val: Outer validation labels in {-1, 0, 1}.
        horizon: Prediction horizon h in trading days (1, 3, or 5).
        feature_names: Optional feature column names (defaults to 23 approved features).
        n_jobs: CPU parallelism for tree construction.
        checkpoint_path: Optional filesystem path for atomic checkpoint persistence.
        experiment_id: Optional experiment identifier for traceability.
        progress_callback: Optional callable(completed_count, total_count, latest_record).
        grid: Optional custom search grid (defaults to exact 162 configurations).

    Returns:
        XGBoostTuningResult with all evaluated candidates, rankings, and champion.
    """
    if not XGBOOST_AVAILABLE or XGBClassifier is None:
        msg = (
            "XGBoost is not available in the current environment. "
            "Please install 'xgboost>=2.1.0' as declared in ml-service/requirements.txt "
            "and ensure OpenMP runtime (libomp) is installed on your system."
        )
        if _XGBOOST_IMPORT_ERROR is not None:
            raise XGBoostDependencyError(f"{msg} Cause: {_XGBOOST_IMPORT_ERROR}") from _XGBOOST_IMPORT_ERROR
        raise XGBoostDependencyError(msg)

    features = list(feature_names or APPROVED_FEATURE_ALLOWLIST)
    search_grid = grid if grid is not None else get_xgboost_search_grid()

    y_in_tr_arr = np.asarray(y_in_tr, dtype=np.int64)
    y_in_val_arr = np.asarray(y_in_val, dtype=np.int64)
    y_full_tr_arr = np.asarray(y_full_tr, dtype=np.int64)
    y_val_arr = np.asarray(y_val, dtype=np.int64)

    if len(np.unique(y_in_tr_arr)) < 2:
        raise ValueError("XGBoost inner training requires at least 2 distinct classes in training partition.")
    if len(np.unique(y_full_tr_arr)) < 2:
        raise ValueError("XGBoost outer training requires at least 2 distinct classes in training partition.")

    records_by_idx: Dict[int, XGBoostCandidateRecord] = {}

    # Checkpoint resumption
    if checkpoint_path is not None and os.path.exists(checkpoint_path):
        try:
            with open(checkpoint_path, "r", encoding="utf-8") as f:
                chk_data = json.load(f)
            if chk_data.get("horizon") == horizon and chk_data.get("model_family") == "xgboost":
                for item in chk_data.get("candidates", []):
                    rec = XGBoostCandidateRecord.model_validate(item)
                    records_by_idx[rec.grid_index] = rec
        except Exception:
            records_by_idx = {}

    total_candidates = len(search_grid)

    for candidate in search_grid:
        idx = candidate.grid_index if candidate.grid_index is not None else len(records_by_idx)
        if idx in records_by_idx:
            if progress_callback is not None:
                progress_callback(len(records_by_idx), total_candidates, records_by_idx[idx])
            continue

        # Stage 1: Inner training with early stopping against inner validation
        t_s1_start = time.perf_counter()
        stage1_model = create_xgboost_model(
            config=candidate,
            horizon=horizon,
            feature_names=features,
            n_jobs=n_jobs,
        )
        stage1_model.fit(
            X=X_in_tr,
            y=y_in_tr_arr,
            eval_set=[(X_in_val, y_in_val_arr)],
            early_stopping_rounds=candidate.early_stopping_rounds or 15,
        )
        t_stage1 = time.perf_counter() - t_s1_start

        best_iter = stage1_model.best_iteration
        if best_iter is not None:
            refit_n_est = int(best_iter + 1)
        else:
            refit_n_est = int(candidate.n_estimators)

        # Stage 2: Full-training refit on outer training set with n_estimators = best_iter + 1
        t_s2_start = time.perf_counter()
        refit_config = candidate.model_copy(update={"n_estimators": refit_n_est, "early_stopping_rounds": None})
        refit_model = create_xgboost_model(
            config=refit_config,
            horizon=horizon,
            feature_names=features,
            n_jobs=n_jobs,
        )
        refit_model.fit(X=X_full_tr, y=y_full_tr_arr)
        t_stage2 = time.perf_counter() - t_s2_start

        total_fit_time = t_stage1 + t_stage2

        # Stage 3: Evaluate on outer validation partition
        y_pred = refit_model.predict(X_val)
        y_prob = refit_model.predict_proba(X_val)

        metrics = compute_classification_metrics(
            y_true=y_val_arr,
            y_pred=y_pred,
            y_prob=y_prob,
            horizon=horizon,
            model_name="XGBClassifier",
        )

        record = XGBoostCandidateRecord(
            grid_index=idx,
            hyperparameters=candidate,
            best_iteration=best_iter,
            metrics=metrics,
            is_selected=False,
            fit_time_seconds=float(total_fit_time),
        )
        records_by_idx[idx] = record

        # Atomic checkpoint persistence
        if checkpoint_path is not None:
            os.makedirs(os.path.dirname(os.path.abspath(checkpoint_path)), exist_ok=True)
            tmp_path = f"{checkpoint_path}.tmp"
            payload = {
                "experiment_id": experiment_id,
                "horizon": horizon,
                "model_family": "xgboost",
                "completed_count": len(records_by_idx),
                "total_count": total_candidates,
                "candidates": [r.model_dump(mode="json") for r in records_by_idx.values()],
            }
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            os.replace(tmp_path, checkpoint_path)

        if progress_callback is not None:
            progress_callback(len(records_by_idx), total_candidates, record)

    # Deterministic ranking
    ranked = sorted(records_by_idx.values(), key=_lexicographic_xgb_sort_key)
    champion_idx = ranked[0].grid_index

    # Mark champion
    final_candidates: List[XGBoostCandidateRecord] = []
    champion_record: Optional[XGBoostCandidateRecord] = None

    for idx in sorted(records_by_idx.keys()):
        rec = records_by_idx[idx]
        is_champ = (rec.grid_index == champion_idx)
        updated_rec = XGBoostCandidateRecord(
            grid_index=rec.grid_index,
            hyperparameters=rec.hyperparameters,
            best_iteration=rec.best_iteration,
            metrics=rec.metrics,
            is_selected=is_champ,
            fit_time_seconds=rec.fit_time_seconds,
        )
        final_candidates.append(updated_rec)
        if is_champ:
            champion_record = updated_rec

    assert champion_record is not None, "Champion candidate must be identified"
    selection_rankings = [r.grid_index for r in ranked]

    n_tr = len(y_full_tr_arr)
    n_v = len(y_val_arr)

    return XGBoostTuningResult(
        horizon=horizon,
        candidates=final_candidates,
        selected_candidate=champion_record,
        selected_hyperparameters=champion_record.hyperparameters,
        selection_rankings=selection_rankings,
        n_train_samples=n_tr,
        n_val_samples=n_v,
        n_features=len(features),
        feature_names=features,
        metadata={
            "experiment_id": experiment_id,
            "total_candidates_evaluated": len(final_candidates),
            "n_jobs": n_jobs,
        },
    )
