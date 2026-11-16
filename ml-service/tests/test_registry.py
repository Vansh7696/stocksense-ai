"""
StockSense AI — Model Registry Test Suite
Validates model artifact and scaler bundling, cryptographic SHA-256 verification,
tamper detection, duplicate version protection, atomic publication, failure cleanup,
bundle/metadata deep consistency, schema versioning, runtime compatibility,
save/load prediction parity, and 3-horizon authentic canonical dataset registration.
"""

import os
import sys
import json
import math
import shutil
import tempfile
import pytest
import numpy as np
import pandas as pd
import joblib

from app.schemas.registry import (
    ModelStatus,
    ModelProvenance,
    ModelRegistryMetadata,
    ModelListItem,
)
from app.services.registry import (
    ModelRegistry,
    RegisteredInferenceModel,
    RegistryError,
    ArtifactNotFoundError,
    ArtifactIntegrityError,
    ModelVersionExistsError,
    IncompatibleFeatureError,
    IncompatibleClassError,
    RegistrySchemaVersionError,
    RuntimeCompatibilityError,
    register_selected_logistic_regression_models,
    check_runtime_compatibility,
    SUPPORTED_REGISTRY_SCHEMA_VERSIONS,
    TARGET_THRESHOLDS_PCT,
    SELECTED_LR_CANDIDATES,
)
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


# =============================================================================
# Synthetic Data Fixture
# =============================================================================

@pytest.fixture
def synthetic_setup():
    rng = np.random.RandomState(42)
    feature_names = list(APPROVED_FEATURE_ALLOWLIST)
    N_tr, N_va = 200, 50

    X_train_raw = rng.normal(10.0, 3.0, (N_tr, len(feature_names)))
    y_train = rng.choice([-1, 0, 1], size=N_tr)

    X_val_raw = rng.normal(10.0, 3.0, (N_va, len(feature_names)))
    y_val = rng.choice([-1, 0, 1], size=N_va)

    scaler = StandardScaler()
    X_tr_scaled = scaler.fit_transform(X_train_raw)
    X_va_scaled = scaler.transform(X_val_raw)

    model = MultinomialLogisticRegression(
        C=0.01,
        class_weight="balanced",
        horizon=1,
        feature_names=feature_names,
    )
    model.fit(X_tr_scaled, y_train)

    val_preds = model.predict(X_va_scaled)
    val_probs = model.predict_proba(X_va_scaled)
    metrics = compute_classification_metrics(y_val, val_preds, val_probs, horizon=1)

    return {
        "model": model,
        "scaler": scaler,
        "metrics": metrics,
        "X_train_raw": X_train_raw,
        "y_train": y_train,
        "X_val_raw": X_val_raw,
        "y_val": y_val,
        "feature_names": feature_names,
    }


# =============================================================================
# 1. Basic Registry Persistence & Parity Tests
# =============================================================================

