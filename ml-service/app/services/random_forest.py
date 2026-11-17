"""
StockSense AI — Random Forest Model Service
Domain wrapper and model factory for Random Forest classification using
scikit-learn's RandomForestClassifier on the approved 23 technical features.
"""

import os
import json
import time
from typing import Dict, List, Optional, Any, Union, Sequence, Tuple, Callable
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier

from app.services.splitting import APPROVED_FEATURE_ALLOWLIST
from app.services.metrics import (
    compute_classification_metrics,
    validate_and_normalize_probabilities,
)
from app.schemas.random_forest import (
    RandomForestHyperparameters,
    RandomForestCandidateRecord,
    RandomForestTuningResult,
    RandomForestModelMetadata,
)

# Canonical 3-class label mappings
EXTERNAL_LABELS = (-1, 0, 1)
INTERNAL_CLASSES = (0, 1, 2)
CLASS_NAMES = ("DOWN", "NEUTRAL", "UP")
EXTERNAL_TO_INTERNAL = {-1: 0, 0: 1, 1: 2}
INTERNAL_TO_EXTERNAL = {0: -1, 1: 0, 2: 1}


class RandomForestModel:
    """
    Domain service wrapping scikit-learn's RandomForestClassifier.

    Guarantees:
    - Direct ingestion of the raw 23 approved technical features without scaling.
    - Strict validation of input column presence, ordering, and finiteness.
    - Class mapping between external labels {-1, 0, 1} and internal indices {0, 1, 2}.
    - Aligned 3-class probability distributions of shape (N, 3) [DOWN, NEUTRAL, UP],
      even if a training fold observed fewer than 3 classes.
    """

    def __init__(
        self,
        n_estimators: int = 100,
        max_depth: Optional[int] = 4,
        min_samples_leaf: int = 25,
        max_features: Union[str, float] = "sqrt",
        class_weight: Optional[str] = None,
        bootstrap: bool = True,
        random_state: int = 42,
        n_jobs: int = -1,
        horizon: Optional[int] = None,
        feature_names: Optional[List[str]] = None,
    ):
        self.n_estimators = int(n_estimators)
        self.max_depth = int(max_depth) if max_depth is not None else None
        self.min_samples_leaf = int(min_samples_leaf)
        self.max_features = max_features
        self.class_weight = class_weight
        self.bootstrap = bool(bootstrap)
        self.random_state = int(random_state)
        self.n_jobs = int(n_jobs)
        self.horizon = horizon
        self.feature_names = list(feature_names or APPROVED_FEATURE_ALLOWLIST)

        self.algorithm_name = "Random Forest Classifier (Bagging)"
        self.solver = "exact"
        self.model_: Optional[RandomForestClassifier] = None
        self.classes_: Optional[np.ndarray] = None
        self.n_samples_: Optional[int] = None
        self.n_features_: Optional[int] = None
        self.is_fitted_: bool = False

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
    ) -> "RandomForestModel":
        """
        Fits Random Forest classifier directly on raw training features.

        Args:
            X: 2D feature matrix (N, 23).
            y: Ground-truth target labels in {-1, 0, 1}.

        Returns:
            Fitted RandomForestModel instance.
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

        if len(unique_labels) < 2:
            raise ValueError(
                f"Random Forest training requires at least 2 distinct classes in training partition, "
                f"got {len(unique_labels)}: {sorted(list(unique_labels))}. Cannot fit classification model on single-class data."
            )

        # Map external labels {-1, 0, 1} to internal classes {0, 1, 2}
        y_internal = np.array([EXTERNAL_TO_INTERNAL[lbl] for lbl in y_int], dtype=np.int64)

        clf = RandomForestClassifier(
            n_estimators=self.n_estimators,
            max_depth=self.max_depth,
            min_samples_leaf=self.min_samples_leaf,
            max_features=self.max_features,
            class_weight=self.class_weight,
            bootstrap=self.bootstrap,
            random_state=self.random_state,
            n_jobs=self.n_jobs,
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
        Predicts discrete 3-class target labels in {-1, 0, 1}.

        Args:
            X: 2D feature matrix (N, 23).

        Returns:
            1D int64 array of shape (N,) containing labels in {-1, 0, 1}.
        """
        if not self.is_fitted_ or self.model_ is None:
            raise ValueError("Model is not fitted. Call fit() before predicting.")

        X_arr = self._validate_and_extract_features(X)
        preds_internal = self.model_.predict(X_arr)

        preds_external = np.array([INTERNAL_TO_EXTERNAL[c] for c in preds_internal], dtype=np.int64)
        return preds_external

    def predict_proba(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
        """
        Predicts 3-class probability distribution of shape (N, 3):
        [P(DOWN), P(NEUTRAL), P(UP)].
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

    def get_metadata(self) -> RandomForestModelMetadata:
        """Returns structured audit metadata for the Random Forest instance."""
        importances: Optional[Dict[str, float]] = None
        if self.is_fitted_ and self.model_ is not None and hasattr(self.model_, "feature_importances_"):
            importances = {
                feat: float(imp)
                for feat, imp in zip(self.feature_names, self.model_.feature_importances_)
            }

        return RandomForestModelMetadata(
            horizon=self.horizon,
            n_estimators=self.n_estimators,
            max_depth=self.max_depth,
            min_samples_leaf=self.min_samples_leaf,
            max_features=self.max_features,
            class_weight=self.class_weight,
            bootstrap=self.bootstrap,
            random_state=self.random_state,
            feature_importances=importances,
        )


def create_random_forest_model(
    config: Optional[RandomForestHyperparameters] = None,
    horizon: Optional[int] = None,
    feature_names: Optional[List[str]] = None,
    n_jobs: int = -1,
) -> RandomForestModel:
    """
    Factory function instantiating a configured RandomForestModel.
    """
    if config is None:
        config = RandomForestHyperparameters()

    return RandomForestModel(
        n_estimators=config.n_estimators,
        max_depth=config.max_depth,
        min_samples_leaf=config.min_samples_leaf,
        max_features=config.max_features,
        class_weight=config.class_weight,
        bootstrap=config.bootstrap,
        random_state=config.random_state,
        n_jobs=n_jobs,
        horizon=horizon,
        feature_names=feature_names,
    )


RF_GRID_N_ESTIMATORS = [100, 200, 300]
RF_GRID_MAX_DEPTH = [3, 4, 5, 6]
RF_GRID_MIN_SAMPLES_LEAF = [15, 25, 40]
RF_GRID_MAX_FEATURES = ["sqrt", "log2", 0.3]


def get_random_forest_search_grid() -> List[RandomForestHyperparameters]:
    """
    Generates the exact approved 108 candidate configurations for Random Forest.
    Grid specification:
    - n_estimators: [100, 200, 300] (3)
    - max_depth: [3, 4, 5, 6] (4)
    - min_samples_leaf: [15, 25, 40] (3)
    - max_features: ["sqrt", "log2", 0.3] (3)
    - Fixed: class_weight=None, bootstrap=True, random_state=42
    Total: 3 * 4 * 3 * 3 = 108 configurations per horizon.
    """
    grid: List[RandomForestHyperparameters] = []
    idx = 0

    for n_est in RF_GRID_N_ESTIMATORS:
        for depth in RF_GRID_MAX_DEPTH:
            for min_leaf in RF_GRID_MIN_SAMPLES_LEAF:
                for max_feat in RF_GRID_MAX_FEATURES:
                    grid.append(
                        RandomForestHyperparameters(
                            n_estimators=n_est,
                            max_depth=depth,
                            min_samples_leaf=min_leaf,
                            max_features=max_feat,
                            class_weight=None,
                            bootstrap=True,
                            random_state=42,
                            grid_index=idx,
                        )
                    )
                    idx += 1

    return grid


def _lexicographic_rf_sort_key(
    record: RandomForestCandidateRecord,
) -> Tuple[float, float, float, int, int, int, int]:
    """
    Deterministic tie-break hierarchy for Random Forest model selection:
    1. Highest balanced accuracy (-bal_acc)
    2. Highest macro F1 (-macro_f1)
    3. Lowest log loss (log_loss)
    4. Lower max_depth (max_depth)
    5. Larger min_samples_leaf (-min_samples_leaf)
    6. Lower n_estimators (n_estimators)
    7. Lower grid_index (grid_index)
    """
    bal_acc = float(record.metrics.balanced_accuracy)
    macro_f1 = float(record.metrics.macro_f1)
    log_loss = float(record.metrics.log_loss)
    max_depth = int(record.hyperparameters.max_depth) if record.hyperparameters.max_depth is not None else 999
    min_leaf = int(record.hyperparameters.min_samples_leaf)
    n_est = int(record.hyperparameters.n_estimators)
    grid_idx = int(record.grid_index) if record.grid_index is not None else 0

    return (-bal_acc, -macro_f1, log_loss, max_depth, -min_leaf, n_est, grid_idx)


def tune_random_forest(
    X_train: Union[pd.DataFrame, np.ndarray],
    y_train: Union[Sequence[int], np.ndarray, pd.Series],
    X_val: Union[pd.DataFrame, np.ndarray],
    y_val: Union[Sequence[int], np.ndarray, pd.Series],
    horizon: int,
    feature_names: Optional[List[str]] = None,
    n_jobs: int = -1,
    checkpoint_path: Optional[str] = None,
    experiment_id: Optional[str] = None,
    progress_callback: Optional[Callable[[int, int, RandomForestCandidateRecord], None]] = None,
    grid: Optional[List[RandomForestHyperparameters]] = None,
) -> RandomForestTuningResult:
    """
    Systematically tunes Random Forest across the approved 108 candidate configurations.

    Guarantees:
    - Direct ingestion of the raw 23 approved technical features without scaling.
    - Fits candidates on outer training partition and evaluates on outer validation partition.
    - Deterministic tie-breaking using the approved 7-level hierarchy.
    - Incremental atomic checkpoint persistence and interruption recovery.
    - Progress reporting callback support.

    Args:
        X_train: Outer training features (N_tr, 23).
        y_train: Outer training labels (N_tr,) in {-1, 0, 1}.
        X_val: Outer validation features (N_val, 23).
        y_val: Outer validation labels (N_val,) in {-1, 0, 1}.
        horizon: Prediction horizon h in trading days (1, 3, or 5).
        feature_names: Optional feature column names (defaults to 23 approved features).
        n_jobs: CPU parallelism for tree construction.
        checkpoint_path: Optional filesystem path for atomic checkpoint persistence.
        experiment_id: Optional experiment identifier for traceability.
        progress_callback: Optional callable(completed_count, total_count, latest_record).
        grid: Optional custom search grid (defaults to exact 108 configurations).

    Returns:
        RandomForestTuningResult with all evaluated candidates, rankings, and champion.
    """
    features = list(feature_names or APPROVED_FEATURE_ALLOWLIST)
    search_grid = grid if grid is not None else get_random_forest_search_grid()

    y_tr_arr = np.asarray(y_train, dtype=np.int64)
    y_val_arr = np.asarray(y_val, dtype=np.int64)

    if len(np.unique(y_tr_arr)) < 2:
        raise ValueError("Random Forest training requires at least 2 distinct classes in training partition.")

    records_by_idx: Dict[int, RandomForestCandidateRecord] = {}

    # Checkpoint resumption
    if checkpoint_path is not None and os.path.exists(checkpoint_path):
        try:
            with open(checkpoint_path, "r", encoding="utf-8") as f:
                chk_data = json.load(f)
            if chk_data.get("horizon") == horizon and chk_data.get("model_family") == "random_forest":
                for item in chk_data.get("candidates", []):
                    rec = RandomForestCandidateRecord.model_validate(item)
                    records_by_idx[rec.grid_index] = rec
        except Exception:
            # Fall back to empty records if checkpoint is unreadable/corrupted
            records_by_idx = {}

    total_candidates = len(search_grid)

    for candidate in search_grid:
        idx = candidate.grid_index if candidate.grid_index is not None else len(records_by_idx)
        if idx in records_by_idx:
            if progress_callback is not None:
                progress_callback(len(records_by_idx), total_candidates, records_by_idx[idx])
            continue

        t0 = time.perf_counter()
        model = create_random_forest_model(
            config=candidate,
            horizon=horizon,
            feature_names=features,
            n_jobs=n_jobs,
        )
        model.fit(X_train, y_tr_arr)
        fit_time = time.perf_counter() - t0

        y_pred = model.predict(X_val)
        y_prob = model.predict_proba(X_val)

        metrics = compute_classification_metrics(
            y_true=y_val_arr,
            y_pred=y_pred,
            y_prob=y_prob,
            horizon=horizon,
            model_name="RandomForestClassifier",
        )

        record = RandomForestCandidateRecord(
            grid_index=idx,
            hyperparameters=candidate,
            metrics=metrics,
            is_selected=False,
            fit_time_seconds=float(fit_time),
        )
        records_by_idx[idx] = record

        # Atomic checkpoint persistence
        if checkpoint_path is not None:
            os.makedirs(os.path.dirname(os.path.abspath(checkpoint_path)), exist_ok=True)
            tmp_path = f"{checkpoint_path}.tmp"
            payload = {
                "experiment_id": experiment_id,
                "horizon": horizon,
                "model_family": "random_forest",
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
    ranked = sorted(records_by_idx.values(), key=_lexicographic_rf_sort_key)
    champion_idx = ranked[0].grid_index

    # Mark champion
    final_candidates: List[RandomForestCandidateRecord] = []
    champion_record: Optional[RandomForestCandidateRecord] = None

    for idx in sorted(records_by_idx.keys()):
        rec = records_by_idx[idx]
        is_champ = (rec.grid_index == champion_idx)
        updated_rec = RandomForestCandidateRecord(
            grid_index=rec.grid_index,
            hyperparameters=rec.hyperparameters,
            metrics=rec.metrics,
            is_selected=is_champ,
            fit_time_seconds=rec.fit_time_seconds,
        )
        final_candidates.append(updated_rec)
        if is_champ:
            champion_record = updated_rec

    assert champion_record is not None, "Champion candidate must be identified"
    selection_rankings = [r.grid_index for r in ranked]

    n_tr = len(y_tr_arr)
    n_v = len(y_val_arr)

    return RandomForestTuningResult(
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
