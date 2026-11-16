"""
StockSense AI — Multinomial Logistic Regression Test Suite
Validates model specification, hyperparameter grid, train-only scaler quarantine,
lexicographic candidate selection, missing-class resilience, zero test leakage,
and authentic canonical dataset tuning across horizons h1, h3, and h5.
"""

import os
import json
import inspect
import math
import pytest
import numpy as np
import pandas as pd

from app.schemas.logistic_regression import (
    LogisticRegressionHyperparameters,
    CandidateEvaluationRecord,
    LogisticRegressionTuningResult,
    LogisticRegressionModelMetadata,
)
from app.services.logistic_regression import (
    MultinomialLogisticRegression,
    get_logistic_regression_hyperparameter_grid,
    tune_logistic_regression,
    _lexicographic_candidate_key,
    GRID_C_VALUES,
    GRID_CLASS_WEIGHTS,
)
from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    StandardScaler,
    PurgedChronologicalSplitter,
)
from app.services.targets import TargetService, normalize_candle_timestamp
from app.services.features import FeatureEngineeringPipeline
from app.services.metrics import compute_classification_metrics


# =============================================================================
# 1. Hyperparameter Grid Tests
# =============================================================================

class TestLogisticRegressionHyperparameterGrid:
    def test_grid_exact_12_candidates(self):
        """Verifies that the hyperparameter grid contains exactly 12 unique candidates."""
        grid = get_logistic_regression_hyperparameter_grid()
        assert len(grid) == 12

        # Verify sequential unique grid indices
        indices = [p.grid_index for p in grid]
        assert indices == list(range(12))

    def test_grid_parameter_values(self):
        """Verifies C values and class_weight combinations match the approved design."""
        grid = get_logistic_regression_hyperparameter_grid()

        expected_C = [0.001, 0.01, 0.1, 1.0, 10.0, 100.0]
        expected_weights = [None, "balanced"]

        for i, C in enumerate(expected_C):
            for j, cw in enumerate(expected_weights):
                idx = i * 2 + j
                param = grid[idx]
                assert param.grid_index == idx
                assert param.C == C
                assert param.class_weight == cw
                assert param.solver == "lbfgs"
                assert param.max_iter == 1000
                assert param.tol == 1e-4
                assert param.random_state == 42


# =============================================================================
# 2. Model Specification & Behavior Tests
# =============================================================================

class TestMultinomialLogisticRegressionModel:
    @pytest.fixture
    def synthetic_data(self):
        rng = np.random.RandomState(42)
        X = rng.normal(size=(100, 23))
        y = rng.choice([-1, 0, 1], size=100)
        return X, y

    def test_model_fit_predict_proba_shapes_and_classes(self, synthetic_data):
        """Verifies fitting, prediction labels {-1, 0, 1}, and probability shape (N, 3)."""
        X, y = synthetic_data
        model = MultinomialLogisticRegression(C=1.0, horizon=1)
        model.fit(X, y)

        assert model.is_fitted_ is True
        assert model.n_samples_ == 100
        assert model.n_features_ == 23

        # Predict
        preds = model.predict(X)
        assert preds.shape == (100,)
        assert set(np.unique(preds)).issubset({-1, 0, 1})

        # Predict proba
        probs = model.predict_proba(X)
        assert probs.shape == (100, 3)
        assert np.all(probs >= 0.0)
        assert np.allclose(probs.sum(axis=1), 1.0, atol=1e-12)

    def test_missing_class_resilience(self):
        """
        Verifies that if a training fold only contains a subset of classes (e.g. DOWN and NEUTRAL),
        predict_proba still returns a canonical (N, 3) matrix with 0.0 for the unobserved class.
        """
        rng = np.random.RandomState(42)
        X = rng.normal(size=(60, 23))
        # Only DOWN (-1) and NEUTRAL (0), UP (+1) is absent
        y = rng.choice([-1, 0], size=60)

        model = MultinomialLogisticRegression(C=1.0)
        model.fit(X, y)

        probs = model.predict_proba(X)
        assert probs.shape == (60, 3)
        assert np.all(probs >= 0.0)
        assert np.allclose(probs.sum(axis=1), 1.0)
        # Column 2 (UP) must be exactly 0.0 for all samples
        assert np.all(probs[:, 2] == 0.0)

        # Predict outputs only classes present in training
        preds = model.predict(X)
        assert set(np.unique(preds)).issubset({-1, 0})

    def test_invalid_feature_dimension_rejection(self, synthetic_data):
        X, y = synthetic_data
        model = MultinomialLogisticRegression()

        # 22 features instead of 23
        with pytest.raises(ValueError, match="Feature dimension mismatch"):
            model.fit(X[:, :22], y)

        # 24 features instead of 23
        X_extra = np.hstack([X, np.zeros((100, 1))])
        with pytest.raises(ValueError, match="Feature dimension mismatch"):
            model.fit(X_extra, y)

        # 1D array instead of 2D
        with pytest.raises(ValueError, match="Feature matrix must be non-empty 2D array"):
            model.fit(X[:, 0], y)

    def test_non_finite_values_rejection(self, synthetic_data):
        X, y = synthetic_data
        model = MultinomialLogisticRegression()

        X_nan = X.copy()
        X_nan[0, 0] = np.nan
        with pytest.raises(ValueError, match="non-finite values"):
            model.fit(X_nan, y)

        X_inf = X.copy()
        X_inf[0, 0] = np.inf
        with pytest.raises(ValueError, match="non-finite values"):
            model.fit(X_inf, y)

    def test_unapproved_target_labels_rejection(self, synthetic_data):
        X, y = synthetic_data
        model = MultinomialLogisticRegression()

        # Unapproved label 2
        y_bad = y.copy()
        y_bad[0] = 2
        with pytest.raises(ValueError, match="Unapproved labels"):
            model.fit(X, y_bad)

        # Unapproved label -2
        y_bad2 = y.copy()
        y_bad2[0] = -2
        with pytest.raises(ValueError, match="Unapproved labels"):
            model.fit(X, y_bad2)

    def test_sample_count_mismatch_rejection(self, synthetic_data):
        X, y = synthetic_data
        model = MultinomialLogisticRegression()

        with pytest.raises(ValueError, match="Sample count mismatch"):
            model.fit(X[:50], y)

    def test_model_metadata_export(self, synthetic_data):
        X, y = synthetic_data
        model = MultinomialLogisticRegression(C=0.1, class_weight="balanced", horizon=3)
        model.fit(X, y)

        meta = model.get_metadata()
        assert isinstance(meta, LogisticRegressionModelMetadata)
        assert meta.horizon == 3
        assert meta.C == 0.1
        assert meta.class_weight == "balanced"
        assert meta.training_samples == 100
        assert len(meta.feature_names) == 23
        assert set(meta.coefficients.keys()) == {"DOWN", "NEUTRAL", "UP"}
        assert len(meta.coefficients["DOWN"]) == 23
        assert set(meta.intercepts.keys()) == {"DOWN", "NEUTRAL", "UP"}