class TestModelRegistryBasics:
    def test_register_and_load_prediction_parity(self, tmp_path, synthetic_setup):
        """Verifies bit-for-bit parity of predictions and probabilities before and after save/load."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        meta = registry.register_model(
            estimator=synthetic_setup["model"],
            scaler=synthetic_setup["scaler"],
            horizon=1,
            hyperparameters={"C": 0.01, "class_weight": "balanced"},
            validation_metrics=synthetic_setup["metrics"],
            training_samples=len(synthetic_setup["y_train"]),
            validation_samples=len(synthetic_setup["y_val"]),
            version="1.0.0",
        )

        assert meta.model_id == "logistic_regression_h1_v1.0.0"
        assert meta.status == ModelStatus.VALIDATION_SELECTED

        # Load registered model
        loaded = registry.load_model("logistic_regression_h1_v1.0.0")
        assert isinstance(loaded, RegisteredInferenceModel)
        assert loaded.model_id == "logistic_regression_h1_v1.0.0"

        # Predict using raw (unscaled) validation data
        df_val = pd.DataFrame(synthetic_setup["X_val_raw"], columns=synthetic_setup["feature_names"])
        preds_loaded = loaded.predict(df_val)
        probs_loaded = loaded.predict_proba(df_val)

        # Baseline predictions using original model and scaler
        X_va_scaled = synthetic_setup["scaler"].transform(synthetic_setup["X_val_raw"])
        orig_preds = synthetic_setup["model"].predict(X_va_scaled)
        orig_probs = synthetic_setup["model"].predict_proba(X_va_scaled)

        # Exact bit-for-bit equivalence
        assert np.array_equal(preds_loaded, orig_preds)
        assert np.allclose(probs_loaded, orig_probs, atol=1e-15)

    def test_metadata_completeness(self, tmp_path, synthetic_setup):
        """Verifies that the metadata sidecar contains all required provenance and audit fields."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        meta = registry.register_model(
            estimator=synthetic_setup["model"],
            scaler=synthetic_setup["scaler"],
            horizon=1,
            hyperparameters={"C": 0.01, "class_weight": "balanced", "solver": "lbfgs"},
            validation_metrics=synthetic_setup["metrics"],
            training_samples=len(synthetic_setup["y_train"]),
            validation_samples=len(synthetic_setup["y_val"]),
            version="1.0.0",
        )

        sidecar_path = os.path.join(str(tmp_path), "logistic_regression_h1_v1.0.0", "metadata.json")
        assert os.path.exists(sidecar_path)

        with open(sidecar_path) as f:
            raw_meta = json.load(f)

        assert raw_meta["registry_schema_version"] == "1.0"
        assert raw_meta["model_id"] == "logistic_regression_h1_v1.0.0"
        assert raw_meta["horizon"] == 1
        assert raw_meta["version"] == "1.0.0"
        assert raw_meta["status"] == "validation_selected"
        assert raw_meta["target_threshold_pct"] == 0.50
        assert raw_meta["purge_window_sessions"] == 1
        assert raw_meta["split_methodology"] == "PurgedGroupedChronologicalSplitter"
        assert raw_meta["training_samples"] == 200
        assert raw_meta["validation_samples"] == 50
        assert len(raw_meta["feature_names"]) == 23
        assert raw_meta["class_labels"] == [-1, 0, 1]
        assert raw_meta["class_names"] == ["DOWN", "NEUTRAL", "UP"]
        assert len(raw_meta["artifact_sha256"]) == 64
        assert raw_meta["artifact_size_bytes"] > 0
        assert "provenance" in raw_meta
        assert "python_version" in raw_meta["provenance"]
        assert "scikit-learn" in raw_meta["provenance"]["library_versions"]


# =============================================================================
# 2. Atomic Registration & Failure Cleanup Tests
# =============================================================================

class TestAtomicRegistrationAndFailureCleanup:
    def test_atomic_publication_leaves_no_staging_directories(self, tmp_path, synthetic_setup):
        """Verifies that successful atomic publication leaves no staging directories behind."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        meta = registry.register_model(
            estimator=synthetic_setup["model"],
            scaler=synthetic_setup["scaler"],
            horizon=1,
            hyperparameters={"C": 0.01},
            validation_metrics=synthetic_setup["metrics"],
            training_samples=200,
            validation_samples=50,
            version="1.0.0",
        )

        entries = os.listdir(str(tmp_path))
        # Exactly one published model directory, zero hidden staging directories
        assert entries == ["logistic_regression_h1_v1.0.0"]
        staging_entries = [e for e in entries if e.startswith(".staging_")]
        assert len(staging_entries) == 0

    def test_serialization_failure_cleans_up_staging(self, tmp_path, synthetic_setup, monkeypatch):
        """Verifies that an error during joblib serialization cleans up staging completely."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        def mock_dump_fail(*args, **kwargs):
            raise IOError("Simulated disk write failure during joblib dump")

        monkeypatch.setattr(joblib, "dump", mock_dump_fail)

        with pytest.raises(IOError, match="Simulated disk write failure"):
            registry.register_model(
                estimator=synthetic_setup["model"],
                scaler=synthetic_setup["scaler"],
                horizon=1,
                hyperparameters={"C": 0.01},
                validation_metrics=synthetic_setup["metrics"],
                training_samples=200,
                validation_samples=50,
                version="1.0.0",
            )

        # Entire registry directory must be clean (no partial files, no staging dirs)
        assert len(os.listdir(str(tmp_path))) == 0

    def test_metadata_serialization_failure_cleans_up_staging(self, tmp_path, synthetic_setup, monkeypatch):
        """Verifies that an error during metadata serialization cleans up staging completely."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        def mock_model_dump_fail(*args, **kwargs):
            raise RuntimeError("Simulated metadata serialization failure")

        monkeypatch.setattr(ModelRegistryMetadata, "model_dump_json", mock_model_dump_fail)

        with pytest.raises(RuntimeError, match="Simulated metadata serialization failure"):
            registry.register_model(
                estimator=synthetic_setup["model"],
                scaler=synthetic_setup["scaler"],
                horizon=1,
                hyperparameters={"C": 0.01},
                validation_metrics=synthetic_setup["metrics"],
                training_samples=200,
                validation_samples=50,
                version="1.0.0",
            )

        assert len(os.listdir(str(tmp_path))) == 0

    def test_destination_conflict_fails_closed(self, tmp_path, synthetic_setup):
        """Verifies that registering an existing version without overwrite=True raises an error."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        registry.register_model(
            estimator=synthetic_setup["model"],
            scaler=synthetic_setup["scaler"],
            horizon=1,
            hyperparameters={"C": 0.01},
            validation_metrics=synthetic_setup["metrics"],
            training_samples=200,
            validation_samples=50,
            version="1.0.0",
            overwrite=False,
        )

        with pytest.raises(ModelVersionExistsError):
            registry.register_model(
                estimator=synthetic_setup["model"],
                scaler=synthetic_setup["scaler"],
                horizon=1,
                hyperparameters={"C": 0.01},
                validation_metrics=synthetic_setup["metrics"],
                training_samples=200,
                validation_samples=50,
                version="1.0.0",
                overwrite=False,
            )


