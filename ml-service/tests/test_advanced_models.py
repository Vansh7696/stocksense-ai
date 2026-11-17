"""
StockSense AI — Advanced ML Model Implementation Test Suite (Phase 5C.4.2)
Validates Random Forest and XGBoost model architectures, hyperparameter grids,
zero-test-leakage synthetic fixtures, RegisteredInferenceModel direct raw-feature
ingestion (scaler=None), strict 23-feature validation, probability alignment,
and ModelRegistry atomic persistence and bit-for-bit deserialization parity.
"""

import os
import json
import tempfile
import pytest
import numpy as np
import pandas as pd

from app.schemas.random_forest import (
    RandomForestHyperparameters,
    RandomForestCandidateRecord,
    RandomForestTuningResult,
    RandomForestModelMetadata,
)
from app.schemas.xgboost_model import (
    XGBoostHyperparameters,
    XGBoostCandidateRecord,
    XGBoostTuningResult,
    XGBoostModelMetadata,
)
from app.services.random_forest import (
    RandomForestModel,
    create_random_forest_model,
    get_random_forest_search_grid,
    RF_GRID_N_ESTIMATORS,
    RF_GRID_MAX_DEPTH,
    RF_GRID_MIN_SAMPLES_LEAF,
    RF_GRID_MAX_FEATURES,
    EXTERNAL_LABELS,
    INTERNAL_CLASSES,
)
from app.services.xgboost_model import (
    XGBoostModel,
    create_xgboost_model,
    get_xgboost_search_grid,
    XGBoostDependencyError,
    XGB_GRID_LEARNING_RATE,
    XGB_GRID_MAX_DEPTH,
    XGB_GRID_SUBSAMPLE,
    XGB_GRID_REG_LAMBDA,
    XGB_GRID_GAMMA,
)
from app.services.registry import (
    ModelRegistry,
    RegisteredInferenceModel,
    RegistryError,
    ArtifactIntegrityError,
    IncompatibleFeatureError,
    IncompatibleClassError,
    RuntimeCompatibilityError,
    check_runtime_compatibility,
)
from app.schemas.registry import ModelStatus, ModelRegistryMetadata, ModelProvenance
from app.schemas.metrics import ClassificationMetrics
from app.services.splitting import APPROVED_FEATURE_ALLOWLIST, StandardScaler
from app.services.logistic_regression import MultinomialLogisticRegression
from app.services.metrics import compute_classification_metrics


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture
def synthetic_data():
    """Generates a small deterministic 60-sample synthetic dataset with 23 features."""
    rng = np.random.RandomState(42)
    n_samples = 60
    n_features = len(APPROVED_FEATURE_ALLOWLIST)
    X = rng.randn(n_samples, n_features)
    # Balanced distribution of 3 classes {-1, 0, 1}
    y = np.array([-1] * 20 + [0] * 20 + [1] * 20, dtype=np.int64)
    rng.shuffle(y)
    df_X = pd.DataFrame(X, columns=APPROVED_FEATURE_ALLOWLIST)
    return {"X": X, "df_X": df_X, "y": y, "features": APPROVED_FEATURE_ALLOWLIST}


@pytest.fixture
def dummy_metrics():
    """Creates a dummy valid ClassificationMetrics instance using compute_classification_metrics."""
    y_true = np.array([-1] * 10 + [0] * 10 + [1] * 10)
    y_pred = y_true.copy()
    probs = np.full((30, 3), 1.0 / 3.0)
    return compute_classification_metrics(y_true, y_pred, probs, horizon=1)


@pytest.fixture
def dummy_metadata(dummy_metrics):
    """Creates a fully valid ModelRegistryMetadata instance."""
    return ModelRegistryMetadata(
        registry_schema_version="1.0",
        model_id="random_forest_h1_v1.0.0",
        model_name="random_forest",
        version="1.0.0",
        horizon=1,
        algorithm="Random Forest",
        solver="not_applicable",
        hyperparameters={"n_estimators": 10, "max_depth": 3},
        training_samples=60,
        validation_samples=20,
        validation_metrics=dummy_metrics,
        feature_names=list(APPROVED_FEATURE_ALLOWLIST),
        artifact_sha256="dummy_sha256",
        artifact_size_bytes=1024,
        experiment_id="test_exp",
        provenance=ModelProvenance(
            dataset_sha256="dummy_hash",
            dataset_identifier="canonical_5stocks_v1",
            git_commit="unknown",
            python_version="3.15.2",
            library_versions={"scikit-learn": "1.9.1"},
            training_timestamp_utc="2026-11-17T00:00:00Z",
        ),
        created_at_utc="2026-11-17T00:00:00Z",
    )


# =============================================================================
# 1. Random Forest Specification & Grid Tests
# =============================================================================