# =============================================================================
# 3. Scaler Quarantine & Leakage Prevention Tests
# =============================================================================

class TestScalerQuarantineAndDataSeparation:
    def test_scaler_fit_strictly_on_training_data(self):
        """
        Verifies that the StandardScaler is fit exclusively on X_train and
        never updates its learned parameters when transforming X_val.
        """
        rng = np.random.RandomState(42)
        X_train = rng.normal(loc=10.0, scale=2.0, size=(100, 23))
        X_val = rng.normal(loc=100.0, scale=20.0, size=(50, 23))

        scaler = StandardScaler()
        X_tr_scaled = scaler.fit_transform(X_train)

        mean_after_train = scaler.mean_.copy()
        scale_after_train = scaler.scale_.copy()

        # Transform validation data
        X_va_scaled = scaler.transform(X_val)

        # Scaler parameters must remain bit-for-bit identical
        assert np.array_equal(scaler.mean_, mean_after_train)
        assert np.array_equal(scaler.scale_, scale_after_train)

        # Training data should have mean ~ 0, scale ~ 1
        assert np.allclose(np.mean(X_tr_scaled, axis=0), 0.0, atol=1e-12)
        assert np.allclose(np.std(X_tr_scaled, axis=0), 1.0, atol=1e-12)

        # Validation data transformed with train params will NOT have mean 0
        assert not np.allclose(np.mean(X_va_scaled, axis=0), 0.0, atol=1.0)


# =============================================================================
# 4. Lexicographic Candidate Selection Tests
# =============================================================================

