"""
StockSense AI — Model Registry Service
Reliable, cryptographically verified, versioned registry for trained ML models.
Ensures atomic persistence of estimators bundled with their corresponding scalers,
tamper-evident SHA-256 validation before unpickling, runtime compatibility checks,
and complete provenance tracking.
"""

import os
import sys
import json
import shutil
import hashlib
import tempfile
import warnings
import datetime
import subprocess
from typing import Dict, List, Optional, Tuple, Any, Union
import numpy as np
import pandas as pd
import joblib
import sklearn
import scipy

from app.schemas.registry import (
    ModelStatus,
    ModelProvenance,
    ModelRegistryMetadata,
    ModelListItem,
)
from app.schemas.metrics import ClassificationMetrics
from app.services.logistic_regression import (
    MultinomialLogisticRegression,
    EXTERNAL_LABELS,
)
from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    StandardScaler,
    PurgedChronologicalSplitter,
)
from app.services.targets import TargetService, normalize_candle_timestamp
from app.services.features import FeatureEngineeringPipeline
from app.services.metrics import (
    CLASS_LABELS,
    CLASS_NAMES,
    compute_classification_metrics,
)


# Supported registry schema versions
SUPPORTED_REGISTRY_SCHEMA_VERSIONS = {"1.0"}

# Canonical target-generation thresholds (theta_h in %)
TARGET_THRESHOLDS_PCT: Dict[int, float] = {
    1: 0.50,
    3: 1.00,
    5: 1.50,
}


# =============================================================================
# Custom Registry Exceptions
# =============================================================================

class RegistryError(Exception):
    """Base exception for all model registry errors."""
    pass


class ArtifactNotFoundError(RegistryError):
    """Raised when a model artifact or metadata sidecar cannot be located."""
    pass


class ArtifactIntegrityError(RegistryError):
    """Raised when an artifact binary fails SHA-256 cryptographic verification."""
    pass


class ModelVersionExistsError(RegistryError):
    """Raised when attempting to overwrite an existing registered model without overwrite=True."""
    pass


class IncompatibleFeatureError(RegistryError):
    """Raised when feature names, ordering, or dimensions mismatch the registered schema."""
    pass


class IncompatibleClassError(RegistryError):
    """Raised when target class labels or ordering mismatch the canonical 3-class schema."""
    pass


class RegistrySchemaVersionError(RegistryError):
    """Raised when an artifact metadata sidecar has an unsupported or incompatible schema version."""
    pass


class RuntimeCompatibilityError(RegistryError):
    """Raised when runtime package or Python versions are incompatible with the serialized artifact."""
    pass


# =============================================================================
# Runtime Compatibility Policy & Verification
# =============================================================================

def check_runtime_compatibility(provenance: ModelProvenance) -> None:
    """
    Enforces deterministic runtime compatibility policy:
    1. Python major.minor must match (patch difference is tolerated).
    2. scikit-learn major.minor must match (patch differences emit UserWarning;
       different minor versions fail because scikit-learn does not guarantee pickle compatibility).
    3. joblib major.minor must match (patch differences emit UserWarning).
    """
    # 1. Python version check
    prov_py_parts = provenance.python_version.split(".")
    curr_py_parts = sys.version.split()[0].split(".")
    if (prov_py_parts[0], prov_py_parts[1]) != (curr_py_parts[0], curr_py_parts[1]):
        raise RuntimeCompatibilityError(
            f"Incompatible Python runtime: model was trained under Python {provenance.python_version} "
            f"(major.minor {prov_py_parts[0]}.{prov_py_parts[1]}), but current runtime is "
            f"{sys.version.split()[0]} ({curr_py_parts[0]}.{curr_py_parts[1]})."
        )

    # 2. scikit-learn version check
    prov_sklearn = provenance.library_versions.get("scikit-learn")
    if prov_sklearn:
        prov_sk_parts = prov_sklearn.split(".")
        curr_sk_parts = sklearn.__version__.split(".")
        if (prov_sk_parts[0], prov_sk_parts[1]) != (curr_sk_parts[0], curr_sk_parts[1]):
            raise RuntimeCompatibilityError(
                f"Incompatible scikit-learn version: model was serialized with scikit-learn {prov_sklearn} "
                f"(major.minor {prov_sk_parts[0]}.{prov_sk_parts[1]}), but current runtime has "
                f"{sklearn.__version__} ({curr_sk_parts[0]}.{curr_sk_parts[1]}). "
                f"scikit-learn estimators do not support cross-minor-version deserialization."
            )
        elif prov_sklearn != sklearn.__version__:
            warnings.warn(
                f"scikit-learn patch release difference: model serialized with {prov_sklearn}, "
                f"current runtime has {sklearn.__version__}.",
                UserWarning,
                stacklevel=2,
            )

    # 3. joblib version check
    prov_joblib = provenance.library_versions.get("joblib")
    if prov_joblib:
        prov_jl_parts = prov_joblib.split(".")
        curr_jl_parts = joblib.__version__.split(".")
        if (prov_jl_parts[0], prov_jl_parts[1]) != (curr_jl_parts[0], curr_jl_parts[1]):
            raise RuntimeCompatibilityError(
                f"Incompatible joblib version: model was serialized with joblib {prov_joblib} "
                f"(major.minor {prov_jl_parts[0]}.{prov_jl_parts[1]}), but current runtime has "
                f"{joblib.__version__} ({curr_jl_parts[0]}.{curr_jl_parts[1]})."
            )