class TestRandomForestSpecificationAndGrid:
    def test_search_grid_exact_108_candidates(self):
        """Verifies that the Random Forest search grid contains exactly 108 configurations."""
        grid = get_random_forest_search_grid()
        assert len(grid) == 108
        # 3 * 4 * 3 * 3 = 108
        expected_total = (
            len(RF_GRID_N_ESTIMATORS)
            * len(RF_GRID_MAX_DEPTH)
            * len(RF_GRID_MIN_SAMPLES_LEAF)
            * len(RF_GRID_MAX_FEATURES)
        )
        assert len(grid) == expected_total

        # Verify sequential unique grid indices
        indices = [p.grid_index for p in grid]
        assert indices == list(range(108))

    def test_search_grid_parameter_values(self):
        """Verifies parameter values match the approved Phase 5C.4.1 design."""
        grid = get_random_forest_search_grid()

        for cand in grid:
            assert cand.n_estimators in [100, 200, 300]
            assert cand.max_depth in [3, 4, 5, 6]
            assert cand.min_samples_leaf in [15, 25, 40]
            assert cand.max_features in ["sqrt", "log2", 0.3]
            assert cand.class_weight is None
            assert cand.bootstrap is True
            assert cand.random_state == 42

    def test_hyperparameters_schema_validation(self):
        """Verifies validation rules in RandomForestHyperparameters."""
        valid_params = RandomForestHyperparameters(
            grid_index=0,
            n_estimators=100,
            max_depth=3,
            min_samples_leaf=15,
            max_features="sqrt",
        )
        assert valid_params.n_estimators == 100

        with pytest.raises(Exception):
            RandomForestHyperparameters(
                grid_index=0,
                n_estimators=0,  # Invalid: ge=10
                max_depth=3,
                min_samples_leaf=15,
                max_features="sqrt",
            )

        with pytest.raises(Exception):
            RandomForestHyperparameters(
                grid_index=0,
                n_estimators=100,
                max_depth=0,  # Invalid: ge=1
                min_samples_leaf=15,
                max_features="sqrt",
            )

    def test_create_random_forest_model_factory(self):
        """Verifies the factory creates a correctly configured model instance."""
        hp = RandomForestHyperparameters(
            grid_index=5,
            n_estimators=200,
            max_depth=4,
            min_samples_leaf=25,
            max_features="log2",
        )
        model = create_random_forest_model(hp)
        assert isinstance(model, RandomForestModel)
        assert model.n_estimators == 200
        assert model.max_depth == 4
        assert model.min_samples_leaf == 25
        assert model.max_features == "log2"
        assert model.is_fitted_ is False


# =============================================================================
# 2. Random Forest Model Fitting & Inference Tests
# =============================================================================

class TestRandomForestModelFitting:
    def test_rf_fit_predict_proba_synthetic(self, synthetic_data):
        """Verifies fitting and inference on synthetic multi-class data."""
        model = RandomForestModel(
            n_estimators=10,
            max_depth=3,
            min_samples_leaf=2,
            random_state=42,
        )
        assert model.is_fitted_ is False

        model.fit(synthetic_data["df_X"], synthetic_data["y"])
        assert model.is_fitted_ is True
        assert model.n_samples_ == len(synthetic_data["y"])
        assert model.n_features_ == 23

        # Predict discrete labels
        preds = model.predict(synthetic_data["df_X"])
        assert isinstance(preds, np.ndarray)
        assert preds.shape == (len(synthetic_data["y"]),)
        assert set(np.unique(preds)).issubset({-1, 0, 1})

        # Predict calibrated probabilities
        probs = model.predict_proba(synthetic_data["df_X"])
        assert isinstance(probs, np.ndarray)
        assert probs.shape == (len(synthetic_data["y"]), 3)
        assert np.all(probs >= 0.0)
        assert np.all(probs <= 1.0)
        np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-5)

        # Audit metadata
        meta = model.get_metadata()
        assert isinstance(meta, RandomForestModelMetadata)
        assert meta.n_estimators == 10
        assert meta.max_depth == 3
        assert len(meta.feature_importances) == 23

    def test_rf_missing_class_resilience(self, synthetic_data):
        """Verifies probability alignment when training fold contains only a subset of classes."""
        # Subset with only classes {-1, 1} (no class 0)
        mask = synthetic_data["y"] != 0
        X_sub = synthetic_data["df_X"][mask]
        y_sub = synthetic_data["y"][mask]

        model = RandomForestModel(
            n_estimators=10,
            max_depth=3,
            min_samples_leaf=2,
            random_state=42,
        )
        model.fit(X_sub, y_sub)
        assert len(model.classes_) == 2

        # Check probabilities: column 1 (NEUTRAL / class 0) must be 0.0, rows sum to 1.0
        probs = model.predict_proba(X_sub)
        assert probs.shape == (len(X_sub), 3)
        np.testing.assert_allclose(probs[:, 1], 0.0, atol=1e-7)
        np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-5)

    def test_rf_rejects_unapproved_labels(self, synthetic_data):
        """Verifies rejection of non-canonical class labels."""
        model = RandomForestModel(n_estimators=10)
        y_invalid = synthetic_data["y"].copy()
        y_invalid[0] = 99
        with pytest.raises(ValueError, match="Unapproved labels detected"):
            model.fit(synthetic_data["df_X"], y_invalid)

    def test_rf_rejects_non_finite_inputs(self, synthetic_data):
        """Verifies rejection of NaN or Inf in feature matrices."""
        model = RandomForestModel(n_estimators=10)
        X_bad = synthetic_data["X"].copy()
        X_bad[0, 0] = np.nan
        with pytest.raises(ValueError, match="non-finite values"):
            model.fit(X_bad, synthetic_data["y"])

    def test_rf_predict_before_fit_raises(self, synthetic_data):
        """Verifies predict and predict_proba fail before fit."""
        model = RandomForestModel(n_estimators=10)
        with pytest.raises(ValueError, match="Model is not fitted"):
            model.predict(synthetic_data["df_X"])
        with pytest.raises(ValueError, match="Model is not fitted"):
            model.predict_proba(synthetic_data["df_X"])

    def test_rf_single_class_raises(self, synthetic_data):
        """Verifies rejection when training labels contain only one class."""
        model = RandomForestModel(n_estimators=10)
        y_single = np.ones(len(synthetic_data["y"]), dtype=np.int64)
        with pytest.raises(ValueError, match="requires at least 2 distinct classes"):
            model.fit(synthetic_data["df_X"], y_single)

    def test_rf_duplicate_columns_rejected(self, synthetic_data):
        """Verifies rejection when input DataFrame contains duplicate feature columns."""
        model = RandomForestModel(n_estimators=10)
        cols = list(synthetic_data["features"]) + [synthetic_data["features"][0]]
        df_dup = pd.DataFrame(np.random.randn(20, len(cols)), columns=cols)
        with pytest.raises(ValueError, match="duplicate feature columns"):
            model._validate_and_extract_features(df_dup)