class TestLexicographicCandidateSelection:
    def _create_mock_metrics(self, bal_acc, macro_f1, log_loss):
        from app.schemas.metrics import (
            ClassificationMetrics,
            ClassMetricDetail,
            CatastrophicErrorDetail,
        )
        return ClassificationMetrics(
            accuracy=bal_acc,
            balanced_accuracy=bal_acc,
            macro_precision=macro_f1,
            macro_recall=bal_acc,
            macro_f1=macro_f1,
            per_class={
                "DOWN": ClassMetricDetail(precision=0.3, recall=0.3, f1=0.3, support=10),
                "NEUTRAL": ClassMetricDetail(precision=0.4, recall=0.4, f1=0.4, support=10),
                "UP": ClassMetricDetail(precision=0.3, recall=0.3, f1=0.3, support=10),
            },
            confusion_matrix=[[3, 3, 4], [3, 4, 3], [4, 3, 3]],
            catastrophic_error=CatastrophicErrorDetail(
                count=0, rate=0.0, down_to_up_count=0, up_to_down_count=0,
                total_samples=30, directional_samples_count=20, directional_subset_rate=0.0
            ),
            log_loss=log_loss,
            brier_score=0.5,
            total_samples=30,
        )

    def test_selection_rule_1_balanced_accuracy_dominates(self):
        """Rule 1: Candidate with higher balanced accuracy wins regardless of other metrics."""
        cand_a = {"grid_index": 0, "C": 1.0, "class_weight": None, "metrics": self._create_mock_metrics(0.40, 0.30, 1.20)}
        cand_b = {"grid_index": 1, "C": 0.001, "class_weight": None, "metrics": self._create_mock_metrics(0.35, 0.35, 1.00)}

        sorted_cands = sorted([cand_b, cand_a], key=_lexicographic_candidate_key)
        assert sorted_cands[0]["grid_index"] == 0

    def test_selection_rule_2_macro_f1_tie_break(self):
        """Rule 2: When balanced accuracy ties, higher macro F1 wins."""
        cand_a = {"grid_index": 0, "C": 1.0, "class_weight": None, "metrics": self._create_mock_metrics(0.38, 0.35, 1.20)}
        cand_b = {"grid_index": 1, "C": 0.001, "class_weight": None, "metrics": self._create_mock_metrics(0.38, 0.32, 1.00)}

        sorted_cands = sorted([cand_b, cand_a], key=_lexicographic_candidate_key)
        assert sorted_cands[0]["grid_index"] == 0

    def test_selection_rule_3_log_loss_tie_break(self):
        """Rule 3: When balanced accuracy and macro F1 tie, lower log loss wins."""
        cand_a = {"grid_index": 0, "C": 1.0, "class_weight": None, "metrics": self._create_mock_metrics(0.38, 0.35, 1.15)}
        cand_b = {"grid_index": 1, "C": 0.001, "class_weight": None, "metrics": self._create_mock_metrics(0.38, 0.35, 1.10)}

        sorted_cands = sorted([cand_a, cand_b], key=_lexicographic_candidate_key)
        assert sorted_cands[0]["grid_index"] == 1  # cand_b has lower log loss

    def test_selection_rule_4_smaller_c_tie_break(self):
        """Rule 4: When performance metrics tie, smaller C (stronger regularization) wins."""
        cand_a = {"grid_index": 5, "C": 10.0, "class_weight": None, "metrics": self._create_mock_metrics(0.38, 0.35, 1.10)}
        cand_b = {"grid_index": 2, "C": 0.01, "class_weight": None, "metrics": self._create_mock_metrics(0.38, 0.35, 1.10)}

        sorted_cands = sorted([cand_a, cand_b], key=_lexicographic_candidate_key)
        assert sorted_cands[0]["grid_index"] == 2  # cand_b has smaller C

    def test_selection_rule_5_class_weight_none_tie_break(self):
        """Rule 5: When performance and C tie, class_weight=None is preferred over 'balanced'."""
        cand_a = {"grid_index": 3, "C": 0.01, "class_weight": "balanced", "metrics": self._create_mock_metrics(0.38, 0.35, 1.10)}
        cand_b = {"grid_index": 2, "C": 0.01, "class_weight": None, "metrics": self._create_mock_metrics(0.38, 0.35, 1.10)}

        sorted_cands = sorted([cand_a, cand_b], key=_lexicographic_candidate_key)
        assert sorted_cands[0]["grid_index"] == 2  # class_weight=None preferred


# =============================================================================
# 5. Full Tuning Pipeline on Authentic Canonical Dataset
# =============================================================================

@pytest.fixture(scope="module")
def historical_splits():
    """Loads canonical 5-stock historical dataset and generates purged splits."""
    fixture_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "data", "historical_candles_5stocks.json")
    )
    if not os.path.exists(fixture_path):
        pytest.skip("Canonical historical fixture not found.")

    with open(fixture_path) as f:
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

    return {
        "clean_calendar": clean_calendar,
        "targets_df": targets_df,
        "features_df": features_df,
    }


