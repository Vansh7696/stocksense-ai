"""
StockSense AI — Advanced Model Hyperparameter Tuning Service (Phase 5C.4.3)
Orchestrates systematic, leakage-safe hyperparameter tuning for Random Forest
and XGBoost models across prediction horizons h1, h3, and h5 on the 23 approved features.

Guarantees:
- Strict Data Quarantine: Zero held-out test data is accessed, loaded, or evaluated.
- Exact Partition Membership: Enforces exact canonical trading-session date sets.
- Target Boundary Validation: Verifies no forward target returns cross partition boundaries.
- Experiment Isolation: All checkpoints, manifests, and artifacts reside under an isolated experiment directory.
- Two-Stage XGBoost Protocol: Inner-validation early stopping determines M*, followed by full-training refit with M* + 1 trees.
- Deterministic Tie-Breaking: Uses the approved 7-level lexicographic selection hierarchy.
- Incremental Atomic Persistence: Checkpoint files are saved atomically with .tmp rename.
"""

import os
import sys
import json
import time
import hashlib
import datetime
import subprocess
from typing import Dict, List, Optional, Any, Union, Sequence, Tuple, Callable
import numpy as np
import pandas as pd
import joblib
import sklearn

from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    APPROVED_EQUITIES,
    MAX_TRAINING_DATE,
    MAX_VALIDATION_DATE,
    QUARANTINED_TEST_START_DATE,
    QUARANTINED_TEST_END_DATE,
    PurgedChronologicalSplitter,
    split_inner_training_dates,
    validate_partition_membership,
    validate_target_boundaries,
    SplittingError,
    PartitionMembershipError,
    QuarantinedTestDataLeakageError,
    TargetBoundaryLeakageError,
)
from app.services.targets import TargetService, normalize_candle_timestamp
from app.services.features import FeatureEngineeringPipeline
from app.services.metrics import (
    CLASS_LABELS,
    CLASS_NAMES,
    compute_classification_metrics,
)
from app.schemas.metrics import ClassificationMetrics
from app.schemas.registry import ModelStatus, ModelRegistryMetadata, ModelProvenance
from app.services.registry import ModelRegistry, is_estimator_fitted
from app.schemas.random_forest import (
    RandomForestHyperparameters,
    RandomForestCandidateRecord,
    RandomForestTuningResult,
)
from app.services.random_forest import (
    RandomForestModel,
    create_random_forest_model,
    get_random_forest_search_grid,
    tune_random_forest,
    _lexicographic_rf_sort_key,
)
from app.schemas.xgboost_model import (
    XGBoostHyperparameters,
    XGBoostCandidateRecord,
    XGBoostTuningResult,
)
from app.services.xgboost_model import (
    XGBoostModel,
    create_xgboost_model,
    get_xgboost_search_grid,
    tune_xgboost,
    _lexicographic_xgb_sort_key,
    XGBOOST_AVAILABLE,
)

CANONICAL_DATASET_SHA256 = "d75a0e0f4e94c0991bbca71e911333b1944e7f064d8f4dd712cffa1688b97170"


