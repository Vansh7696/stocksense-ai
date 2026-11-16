"""
StockSense AI — Baseline Classifiers Unit Test Suite
Exhaustive verification of MajorityClassifier and MomentumBaseline benchmark models:
- Normal, edge-case, and missing-class behavior
- Deterministic tie-breaking
- Horizon-specific thresholding and ddof=1 standard deviation
- Bounded temperature calibration on training data
- Probability shape, non-negativity, and simplex normalization
- Explicit data leakage quarantine verification
"""

import math
import numpy as np
import pandas as pd
import pytest

from app.schemas.baselines import (
    MajorityClassifierMetadata,
    MomentumBaselineMetadata,
)
from app.services.baselines import (
    MajorityClassifier,
    MomentumBaseline,
    CANONICAL_LABELS,
)
from app.services.metrics import (
    compute_classification_metrics,
    MetricsEngine,
)


# =============================================================================
# 1. MajorityClassifier Unit Tests
# =============================================================================

class TestMajorityClassifier:
    """Tests for the naive frequency-based MajorityClassifier."""

    def test_normal_majority_prediction_neutral(self):
        # 10 samples: 2 DOWN (-1), 5 NEUTRAL (0), 3 UP (+1)
        y_train = np.array([-1, -1, 0, 0, 0, 0, 0, 1, 1, 1])
        clf = MajorityClassifier(horizon=1)
        clf.fit(y_train)

        assert clf.is_fitted_
        assert clf.majority_class_ == 0
        assert clf.tie_broken_ is False
        assert clf.n_samples_ == 10
        assert math.isclose(clf.class_frequencies_[-1], 0.20, rel_tol=1e-9)
        assert math.isclose(clf.class_frequencies_[0], 0.50, rel_tol=1e-9)
        assert math.isclose(clf.class_frequencies_[1], 0.30, rel_tol=1e-9)

        # Predict on new samples
        X_test = np.array([10.0, 20.0, 30.0, 40.0])
        preds = clf.predict(X_test)
        assert len(preds) == 4
        assert np.all(preds == 0)

        # Predict probabilities
        probs = clf.predict_proba(X_test)
        assert probs.shape == (4, 3)
        assert np.allclose(probs.sum(axis=1), 1.0, atol=1e-12)
        # Expected column order: DOWN (-1), NEUTRAL (0), UP (+1)
        expected_row = [0.20, 0.50, 0.30]
        for row in probs:
            assert np.allclose(row, expected_row, atol=1e-12)

    def test_all_neutral_training_data(self):
        y_train = np.array([0, 0, 0, 0, 0])
        clf = MajorityClassifier()
        clf.fit(y_train)

        assert clf.majority_class_ == 0
        assert clf.class_frequencies_[-1] == 0.0
        assert clf.class_frequencies_[0] == 1.0
        assert clf.class_frequencies_[1] == 0.0

        probs = clf.predict_proba([1, 2, 3])
        assert np.allclose(probs[:, 0], 0.0)
        assert np.allclose(probs[:, 1], 1.0)
        assert np.allclose(probs[:, 2], 0.0)

    def test_missing_classes_in_training_data(self):
        # Only DOWN (-1) and UP (+1), class 0 is missing
        y_train = np.array([-1, -1, -1, 1])
        clf = MajorityClassifier()
        clf.fit(y_train)

        assert clf.majority_class_ == -1
        assert clf.class_frequencies_[-1] == 0.75
        assert clf.class_frequencies_[0] == 0.0
        assert clf.class_frequencies_[1] == 0.25

    def test_deterministic_tie_breaking(self):
        # 3-way exact tie: exactly 2 DOWN, 2 NEUTRAL, 2 UP
        y_train = np.array([-1, -1, 0, 0, 1, 1])

        # Default priority: [0, 1, -1] -> should choose 0 (NEUTRAL)
        clf1 = MajorityClassifier()
        clf1.fit(y_train)
        assert clf1.tie_broken_ is True
        assert clf1.majority_class_ == 0

        # Custom priority: [1, -1, 0] -> should choose 1 (UP)
        clf2 = MajorityClassifier(tie_breaker_priority=[1, -1, 0])
        clf2.fit(y_train)
        assert clf2.tie_broken_ is True
        assert clf2.majority_class_ == 1

        # 2-way tie between DOWN (-1) and UP (+1), both count=2, NEUTRAL count=1
        y_train_2way = np.array([-1, -1, 1, 1, 0])
        clf3 = MajorityClassifier(tie_breaker_priority=[0, 1, -1])
        clf3.fit(y_train_2way)
        assert clf3.tie_broken_ is True
        assert clf3.majority_class_ == 1  # 1 has higher priority than -1

    def test_fit_with_feature_matrix_and_labels(self):
        X = pd.DataFrame({"feat1": [1.0, 2.0, 3.0], "feat2": [4.0, 5.0, 6.0]})
        y = pd.Series([1, 1, -1])
        clf = MajorityClassifier()
        clf.fit(X, y)
        assert clf.majority_class_ == 1
        preds = clf.predict(X)
        assert np.all(preds == 1)

    def test_re_fitting_updates_state_completely(self):
        clf = MajorityClassifier()
        clf.fit([0, 0, 0])
        assert clf.majority_class_ == 0

        clf.fit([1, 1, 1])
        assert clf.majority_class_ == 1
        assert clf.class_frequencies_[1] == 1.0
        assert clf.class_frequencies_[0] == 0.0

    def test_rejects_empty_training_labels(self):
        clf = MajorityClassifier()
        with pytest.raises(ValueError, match="empty training labels"):
            clf.fit([])

    def test_rejects_unapproved_labels(self):
        clf = MajorityClassifier()
        with pytest.raises(ValueError, match="Unapproved labels detected"):
            clf.fit([0, 1, 2])

    def test_rejects_nan_in_labels(self):
        clf = MajorityClassifier()
        with pytest.raises(ValueError, match="non-finite values"):
            clf.fit([0, 1, np.nan])

    def test_predict_before_fit_raises(self):
        clf = MajorityClassifier()
        with pytest.raises(ValueError, match="not fitted"):
            clf.predict([1, 2, 3])

        with pytest.raises(ValueError, match="not fitted"):
            clf.predict_proba([1, 2, 3])

    def test_get_metadata_schema_conformance(self):
        clf = MajorityClassifier(horizon=3)
        clf.fit([0, 0, 1, -1])
        meta = clf.get_metadata()
        assert isinstance(meta, MajorityClassifierMetadata)
        assert meta.horizon == 3
        assert meta.majority_class == 0
        assert meta.training_samples == 4

    def test_interoperability_with_metrics_engine(self):
        y_train = np.array([-1, 0, 0, 1, 0])
        y_test = np.array([-1, 0, 1, 1, -1])

        clf = MajorityClassifier(horizon=1)
        clf.fit(y_train)

        preds = clf.predict(y_test)
        probs = clf.predict_proba(y_test)

        metrics = compute_classification_metrics(
            y_true=y_test,
            y_pred=preds,
            y_prob=probs,
            horizon=1,
            model_name="majority_baseline",
        )
        assert 0.0 <= metrics.accuracy <= 1.0
        assert 0.0 <= metrics.brier_score <= 2.0
        assert metrics.log_loss is not None and metrics.log_loss >= 0.0