# =============================================================================
# 3. XGBoost Specification & Grid Tests
# =============================================================================

class TestXGBoostSpecificationAndGrid:
    def test_search_grid_exact_162_candidates(self):
        """Verifies that the XGBoost search grid contains exactly 162 configurations."""
        grid = get_xgboost_search_grid()
        assert len(grid) == 162
        # 3 * 3 * 3 * 3 * 2 = 162
        expected_total = (
            len(XGB_GRID_LEARNING_RATE)
            * len(XGB_GRID_MAX_DEPTH)
            * len(XGB_GRID_SUBSAMPLE)
            * len(XGB_GRID_REG_LAMBDA)
            * len(XGB_GRID_GAMMA)
        )
        assert len(grid) == expected_total

        # Verify sequential unique grid indices
        indices = [p.grid_index for p in grid]
        assert indices == list(range(162))

    def test_search_grid_parameter_values(self):
        """Verifies parameter values match the approved Phase 5C.4.1 design."""
        grid = get_xgboost_search_grid()

        for cand in grid:
            assert cand.learning_rate in XGB_GRID_LEARNING_RATE
            assert cand.max_depth in XGB_GRID_MAX_DEPTH
            assert cand.subsample in XGB_GRID_SUBSAMPLE
            assert cand.reg_lambda in XGB_GRID_REG_LAMBDA
            assert cand.gamma in XGB_GRID_GAMMA
            assert cand.min_child_weight == 15.0
            assert cand.colsample_bytree == 0.8
            assert cand.n_estimators == 200
            assert cand.objective == "multi:softprob"
            assert cand.num_class == 3
            assert cand.eval_metric == "mlogloss"
            assert cand.early_stopping_rounds == 15
            assert cand.random_state == 42

    def test_hyperparameters_schema_validation(self):
        """Verifies validation rules in XGBoostHyperparameters."""
        valid_params = XGBoostHyperparameters(
            grid_index=0,
            learning_rate=0.05,
            max_depth=4,
            subsample=0.8,
            reg_lambda=1.0,
            gamma=0.0,
        )
        assert valid_params.learning_rate == 0.05

        with pytest.raises(Exception):
            XGBoostHyperparameters(
                grid_index=0,
                learning_rate=0.0,  # Invalid: gt=0.0
                max_depth=4,
                subsample=0.8,
                reg_lambda=1.0,
                gamma=0.0,
            )

    def test_create_xgboost_model_factory(self):
        """Verifies factory creates a correctly configured model instance."""
        hp = XGBoostHyperparameters(
            grid_index=10,
            learning_rate=0.03,
            max_depth=5,
            subsample=0.6,
            reg_lambda=5.0,
            gamma=0.1,
        )
        model = create_xgboost_model(hp)
        assert isinstance(model, XGBoostModel)
        assert model.learning_rate == 0.03
        assert model.max_depth == 5
        assert model.subsample == 0.6
        assert model.reg_lambda == 5.0
        assert model.gamma == 0.1
        assert model.is_fitted_ is False

    def test_xgboost_dependency_or_execution(self, synthetic_data):
        """
        Verifies that fitting XGBoost either succeeds (if xgboost is installed)
        or raises XGBoostDependencyError with clear actionable guidance.
        """
        model = XGBoostModel(
            learning_rate=0.05,
            max_depth=3,
            n_estimators=10,
            random_state=42,
        )
        try:
            model.fit(synthetic_data["df_X"], synthetic_data["y"])
            assert model.is_fitted_ is True
            preds = model.predict(synthetic_data["df_X"])
            assert set(np.unique(preds)).issubset({-1, 0, 1})
        except XGBoostDependencyError as exc:
            assert "XGBoost is not installed" in str(exc)
            assert "requirements.txt" in str(exc)