def compute_file_sha256(filepath: str) -> str:
    """Computes SHA-256 digest of a local file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


class AdvancedTuningOrchestrator:
    """
    Coordinates multi-horizon hyperparameter tuning for Random Forest and XGBoost.
    """

    def __init__(
        self,
        experiment_id: str,
        output_base_dir: Optional[str] = None,
        dataset_path: Optional[str] = None,
        max_workers: Optional[int] = None,
        resume: bool = True,
    ):
        if not experiment_id or not experiment_id.strip():
            raise ValueError("experiment_id cannot be empty.")

        self.experiment_id = str(experiment_id).strip()
        self.resume = bool(resume)

        default_base = os.path.abspath(
            os.path.join(
                os.path.dirname(__file__),
                "..",
                "..",
                "models",
                "tuning",
                "phase_5c4_3",
                self.experiment_id,
            )
        )
        self.output_base_dir = os.path.abspath(output_base_dir) if output_base_dir else default_base

        default_dataset = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..", "data", "historical_candles_5stocks.json")
        )
        self.dataset_path = os.path.abspath(dataset_path) if dataset_path else default_dataset

        self.max_workers = int(max_workers) if max_workers is not None else min(4, os.cpu_count() or 1)

        self.checkpoints_dir = os.path.join(self.output_base_dir, "checkpoints")
        self.manifests_dir = os.path.join(self.output_base_dir, "manifests")
        self.champions_dir = os.path.join(self.output_base_dir, "champions")
        self.registry_dir = os.path.join(self.output_base_dir, "registry")

        # Conflict check if not resuming
        if not self.resume and os.path.exists(self.output_base_dir):
            existing_files = []
            for d in (self.checkpoints_dir, self.manifests_dir):
                if os.path.exists(d):
                    existing_files.extend(os.listdir(d))
            if existing_files:
                raise FileExistsError(
                    f"Experiment '{self.experiment_id}' already has existing artifacts at "
                    f"'{self.output_base_dir}' and resume=False. Choose a unique experiment_id."
                )

        os.makedirs(self.checkpoints_dir, exist_ok=True)
        os.makedirs(self.manifests_dir, exist_ok=True)
        os.makedirs(self.champions_dir, exist_ok=True)
        os.makedirs(self.registry_dir, exist_ok=True)

    def prepare_dataset(
        self,
        horizons: Sequence[int] = (1, 3, 5),
    ) -> Dict[int, Dict[str, Any]]:
        """
        Loads the canonical dataset, extracts features and targets, and produces
        strictly quarantined, leakage-audited partition datasets for each requested horizon.

        Returns:
            Dict mapping horizon -> {
                "X_in_tr": DataFrame, "y_in_tr": Series,
                "X_in_val": DataFrame, "y_in_val": Series,
                "X_full_tr": DataFrame, "y_full_tr": Series,
                "X_val": DataFrame, "y_val": Series,
                "dates": dict,
            }
        """
        if not os.path.exists(self.dataset_path):
            raise FileNotFoundError(f"Canonical dataset fixture not found at {self.dataset_path}")

        dataset_sha256 = compute_file_sha256(self.dataset_path)
        with open(self.dataset_path, "r", encoding="utf-8") as f:
            raw_data = json.load(f)

        # 544 trading-session dates from candle index 199 onward
        clean_calendar = [
            normalize_candle_timestamp(c["timestamp"])[1]
            for c in raw_data["RELIANCE"]["candles"][199:]
        ]
        if len(clean_calendar) != 544:
            raise ValueError(f"Expected exactly 544 trading-session dates, got {len(clean_calendar)}")

        target_service = TargetService()
        feat_pipe = FeatureEngineeringPipeline()

        all_targets = []
        all_features = []

        for symbol, stock_info in raw_data.items():
            raw_candles = stock_info["candles"]

            # Targets on 544 clean dates
            t_res = target_service.generate(
                raw_candles[199:],
                symbol=symbol,
                horizons=list(horizons),
                expected_sessions=clean_calendar,
            )
            t_df = t_res.to_dataframe()
            t_df["session_date"] = t_df["signal_date"]
            all_targets.append(t_df)

            # Features with drop_na=True
            f_res = feat_pipe.extract_features(raw_candles, drop_na=True)
            f_df = pd.DataFrame(f_res["features"])
            f_df["session_date"] = f_df["timestamp"].apply(lambda ts: normalize_candle_timestamp(ts)[1])
            f_df["stock_symbol"] = symbol
            all_features.append(f_df)

        targets_df = pd.concat(all_targets, ignore_index=True)
        features_df = pd.concat(all_features, ignore_index=True)

        # Canonical date partition boundaries
        splitter = PurgedChronologicalSplitter()
        bounds = splitter.get_partition_boundaries(clean_calendar)
        nominal_train_dates = clean_calendar[:bounds["train"].nominal_dates_count]
        nominal_val_dates = clean_calendar[
            bounds["val"].start_index : bounds["val"].end_index + 1
        ]
        val_start_date = bounds["val"].start_date

        horizon_partitions: Dict[int, Dict[str, Any]] = {}

        for h in horizons:
            targ_h = targets_df[targets_df["prediction_horizon"] == h].copy()

            # Outer split
            retained_outer_train = nominal_train_dates[:-h]
            retained_outer_val = nominal_val_dates[:-h]

            # Inner split
            in_tr_dates, p_in_tr_dates, in_val_dates, p_in_val_dates = split_inner_training_dates(
                nominal_train_dates, horizon=h, inner_train_ratio=0.80
            )

            # Join helper
            def _extract_xy(date_set: Sequence[str], p_name: str) -> Tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
                targ_part = targ_h[targ_h["session_date"].isin(date_set)].copy()
                validate_partition_membership(targ_part, date_set, partition_name=p_name)

                merged = pd.merge(
                    targ_part[["stock_symbol", "session_date", "target_label", "exit_date"]],
                    features_df[["stock_symbol", "session_date"] + list(APPROVED_FEATURE_ALLOWLIST)],
                    on=["stock_symbol", "session_date"],
                    how="inner",
                )
                if len(merged) != len(targ_part):
                    raise ValueError(f"Feature join integrity failure for {p_name}")

                X = merged[list(APPROVED_FEATURE_ALLOWLIST)].copy()
                y = merged["target_label"].copy()
                return X, y, merged

            X_in_tr, y_in_tr, df_in_tr = _extract_xy(in_tr_dates, f"inner_train_h{h}")
            X_in_val, y_in_val, df_in_val = _extract_xy(in_val_dates, f"inner_val_h{h}")
            X_full_tr, y_full_tr, df_full_tr = _extract_xy(retained_outer_train, f"outer_train_h{h}")
            X_val, y_val, df_val = _extract_xy(retained_outer_val, f"outer_val_h{h}")

            # Strict boundary validation
            validate_target_boundaries(
                df_in_tr,
                next_partition_start_date=in_val_dates[0],
                horizon=h,
                partition_name=f"inner_train_h{h}",
            )
            validate_target_boundaries(
                df_full_tr,
                next_partition_start_date=val_start_date,
                horizon=h,
                partition_name=f"outer_train_h{h}",
            )

            horizon_partitions[h] = {
                "X_in_tr": X_in_tr,
                "y_in_tr": y_in_tr,
                "X_in_val": X_in_val,
                "y_in_val": y_in_val,
                "X_full_tr": X_full_tr,
                "y_full_tr": y_full_tr,
                "X_val": X_val,
                "y_val": y_val,
                "dates": {
                    "inner_train": in_tr_dates,
                    "inner_val": in_val_dates,
                    "outer_train": retained_outer_train,
                    "outer_val": retained_outer_val,
                },
                "dataset_sha256": dataset_sha256,
            }

        return horizon_partitions

    def _collect_environment_provenance(self) -> Dict[str, Any]:
        """Collects git commit and runtime package versions."""
        git_commit = "unknown"
        try:
            git_commit = (
                subprocess.check_output(["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL)
                .decode("utf-8")
                .strip()
            )
        except Exception:
            pass

        xgb_version = "not_available"
        if XGBOOST_AVAILABLE:
            try:
                import xgboost as xgb
                xgb_version = getattr(xgb, "__version__", "unknown")
            except Exception:
                pass

        return {
            "git_commit": git_commit,
            "python_version": sys.version.split()[0],
            "scikit_learn_version": sklearn.__version__,
            "xgboost_version": xgb_version,
            "timestamp_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

    def run_tuning(
        self,
        horizons: Sequence[int] = (1, 3, 5),
        models: Sequence[str] = ("random_forest", "xgboost"),
        rf_grid: Optional[List[RandomForestHyperparameters]] = None,
        xgb_grid: Optional[List[XGBoostHyperparameters]] = None,
        progress_callback: Optional[Callable[[str, int, int, Any], None]] = None,
    ) -> Dict[str, Any]:
        """
        Executes systematic hyperparameter tuning campaigns across all requested horizons and models.

        Args:
            horizons: Sequence of prediction horizons h in (1, 3, 5).
            models: Sequence of model family names in ("random_forest", "xgboost").
            rf_grid: Optional custom search grid for Random Forest.
            xgb_grid: Optional custom search grid for XGBoost.
            progress_callback: Optional callable(tag, completed, total, latest_record).

        Returns:
            Dictionary with full summary manifest.
        """
        print(f"=== Starting Phase 5C.4.3 Tuning Experiment '{self.experiment_id}' ===")
        print(f"Output Directory: {self.output_base_dir}")
        print(f"Max Workers: {self.max_workers}")

        dataset_bundles = self.prepare_dataset(horizons=horizons)
        env_meta = self._collect_environment_provenance()

        summary: Dict[str, Any] = {
            "experiment_id": self.experiment_id,
            "created_at_utc": env_meta["timestamp_utc"],
            "dataset_sha256": dataset_bundles[horizons[0]]["dataset_sha256"],
            "provenance": env_meta,
            "horizons": list(horizons),
            "models_evaluated": list(models),
            "results": {},
        }

        registry = ModelRegistry(registry_dir=self.registry_dir)

        for h in horizons:
            bundle = dataset_bundles[h]
            summary["results"][f"h{h}"] = {}

            # -------------------------------------------------------------
            # Random Forest Tuning
            # -------------------------------------------------------------
            if "random_forest" in models:
                tag = f"rf_h{h}"
                print(f"\n--- Tuning Random Forest (h={h}) ---")
                chk_path = os.path.join(self.checkpoints_dir, f"checkpoint_rf_h{h}.json")

                def _rf_cb(done: int, total: int, rec: RandomForestCandidateRecord) -> None:
                    if progress_callback is not None:
                        progress_callback(tag, done, total, rec)
                    if done % 20 == 0 or done == total:
                        print(
                            f"  [RF h={h}] {done}/{total} ({(done/total)*100:.1f}%) | "
                            f"Latest: BalAcc={rec.metrics.balanced_accuracy:.4f}, F1={rec.metrics.macro_f1:.4f}, "
                            f"LogLoss={rec.metrics.log_loss:.4f}"
                        )

                rf_res = tune_random_forest(
                    X_train=bundle["X_full_tr"],
                    y_train=bundle["y_full_tr"],
                    X_val=bundle["X_val"],
                    y_val=bundle["y_val"],
                    horizon=h,
                    n_jobs=self.max_workers,
                    checkpoint_path=chk_path,
                    experiment_id=self.experiment_id,
                    progress_callback=_rf_cb,
                    grid=rf_grid,
                )

                # Write final manifest
                manifest_rf_path = os.path.join(self.manifests_dir, f"tuning_manifest_rf_h{h}.json")
                with open(manifest_rf_path, "w", encoding="utf-8") as f:
                    json.dump(rf_res.model_dump(mode="json"), f, indent=2)

                # Fit and register champion model
                champ_rf_model = create_random_forest_model(
                    config=rf_res.selected_hyperparameters,
                    horizon=h,
                    n_jobs=self.max_workers,
                )
                champ_rf_model.fit(bundle["X_full_tr"], bundle["y_full_tr"])

                # Persist champion binary
                rf_champ_filename = f"random_forest_champion_h{h}.joblib"
                rf_champ_path = os.path.join(self.champions_dir, rf_champ_filename)
                joblib.dump(
                    {
                        "estimator": champ_rf_model,
                        "scaler": None,
                        "feature_names": list(APPROVED_FEATURE_ALLOWLIST),
                        "horizon": h,
                        "hyperparameters": rf_res.selected_hyperparameters.model_dump(),
                        "metrics": rf_res.selected_candidate.metrics.model_dump(),
                    },
                    rf_champ_path,
                    compress=3,
                )

                # Register champion under VALIDATION_SELECTED
                registry.register_model(
                    estimator=champ_rf_model,
                    scaler=None,
                    model_name="random_forest",
                    version="1.0.0",
                    horizon=h,
                    hyperparameters=rf_res.selected_hyperparameters.model_dump(),
                    validation_metrics=rf_res.selected_candidate.metrics,
                    training_samples=rf_res.n_train_samples,
                    validation_samples=rf_res.n_val_samples,
                    experiment_id=self.experiment_id,
                    algorithm="Random Forest Classifier",
                    status=ModelStatus.VALIDATION_SELECTED,
                    notes=f"Champion selected via Phase 5C.4.3 tuning (grid index {rf_res.selected_candidate.grid_index})",
                    overwrite=True,
                )

                summary["results"][f"h{h}"]["random_forest"] = {
                    "selected_candidate_grid_index": rf_res.selected_candidate.grid_index,
                    "selected_hyperparameters": rf_res.selected_hyperparameters.model_dump(),
                    "validation_metrics": rf_res.selected_candidate.metrics.model_dump(),
                    "total_candidates": len(rf_res.candidates),
                    "fit_time_seconds": rf_res.selected_candidate.fit_time_seconds,
                    "champion_artifact": rf_champ_filename,
                }
                print(
                    f"  [RF h={h} Champion] Grid #{rf_res.selected_candidate.grid_index} | "
                    f"BalAcc: {rf_res.selected_candidate.metrics.balanced_accuracy:.4f} | "
                    f"F1: {rf_res.selected_candidate.metrics.macro_f1:.4f} | "
                    f"LogLoss: {rf_res.selected_candidate.metrics.log_loss:.4f}"
                )

            # -------------------------------------------------------------
            # XGBoost Tuning
            # -------------------------------------------------------------
            if "xgboost" in models:
                tag = f"xgb_h{h}"
                print(f"\n--- Tuning XGBoost (h={h}) ---")
                chk_path = os.path.join(self.checkpoints_dir, f"checkpoint_xgb_h{h}.json")

                def _xgb_cb(done: int, total: int, rec: XGBoostCandidateRecord) -> None:
                    if progress_callback is not None:
                        progress_callback(tag, done, total, rec)
                    if done % 20 == 0 or done == total:
                        print(
                            f"  [XGB h={h}] {done}/{total} ({(done/total)*100:.1f}%) | "
                            f"Latest (M*={rec.best_iteration}): BalAcc={rec.metrics.balanced_accuracy:.4f}, "
                            f"F1={rec.metrics.macro_f1:.4f}, LogLoss={rec.metrics.log_loss:.4f}"
                        )

                xgb_res = tune_xgboost(
                    X_in_tr=bundle["X_in_tr"],
                    y_in_tr=bundle["y_in_tr"],
                    X_in_val=bundle["X_in_val"],
                    y_in_val=bundle["y_in_val"],
                    X_full_tr=bundle["X_full_tr"],
                    y_full_tr=bundle["y_full_tr"],
                    X_val=bundle["X_val"],
                    y_val=bundle["y_val"],
                    horizon=h,
                    n_jobs=self.max_workers,
                    checkpoint_path=chk_path,
                    experiment_id=self.experiment_id,
                    progress_callback=_xgb_cb,
                    grid=xgb_grid,
                )

                # Write final manifest
                manifest_xgb_path = os.path.join(self.manifests_dir, f"tuning_manifest_xgb_h{h}.json")
                with open(manifest_xgb_path, "w", encoding="utf-8") as f:
                    json.dump(xgb_res.model_dump(mode="json"), f, indent=2)

                # Fit and register champion model
                best_iter = xgb_res.selected_candidate.best_iteration
                champ_n_est = (best_iter + 1) if best_iter is not None else xgb_res.selected_hyperparameters.n_estimators
                champ_config = xgb_res.selected_hyperparameters.model_copy(
                    update={"n_estimators": champ_n_est, "early_stopping_rounds": None}
                )

                champ_xgb_model = create_xgboost_model(
                    config=champ_config,
                    horizon=h,
                    n_jobs=self.max_workers,
                )
                champ_xgb_model.fit(bundle["X_full_tr"], bundle["y_full_tr"])

                # Persist champion binary
                xgb_champ_filename = f"xgboost_champion_h{h}.joblib"
                xgb_champ_path = os.path.join(self.champions_dir, xgb_champ_filename)
                joblib.dump(
                    {
                        "estimator": champ_xgb_model,
                        "scaler": None,
                        "feature_names": list(APPROVED_FEATURE_ALLOWLIST),
                        "horizon": h,
                        "hyperparameters": champ_config.model_dump(),
                        "metrics": xgb_res.selected_candidate.metrics.model_dump(),
                        "best_iteration": best_iter,
                    },
                    xgb_champ_path,
                    compress=3,
                )

                # Register champion under VALIDATION_SELECTED
                registry.register_model(
                    estimator=champ_xgb_model,
                    scaler=None,
                    model_name="xgboost",
                    version="1.0.0",
                    horizon=h,
                    hyperparameters=champ_config.model_dump(),
                    validation_metrics=xgb_res.selected_candidate.metrics,
                    training_samples=xgb_res.n_train_samples,
                    validation_samples=xgb_res.n_val_samples,
                    experiment_id=self.experiment_id,
                    algorithm="XGBoost Classifier (Gradient Boosting)",
                    status=ModelStatus.VALIDATION_SELECTED,
                    notes=(
                        f"Champion selected via Phase 5C.4.3 tuning (grid index {xgb_res.selected_candidate.grid_index}, "
                        f"M*={best_iter}, refit n_estimators={champ_n_est})"
                    ),
                    overwrite=True,
                )

                summary["results"][f"h{h}"]["xgboost"] = {
                    "selected_candidate_grid_index": xgb_res.selected_candidate.grid_index,
                    "selected_hyperparameters": champ_config.model_dump(),
                    "best_iteration": best_iter,
                    "refit_n_estimators": champ_n_est,
                    "validation_metrics": xgb_res.selected_candidate.metrics.model_dump(),
                    "total_candidates": len(xgb_res.candidates),
                    "fit_time_seconds": xgb_res.selected_candidate.fit_time_seconds,
                    "champion_artifact": xgb_champ_filename,
                }
                print(
                    f"  [XGB h={h} Champion] Grid #{xgb_res.selected_candidate.grid_index} | "
                    f"M*={best_iter} -> Refit Trees={champ_n_est} | "
                    f"BalAcc: {xgb_res.selected_candidate.metrics.balanced_accuracy:.4f} | "
                    f"F1: {xgb_res.selected_candidate.metrics.macro_f1:.4f} | "
                    f"LogLoss: {xgb_res.selected_candidate.metrics.log_loss:.4f}"
                )

        # Write overall summary manifest
        summary_path = os.path.join(self.manifests_dir, "tuning_summary_phase_5c4_3.json")
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)

        print(f"\n=== Tuning Completed Successfully ===")
        print(f"Summary Manifest written to: {summary_path}")
        return summary