# =============================================================================
# 2. MomentumBaseline Unit Tests
# =============================================================================

class TestMomentumBaseline:
    """Tests for the rule-based MomentumBaseline classifier."""

    @pytest.fixture
    def synthetic_returns(self):
        rng = np.random.RandomState(42)
        n = 500
        returns = rng.normal(loc=0.0, scale=1.5, size=n)
        labels = np.zeros(n, dtype=np.int64)
        labels[returns > 1.5] = 1
        labels[returns < -1.5] = -1
        # Add random noise to labels
        noise_idx = rng.choice(n, size=50, replace=False)
        labels[noise_idx] = rng.choice([-1, 0, 1], size=50)
        return returns, labels

    def test_threshold_calculation_uses_ddof_1(self, synthetic_returns):
        returns, labels = synthetic_returns
        expected_delta = float(np.std(returns, ddof=1))

        model = MomentumBaseline(horizon=1)
        model.fit(returns, labels)

        assert math.isclose(model.threshold_delta_, expected_delta, rel_tol=1e-12)
        assert math.isclose(model.training_std_return_, expected_delta, rel_tol=1e-12)

    def test_classification_boundary_rules(self):
        """
        UP when r > +delta_h
        DOWN when r < -delta_h
        NEUTRAL when -delta_h <= r <= +delta_h
        """
        # Controlled training data with known std
        r_train = np.array([-2.0, -1.0, 0.0, 1.0, 2.0])
        y_train = np.array([-1, -1, 0, 1, 1])
        delta = float(np.std(r_train, ddof=1))

        model = MomentumBaseline(horizon=1, optimize_temperature=False)
        model.fit(r_train, y_train)

        # Test exact boundary values
        test_returns = np.array([
            delta + 0.01,  # Strictly above delta -> UP (+1)
            delta,         # Exactly on boundary -> NEUTRAL (0)
            delta - 0.01,  # Inside band -> NEUTRAL (0)
            0.0,           # Center -> NEUTRAL (0)
            -delta + 0.01, # Inside band -> NEUTRAL (0)
            -delta,        # Exactly on negative boundary -> NEUTRAL (0)
            -delta - 0.01, # Strictly below -delta -> DOWN (-1)
        ])

        preds = model.predict(test_returns)
        expected_preds = np.array([1, 0, 0, 0, 0, 0, -1])
        assert np.array_equal(preds, expected_preds)

    def test_horizon_specific_thresholds(self):
        """Thresholds delta_h are fitted independently for h1, h3, h5."""
        rng = np.random.RandomState(123)
        r_h1 = rng.normal(0, 1.0, size=200)
        r_h3 = rng.normal(0, 1.8, size=200)
        r_h5 = rng.normal(0, 2.5, size=200)

        y = rng.choice([-1, 0, 1], size=200)

        m1 = MomentumBaseline(horizon=1).fit(r_h1, y)
        m3 = MomentumBaseline(horizon=3).fit(r_h3, y)
        m5 = MomentumBaseline(horizon=5).fit(r_h5, y)

        assert m1.threshold_delta_ < m3.threshold_delta_ < m5.threshold_delta_
        assert math.isclose(m1.threshold_delta_, np.std(r_h1, ddof=1), rel_tol=1e-12)
        assert math.isclose(m3.threshold_delta_, np.std(r_h3, ddof=1), rel_tol=1e-12)
        assert math.isclose(m5.threshold_delta_, np.std(r_h5, ddof=1), rel_tol=1e-12)

    def test_probability_matrix_properties_and_column_order(self, synthetic_returns):
        returns, labels = synthetic_returns
        model = MomentumBaseline(horizon=1)
        model.fit(returns, labels)

        test_r = np.array([-5.0, 0.0, 5.0])
        probs = model.predict_proba(test_r)

        assert probs.shape == (3, 3)
        assert np.all(probs >= 0.0)
        assert np.allclose(probs.sum(axis=1), 1.0, atol=1e-12)

        # Strongly negative return (-5.0): DOWN probability must dominate
        # Column 0: DOWN, Column 1: NEUTRAL, Column 2: UP
        assert probs[0, 0] > probs[0, 1] > probs[0, 2]

        # Zero return (0.0): s_NEUTRAL = +delta, s_DOWN = -delta, s_UP = -delta -> NEUTRAL dominates
        assert probs[1, 1] > probs[1, 0]
        assert math.isclose(probs[1, 0], probs[1, 2], rel_tol=1e-7)

        # Strongly positive return (+5.0): UP probability must dominate
        assert probs[2, 2] > probs[2, 1] > probs[2, 0]

    def test_temperature_calibration_on_training_data(self, synthetic_returns):
        returns, labels = synthetic_returns
        model = MomentumBaseline(horizon=1, optimize_temperature=True)
        model.fit(returns, labels)

        assert model.optimization_success_ is True
        assert 0.1 <= model.temperature_ <= 10.0
        assert model.optimization_nll_ is not None and model.optimization_nll_ > 0.0

    def test_constant_returns_edge_case(self):
        """Constant returns (variance = 0) handled gracefully without division by zero."""
        r_const = np.array([1.5, 1.5, 1.5, 1.5])
        y = np.array([1, 1, 1, 1])

        model = MomentumBaseline()
        model.fit(r_const, y)

        assert model.is_constant_return_ is True
        assert model.threshold_delta_ == 0.0

        # With delta_h = 0.0 and r = 1.5 > 0, approved hard rule predicts 1 (UP)
        preds = model.predict(r_const)
        assert np.all(preds == 1)

        probs = model.predict_proba(r_const)
        assert probs.shape == (4, 3)
        assert np.allclose(probs.sum(axis=1), 1.0)
        assert np.all(probs[:, 2] > probs[:, 1])
        assert np.all(probs[:, 1] == probs[:, 0])

    def test_dataframe_and_2d_array_input_formats(self):
        df_train = pd.DataFrame({
            "unrelated": [10, 20, 30, 40],
            "return_1d": [-2.0, -0.5, 0.5, 2.0],
        })
        y_train = np.array([-1, 0, 0, 1])

        model = MomentumBaseline()
        model.fit(df_train, y_train)

        # Predict with DataFrame
        preds_df = model.predict(df_train)
        assert len(preds_df) == 4

        # Predict with 1D numpy array
        preds_1d = model.predict([-2.0, 0.0, 2.0])
        assert len(preds_1d) == 3

    def test_rejects_missing_return_1d_column_in_dataframe(self):
        df_bad = pd.DataFrame({"featA": [1, 2], "featB": [3, 4]})
        model = MomentumBaseline()
        with pytest.raises(ValueError, match="Required feature 'return_1d' not found"):
            model.fit(df_bad, [0, 1])

    def test_rejects_nan_in_returns(self):
        model = MomentumBaseline()
        with pytest.raises(ValueError, match="non-finite values"):
            model.fit([1.0, np.nan, 2.0], [0, 0, 1])

    def test_rejects_unapproved_target_labels(self):
        model = MomentumBaseline()
        with pytest.raises(ValueError, match="Unapproved labels detected"):
            model.fit([1.0, 2.0, 3.0], [-1, 0, 5])

    def test_get_metadata_conformance(self, synthetic_returns):
        returns, labels = synthetic_returns
        model = MomentumBaseline(horizon=5)
        model.fit(returns, labels)
        meta = model.get_metadata()

        assert isinstance(meta, MomentumBaselineMetadata)
        assert meta.horizon == 5
        assert meta.threshold_delta > 0.0
        assert meta.temperature > 0.0
        assert meta.training_samples == len(returns)

    def test_determinism_across_multiple_runs(self, synthetic_returns):
        returns, labels = synthetic_returns
        m1 = MomentumBaseline(horizon=1).fit(returns, labels)
        m2 = MomentumBaseline(horizon=1).fit(returns, labels)

        assert m1.threshold_delta_ == m2.threshold_delta_
        assert m1.temperature_ == m2.temperature_
        assert np.array_equal(m1.predict(returns[:20]), m2.predict(returns[:20]))
        assert np.allclose(m1.predict_proba(returns[:20]), m2.predict_proba(returns[:20]))