# =============================================================================
# 3. Bundle & Metadata Consistency Tests
# =============================================================================

class TestBundleMetadataConsistency:
    @pytest.fixture
    def registered_model(self, tmp_path, synthetic_setup):
        registry = ModelRegistry(registry_dir=str(tmp_path))
        registry.register_model(
            estimator=synthetic_setup["model"],
            scaler=synthetic_setup["scaler"],
            horizon=1,
            hyperparameters={"C": 0.01},
            validation_metrics=synthetic_setup["metrics"],
            training_samples=200,
            validation_samples=50,
            version="1.0.0",
        )
        return registry, "logistic_regression_h1_v1.0.0", str(tmp_path)

    def _tamper_bundle(self, base_dir, model_id, tamper_fn):
        """Helper to mutate bundle contents and update metadata SHA-256 to isolate consistency checks."""
        artifact_path = os.path.join(base_dir, model_id, "model.joblib")
        bundle = joblib.load(artifact_path)
        bundle = tamper_fn(bundle)
        joblib.dump(bundle, artifact_path)

        # Update metadata SHA-256 so the check passes cryptographic hash and reaches bundle checks
        hasher = ModelRegistry()._compute_sha256(artifact_path)
        meta_path = os.path.join(base_dir, model_id, "metadata.json")
        with open(meta_path, "r") as f:
            meta = json.load(f)
        meta["artifact_sha256"] = hasher
        with open(meta_path, "w") as f:
            json.dump(meta, f)

    def test_bundle_model_id_mismatch_rejected(self, registered_model):
        """Verifies rejection when bundle['model_id'] does not match metadata."""
        registry, model_id, base_dir = registered_model

        def tamper(bundle):
            bundle["model_id"] = "different_model_id"
            return bundle

        self._tamper_bundle(base_dir, model_id, tamper)

        with pytest.raises(RegistryError, match="Bundle model_id mismatch"):
            registry.load_model(model_id)

    def test_bundle_horizon_mismatch_rejected(self, registered_model):
        """Verifies rejection when bundle['horizon'] does not match metadata."""
        registry, model_id, base_dir = registered_model

        def tamper(bundle):
            bundle["horizon"] = 5  # metadata is h=1
            return bundle

        self._tamper_bundle(base_dir, model_id, tamper)

        with pytest.raises(RegistryError, match="Bundle horizon mismatch"):
            registry.load_model(model_id)

    def test_unfitted_estimator_rejected(self, registered_model):
        """Verifies rejection if estimator is unfitted."""
        registry, model_id, base_dir = registered_model

        def tamper(bundle):
            bundle["estimator"].is_fitted_ = False
            return bundle

        self._tamper_bundle(base_dir, model_id, tamper)

        with pytest.raises(RegistryError, match="estimator is missing or unfitted"):
            registry.load_model(model_id)

    def test_scaler_feature_count_mismatch_rejected(self, registered_model):
        """Verifies rejection if scaler expects a different feature count than registered."""
        registry, model_id, base_dir = registered_model

        def tamper(bundle):
            bundle["scaler"].n_features_in_ = 20  # registered has 23
            return bundle

        self._tamper_bundle(base_dir, model_id, tamper)

        with pytest.raises(IncompatibleFeatureError, match="Scaler feature count mismatch"):
            registry.load_model(model_id)

    def test_estimator_feature_dimension_mismatch_rejected(self, registered_model):
        """Verifies rejection if estimator expects a different feature count than registered."""
        registry, model_id, base_dir = registered_model

        def tamper(bundle):
            bundle["estimator"].n_features_ = 20  # registered has 23
            return bundle

        self._tamper_bundle(base_dir, model_id, tamper)

        with pytest.raises(IncompatibleFeatureError, match="Estimator feature dimension mismatch"):
            registry.load_model(model_id)