# =============================================================================
# Inference Pipeline Wrapper
# =============================================================================

class RegisteredInferenceModel:
    """
    Unified inference pipeline bundling a fitted estimator with its fitted StandardScaler.

    Guarantees:
    - Input features are strictly validated against the approved 23-feature schema.
    - Standard scaling parameters (mean, scale) are applied automatically without refitting.
    - Column reordering immunity: DataFrames with columns in arbitrary order are safely realigned.
    - Output predictions and probabilities match canonical 3-class semantics:
        Classes: DOWN (-1), NEUTRAL (0), UP (+1)
        Probabilities: shape (N, 3) ordered [P(DOWN), P(NEUTRAL), P(UP)]
    - Estimator and scaler cannot become mismatched or separated.
    """

    def __init__(
        self,
        estimator: MultinomialLogisticRegression,
        scaler: StandardScaler,
        metadata: ModelRegistryMetadata,
    ):
        self.estimator = estimator
        self.scaler = scaler
        self.metadata = metadata
        self.feature_names = list(metadata.feature_names)
        self.horizon = metadata.horizon
        self.model_id = metadata.model_id
        self.version = metadata.version

    def _validate_and_scale(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
        """Validates incoming feature columns, order, and finiteness, then scales using the fitted scaler."""
        if isinstance(X, pd.DataFrame):
            # Verify exact feature column presence
            missing_cols = [c for c in self.feature_names if c not in X.columns]
            if missing_cols:
                raise IncompatibleFeatureError(
                    f"Input DataFrame is missing required features: {missing_cols[:5]}. "
                    f"Expected exactly {len(self.feature_names)} features: {self.feature_names}."
                )
            # Reorder columns strictly according to the registered feature ordering
            X_ordered = X[self.feature_names].to_numpy(dtype=np.float64)
        elif isinstance(X, np.ndarray):
            X_ordered = np.asarray(X, dtype=np.float64)
            if X_ordered.ndim != 2 or X_ordered.shape[1] != len(self.feature_names):
                raise IncompatibleFeatureError(
                    f"Input array feature dimension mismatch: expected (N, {len(self.feature_names)}), "
                    f"got {X_ordered.shape}."
                )
        else:
            raise TypeError(f"Expected DataFrame or ndarray, got {type(X).__name__}")

        if not np.all(np.isfinite(X_ordered)):
            raise ValueError("Input feature matrix contains non-finite values (NaN or Inf).")

        # Standardize using the frozen scaler parameters (transform only, no refit)
        scaled = self.scaler.transform(X_ordered)
        return scaled

    def predict(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
        """
        Generates discrete 3-class predictions {-1, 0, 1} on input features.
        """
        X_scaled = self._validate_and_scale(X)
        return self.estimator.predict(X_scaled)

    def predict_proba(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
        """
        Generates calibrated 3-class probability distribution of shape (N, 3):
        [P(DOWN), P(NEUTRAL), P(UP)].
        """
        X_scaled = self._validate_and_scale(X)
        return self.estimator.predict_proba(X_scaled)


# =============================================================================
# Model Registry Engine
# =============================================================================

class ModelRegistry:
    """
    File-based, versioned model registry for StockSense AI.

    Security & Reliability Properties:
    - Atomic Registration: writes to a staging directory on the same filesystem and publishes via atomic rename.
    - Automatic Failure Cleanup: temporary staging directories are cleaned up immediately on any exception.
    - Restricts deserialization strictly to trusted locally registered artifacts.
    - Computes and verifies SHA-256 digests prior to calling joblib.load().
    - Bundles estimators and scalers in a single atomic payload to prevent separation.
    - Enforces bundle-to-metadata consistency (model_id, horizon, features, class labels, estimator dimensions).
    - Prevents silent fallbacks; missing or corrupted artifacts raise explicit exceptions.
    - Enforces version immutability unless explicit overwrite is requested.
    """

    DEFAULT_REGISTRY_DIR = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "models", "registry")
    )

    def __init__(self, registry_dir: Optional[str] = None):
        self.registry_dir = os.path.abspath(registry_dir or self.DEFAULT_REGISTRY_DIR)
        os.makedirs(self.registry_dir, exist_ok=True)

    def _get_model_dir(self, model_id: str) -> str:
        """Returns the absolute directory path for a specific model ID."""
        return os.path.join(self.registry_dir, model_id)

    def _compute_sha256(self, file_path: str) -> str:
        """Computes the SHA-256 hexadecimal digest of a file in 64KB chunks."""
        hasher = hashlib.sha256()
        with open(file_path, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)
        return hasher.hexdigest()

    def _get_git_commit(self) -> str:
        """Retrieves the current Git commit hash or returns 'unknown'."""
        try:
            res = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                check=True,
                timeout=5,
            )
            return res.stdout.strip()
        except Exception:
            return "unknown"

    def _collect_provenance(
        self,
        dataset_path: Optional[str] = None,
        dataset_identifier: str = "canonical_5stocks_v1",
    ) -> ModelProvenance:
        """Collects runtime environment, package versions, and dataset cryptographic hash."""
        default_dataset_path = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..", "data", "historical_candles_5stocks.json")
        )
        resolved_data_path = dataset_path or default_dataset_path
        if os.path.exists(resolved_data_path):
            ds_sha256 = self._compute_sha256(resolved_data_path)
        else:
            ds_sha256 = "unavailable_dataset_file_missing"

        lib_versions = {
            "scikit-learn": sklearn.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scipy": scipy.__version__,
            "joblib": joblib.__version__,
        }

        return ModelProvenance(
            dataset_sha256=ds_sha256,
            dataset_identifier=dataset_identifier,
            git_commit=self._get_git_commit(),
            python_version=sys.version.split()[0],
            library_versions=lib_versions,
            training_timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        )

    def register_model(
        self,
        estimator: MultinomialLogisticRegression,
        scaler: StandardScaler,
        horizon: int,
        hyperparameters: Dict[str, Any],
        validation_metrics: ClassificationMetrics,
        training_samples: int,
        validation_samples: int,
        version: str = "1.0.0",
        model_name: str = "logistic_regression",
        experiment_id: str = "phase-5c3-lr-tuning",
        target_threshold_pct: Optional[float] = None,
        purge_window_sessions: Optional[int] = None,
        registry_schema_version: str = "1.0",
        dataset_path: Optional[str] = None,
        dataset_identifier: str = "canonical_5stocks_v1",
        status: ModelStatus = ModelStatus.VALIDATION_SELECTED,
        notes: Optional[str] = None,
        overwrite: bool = False,
    ) -> ModelRegistryMetadata:
        """
        Atomically persists a fitted estimator bundled with its scaler and writes a metadata sidecar.

        Guarantees:
        - Writes into a staging directory located on the same filesystem.
        - Validates artifact integrity prior to publication.
        - Publishes atomically using POSIX os.replace.
        - Automatically cleans up staging directories on any failure.
        - Rejects destination overwrite unless overwrite=True.
        """
        if horizon not in (1, 3, 5):
            raise ValueError(f"Prediction horizon must be 1, 3, or 5 (got horizon={horizon})")

        # Deterministic Model ID: e.g. logistic_regression_h1_v1.0.0
        model_id = f"{model_name}_h{horizon}_v{version}"
        final_model_dir = self._get_model_dir(model_id)

        # 1. Enforce version conflict protection before doing any work
        if os.path.exists(final_model_dir) and not overwrite:
            raise ModelVersionExistsError(
                f"Model version '{model_id}' is already registered in {final_model_dir}. "
                f"Set overwrite=True to replace existing artifact."
            )

        # Ensure estimator and scaler are fitted
        if not getattr(estimator, "is_fitted_", False):
            raise ValueError("Cannot register an unfitted estimator.")
        if scaler.mean_ is None or scaler.scale_ is None:
            raise ValueError("Cannot register an unfitted scaler.")

        feature_names = list(getattr(estimator, "feature_names", APPROVED_FEATURE_ALLOWLIST))

        # 2. Create staging directory on the SAME filesystem to guarantee atomic os.replace()
        staging_dir = tempfile.mkdtemp(prefix=f".staging_{model_id}_", dir=self.registry_dir)
        artifact_filename = "model.joblib"

        try:
            staging_artifact_path = os.path.join(staging_dir, artifact_filename)
            staging_metadata_path = os.path.join(staging_dir, "metadata.json")

            # Bundle estimator, scaler, and schema metadata together
            bundle = {
                "estimator": estimator,
                "scaler": scaler,
                "feature_names": feature_names,
                "class_labels": list(EXTERNAL_LABELS),
                "class_names": list(CLASS_NAMES),
                "horizon": horizon,
                "version": version,
                "model_id": model_id,
                "hyperparameters": hyperparameters,
                "created_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }

            # Atomically serialize bundled artifact into staging
            joblib.dump(bundle, staging_artifact_path, compress=3)

            # Compute artifact file metrics
            artifact_sha256 = self._compute_sha256(staging_artifact_path)
            artifact_size = os.path.getsize(staging_artifact_path)

            # Collect complete cryptographic and environment provenance
            provenance = self._collect_provenance(
                dataset_path=dataset_path,
                dataset_identifier=dataset_identifier,
            )

            # Resolve canonical thresholds and purge windows
            resolved_threshold = (
                target_threshold_pct
                if target_threshold_pct is not None
                else TARGET_THRESHOLDS_PCT.get(horizon, 0.50)
            )
            resolved_purge_window = (
                purge_window_sessions
                if purge_window_sessions is not None
                else horizon
            )

            metadata = ModelRegistryMetadata(
                registry_schema_version=registry_schema_version,
                model_id=model_id,
                model_name=model_name,
                version=version,
                horizon=horizon,
                algorithm="Multinomial Logistic Regression (L2)",
                solver=hyperparameters.get("solver", "lbfgs"),
                hyperparameters=hyperparameters,
                target_type="open_to_close",
                target_threshold_pct=resolved_threshold,
                target_definition="UP (+1) if return > +theta_h, DOWN (-1) if return < -theta_h, NEUTRAL (0) otherwise",
                entry_price_convention="next_session_open (O[t+1])",
                exit_price_convention="horizon_session_close (C[t+h])",
                split_methodology="PurgedGroupedChronologicalSplitter",
                split_ratios={"train": 0.70, "validation": 0.15, "test": 0.15},
                purge_window_sessions=resolved_purge_window,
                embargo_window_sessions=0,
                feature_schema_version="23_scale_invariant_technical_v1",
                training_samples=training_samples,
                validation_samples=validation_samples,
                validation_metrics=validation_metrics,
                feature_names=feature_names,
                class_labels=list(EXTERNAL_LABELS),
                class_names=list(CLASS_NAMES),
                artifact_filename=artifact_filename,
                artifact_sha256=artifact_sha256,
                artifact_size_bytes=artifact_size,
                status=status,
                experiment_id=experiment_id,
                notes=notes,
                provenance=provenance,
                created_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            )

            # Write metadata sidecar JSON into staging
            with open(staging_metadata_path, "w", encoding="utf-8") as f:
                f.write(metadata.model_dump_json(indent=2))

            # Pre-publication validation of staging files
            if not os.path.exists(staging_artifact_path) or not os.path.exists(staging_metadata_path):
                raise RegistryError("Staging failure: artifact or metadata file missing before publication.")
            if self._compute_sha256(staging_artifact_path) != artifact_sha256:
                raise ArtifactIntegrityError("Staging failure: artifact binary failed SHA-256 validation.")

            # Atomic publication via os.replace()
            if os.path.exists(final_model_dir):
                # Atomic directory replacement with rollback safety
                backup_dir = tempfile.mkdtemp(prefix=f".backup_{model_id}_", dir=self.registry_dir)
                os.rmdir(backup_dir)
                os.replace(final_model_dir, backup_dir)
                try:
                    os.replace(staging_dir, final_model_dir)
                    shutil.rmtree(backup_dir, ignore_errors=True)
                except Exception:
                    if os.path.exists(backup_dir):
                        os.replace(backup_dir, final_model_dir)
                    raise
            else:
                os.replace(staging_dir, final_model_dir)

            return metadata

        except Exception:
            # Clean up temporary staging directory on any failure
            if os.path.exists(staging_dir):
                shutil.rmtree(staging_dir, ignore_errors=True)
            raise

    def get_metadata(self, model_id: str) -> ModelRegistryMetadata:
        """
        Retrieves, validates, and parses the metadata sidecar for a registered model.
        """
        model_dir = self._get_model_dir(model_id)
        metadata_path = os.path.join(model_dir, "metadata.json")

        if not os.path.exists(metadata_path):
            raise ArtifactNotFoundError(
                f"Metadata sidecar for model '{model_id}' not found at: {metadata_path}"
            )

        with open(metadata_path, "r", encoding="utf-8") as f:
            raw_data = json.load(f)

        metadata = ModelRegistryMetadata.model_validate(raw_data)

        # Enforce registry schema version validation
        if metadata.registry_schema_version not in SUPPORTED_REGISTRY_SCHEMA_VERSIONS:
            raise RegistrySchemaVersionError(
                f"Unsupported registry schema version '{metadata.registry_schema_version}' for model '{model_id}'. "
                f"Supported schema versions: {sorted(list(SUPPORTED_REGISTRY_SCHEMA_VERSIONS))}."
            )

        return metadata

    def verify_artifact_integrity(self, model_id: str) -> bool:
        """
        Verifies that the serialized artifact binary matches the recorded SHA-256 digest.
        """
        metadata = self.get_metadata(model_id)
        model_dir = self._get_model_dir(model_id)
        artifact_path = os.path.join(model_dir, metadata.artifact_filename)

        if not os.path.exists(artifact_path):
            raise ArtifactNotFoundError(
                f"Artifact binary for model '{model_id}' not found at: {artifact_path}"
            )

        computed_sha256 = self._compute_sha256(artifact_path)
        return computed_sha256 == metadata.artifact_sha256

    def load_model(self, model_id: str) -> RegisteredInferenceModel:
        """
        Loads a registered model and returns an inference-ready pipeline wrapper.

        Security & Consistency Enforcement:
        1. Validates registry schema version.
        2. Validates runtime environment compatibility (Python, scikit-learn, joblib).
        3. Cryptographic pre-deserialization SHA-256 integrity check.
        4. Safe joblib deserialization.
        5. Deep bundle vs metadata cross-validation:
           - bundle["model_id"] == metadata.model_id
           - bundle["horizon"] == metadata.horizon
           - bundle["feature_names"] == metadata.feature_names
           - bundle["class_labels"] == metadata.class_labels
           - estimator and scaler are present, fitted, and dimensionally consistent.
        """
        metadata = self.get_metadata(model_id)

        # 1. Enforce runtime compatibility
        check_runtime_compatibility(metadata.provenance)

        model_dir = self._get_model_dir(model_id)
        artifact_path = os.path.join(model_dir, metadata.artifact_filename)

        if not os.path.exists(artifact_path):
            raise ArtifactNotFoundError(
                f"Model binary '{metadata.artifact_filename}' for model '{model_id}' not found."
            )

        # 2. Pre-deserialization SHA-256 integrity check
        computed_sha256 = self._compute_sha256(artifact_path)
        if computed_sha256 != metadata.artifact_sha256:
            raise ArtifactIntegrityError(
                f"Artifact SHA-256 integrity verification failed for model '{model_id}'!\n"
                f"  Expected digest: {metadata.artifact_sha256}\n"
                f"  Computed digest: {computed_sha256}\n"
                f"Refusing to unpickle potentially corrupted or untrusted artifact."
            )

        # 3. Safe deserialization of trusted locally generated artifact
        try:
            bundle = joblib.load(artifact_path)
        except Exception as e:
            raise RegistryError(f"Failed to deserialize model artifact '{artifact_path}': {e}") from e

        # 4. Validate bundle schema and contents
        if not isinstance(bundle, dict):
            raise RegistryError("Corrupted artifact format: expected dictionary bundle.")

        for required_key in ["estimator", "scaler", "feature_names", "class_labels", "horizon"]:
            if required_key not in bundle:
                raise RegistryError(f"Corrupted bundle: missing required key '{required_key}'.")

        # 5. Deep cross-validation of bundle against metadata
        if bundle.get("model_id") != metadata.model_id:
            raise RegistryError(
                f"Bundle model_id mismatch: bundle has '{bundle.get('model_id')}', "
                f"but metadata expects '{metadata.model_id}'."
            )

        if bundle.get("horizon") != metadata.horizon:
            raise RegistryError(
                f"Bundle horizon mismatch: bundle has h={bundle.get('horizon')}, "
                f"but metadata expects h={metadata.horizon}."
            )

        bundle_features = bundle.get("feature_names")
        if bundle_features != list(metadata.feature_names):
            raise IncompatibleFeatureError(
                f"Feature mismatch between artifact bundle and metadata sidecar for model '{model_id}'."
            )

        bundle_classes = bundle.get("class_labels")
        if tuple(bundle_classes or ()) != tuple(metadata.class_labels):
            raise IncompatibleClassError(
                f"Class label mismatch: bundle has {bundle_classes}, but metadata expects {metadata.class_labels}."
            )

        estimator = bundle.get("estimator")
        scaler = bundle.get("scaler")

        if estimator is None or not getattr(estimator, "is_fitted_", False):
            raise RegistryError(f"Corrupted bundle: estimator is missing or unfitted in model '{model_id}'.")

        if scaler is None or scaler.mean_ is None or scaler.scale_ is None:
            raise RegistryError(f"Corrupted bundle: scaler is missing or unfitted in model '{model_id}'.")

        if scaler.n_features_in_ != len(metadata.feature_names):
            raise IncompatibleFeatureError(
                f"Scaler feature count mismatch: scaler expects {scaler.n_features_in_} features, "
                f"but metadata specifies {len(metadata.feature_names)} features."
            )

        estimator_features = getattr(estimator, "n_features_", None)
        if estimator_features is not None and estimator_features != len(metadata.feature_names):
            raise IncompatibleFeatureError(
                f"Estimator feature dimension mismatch: estimator expects {estimator_features} features, "
                f"but metadata specifies {len(metadata.feature_names)} features."
            )

        return RegisteredInferenceModel(
            estimator=estimator,
            scaler=scaler,
            metadata=metadata,
        )

    def list_models(self, horizon: Optional[int] = None) -> List[ModelListItem]:
        """
        Scans registry directory and returns summary descriptors for all registered models.
        """
        if not os.path.exists(self.registry_dir):
            return []

        models: List[ModelListItem] = []
        for entry in sorted(os.listdir(self.registry_dir)):
            if entry.startswith("."):
                continue  # Skip hidden files or staging directories
            entry_path = os.path.join(self.registry_dir, entry)
            meta_path = os.path.join(entry_path, "metadata.json")
            if os.path.isdir(entry_path) and os.path.exists(meta_path):
                try:
                    meta = self.get_metadata(entry)
                    if horizon is not None and meta.horizon != horizon:
                        continue
                    models.append(
                        ModelListItem(
                            model_id=meta.model_id,
                            model_name=meta.model_name,
                            version=meta.version,
                            horizon=meta.horizon,
                            status=meta.status,
                            registry_schema_version=meta.registry_schema_version,
                            val_balanced_accuracy=meta.validation_metrics.balanced_accuracy,
                            val_macro_f1=meta.validation_metrics.macro_f1,
                            val_log_loss=meta.validation_metrics.log_loss,
                            created_at_utc=meta.created_at_utc,
                            artifact_sha256=meta.artifact_sha256,
                        )
                    )
                except Exception:
                    continue

        return models


# =============================================================================
# Automated Registration Pipeline for Selected Logistic Regression Models
# =============================================================================

SELECTED_LR_CANDIDATES = {
    1: {"C": 0.001, "class_weight": None, "solver": "lbfgs", "max_iter": 1000, "tol": 1e-4, "random_state": 42},
    3: {"C": 0.001, "class_weight": "balanced", "solver": "lbfgs", "max_iter": 1000, "tol": 1e-4, "random_state": 42},
    5: {"C": 0.01, "class_weight": "balanced", "solver": "lbfgs", "max_iter": 1000, "tol": 1e-4, "random_state": 42},
}


def register_selected_logistic_regression_models(
    registry_dir: Optional[str] = None,
    dataset_path: Optional[str] = None,
    version: str = "1.0.0",
    overwrite: bool = True,
) -> Dict[int, ModelRegistryMetadata]:
    """
    Trains and registers the three validation-selected Logistic Regression models
    on authentic canonical splits, strictly preserving zero test partition evaluation.

    Returns:
        Dict mapping horizon (1, 3, 5) to ModelRegistryMetadata.
    """
    default_dataset_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "data", "historical_candles_5stocks.json")
    )
    fixture_path = dataset_path or default_dataset_path
    if not os.path.exists(fixture_path):
        raise FileNotFoundError(f"Canonical dataset fixture not found at: {fixture_path}")

    with open(fixture_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    clean_calendar = [
        normalize_candle_timestamp(c["timestamp"])[1]
        for c in data["RELIANCE"]["candles"][199:]
    ]

    target_service = TargetService()
    feat_pipe = FeatureEngineeringPipeline()

    all_targets = []
    all_features = []
    for symbol, stock_info in data.items():
        raw_candles = stock_info["candles"]
        t_res = target_service.generate(
            raw_candles[199:],
            symbol=symbol,
            horizons=[1, 3, 5],
            expected_sessions=clean_calendar,
        )
        all_targets.append(t_res.to_dataframe())

        f_res = feat_pipe.extract_features(raw_candles, drop_na=True)
        f_df = pd.DataFrame(f_res["features"])
        f_df["session_date"] = f_df["timestamp"].apply(lambda ts: normalize_candle_timestamp(ts)[1])
        f_df["stock_symbol"] = symbol
        all_features.append(f_df)

    targets_df = pd.concat(all_targets, ignore_index=True)
    features_df = pd.concat(all_features, ignore_index=True)

    splitter = PurgedChronologicalSplitter()
    registry = ModelRegistry(registry_dir=registry_dir)
    registered_results: Dict[int, ModelRegistryMetadata] = {}

    for h in [1, 3, 5]:
        params = SELECTED_LR_CANDIDATES[h]

        # Extract features and targets for train and validation
        X_tr, y_tr, X_va, y_va, _, _, _ = splitter.split_features_and_targets(
            features_df=features_df,
            targets_df=targets_df,
            clean_dates=clean_calendar,
            horizon=h,
            feature_names=list(APPROVED_FEATURE_ALLOWLIST),
        )

        # Scaler fitted strictly on X_train
        scaler = StandardScaler()
        X_tr_scaled = scaler.fit_transform(X_tr)
        X_va_scaled = scaler.transform(X_va)

        y_tr_arr = np.asarray(y_tr, dtype=np.int64)
        y_va_arr = np.asarray(y_va, dtype=np.int64)

        # Train model
        model = MultinomialLogisticRegression(
            C=params["C"],
            class_weight=params["class_weight"],
            solver=params["solver"],
            max_iter=params["max_iter"],
            tol=params["tol"],
            random_state=params["random_state"],
            horizon=h,
            feature_names=list(APPROVED_FEATURE_ALLOWLIST),
        )
        model.fit(X_tr_scaled, y_tr_arr)

        # Evaluate on validation data
        val_preds = model.predict(X_va_scaled)
        val_probs = model.predict_proba(X_va_scaled)

        val_metrics = compute_classification_metrics(
            y_true=y_va_arr,
            y_pred=val_preds,
            y_prob=val_probs,
            horizon=h,
            model_name=f"LogisticRegression_h{h}_selected",
        )

        meta = registry.register_model(
            estimator=model,
            scaler=scaler,
            horizon=h,
            hyperparameters=params,
            validation_metrics=val_metrics,
            training_samples=len(X_tr),
            validation_samples=len(X_va),
            version=version,
            model_name="logistic_regression",
            experiment_id="phase-5c3-lr-tuning",
            target_threshold_pct=TARGET_THRESHOLDS_PCT[h],
            purge_window_sessions=h,
            registry_schema_version="1.0",
            dataset_path=fixture_path,
            dataset_identifier="canonical_5stocks_v1",
            status=ModelStatus.VALIDATION_SELECTED,
            notes=f"Phase 5C.3 validation-selected candidate for horizon h={h}.",
            overwrite=overwrite,
        )
        registered_results[h] = meta

    return registered_results