# =============================================================================
# 3. Data Leakage Quarantine Verification Tests
# =============================================================================

class TestBaselineDataLeakageQuarantine:
    """
    Explicitly tests and proves that validation and test partitions cannot leak
    into MajorityClassifier or MomentumBaseline parameters.
    """

    def test_majority_classifier_unaffected_by_val_or_test_labels(self):
        # Training set is majority NEUTRAL (0)
        y_train = np.array([0, 0, 0, -1, 1])
        # Validation and test sets are heavily UP (+1)
        y_val = np.array([1, 1, 1, 1, 1])
        y_test = np.array([1, 1, 1, 1, 1])

        clf = MajorityClassifier()
        clf.fit(y_train)

        # Baseline fitted exclusively on train
        assert clf.majority_class_ == 0
        assert clf.class_frequencies_[0] == 3 / 5

        # Predictions on val and test evaluate to 0 (the training majority), NOT 1
        val_preds = clf.predict(np.zeros(len(y_val)))
        test_preds = clf.predict(np.zeros(len(y_test)))

        assert np.all(val_preds == 0)
        assert np.all(test_preds == 0)

    def test_momentum_baseline_threshold_unaffected_by_val_or_test_returns(self):
        # Training returns with low volatility (std ~ 0.5)
        rng = np.random.RandomState(42)
        r_train = rng.normal(0, 0.5, size=300)
        y_train = rng.choice([-1, 0, 1], size=300)

        # Validation and test returns with extreme volatility (std ~ 5.0)
        r_val = rng.normal(0, 5.0, size=100)
        y_val = rng.choice([-1, 0, 1], size=100)
        r_test = rng.normal(0, 10.0, size=100)
        y_test = rng.choice([-1, 0, 1], size=100)

        model = MomentumBaseline(horizon=1)
        model.fit(r_train, y_train)

        # Fitted threshold delta_h must strictly match r_train std, never r_val or r_test
        expected_delta = float(np.std(r_train, ddof=1))
        assert math.isclose(model.threshold_delta_, expected_delta, rel_tol=1e-12)

        # Proves that threshold is completely quarantined from validation/test volatility
        val_std = float(np.std(r_val, ddof=1))
        test_std = float(np.std(r_test, ddof=1))
        assert model.threshold_delta_ < val_std
        assert model.threshold_delta_ < test_std

    def test_momentum_baseline_temperature_unaffected_by_val_or_test(self):
        # Train model on training data
        rng = np.random.RandomState(101)
        r_train = rng.normal(0, 1.2, size=300)
        y_train = rng.choice([-1, 0, 1], size=300)

        model = MomentumBaseline(horizon=1)
        model.fit(r_train, y_train)
        frozen_tau = model.temperature_
        frozen_delta = model.threshold_delta_

        # Generating predictions on validation data does not mutate fitted parameters
        r_val = rng.normal(0, 3.0, size=100)
        _ = model.predict(r_val)
        _ = model.predict_proba(r_val)

        assert model.temperature_ == frozen_tau
        assert model.threshold_delta_ == frozen_delta