# =============================================================================
# 4. XGBoost Model Fitting & Inference Tests
# =============================================================================

class TestXGBoostModelFitting:
    def test_xgboost_fit_predict_proba_synthetic(self, synthetic_data):
        """Verifies fitting and inference on synthetic multi-class data."""
        model = XGBoostModel(
            learning_rate=0.05,
            max_depth=3,
            n_estimators=10,
            random_state=42,
        )
        assert model.is_fitted_ is False
        model.fit(synthetic_data["df_X"], synthetic_data["y"])
        assert model.is_fitted_ is True
        assert model.n_samples_ == len(synthetic_data["y"])
        assert model.n_features_ == 23

        preds = model.predict(synthetic_data["df_X"])
        assert isinstance(preds, np.ndarray)
        assert preds.shape == (len(synthetic_data["y"]),)
        assert set(np.unique(preds)).issubset({-1, 0, 1})

        probs = model.predict_proba(synthetic_data["df_X"])
        assert isinstance(probs, np.ndarray)
        assert probs.shape == (len(synthetic_data["y"]), 3)
        assert np.all(probs >= 0.0)
        assert np.all(probs <= 1.0)
        np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-5)

    def test_xgboost_early_stopping_inner_val(self, synthetic_data):
        """
        Verifies D.1: XGBoost early stopping with inner validation set.
        Checks that best_iteration_ is captured and prediction works.
        """
        X_train, y_train = synthetic_data["df_X"].iloc[:40], synthetic_data["y"][:40]
        X_val, y_val = synthetic_data["df_X"].iloc[40:], synthetic_data["y"][40:]

        model = XGBoostModel(
            learning_rate=0.1,
            max_depth=3,
            n_estimators=50,
            early_stopping_rounds=10,
            random_state=42,
        )
        model.fit(X_train, y_train, eval_set=[(X_val, y_val)])
        assert model.is_fitted_ is True
        assert model.best_iteration_ is not None
        assert isinstance(model.best_iteration_, int)
        assert model.best_iteration_ >= 0

        preds = model.predict(X_val)
        assert set(np.unique(preds)).issubset({-1, 0, 1})
        probs = model.predict_proba(X_val)
        assert probs.shape == (len(X_val), 3)
        np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-5)

    def test_xgboost_missing_class_down_up(self, synthetic_data):
        """
        Verifies D.2: Training fold missing NEUTRAL (0). Only {-1, 1} present.
        Must map {-1, 1} -> {0, 1} internally, and align output proba column 1 (NEUTRAL) to 0.0.
        """
        mask = synthetic_data["y"] != 0
        X_sub = synthetic_data["df_X"][mask]
        y_sub = synthetic_data["y"][mask]

        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10, random_state=42)
        model.fit(X_sub, y_sub)
        assert len(model.observed_classes_) == 2
        assert set(model.observed_classes_) == {-1, 1}

        preds = model.predict(X_sub)
        assert set(np.unique(preds)).issubset({-1, 1})

        probs = model.predict_proba(X_sub)
        assert probs.shape == (len(X_sub), 3)
        np.testing.assert_allclose(probs[:, 1], 0.0, atol=1e-7)
        np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-5)

    def test_xgboost_missing_class_down_neutral(self, synthetic_data):
        """
        Verifies D.2: Training fold missing UP (+1). Only {-1, 0} present.
        Must align output proba column 2 (UP) to 0.0.
        """
        mask = synthetic_data["y"] != 1
        X_sub = synthetic_data["df_X"][mask]
        y_sub = synthetic_data["y"][mask]

        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10, random_state=42)
        model.fit(X_sub, y_sub)
        assert set(model.observed_classes_) == {-1, 0}

        preds = model.predict(X_sub)
        assert set(np.unique(preds)).issubset({-1, 0})

        probs = model.predict_proba(X_sub)
        assert probs.shape == (len(X_sub), 3)
        np.testing.assert_allclose(probs[:, 2], 0.0, atol=1e-7)
        np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-5)

    def test_xgboost_missing_class_neutral_up(self, synthetic_data):
        """
        Verifies D.2: Training fold missing DOWN (-1). Only {0, 1} present.
        Must align output proba column 0 (DOWN) to 0.0.
        """
        mask = synthetic_data["y"] != -1
        X_sub = synthetic_data["df_X"][mask]
        y_sub = synthetic_data["y"][mask]

        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10, random_state=42)
        model.fit(X_sub, y_sub)
        assert set(model.observed_classes_) == {0, 1}

        preds = model.predict(X_sub)
        assert set(np.unique(preds)).issubset({0, 1})

        probs = model.predict_proba(X_sub)
        assert probs.shape == (len(X_sub), 3)
        np.testing.assert_allclose(probs[:, 0], 0.0, atol=1e-7)
        np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-5)

    def test_xgboost_single_class_raises(self, synthetic_data):
        """Verifies D.2: Training fold with single class raises domain ValueError."""
        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10)
        y_single = np.ones(len(synthetic_data["y"]), dtype=np.int64)
        with pytest.raises(ValueError, match="requires at least 2 distinct classes"):
            model.fit(synthetic_data["df_X"], y_single)

    def test_xgboost_eval_set_validation_unapproved_label(self, synthetic_data):
        """Verifies C.3: eval_set with unapproved label (e.g. 99) raises domain ValueError."""
        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10)
        y_val_bad = synthetic_data["y"].copy()
        y_val_bad[0] = 99
        with pytest.raises(ValueError, match="Unapproved labels detected in eval_set"):
            model.fit(
                synthetic_data["df_X"],
                synthetic_data["y"],
                eval_set=[(synthetic_data["df_X"], y_val_bad)],
            )

    def test_xgboost_eval_set_validation_unseen_class(self, synthetic_data):
        """
        Verifies C.3: eval_set containing class absent in training partition raises domain ValueError.
        """
        mask = synthetic_data["y"] != 1
        X_train = synthetic_data["df_X"][mask]
        y_train = synthetic_data["y"][mask]

        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10)
        with pytest.raises(ValueError, match="eval_set contains classes.*not observed in training"):
            model.fit(
                X_train,
                y_train,
                eval_set=[(synthetic_data["df_X"], synthetic_data["y"])],
            )

    def test_xgboost_eval_set_validation_mismatched_length(self, synthetic_data):
        """Verifies C.3: eval_set with sample length mismatch raises domain ValueError."""
        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10)
        with pytest.raises(ValueError, match="eval_set sample count mismatch"):
            model.fit(
                synthetic_data["df_X"],
                synthetic_data["y"],
                eval_set=[(synthetic_data["df_X"].iloc[:10], synthetic_data["y"][:20])],
            )

    def test_xgboost_metadata(self, synthetic_data):
        """Verifies D.4: model.get_metadata() returns valid XGBoostModelMetadata."""
        model = XGBoostModel(
            learning_rate=0.03,
            max_depth=4,
            subsample=0.85,
            reg_lambda=2.0,
            gamma=0.1,
            n_estimators=10,
            random_state=42,
        )
        model.fit(synthetic_data["df_X"], synthetic_data["y"])
        meta = model.get_metadata()
        assert isinstance(meta, XGBoostModelMetadata)
        assert meta.learning_rate == 0.03
        assert meta.max_depth == 4
        assert meta.subsample == 0.85
        assert meta.reg_lambda == 2.0
        assert meta.gamma == 0.1
        assert meta.n_estimators == 10
        assert meta.feature_importances is not None
        assert len(meta.feature_importances) == 23

    def test_xgboost_duplicate_columns_rejected(self, synthetic_data):
        """Verifies rejection when input DataFrame contains duplicate feature columns."""
        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10)
        cols = list(synthetic_data["features"]) + [synthetic_data["features"][0]]
        df_dup = pd.DataFrame(np.random.randn(20, len(cols)), columns=cols)
        with pytest.raises(ValueError, match="duplicate feature columns"):
            model._validate_and_extract_features(df_dup)

    def test_xgboost_predict_before_fit_raises(self, synthetic_data):
        """Verifies predict and predict_proba fail before fit."""
        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10)
        with pytest.raises(ValueError, match="Model is not fitted"):
            model.predict(synthetic_data["df_X"])
        with pytest.raises(ValueError, match="Model is not fitted"):
            model.predict_proba(synthetic_data["df_X"])