# =============================================================================
# 4. Schema Versioning & Runtime Compatibility Tests
# =============================================================================

class TestSchemaAndRuntimeCompatibility:
    @pytest.fixture
    def registered_model(self, tmp_path, synthetic_setup):
        registry = ModelRegistry(registry_dir=str(tmp_path))
        registry.register_model(
            estimator=synthetic_setup["model"],
            scaler=synthetic_setup["scaler"],
            horizon=1,
            hyperparameters={"C": 0.01},
            validation_metrics=synthetic_setup["metrics"],
            training_samples=200,
            validation_samples=50,
            version="1.0.0",
        )
        return registry, "logistic_regression_h1_v1.0.0", str(tmp_path)

    def test_unsupported_registry_schema_version_rejected(self, registered_model):
        """Verifies that an unknown registry schema version fails closed."""
        registry, model_id, base_dir = registered_model
        meta_path = os.path.join(base_dir, model_id, "metadata.json")

        with open(meta_path, "r") as f:
            meta = json.load(f)
        meta["registry_schema_version"] = "99.0"
        with open(meta_path, "w") as f:
            json.dump(meta, f)

        with pytest.raises(RegistrySchemaVersionError, match="Unsupported registry schema version '99.0'"):
            registry.load_model(model_id)

    def test_incompatible_python_version_rejected(self, registered_model):
        """Verifies that major.minor Python differences fail closed."""
        registry, model_id, base_dir = registered_model
        meta_path = os.path.join(base_dir, model_id, "metadata.json")

        with open(meta_path, "r") as f:
            meta = json.load(f)
        meta["provenance"]["python_version"] = "2.7.18"
        with open(meta_path, "w") as f:
            json.dump(meta, f)

        with pytest.raises(RuntimeCompatibilityError, match="Incompatible Python runtime"):
            registry.load_model(model_id)

    def test_incompatible_sklearn_version_rejected(self, registered_model):
        """Verifies that major.minor scikit-learn differences fail closed."""
        registry, model_id, base_dir = registered_model
        meta_path = os.path.join(base_dir, model_id, "metadata.json")

        with open(meta_path, "r") as f:
            meta = json.load(f)
        meta["provenance"]["library_versions"]["scikit-learn"] = "0.24.2"
        with open(meta_path, "w") as f:
            json.dump(meta, f)

        with pytest.raises(RuntimeCompatibilityError, match="Incompatible scikit-learn version"):
            registry.load_model(model_id)

    def test_incompatible_joblib_version_rejected(self, registered_model):
        """Verifies that major.minor joblib differences fail closed."""
        registry, model_id, base_dir = registered_model
        meta_path = os.path.join(base_dir, model_id, "metadata.json")

        with open(meta_path, "r") as f:
            meta = json.load(f)
        meta["provenance"]["library_versions"]["joblib"] = "0.14.1"
        with open(meta_path, "w") as f:
            json.dump(meta, f)

        with pytest.raises(RuntimeCompatibilityError, match="Incompatible joblib version"):
            registry.load_model(model_id)


# =============================================================================
# 5. Authentic Canonical Dataset Three-Horizon Registration Tests
# =============================================================================

@pytest.fixture(scope="module")
def registered_registry(tmp_path_factory):
    """Registers the three validation-selected models on the authentic canonical fixture."""
    reg_dir = tmp_path_factory.mktemp("authentic_registry")
    registered_meta = register_selected_logistic_regression_models(
        registry_dir=str(reg_dir),
        version="1.0.0",
        overwrite=True,
    )
    return ModelRegistry(registry_dir=str(reg_dir)), registered_meta, str(reg_dir)