# =============================================================================
# 4. Phase 5C.3.4 Mathematical Audit Regression Tests
# =============================================================================

class TestBaselineMathematicalAudit:
    """
    Focused mathematical regression tests auditing the exact behavior of:
    - predict() vs argmax(predict_proba()) across 7 return magnitude test points
    - Exact threshold ties and NEUTRAL tie-breaking
    - Constant return handling (zero, positive, negative, and 1e-12 boundary)
    - Allowlist feature indexing (index 15 = return_1d)
    - MajorityClassifier tie-breaking priority
    - Temperature optimization monotonicity across [0.1, 10.0]
    - Training-only temperature calibration on authentic purged splits (h1: 1895, h3: 1885, h5: 1875)
    - Zero validation/test leakage
    """

    def test_momentum_prediction_and_probability_consistency_7_points(self):
        """
        Audits exact behavior of hard classification vs softmax probabilities for:
        0, +0.5*delta, +delta, +1.5*delta, -0.5*delta, -delta, -1.5*delta.
        Under the approved piecewise distance scores from Section 4.2 of the design:
            s_UP = r - delta, s_DOWN = -r - delta, s_NEUTRAL = delta - |r|
        Verifies that predict(r) == deterministic_argmax_with_neutral_tie(predict_proba(r))
        strictly holds for all 7 points.
        """
        from app.services.baselines import deterministic_argmax_with_neutral_tie

        delta = 1.294865
        model = MomentumBaseline(horizon=1, optimize_temperature=False, default_temperature=1.0)
        model.threshold_delta_ = delta
        model.temperature_ = 1.0
        model.is_fitted_ = True
        model.is_constant_return_ = False

        # 1. return_1d = 0.0
        h_0 = model.predict([0.0])[0]
        p_0 = model.predict_proba([0.0])[0]
        assert h_0 == 0  # Hard rule: 0 is inside [-delta, +delta] -> NEUTRAL
        # Piecewise: s_NEUTRAL = +delta > s_DOWN = s_UP = -delta -> NEUTRAL dominates
        assert p_0[1] > p_0[0] and math.isclose(p_0[0], p_0[2], rel_tol=1e-7)
        assert deterministic_argmax_with_neutral_tie(p_0)[0] == 0
        assert h_0 == deterministic_argmax_with_neutral_tie(p_0)[0]

        # 2. return_1d = +0.5 * delta
        h_pos_half = model.predict([0.5 * delta])[0]
        p_pos_half = model.predict_proba([0.5 * delta])[0]
        assert h_pos_half == 0  # Hard rule: 0.5*delta <= delta -> NEUTRAL
        # Piecewise: s_NEUTRAL = +0.5*delta > s_UP = -0.5*delta > s_DOWN = -1.5*delta
        assert p_pos_half[1] > p_pos_half[2] > p_pos_half[0]
        assert deterministic_argmax_with_neutral_tie(p_pos_half)[0] == 0
        assert h_pos_half == deterministic_argmax_with_neutral_tie(p_pos_half)[0]

        # 3. return_1d = +1.0 * delta (exact positive boundary)
        h_pos_1 = model.predict([1.0 * delta])[0]
        p_pos_1 = model.predict_proba([1.0 * delta])[0]
        assert h_pos_1 == 0  # Hard rule: r > delta strictly for UP; at boundary r == delta -> NEUTRAL
        # Piecewise: s_UP = 0, s_NEUTRAL = 0, s_DOWN = -2*delta -> exact tie between UP and NEUTRAL
        assert math.isclose(p_pos_1[1], p_pos_1[2], rel_tol=1e-7)
        assert p_pos_1[1] > p_pos_1[0]
        # NEUTRAL wins boundary ties
        assert deterministic_argmax_with_neutral_tie(p_pos_1)[0] == 0
        assert h_pos_1 == deterministic_argmax_with_neutral_tie(p_pos_1)[0]

        # 4. return_1d = +1.5 * delta (positive breakout region)
        h_pos_1_5 = model.predict([1.5 * delta])[0]
        p_pos_1_5 = model.predict_proba([1.5 * delta])[0]
        assert h_pos_1_5 == 1  # Hard rule: r > delta -> UP (+1)
        # Piecewise: s_UP = +0.5*delta > s_NEUTRAL = -0.5*delta > s_DOWN = -2.5*delta
        assert p_pos_1_5[2] > p_pos_1_5[1] > p_pos_1_5[0]
        assert deterministic_argmax_with_neutral_tie(p_pos_1_5)[0] == 1
        assert h_pos_1_5 == deterministic_argmax_with_neutral_tie(p_pos_1_5)[0]

        # 5. return_1d = -0.5 * delta
        h_neg_half = model.predict([-0.5 * delta])[0]
        p_neg_half = model.predict_proba([-0.5 * delta])[0]
        assert h_neg_half == 0  # Hard rule: -0.5*delta >= -delta -> NEUTRAL
        # Piecewise: s_NEUTRAL = +0.5*delta > s_DOWN = -0.5*delta > s_UP = -1.5*delta
        assert p_neg_half[1] > p_neg_half[0] > p_neg_half[2]
        assert deterministic_argmax_with_neutral_tie(p_neg_half)[0] == 0
        assert h_neg_half == deterministic_argmax_with_neutral_tie(p_neg_half)[0]

        # 6. return_1d = -1.0 * delta (exact negative boundary)
        h_neg_1 = model.predict([-1.0 * delta])[0]
        p_neg_1 = model.predict_proba([-1.0 * delta])[0]
        assert h_neg_1 == 0  # Hard rule: r < -delta strictly for DOWN; at boundary r == -delta -> NEUTRAL
        # Piecewise: s_DOWN = 0, s_NEUTRAL = 0, s_UP = -2*delta -> exact tie between DOWN and NEUTRAL
        assert math.isclose(p_neg_1[0], p_neg_1[1], rel_tol=1e-7)
        assert p_neg_1[1] > p_neg_1[2]
        # NEUTRAL wins boundary ties
        assert deterministic_argmax_with_neutral_tie(p_neg_1)[0] == 0
        assert h_neg_1 == deterministic_argmax_with_neutral_tie(p_neg_1)[0]

        # 7. return_1d = -1.5 * delta (negative breakout region)
        h_neg_1_5 = model.predict([-1.5 * delta])[0]
        p_neg_1_5 = model.predict_proba([-1.5 * delta])[0]
        assert h_neg_1_5 == -1  # Hard rule: r < -delta -> DOWN (-1)
        # Piecewise: s_DOWN = +0.5*delta > s_NEUTRAL = -0.5*delta > s_UP = -2.5*delta
        assert p_neg_1_5[0] > p_neg_1_5[1] > p_neg_1_5[2]
        assert deterministic_argmax_with_neutral_tie(p_neg_1_5)[0] == -1
        assert h_neg_1_5 == deterministic_argmax_with_neutral_tie(p_neg_1_5)[0]

    def test_exact_threshold_ties_and_predict_parity(self):
        """
        Verifies exact boundary tie-breaking and immediate vicinity parity:
        - Values immediately below +delta: NEUTRAL (0)
        - Value exactly at +delta: NEUTRAL (0) (exact tie)
        - Values immediately above +delta: UP (+1) (directional win)
        - Values immediately above -delta: NEUTRAL (0)
        - Value exactly at -delta: NEUTRAL (0) (exact tie)
        - Values immediately below -delta: DOWN (-1) (directional win)
        Ensures predict(r) == model.predict_from_proba(model.predict_proba(r)) across all points.
        """
        from app.services.baselines import deterministic_argmax_with_neutral_tie

        for delta in [0.5, 1.294865, 2.5]:
            model = MomentumBaseline(default_temperature=1.0)
            model.threshold_delta_ = delta
            model.temperature_ = 1.0
            model.is_fitted_ = True

            # 1. Exact positive boundary r = +delta
            p_pos = model.predict_proba([delta])
            h_pos = model.predict([delta])
            assert h_pos[0] == 0
            assert p_pos[0, 1] == p_pos[0, 2]  # Bit-for-bit exact equality
            assert p_pos[0, 1] > p_pos[0, 0]
            assert deterministic_argmax_with_neutral_tie(p_pos)[0] == 0
            assert h_pos[0] == deterministic_argmax_with_neutral_tie(p_pos)[0]

            # 2. Values immediately below +delta
            for eps in [1e-14, 1e-12, 1e-8]:
                r_below = delta - eps
                p_below = model.predict_proba([r_below])
                h_below = model.predict([r_below])
                assert h_below[0] == 0
                assert p_below[0, 1] > p_below[0, 2]  # NEUTRAL strictly higher
                assert deterministic_argmax_with_neutral_tie(p_below)[0] == 0
                assert h_below[0] == deterministic_argmax_with_neutral_tie(p_below)[0]

            # 3. Values immediately above +delta (genuine directional win)
            for eps in [1e-14, 1e-12, 1e-8]:
                r_above = delta + eps
                p_above = model.predict_proba([r_above])
                h_above = model.predict([r_above])
                assert h_above[0] == 1
                assert p_above[0, 2] > p_above[0, 1]  # UP strictly higher
                assert deterministic_argmax_with_neutral_tie(p_above)[0] == 1
                assert h_above[0] == deterministic_argmax_with_neutral_tie(p_above)[0]

            # 4. Exact negative boundary r = -delta
            p_neg = model.predict_proba([-delta])
            h_neg = model.predict([-delta])
            assert h_neg[0] == 0
            assert p_neg[0, 0] == p_neg[0, 1]  # Bit-for-bit exact equality
            assert p_neg[0, 1] > p_neg[0, 2]
            assert deterministic_argmax_with_neutral_tie(p_neg)[0] == 0
            assert h_neg[0] == deterministic_argmax_with_neutral_tie(p_neg)[0]

            # 5. Values immediately above -delta (inside deadband)
            for eps in [1e-14, 1e-12, 1e-8]:
                r_in = -delta + eps
                p_in = model.predict_proba([r_in])
                h_in = model.predict([r_in])
                assert h_in[0] == 0
                assert p_in[0, 1] > p_in[0, 0]  # NEUTRAL strictly higher
                assert deterministic_argmax_with_neutral_tie(p_in)[0] == 0
                assert h_in[0] == deterministic_argmax_with_neutral_tie(p_in)[0]

            # 6. Values immediately below -delta (breakout into DOWN)
            for eps in [1e-14, 1e-12, 1e-8]:
                r_out = -delta - eps
                p_out = model.predict_proba([r_out])
                h_out = model.predict([r_out])
                assert h_out[0] == -1
                assert p_out[0, 0] > p_out[0, 1]  # DOWN strictly higher
                assert deterministic_argmax_with_neutral_tie(p_out)[0] == -1
                assert h_out[0] == deterministic_argmax_with_neutral_tie(p_out)[0]

    def test_directional_probability_advantage_not_overridden_by_tolerance(self):
        """
        Confirms that a directional probability advantage over NEUTRAL, even when
        infinitesimal (e.g. 1e-15), is strictly respected and NEVER overridden.
        """
        from app.services.baselines import deterministic_argmax_with_neutral_tie

        # Construct synthetic probabilities where UP exceeds NEUTRAL by 1e-15
        base = 0.49
        p_up_slight = np.array([[0.02, base, base + 1e-15]])
        p_up_slight /= p_up_slight.sum()
        assert deterministic_argmax_with_neutral_tie(p_up_slight)[0] == 1  # UP wins

        # Construct synthetic probabilities where DOWN exceeds NEUTRAL by 1e-15
        p_down_slight = np.array([[base + 1e-15, base, 0.02]])
        p_down_slight /= p_down_slight.sum()
        assert deterministic_argmax_with_neutral_tie(p_down_slight)[0] == -1  # DOWN wins

        # Construct synthetic exact tie where UP equals NEUTRAL
        p_tie = np.array([[0.02, 0.49, 0.49]])
        assert deterministic_argmax_with_neutral_tie(p_tie)[0] == 0  # NEUTRAL wins exact tie

    def test_constant_return_permutations(self):
        """
        Tests zero-variance handling on zero, positive, negative, and boundary near-constant returns.
        Verifies:
        - delta_h = 0 and r = 0 -> NEUTRAL (0)
        - delta_h = 0 and r > 0 -> UP (+1)
        - delta_h = 0 and r < 0 -> DOWN (-1)
        Piecewise probability scores do not divide by delta_h, avoiding division by zero.
        """
        from app.services.baselines import deterministic_argmax_with_neutral_tie

        # 1. Constant zero returns (delta_h = 0, r = 0 -> NEUTRAL)
        m_zero = MomentumBaseline().fit([0.0, 0.0, 0.0], [0, 0, 0])
        assert m_zero.is_constant_return_ is True
        assert m_zero.threshold_delta_ == 0.0
        assert np.all(m_zero.predict([0.0, 0.0]) == 0)
        p_zero = m_zero.predict_proba([0.0])
        assert np.allclose(p_zero, [1/3, 1/3, 1/3])
        assert deterministic_argmax_with_neutral_tie(p_zero)[0] == 0

        # 2. Constant positive returns (delta_h = 0, r > 0 -> UP)
        m_pos = MomentumBaseline().fit([2.0, 2.0, 2.0], [1, 1, 1])
        assert m_pos.is_constant_return_ is True
        assert m_pos.threshold_delta_ == 0.0
        assert np.all(m_pos.predict([2.0, 2.0]) == 1)
        p_pos = m_pos.predict_proba([2.0])
        assert p_pos[0, 2] > p_pos[0, 1]
        assert p_pos[0, 1] == p_pos[0, 0]
        assert deterministic_argmax_with_neutral_tie(p_pos)[0] == 1

        # 3. Constant negative returns (delta_h = 0, r < 0 -> DOWN)
        m_neg = MomentumBaseline().fit([-2.0, -2.0, -2.0], [-1, -1, -1])
        assert m_neg.is_constant_return_ is True
        assert m_neg.threshold_delta_ == 0.0
        assert np.all(m_neg.predict([-2.0, -2.0]) == -1)
        p_neg = m_neg.predict_proba([-2.0])
        assert p_neg[0, 0] > p_neg[0, 1]
        assert p_neg[0, 1] == p_neg[0, 2]
        assert deterministic_argmax_with_neutral_tie(p_neg)[0] == -1

        # 4. Returns with std below 1e-12 threshold
        tiny_std_returns = [1.0, 1.0 + 1e-14, 1.0, 1.0 + 1e-14]
        m_tiny = MomentumBaseline().fit(tiny_std_returns, [1, 1, 1, 1])
        assert m_tiny.is_constant_return_ is True
        assert m_tiny.threshold_delta_ == 0.0
        assert np.all(m_tiny.predict(tiny_std_returns) == 1)

        # 5. Returns with std above 1e-12 threshold
        above_std_returns = [1.0, 1.0 + 1e-10, 1.0, 1.0 + 1e-10]
        m_above = MomentumBaseline().fit(above_std_returns, [1, 1, 1, 1])
        assert m_above.is_constant_return_ is False
        assert m_above.threshold_delta_ > 0.0

    def test_feature_allowlist_index_15_verification(self):
        """Verifies that index 15 in APPROVED_FEATURE_ALLOWLIST is exactly 'return_1d'."""
        from app.services.splitting import APPROVED_FEATURE_ALLOWLIST
        assert len(APPROVED_FEATURE_ALLOWLIST) == 23
        assert APPROVED_FEATURE_ALLOWLIST[15] == "return_1d"

        # Verify 23-column array feature extraction in MomentumBaseline
        X_23 = np.zeros((10, 23))
        X_23[:, 15] = np.array([-2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 2.5])
        y = np.zeros(10, dtype=int)

        model = MomentumBaseline()
        model.fit(X_23, y)
        assert math.isclose(model.training_std_return_, float(np.std(X_23[:, 15], ddof=1)), rel_tol=1e-12)

    def test_majority_classifier_tie_breaking_order(self):
        """Verifies that MajorityClassifier priority order is NEUTRAL (0) > UP (+1) > DOWN (-1)."""
        # 3-way tie
        clf = MajorityClassifier()
        clf.fit([-1, 0, 1])
        assert clf.tie_broken_ is True
        assert clf.majority_class_ == 0

        # 2-way tie between DOWN (-1) and UP (+1)
        clf2 = MajorityClassifier()
        clf2.fit([-1, -1, 1, 1])
        assert clf2.tie_broken_ is True
        assert clf2.majority_class_ == 1  # UP has higher priority than DOWN

    def test_temperature_optimization_monotonicity(self):
        """
        Verifies that for pure-noise return distributions, the NLL function across [0.1, 10.0]
        monotonically decreases toward higher temperature to avoid overconfidence penalties.
        """
        rng = np.random.RandomState(42)
        r = rng.normal(0, 1.3, size=500)
        y = rng.choice([-1, 0, 1], size=500)  # Pure noise labels

        model = MomentumBaseline(horizon=1, optimize_temperature=True)
        model.fit(r, y)

        # Check NLL at tau = 0.5, 1.0, 2.0, 5.0, 10.0
        delta = model.threshold_delta_
        y_onehot = np.zeros((len(y), 3))
        for i, val in enumerate(y):
            y_onehot[i, val + 1] = 1.0

        nll_values = []
        for tau in [0.5, 1.0, 2.0, 5.0, 10.0]:
            probs = model._compute_probabilities(r, delta, tau)
            probs = np.clip(probs, 1e-15, 1.0 - 1e-15)
            probs = probs / probs.sum(axis=1, keepdims=True)
            nll = -float(np.mean(np.sum(y_onehot * np.log(probs), axis=1)))
            nll_values.append(nll)

        # Must be strictly monotonically decreasing for pure noise
        for i in range(len(nll_values) - 1):
            assert nll_values[i] > nll_values[i + 1]

        assert math.isclose(model.temperature_, 10.0, abs_tol=1e-3)

    def test_training_only_temperature_calibration_on_authentic_splits(self):
        """
        Regression test verifying:
        1. Exact training partition sample counts from authentic canonical fixture:
           - h1: 1,895 samples
           - h3: 1,885 samples
           - h5: 1,875 samples
        2. Horizon-specific temperature calibration using training partition ONLY.
        3. Strict zero-leakage quarantine: validation and test data are never touched.
        """
        import os, json
        from app.services.splitting import PurgedChronologicalSplitter, APPROVED_FEATURE_ALLOWLIST
        from app.services.targets import TargetService, normalize_candle_timestamp
        from app.services.features import FeatureEngineeringPipeline

        fixture_path = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "data", "historical_candles_5stocks.json")
        )
        if not os.path.exists(fixture_path):
            pytest.skip("Canonical fixture historical_candles_5stocks.json not available")

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

        splitter = PurgedChronologicalSplitter()

        expected_training_counts = {1: 1895, 3: 1885, 5: 1875}

        for h, expected_n in expected_training_counts.items():
            X_tr, y_tr, X_va, y_va, X_te, y_te, acct = splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_calendar,
                horizon=h,
                feature_names=list(APPROVED_FEATURE_ALLOWLIST),
            )

            # 1. Assert exact training partition count
            assert len(X_tr) == len(y_tr) == expected_n
            assert acct.retained_train_count == expected_n

            # 2. Fit MomentumBaseline strictly on training data
            model = MomentumBaseline(horizon=h, optimize_temperature=True)
            model.fit(X_tr, y_tr)

            # Check optimization results
            assert model.optimization_success_ is True
            assert 0.1 <= model.temperature_ <= 10.0
            assert model.n_samples_ == expected_n

            # Horizon 5 has interior optimum (~9.38); horizons 1 and 3 select the upper endpoint (10.0)
            if h == 5:
                assert model.selected_candidate_type_ == "optimizer_interior"
                assert math.isclose(model.temperature_, 9.3846, abs_tol=0.05)
                # Interior candidate must be strictly better than both endpoints
                assert model.optimization_nll_ < model.endpoint_upper_nll_
                assert model.optimization_nll_ < model.endpoint_lower_nll_
            else:
                assert model.selected_candidate_type_ == "upper_endpoint"
                assert math.isclose(model.temperature_, 10.0, abs_tol=1e-7)
                # Upper endpoint must be strictly lower than optimizer candidate and lower endpoint
                assert model.optimization_nll_ == model.endpoint_upper_nll_
                assert model.endpoint_upper_nll_ <= model.optimizer_candidate_nll_
                assert model.endpoint_upper_nll_ < model.endpoint_lower_nll_

            # 3. Verify Pydantic metadata includes candidate diagnostics
            meta = model.get_metadata()
            assert meta.temperature == model.temperature_
            assert meta.selected_candidate_type == model.selected_candidate_type_
            assert meta.endpoint_lower_nll is not None
            assert meta.endpoint_upper_nll is not None

            # 4. Verify predict and predict_proba consistency on training sample subset
            preds_sub = model.predict(X_tr[:50])
            probs_sub = model.predict_proba(X_tr[:50])
            argmax_sub = model.predict_from_proba(probs_sub)
            assert np.array_equal(preds_sub, argmax_sub)