# =============================================================================
# 5. RegisteredInferenceModel Tree Ensembles Integration Tests
# =============================================================================

class TestRegisteredInferenceModelTreeIntegration:
    def test_inference_model_with_scaler_none(self, synthetic_data, dummy_metadata):
        """Verifies RegisteredInferenceModel direct raw feature ingestion when scaler=None."""
        model = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        inference_pipeline = RegisteredInferenceModel(
            estimator=model,
            scaler=None,  # Tree model: no scaling
            metadata=dummy_metadata,
        )

        assert inference_pipeline.scaler is None

        # Test prediction with DataFrame
        preds_df = inference_pipeline.predict(synthetic_data["df_X"])
        assert isinstance(preds_df, np.ndarray)
        assert set(np.unique(preds_df)).issubset({-1, 0, 1})

        # Test prediction with ndarray
        preds_arr = inference_pipeline.predict(synthetic_data["X"])
        np.testing.assert_array_equal(preds_df, preds_arr)

        # Test calibrated probabilities
        probs = inference_pipeline.predict_proba(synthetic_data["df_X"])
        assert probs.shape == (len(synthetic_data["y"]), 3)
        np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-5)

    def test_feature_column_reordering_immunity(self, synthetic_data, dummy_metadata):
        """Verifies that DataFrame column permuting does not alter predictions."""
        model = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        inference_pipeline = RegisteredInferenceModel(estimator=model, scaler=None, metadata=dummy_metadata)

        # Reverse column order
        reversed_cols = list(reversed(synthetic_data["features"]))
        df_reversed = synthetic_data["df_X"][reversed_cols]

        preds_orig = inference_pipeline.predict(synthetic_data["df_X"])
        preds_rev = inference_pipeline.predict(df_reversed)
        np.testing.assert_array_equal(preds_orig, preds_rev)

        probs_orig = inference_pipeline.predict_proba(synthetic_data["df_X"])
        probs_rev = inference_pipeline.predict_proba(df_reversed)
        np.testing.assert_allclose(probs_orig, probs_rev, atol=1e-7)

    def test_rejects_missing_features(self, synthetic_data, dummy_metadata):
        """Verifies rejection when input DataFrame is missing required features."""
        model = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        inference_pipeline = RegisteredInferenceModel(estimator=model, scaler=None, metadata=dummy_metadata)
        df_missing = synthetic_data["df_X"].drop(columns=[synthetic_data["features"][0]])

        with pytest.raises(IncompatibleFeatureError, match="missing required features"):
            inference_pipeline.predict(df_missing)

    def test_rejects_unexpected_features(self, synthetic_data, dummy_metadata):
        """Verifies rejection when input DataFrame has extra unapproved features."""
        model = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        inference_pipeline = RegisteredInferenceModel(estimator=model, scaler=None, metadata=dummy_metadata)
        df_extra = synthetic_data["df_X"].copy()
        df_extra["unapproved_extra_feature"] = 1.0

        with pytest.raises(IncompatibleFeatureError, match="unexpected features"):
            inference_pipeline.predict(df_extra)

    def test_rejects_wrong_array_dimension(self, synthetic_data, dummy_metadata):
        """Verifies rejection when ndarray has wrong number of features."""
        model = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        inference_pipeline = RegisteredInferenceModel(estimator=model, scaler=None, metadata=dummy_metadata)

        with pytest.raises(IncompatibleFeatureError, match="dimension mismatch"):
            inference_pipeline.predict(synthetic_data["X"][:, :20])

    def test_rejects_duplicate_column_names(self, synthetic_data, dummy_metadata):
        """Verifies Fix C.1: RegisteredInferenceModel explicitly rejects DataFrames with duplicate columns."""
        model = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])
        inference_pipeline = RegisteredInferenceModel(estimator=model, scaler=None, metadata=dummy_metadata)

        # Create DataFrame with duplicate column names
        cols = list(synthetic_data["features"])
        cols[1] = cols[0]  # duplicate first column name
        df_dup = pd.DataFrame(synthetic_data["X"].copy(), columns=cols)

        with pytest.raises(IncompatibleFeatureError, match="duplicate.*column"):
            inference_pipeline.predict(df_dup)

        with pytest.raises(IncompatibleFeatureError, match="duplicate.*column"):
            inference_pipeline.predict_proba(df_dup)

    def test_rejects_mismatched_column_count(self, synthetic_data, dummy_metadata):
        """Verifies Fix C.1: RegisteredInferenceModel explicitly rejects column count != 23."""
        model = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])
        inference_pipeline = RegisteredInferenceModel(estimator=model, scaler=None, metadata=dummy_metadata)

        # 24 columns
        cols = list(synthetic_data["features"]) + ["extra_col"]
        df_extra_col = pd.DataFrame(np.random.randn(len(synthetic_data["y"]), len(cols)), columns=cols)
        with pytest.raises(IncompatibleFeatureError):
            inference_pipeline.predict(df_extra_col)