class TestTuningPipelineOnAuthenticDataset:
    def test_tune_logistic_regression_horizon_1(self, historical_splits):
        """Verifies hyperparameter tuning on horizon h=1 authentic splits."""
        splitter = PurgedChronologicalSplitter()
        X_tr, y_tr, X_va, y_va, X_te, y_te, acct = splitter.split_features_and_targets(
            features_df=historical_splits["features_df"],
            targets_df=historical_splits["targets_df"],
            clean_dates=historical_splits["clean_calendar"],
            horizon=1,
            feature_names=list(APPROVED_FEATURE_ALLOWLIST),
        )

        assert len(X_tr) == 1895
        assert len(X_va) == 400

        res = tune_logistic_regression(X_tr, y_tr, X_va, y_va, horizon=1)

        assert isinstance(res, LogisticRegressionTuningResult)
        assert res.horizon == 1
        assert len(res.candidates) == 12
        assert res.n_train_samples == 1895
        assert res.n_val_samples == 400

        # Horizon 1 selected candidate: idx=0, C=0.001, class_weight=None
        best = res.selected_candidate
        assert best.grid_index == 0
        assert best.C == 0.001
        assert best.class_weight is None
        assert math.isclose(best.metrics.balanced_accuracy, 0.3870, abs_tol=0.005)
        assert best.is_selected is True

    def test_tune_logistic_regression_horizon_3(self, historical_splits):
        """Verifies hyperparameter tuning on horizon h=3 authentic splits."""
        splitter = PurgedChronologicalSplitter()
        X_tr, y_tr, X_va, y_va, X_te, y_te, acct = splitter.split_features_and_targets(
            features_df=historical_splits["features_df"],
            targets_df=historical_splits["targets_df"],
            clean_dates=historical_splits["clean_calendar"],
            horizon=3,
            feature_names=list(APPROVED_FEATURE_ALLOWLIST),
        )

        assert len(X_tr) == 1885
        assert len(X_va) == 390

        res = tune_logistic_regression(X_tr, y_tr, X_va, y_va, horizon=3)

        assert res.horizon == 3
        assert len(res.candidates) == 12
        assert res.n_train_samples == 1885
        assert res.n_val_samples == 390

        # Horizon 3 selected candidate: idx=1, C=0.001, class_weight='balanced'
        best = res.selected_candidate
        assert best.grid_index == 1
        assert best.C == 0.001
        assert best.class_weight == "balanced"
        assert math.isclose(best.metrics.balanced_accuracy, 0.3630, abs_tol=0.005)

    def test_tune_logistic_regression_horizon_5(self, historical_splits):
        """Verifies hyperparameter tuning on horizon h=5 authentic splits."""
        splitter = PurgedChronologicalSplitter()
        X_tr, y_tr, X_va, y_va, X_te, y_te, acct = splitter.split_features_and_targets(
            features_df=historical_splits["features_df"],
            targets_df=historical_splits["targets_df"],
            clean_dates=historical_splits["clean_calendar"],
            horizon=5,
            feature_names=list(APPROVED_FEATURE_ALLOWLIST),
        )

        assert len(X_tr) == 1875
        assert len(X_va) == 380

        res = tune_logistic_regression(X_tr, y_tr, X_va, y_va, horizon=5)

        assert res.horizon == 5
        assert len(res.candidates) == 12
        assert res.n_train_samples == 1875
        assert res.n_val_samples == 380

        # Horizon 5 selected candidate: idx=3, C=0.01, class_weight='balanced'
        best = res.selected_candidate
        assert best.grid_index == 3
        assert best.C == 0.01
        assert best.class_weight == "balanced"
        assert math.isclose(best.metrics.balanced_accuracy, 0.3587, abs_tol=0.005)

    def test_tuning_function_signature_has_zero_test_parameters(self):
        """
        Enforces programmatic leakage quarantine:
        tune_logistic_regression signature must NOT accept any test arguments.
        """
        sig = inspect.signature(tune_logistic_regression)
        param_names = list(sig.parameters.keys())

        for forbidden in ["X_test", "y_test", "test_features", "test_targets", "test_labels"]:
            assert forbidden not in param_names, f"Forbidden test parameter found in tuning signature: {forbidden}"

    def test_tuning_pipeline_reproducibility(self, historical_splits):
        """Verifies that running tuning twice yields identical results bit-for-bit."""
        splitter = PurgedChronologicalSplitter()
        X_tr, y_tr, X_va, y_va, _, _, _ = splitter.split_features_and_targets(
            features_df=historical_splits["features_df"],
            targets_df=historical_splits["targets_df"],
            clean_dates=historical_splits["clean_calendar"],
            horizon=1,
            feature_names=list(APPROVED_FEATURE_ALLOWLIST),
        )

        res1 = tune_logistic_regression(X_tr, y_tr, X_va, y_va, horizon=1)
        res2 = tune_logistic_regression(X_tr, y_tr, X_va, y_va, horizon=1)

        assert res1.selected_candidate.grid_index == res2.selected_candidate.grid_index
        assert res1.selected_candidate.metrics.balanced_accuracy == res2.selected_candidate.metrics.balanced_accuracy
        assert res1.selected_candidate.metrics.log_loss == res2.selected_candidate.metrics.log_loss
        assert res1.selection_rankings == res2.selection_rankings