class TestAuthenticDatasetThreeHorizonRegistration:
    def test_all_three_horizons_registered(self, registered_registry):
        """Verifies that models for horizons h1, h3, and h5 are registered."""
        registry, meta_dict, _ = registered_registry

        assert set(meta_dict.keys()) == {1, 3, 5}

        for h in [1, 3, 5]:
            model_id = f"logistic_regression_h{h}_v1.0.0"
            meta = meta_dict[h]
            assert meta.model_id == model_id
            assert meta.horizon == h
            assert meta.status == ModelStatus.VALIDATION_SELECTED
            assert meta.registry_schema_version == "1.0"
            assert registry.verify_artifact_integrity(model_id) is True

    def test_horizon_1_hyperparameters_and_provenance(self, registered_registry):
        """Verifies horizon h=1 selected parameters, metrics, and exact target threshold (0.50%)."""
        _, meta_dict, _ = registered_registry
        meta1 = meta_dict[1]

        assert meta1.hyperparameters["C"] == 0.001
        assert meta1.hyperparameters["class_weight"] is None
        assert meta1.target_threshold_pct == 0.50
        assert meta1.purge_window_sessions == 1
        assert meta1.training_samples == 1895
        assert meta1.validation_samples == 400
        assert math.isclose(meta1.validation_metrics.balanced_accuracy, 0.3870, abs_tol=0.005)
        assert math.isclose(meta1.validation_metrics.log_loss, 1.0882, abs_tol=0.005)

    def test_horizon_3_hyperparameters_and_provenance(self, registered_registry):
        """Verifies horizon h=3 selected parameters, metrics, and exact target threshold (1.00%)."""
        _, meta_dict, _ = registered_registry
        meta3 = meta_dict[3]

        assert meta3.hyperparameters["C"] == 0.001
        assert meta3.hyperparameters["class_weight"] == "balanced"
        assert meta3.target_threshold_pct == 1.00
        assert meta3.purge_window_sessions == 3
        assert meta3.training_samples == 1885
        assert meta3.validation_samples == 390
        assert math.isclose(meta3.validation_metrics.balanced_accuracy, 0.3630, abs_tol=0.005)
        assert math.isclose(meta3.validation_metrics.log_loss, 1.0952, abs_tol=0.005)

    def test_horizon_5_hyperparameters_and_provenance(self, registered_registry):
        """Verifies horizon h=5 selected parameters, metrics, and exact target threshold (1.50%)."""
        _, meta_dict, _ = registered_registry
        meta5 = meta_dict[5]

        assert meta5.hyperparameters["C"] == 0.01
        assert meta5.hyperparameters["class_weight"] == "balanced"
        assert meta5.target_threshold_pct == 1.50
        assert meta5.purge_window_sessions == 5
        assert meta5.training_samples == 1875
        assert meta5.validation_samples == 380
        assert math.isclose(meta5.validation_metrics.balanced_accuracy, 0.3587, abs_tol=0.005)
        assert math.isclose(meta5.validation_metrics.log_loss, 1.1464, abs_tol=0.005)

    def test_list_models_filtering(self, registered_registry):
        """Verifies listing all models and filtering by horizon."""
        registry, _, _ = registered_registry

        all_models = registry.list_models()
        assert len(all_models) == 3

        h1_models = registry.list_models(horizon=1)
        assert len(h1_models) == 1
        assert h1_models[0].model_id == "logistic_regression_h1_v1.0.0"

        h3_models = registry.list_models(horizon=3)
        assert len(h3_models) == 1
        assert h3_models[0].model_id == "logistic_regression_h3_v1.0.0"

        h5_models = registry.list_models(horizon=5)
        assert len(h5_models) == 1
        assert h5_models[0].model_id == "logistic_regression_h5_v1.0.0"

    def test_loaded_models_produce_valid_3class_probability_distributions(self, registered_registry):
        """Verifies that loaded models produce normalized 3-class probabilities [DOWN, NEUTRAL, UP]."""
        registry, _, _ = registered_registry

        for h in [1, 3, 5]:
            loaded = registry.load_model(f"logistic_regression_h{h}_v1.0.0")
            dummy_X = np.random.RandomState(42).normal(0, 1, (10, 23))

            probs = loaded.predict_proba(dummy_X)
            preds = loaded.predict(dummy_X)

            assert probs.shape == (10, 3)
            assert np.all(probs >= 0.0)
            assert np.all(probs <= 1.0)
            assert np.allclose(np.sum(probs, axis=1), 1.0, atol=1e-12)

            assert set(preds).issubset({-1, 0, 1})

    def test_provenance_contains_valid_canonical_dataset_sha256(self, registered_registry):
        """Verifies that all registered models record the exact SHA-256 of the canonical dataset."""
        _, meta_dict, _ = registered_registry
        expected_ds_sha256 = "d75a0e0f4e94c0991bbca71e911333b1944e7f064d8f4dd712cffa1688b97170"

        for h in [1, 3, 5]:
            meta = meta_dict[h]
            assert meta.provenance.dataset_sha256 == expected_ds_sha256
            assert meta.provenance.dataset_identifier == "canonical_5stocks_v1"
            assert meta.provenance.git_commit != ""
            assert meta.provenance.python_version != ""
            assert "scikit-learn" in meta.provenance.library_versions