# =============================================================================
# 6. ModelRegistry Tree Models Persistence & Load Tests
# =============================================================================

class TestModelRegistryAdvancedModelsIntegration:
    def test_register_and_load_random_forest_scaler_none(self, tmp_path, synthetic_data, dummy_metrics):
        """Verifies complete save/load lifecycle with scaler=None and bit-for-bit prediction parity."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        model = RandomForestModel(
            n_estimators=15,
            max_depth=4,
            min_samples_leaf=2,
            random_state=42,
        )
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        # Register with scaler=None
        meta = registry.register_model(
            estimator=model,
            scaler=None,
            horizon=1,
            hyperparameters={"n_estimators": 15, "max_depth": 4},
            validation_metrics=dummy_metrics,
            training_samples=len(synthetic_data["y"]),
            validation_samples=20,
            version="1.0.0",
            model_name="random_forest",
            algorithm="Random Forest",
            solver="not_applicable",
            experiment_id="phase-5c4-rf-test",
        )

        assert meta.model_id == "random_forest_h1_v1.0.0"
        assert meta.algorithm == "Random Forest"
        assert meta.solver == "not_applicable"
        assert meta.status == ModelStatus.VALIDATION_SELECTED

        # Verify integrity before load
        assert registry.verify_artifact_integrity("random_forest_h1_v1.0.0") is True

        # Load registered model
        loaded = registry.load_model("random_forest_h1_v1.0.0")
        assert isinstance(loaded, RegisteredInferenceModel)
        assert loaded.scaler is None
        assert loaded.model_id == "random_forest_h1_v1.0.0"

        # Verify bit-for-bit parity
        preds_orig = model.predict(synthetic_data["df_X"])
        preds_loaded = loaded.predict(synthetic_data["df_X"])
        np.testing.assert_array_equal(preds_orig, preds_loaded)

        probs_orig = model.predict_proba(synthetic_data["df_X"])
        probs_loaded = loaded.predict_proba(synthetic_data["df_X"])
        np.testing.assert_allclose(probs_orig, probs_loaded, atol=1e-12)

    def test_register_and_load_xgboost_scaler_none(self, tmp_path, synthetic_data, dummy_metrics):
        """Verifies complete save/load lifecycle for XGBoost with scaler=None and bit-for-bit parity."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        model = XGBoostModel(
            learning_rate=0.05,
            max_depth=3,
            n_estimators=15,
            random_state=42,
        )
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        meta = registry.register_model(
            estimator=model,
            scaler=None,
            horizon=1,
            hyperparameters={"learning_rate": 0.05, "max_depth": 3, "n_estimators": 15},
            validation_metrics=dummy_metrics,
            training_samples=len(synthetic_data["y"]),
            validation_samples=20,
            version="1.0.0",
            model_name="xgboost",
            algorithm="XGBoost",
            solver="not_applicable",
            experiment_id="phase-5c4-xgb-test",
        )

        assert meta.model_id == "xgboost_h1_v1.0.0"
        assert meta.algorithm == "XGBoost"
        assert meta.solver == "not_applicable"
        assert meta.status == ModelStatus.VALIDATION_SELECTED

        # Verify integrity
        assert registry.verify_artifact_integrity("xgboost_h1_v1.0.0") is True

        # Load registered model
        loaded = registry.load_model("xgboost_h1_v1.0.0")
        assert isinstance(loaded, RegisteredInferenceModel)
        assert loaded.scaler is None
        assert loaded.model_id == "xgboost_h1_v1.0.0"

        # Verify bit-for-bit prediction parity
        preds_orig = model.predict(synthetic_data["df_X"])
        preds_loaded = loaded.predict(synthetic_data["df_X"])
        np.testing.assert_array_equal(preds_orig, preds_loaded)

        probs_orig = model.predict_proba(synthetic_data["df_X"])
        probs_loaded = loaded.predict_proba(synthetic_data["df_X"])
        np.testing.assert_allclose(probs_orig, probs_loaded, atol=1e-12)

    def test_tampered_artifact_fails_integrity(self, tmp_path, synthetic_data, dummy_metrics):
        """Verifies cryptographic tamper detection on serialized tree model."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        model = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        registry.register_model(
            estimator=model,
            scaler=None,
            horizon=1,
            hyperparameters={},
            validation_metrics=dummy_metrics,
            training_samples=len(synthetic_data["y"]),
            validation_samples=20,
            version="1.0.0",
            model_name="random_forest",
            algorithm="Random Forest",
            solver="not_applicable",
        )

        # Tamper with the artifact file
        artifact_path = os.path.join(str(tmp_path), "random_forest_h1_v1.0.0", "model.joblib")
        with open(artifact_path, "ab") as f:
            f.write(b"tamper_bytes")

        assert registry.verify_artifact_integrity("random_forest_h1_v1.0.0") is False

        with pytest.raises(ArtifactIntegrityError, match="integrity verification failed"):
            registry.load_model("random_forest_h1_v1.0.0")

    def test_xgboost_tampered_artifact_fails_integrity(self, tmp_path, synthetic_data, dummy_metrics):
        """Verifies D.3: Cryptographic tamper detection on serialized XGBoost model."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        model = XGBoostModel(learning_rate=0.05, max_depth=3, n_estimators=10, random_state=42)
        model.fit(synthetic_data["df_X"], synthetic_data["y"])

        registry.register_model(
            estimator=model,
            scaler=None,
            horizon=1,
            hyperparameters={},
            validation_metrics=dummy_metrics,
            training_samples=len(synthetic_data["y"]),
            validation_samples=20,
            version="1.0.0",
            model_name="xgboost",
            algorithm="XGBoost",
            solver="not_applicable",
        )

        # Tamper with the artifact
        artifact_path = os.path.join(str(tmp_path), "xgboost_h1_v1.0.0", "model.joblib")
        with open(artifact_path, "ab") as f:
            f.write(b"tamper_bytes_xgb")

        assert registry.verify_artifact_integrity("xgboost_h1_v1.0.0") is False

        with pytest.raises(ArtifactIntegrityError, match="integrity verification failed"):
            registry.load_model("xgboost_h1_v1.0.0")

    def test_xgboost_provenance_records_installed_version(self, tmp_path):
        """Verifies C.2: ModelRegistry._collect_provenance() records xgboost version."""
        registry = ModelRegistry(registry_dir=str(tmp_path))
        prov = registry._collect_provenance("dummy_sha", "dummy_id")
        assert "xgboost" in prov.library_versions
        import xgboost
        assert prov.library_versions["xgboost"] == xgboost.__version__

    def test_incompatible_xgboost_runtime_version_rejected(self):
        """Verifies C.2: check_runtime_compatibility rejects incompatible XGBoost major.minor version."""
        incompat_prov = ModelProvenance(
            dataset_sha256="dummy",
            dataset_identifier="dummy",
            git_commit="unknown",
            python_version="3.14.9",
            library_versions={"xgboost": "2.1.0"},
            training_timestamp_utc="2026-11-17T00:00:00Z",
        )
        with pytest.raises(RuntimeCompatibilityError, match="Incompatible xgboost version"):
            check_runtime_compatibility(incompat_prov, algorithm="XGBoost")

        # But if algorithm is Random Forest, xgboost mismatch is ignored
        check_runtime_compatibility(incompat_prov, algorithm="Random Forest")

    def test_optional_xgboost_failure_does_not_break_random_forest(self, tmp_path, synthetic_data, dummy_metrics, monkeypatch):
        """Verifies B.2: When XGBoost is unavailable, RandomForestModel and registry still function normally."""
        import app.services.xgboost_model as xgm
        monkeypatch.setattr(xgm, "XGBOOST_AVAILABLE", False)

        with pytest.raises(XGBoostDependencyError):
            xgm.create_xgboost_model()

        # Random Forest must still train, serialize, load and predict without error
        registry = ModelRegistry(registry_dir=str(tmp_path))
        rf = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        rf.fit(synthetic_data["df_X"], synthetic_data["y"])
        meta = registry.register_model(
            estimator=rf,
            scaler=None,
            horizon=1,
            hyperparameters={"n_estimators": 10},
            validation_metrics=dummy_metrics,
            training_samples=len(synthetic_data["y"]),
            validation_samples=20,
            version="1.0.0",
            model_name="random_forest",
            algorithm="Random Forest",
            solver="not_applicable",
        )
        loaded = registry.load_model(meta.model_id)
        assert len(loaded.predict(synthetic_data["df_X"])) == len(synthetic_data["y"])

    def test_coexistence_with_scaled_logistic_regression(self, tmp_path, synthetic_data, dummy_metrics):
        """Verifies that scaled Logistic Regression and unscaled Random Forest coexist in the registry."""
        registry = ModelRegistry(registry_dir=str(tmp_path))

        # 1. Register Logistic Regression (with StandardScaler)
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(synthetic_data["X"])
        lr = MultinomialLogisticRegression(C=0.01, random_state=42)
        lr.fit(X_scaled, synthetic_data["y"])

        registry.register_model(
            estimator=lr,
            scaler=scaler,
            horizon=1,
            hyperparameters={"C": 0.01},
            validation_metrics=dummy_metrics,
            training_samples=len(synthetic_data["y"]),
            validation_samples=20,
            version="1.0.0",
            model_name="logistic_regression",
            algorithm="Multinomial Logistic Regression (L2)",
            solver="lbfgs",
        )

        # 2. Register Random Forest (with scaler=None)
        rf = RandomForestModel(n_estimators=10, max_depth=3, min_samples_leaf=2, random_state=42)
        rf.fit(synthetic_data["df_X"], synthetic_data["y"])

        registry.register_model(
            estimator=rf,
            scaler=None,
            horizon=3,
            hyperparameters={"n_estimators": 10},
            validation_metrics=dummy_metrics,
            training_samples=len(synthetic_data["y"]),
            validation_samples=20,
            version="1.0.0",
            model_name="random_forest",
            algorithm="Random Forest",
            solver="not_applicable",
        )

        # List models
        items = registry.list_models()
        assert len(items) == 2
        model_ids = {item.model_id for item in items}
        assert "logistic_regression_h1_v1.0.0" in model_ids
        assert "random_forest_h3_v1.0.0" in model_ids

        # Load both and verify proper scaler presence/absence
        loaded_lr = registry.load_model("logistic_regression_h1_v1.0.0")
        assert loaded_lr.scaler is not None
        assert loaded_lr.scaler.mean_ is not None

        loaded_rf = registry.load_model("random_forest_h3_v1.0.0")
        assert loaded_rf.scaler is None

        # Verify inference works on raw features for both
        preds_lr = loaded_lr.predict(synthetic_data["df_X"])
        preds_rf = loaded_rf.predict(synthetic_data["df_X"])
        assert len(preds_lr) == len(synthetic_data["y"])
        assert len(preds_rf) == len(synthetic_data["y"])
