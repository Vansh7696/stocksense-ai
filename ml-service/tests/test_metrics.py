"""
StockSense AI — Classification Metrics Engine Test Suite
Tests for deterministic 3-class directional classification metrics.
Target classes: DOWN (-1), NEUTRAL (0), UP (+1).
"""

import math
import numpy as np
import pytest
from sklearn import metrics as sk_metrics

from app.schemas.metrics import (
    ClassMetricDetail,
    ConfusionMatrixData,
    CatastrophicErrorDetail,
    ClassificationMetrics,
)
from app.services.metrics import (
    CLASS_LABELS,
    CLASS_NAMES,
    LABEL_TO_INDEX,
    INDEX_TO_LABEL,
    LABEL_TO_NAME,
    DEFAULT_EPSILON,
    validate_classification_inputs,
    validate_and_normalize_probabilities,
    compute_confusion_matrix,
    compute_catastrophic_error,
    compute_multiclass_log_loss,
    compute_brier_score,
    compute_classification_metrics,
    MetricsEngine,
)


# =============================================================================
# 1. Metric Definitions & Scikit-Learn Parity Tests
# =============================================================================

class TestMetricDefinitionsAndSklearnParity:
    """Verifies standard classification metric formulas and exact agreement with scikit-learn."""

    @pytest.fixture
    def sample_data(self):
        rng = np.random.RandomState(42)
        n = 300
        y_true = rng.choice([-1, 0, 1], size=n, p=[0.33, 0.38, 0.29])
        # Add some noise to create realistic predictions
        noise = rng.choice([-1, 0, 1], size=n, p=[0.2, 0.6, 0.2])
        y_pred = np.clip(y_true + noise, -1, 1)

        # Generate non-trivial probability matrix
        logits = rng.normal(size=(n, 3))
        exp_logits = np.exp(logits - np.max(logits, axis=1, keepdims=True))
        y_prob = exp_logits / exp_logits.sum(axis=1, keepdims=True)

        return y_true, y_pred, y_prob

    def test_overall_accuracy_matches_sklearn(self, sample_data):
        y_true, y_pred, y_prob = sample_data
        res = compute_classification_metrics(y_true, y_pred, y_prob)
        sk_acc = sk_metrics.accuracy_score(y_true, y_pred)
        assert math.isclose(res.accuracy, sk_acc, rel_tol=1e-9)

    def test_balanced_accuracy_matches_sklearn(self, sample_data):
        y_true, y_pred, y_prob = sample_data
        res = compute_classification_metrics(y_true, y_pred, y_prob)
        sk_bal_acc = sk_metrics.balanced_accuracy_score(y_true, y_pred)
        assert math.isclose(res.balanced_accuracy, sk_bal_acc, rel_tol=1e-9)

    def test_macro_precision_matches_sklearn(self, sample_data):
        y_true, y_pred, y_prob = sample_data
        res = compute_classification_metrics(y_true, y_pred, y_prob)
        sk_prec = sk_metrics.precision_score(y_true, y_pred, average="macro", zero_division=0.0)
        assert math.isclose(res.macro_precision, sk_prec, rel_tol=1e-9)

    def test_macro_recall_matches_sklearn(self, sample_data):
        y_true, y_pred, y_prob = sample_data
        res = compute_classification_metrics(y_true, y_pred, y_prob)
        sk_rec = sk_metrics.recall_score(y_true, y_pred, average="macro", zero_division=0.0)
        assert math.isclose(res.macro_recall, sk_rec, rel_tol=1e-9)

    def test_macro_f1_matches_sklearn(self, sample_data):
        y_true, y_pred, y_prob = sample_data
        res = compute_classification_metrics(y_true, y_pred, y_prob)
        sk_f1 = sk_metrics.f1_score(y_true, y_pred, average="macro", zero_division=0.0)
        assert math.isclose(res.macro_f1, sk_f1, rel_tol=1e-9)

    def test_per_class_metrics_match_sklearn(self, sample_data):
        y_true, y_pred, y_prob = sample_data
        res = compute_classification_metrics(y_true, y_pred, y_prob)

        sk_prec_per_class = sk_metrics.precision_score(
            y_true, y_pred, labels=[-1, 0, 1], average=None, zero_division=0.0
        )
        sk_rec_per_class = sk_metrics.recall_score(
            y_true, y_pred, labels=[-1, 0, 1], average=None, zero_division=0.0
        )
        sk_f1_per_class = sk_metrics.f1_score(
            y_true, y_pred, labels=[-1, 0, 1], average=None, zero_division=0.0
        )

        for idx, name in enumerate(["DOWN", "NEUTRAL", "UP"]):
            class_res = res.per_class[name]
            assert math.isclose(class_res.precision, sk_prec_per_class[idx], rel_tol=1e-9)
            assert math.isclose(class_res.recall, sk_rec_per_class[idx], rel_tol=1e-9)
            assert math.isclose(class_res.f1, sk_f1_per_class[idx], rel_tol=1e-9)
            expected_support = int(np.sum(y_true == CLASS_LABELS[idx]))
            assert class_res.support == expected_support

    def test_confusion_matrix_matches_sklearn_with_fixed_class_order(self, sample_data):
        y_true, y_pred, y_prob = sample_data
        res = compute_classification_metrics(y_true, y_pred, y_prob)
        sk_cm = sk_metrics.confusion_matrix(y_true, y_pred, labels=[-1, 0, 1])
        assert np.array_equal(np.array(res.confusion_matrix), sk_cm)

    def test_log_loss_matches_sklearn(self, sample_data):
        y_true, y_pred, y_prob = sample_data
        res = compute_classification_metrics(y_true, y_pred, y_prob, epsilon=1e-15)
        # scikit-learn log_loss
        sk_ll = sk_metrics.log_loss(y_true, y_prob, labels=[-1, 0, 1])
        assert math.isclose(res.log_loss, sk_ll, rel_tol=1e-7)


# =============================================================================
# 2. Catastrophic Directional Error Tests
# =============================================================================

class TestCatastrophicDirectionalError:
    """Verifies catastrophic directional error definitions, counts, rates, and denominators."""

    def test_catastrophic_error_definition_and_counts(self):
        """
        Catastrophic error:
        Actual DOWN (-1) predicted UP (+1), or Actual UP (+1) predicted DOWN (-1).
        """
        # 10 samples:
        # 2 actual DOWN predicted UP (catastrophic)
        # 1 actual UP predicted DOWN (catastrophic)
        # 1 actual DOWN predicted NEUTRAL (ordinary error, NOT catastrophic)
        # 1 actual UP predicted NEUTRAL (ordinary error, NOT catastrophic)
        # 1 actual NEUTRAL predicted UP (NOT catastrophic)
        # 4 correct predictions
        y_true = np.array([-1, -1,  1, -1,  1,  0, -1,  0,  1,  0])
        y_pred = np.array([ 1,  1, -1,  0,  0,  1, -1,  0,  1,  0])

        cm = compute_confusion_matrix(y_true, y_pred)
        cat_err = compute_catastrophic_error(cm, total_samples=len(y_true))

        assert cat_err.count == 3
        assert cat_err.down_to_up_count == 2
        assert cat_err.up_to_down_count == 1
        # Primary denominator: total_samples = 10
        assert cat_err.total_samples == 10
        assert math.isclose(cat_err.rate, 3 / 10, rel_tol=1e-9)

        # Secondary denominator: directional_samples_count = 4 DOWN + 3 UP = 7
        assert cat_err.directional_samples_count == 7
        assert math.isclose(cat_err.directional_subset_rate, 3 / 7, rel_tol=1e-9)

    def test_catastrophic_error_zero_when_no_opposite_predictions(self):
        # All errors are to/from NEUTRAL
        y_true = np.array([-1,  0,  1, -1,  1])
        y_pred = np.array([ 0, -1,  0, -1,  1])  # No DOWN<->UP errors

        cm = compute_confusion_matrix(y_true, y_pred)
        cat_err = compute_catastrophic_error(cm, total_samples=len(y_true))

        assert cat_err.count == 0
        assert cat_err.rate == 0.0
        assert cat_err.directional_subset_rate == 0.0

    def test_catastrophic_error_directional_subset_when_all_neutral(self):
        # All samples are NEUTRAL: directional samples = 0
        y_true = np.array([0, 0, 0, 0])
        y_pred = np.array([1, -1, 0, 1])

        cm = compute_confusion_matrix(y_true, y_pred)
        cat_err = compute_catastrophic_error(cm, total_samples=len(y_true))

        assert cat_err.count == 0
        assert cat_err.rate == 0.0
        assert cat_err.directional_samples_count == 0
        assert cat_err.directional_subset_rate is None


# =============================================================================
# 3. Standard Multiclass Brier Score Tests
# =============================================================================

class TestStandardMulticlassBrierScore:
    """Verifies the standard multiclass Brier score formula, range [0, 2], and known values."""

    def test_perfect_prediction_brier_score_is_zero(self):
        y_true = np.array([-1, 0, 1])
        # Perfect probabilities: col0=DOWN, col1=NEUTRAL, col2=UP
        y_prob = np.array([
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ])
        brier = compute_brier_score(y_true, y_prob)
        assert math.isclose(brier, 0.0, abs_tol=1e-12)

    def test_worst_possible_prediction_brier_score_is_two(self):
        # Every prediction is 100% confident on a wrong class
        y_true = np.array([-1, 0, 1])
        y_prob = np.array([
            [0.0, 0.0, 1.0],  # Actual DOWN (-1), predicted UP (+1) -> (0-1)^2 + (0-0)^2 + (1-0)^2 = 2.0
            [1.0, 0.0, 0.0],  # Actual NEUTRAL (0), predicted DOWN (-1) -> 2.0
            [0.0, 1.0, 0.0],  # Actual UP (+1), predicted NEUTRAL (0) -> 2.0
        ])
        brier = compute_brier_score(y_true, y_prob)
        assert math.isclose(brier, 2.0, abs_tol=1e-12)

    def test_uniform_random_probabilities_brier_score(self):
        # Uniform 1/3 for all classes:
        # For each sample: (1/3 - 1)^2 + (1/3 - 0)^2 + (1/3 - 0)^2 = 4/9 + 1/9 + 1/9 = 6/9 = 2/3
        y_true = np.array([-1, 0, 1, 0, -1])
        y_prob = np.full((len(y_true), 3), 1.0 / 3.0)
        brier = compute_brier_score(y_true, y_prob)
        assert math.isclose(brier, 2.0 / 3.0, rel_tol=1e-9)

    def test_manual_calculation_verification(self):
        y_true = np.array([-1, 1])
        # Sample 1 (DOWN): one-hot = [1, 0, 0], prob = [0.7, 0.2, 0.1]
        # sq_err_1 = (0.7-1)^2 + (0.2-0)^2 + (0.1-0)^2 = 0.09 + 0.04 + 0.01 = 0.14
        # Sample 2 (UP): one-hot = [0, 0, 1], prob = [0.1, 0.3, 0.6]
        # sq_err_2 = (0.1-0)^2 + (0.3-0)^2 + (0.6-1)^2 = 0.01 + 0.09 + 0.16 = 0.26
        # Mean = (0.14 + 0.26) / 2 = 0.20
        y_prob = np.array([
            [0.7, 0.2, 0.1],
            [0.1, 0.3, 0.6],
        ])
        brier = compute_brier_score(y_true, y_prob)
        assert math.isclose(brier, 0.20, rel_tol=1e-9)


# =============================================================================
# 4. Probability Handling & Invariant Enforcement
# =============================================================================

class TestProbabilityHandling:
    """Verifies shape requirements, clipping, renormalization, and invalid value rejections."""

    def test_rejects_non_2d_probability_array(self):
        with pytest.raises(ValueError, match="must be 2-dimensional"):
            validate_and_normalize_probabilities([0.33, 0.33, 0.34], expected_samples=1)

    def test_rejects_wrong_column_count(self):
        # 2 columns instead of 3
        with pytest.raises(ValueError, match="shape mismatch"):
            validate_and_normalize_probabilities([[0.5, 0.5]], expected_samples=1)

        # 4 columns instead of 3
        with pytest.raises(ValueError, match="shape mismatch"):
            validate_and_normalize_probabilities([[0.25, 0.25, 0.25, 0.25]], expected_samples=1)

    def test_rejects_mismatched_sample_count(self):
        probs = np.array([[0.3, 0.4, 0.3], [0.2, 0.5, 0.3]])
        with pytest.raises(ValueError, match="shape mismatch"):
            validate_and_normalize_probabilities(probs, expected_samples=3)

    def test_rejects_negative_probabilities(self):
        probs = np.array([[0.5, -0.1, 0.6]])
        with pytest.raises(ValueError, match="contains negative values"):
            validate_and_normalize_probabilities(probs, expected_samples=1)

    def test_rejects_nan_in_probabilities(self):
        probs = np.array([[0.5, np.nan, 0.5]])
        with pytest.raises(ValueError, match="contains non-finite values"):
            validate_and_normalize_probabilities(probs, expected_samples=1)

    def test_rejects_infinity_in_probabilities(self):
        probs = np.array([[0.5, np.inf, 0.5]])
        with pytest.raises(ValueError, match="contains non-finite values"):
            validate_and_normalize_probabilities(probs, expected_samples=1)

    def test_rejects_zero_sum_row(self):
        probs = np.array([[0.0, 0.0, 0.0]])
        with pytest.raises(ValueError, match="non-positive sum"):
            validate_and_normalize_probabilities(probs, expected_samples=1)

    def test_normalizes_unnormalized_valid_probability_rows(self):
        # Probabilities that sum to 2.0 or 0.8
        probs = np.array([
            [1.0, 0.5, 0.5],  # sum = 2.0
            [0.2, 0.2, 0.4],  # sum = 0.8
        ])
        norm = validate_and_normalize_probabilities(probs, expected_samples=2)
        assert np.allclose(norm.sum(axis=1), 1.0, atol=1e-12)
        assert np.allclose(norm[0], [0.5, 0.25, 0.25])
        assert np.allclose(norm[1], [0.25, 0.25, 0.50])

    def test_epsilon_clipping_and_renormalization_in_log_loss(self):
        # Extreme probabilities: [1.0, 0.0, 0.0] with actual UP (+1)
        y_true = np.array([1])
        y_prob = np.array([[1.0, 0.0, 0.0]])

        # Without clipping, log(0) would be -inf
        eps = 1e-15
        loss = compute_multiclass_log_loss(y_true, y_prob, epsilon=eps)
        assert np.isfinite(loss)
        assert loss > 0.0


# =============================================================================
# 5. Input Validation & Edge Cases
# =============================================================================

class TestInputValidationAndEdgeCases:
    """Verifies label checking, empty arrays, missing classes, and explicit zero division."""

    def test_rejects_empty_arrays(self):
        with pytest.raises(ValueError, match="Cannot compute classification metrics on empty arrays"):
            compute_classification_metrics([], [])

    def test_rejects_length_mismatch(self):
        with pytest.raises(ValueError, match="Length mismatch"):
            compute_classification_metrics([-1, 0, 1], [-1, 0])

    def test_rejects_non_1d_labels(self):
        with pytest.raises(ValueError, match="must be 1D"):
            compute_classification_metrics([[-1, 0], [0, 1]], [[-1, 0], [0, 1]])

    def test_rejects_unapproved_labels_in_y_true(self):
        with pytest.raises(ValueError, match="Unapproved labels detected in y_true.*2"):
            compute_classification_metrics([-1, 0, 2], [-1, 0, 1])

        with pytest.raises(ValueError, match="Unapproved labels detected in y_true.*-2"):
            compute_classification_metrics([-2, 0, 1], [-1, 0, 1])

    def test_rejects_unapproved_labels_in_y_pred(self):
        with pytest.raises(ValueError, match="Unapproved labels detected in y_pred.*5"):
            compute_classification_metrics([-1, 0, 1], [-1, 0, 5])

    def test_rejects_nan_in_labels(self):
        with pytest.raises(ValueError, match="contains non-finite values"):
            compute_classification_metrics([np.nan, 0, 1], [-1, 0, 1])

    def test_single_sample_evaluation(self):
        # Exactly one sample
        res = compute_classification_metrics([-1], [-1], [[0.9, 0.05, 0.05]])
        assert res.total_samples == 1
        assert res.accuracy == 1.0
        assert res.per_class["DOWN"].support == 1
        assert res.per_class["NEUTRAL"].support == 0
        assert res.per_class["UP"].support == 0
        # Precision and recall for predicted and actual class is 1.0
        assert res.per_class["DOWN"].precision == 1.0
        assert res.per_class["DOWN"].recall == 1.0
        # Zero division for unpredicted and unobserved classes evaluates to 0.0
        assert res.per_class["NEUTRAL"].precision == 0.0
        assert res.per_class["NEUTRAL"].recall == 0.0
        assert res.per_class["UP"].precision == 0.0
        assert res.per_class["UP"].recall == 0.0
        # Balanced accuracy averages recall across present classes (only DOWN -> recall=1.0)
        assert res.balanced_accuracy == 1.0
        sk_bal = sk_metrics.balanced_accuracy_score([-1], [-1])
        assert math.isclose(res.balanced_accuracy, sk_bal, rel_tol=1e-9)
        # Macro recall averages over all 3 fixed classes [-1, 0, 1]: (1 + 0 + 0) / 3 = 1/3
        assert math.isclose(res.macro_recall, 1.0 / 3.0, rel_tol=1e-9)

    def test_missing_class_in_y_true(self):
        """When a class never appears in y_true (support=0), recall is 0.0 and no exception occurs."""
        # Class UP (+1) is missing from y_true
        y_true = np.array([-1, -1, 0, 0])
        y_pred = np.array([-1,  0, 0, 1])

        res = compute_classification_metrics(y_true, y_pred)
        assert res.per_class["UP"].support == 0
        assert res.per_class["UP"].recall == 0.0  # Zero division: 0/0 -> 0.0
        assert res.per_class["UP"].f1 == 0.0

    def test_missing_class_in_y_pred(self):
        """When a class is never predicted (TP + FP = 0), precision is 0.0 and no exception occurs."""
        # Class DOWN (-1) is never predicted by the model
        y_true = np.array([-1, 0, 1, -1])
        y_pred = np.array([ 0, 0, 1,  1])

        res = compute_classification_metrics(y_true, y_pred)
        assert res.per_class["DOWN"].precision == 0.0  # Zero division: 0/0 -> 0.0
        assert res.per_class["DOWN"].recall == 0.0

    def test_completely_incorrect_predictions(self):
        """Accuracy = 0.0, Macro F1 = 0.0, Catastrophic errors identified."""
        y_true = np.array([-1, -1, 1, 1])
        y_pred = np.array([ 1,  1,-1,-1])  # 100% catastrophic error

        res = compute_classification_metrics(y_true, y_pred)
        assert res.accuracy == 0.0
        assert res.balanced_accuracy == 0.0
        assert res.macro_precision == 0.0
        assert res.macro_recall == 0.0
        assert res.macro_f1 == 0.0
        assert res.catastrophic_error.count == 4
        assert res.catastrophic_error.rate == 1.0


# =============================================================================
# 6. MetricsEngine Class API & Multi-Horizon Verification
# =============================================================================

class TestMetricsEngineAPI:
    """Verifies the MetricsEngine class interface across horizons h1, h3, h5."""

    def test_engine_evaluates_across_horizons(self):
        engine = MetricsEngine(epsilon=1e-15)

        for h in [1, 3, 5]:
            rng = np.random.RandomState(100 + h)
            n = 150
            y_true = rng.choice([-1, 0, 1], size=n)
            y_pred = rng.choice([-1, 0, 1], size=n)
            y_prob = np.full((n, 3), 1.0 / 3.0)

            res = engine.evaluate(
                y_true=y_true,
                y_pred=y_pred,
                y_prob=y_prob,
                horizon=h,
                model_name=f"test_baseline_h{h}",
                metadata={"test_run": True},
            )

            assert res.horizon == h
            assert res.model_name == f"test_baseline_h{h}"
            assert res.total_samples == n
            assert 0.0 <= res.accuracy <= 1.0
            assert 0.0 <= res.balanced_accuracy <= 1.0
            assert 0.0 <= res.brier_score <= 2.0
            assert res.log_loss is not None and res.log_loss >= 0.0

    def test_engine_confusion_matrix_data_helper(self):
        engine = MetricsEngine()
        y_true = [-1, 0, 1, 0]
        y_pred = [-1, -1, 1, 0]
        cm_data = engine.compute_confusion_matrix_data(y_true, y_pred)

        assert isinstance(cm_data, ConfusionMatrixData)
        assert cm_data.class_order == ["DOWN", "NEUTRAL", "UP"]
        assert cm_data.class_labels == [-1, 0, 1]
        assert cm_data.matrix[0][0] == 1  # actual DOWN, pred DOWN
        assert cm_data.matrix[1][0] == 1  # actual NEUTRAL, pred DOWN
        assert cm_data.matrix[1][1] == 1  # actual NEUTRAL, pred NEUTRAL
        assert cm_data.matrix[2][2] == 1  # actual UP, pred UP


# =============================================================================
# 7. Determinism Test
# =============================================================================

class TestMetricsEngineDeterminism:
    """Verifies that 100 identical executions produce identical bit-for-bit results."""

    def test_deterministic_calculation_over_100_runs(self):
        rng = np.random.RandomState(999)
        n = 200
        y_true = rng.choice([-1, 0, 1], size=n)
        y_pred = rng.choice([-1, 0, 1], size=n)
        raw_prob = rng.uniform(0.01, 1.0, size=(n, 3))
        y_prob = raw_prob / raw_prob.sum(axis=1, keepdims=True)

        engine = MetricsEngine()
        baseline = engine.evaluate(y_true, y_pred, y_prob)

        for _ in range(100):
            current = engine.evaluate(y_true, y_pred, y_prob)
            assert current.accuracy == baseline.accuracy
            assert current.balanced_accuracy == baseline.balanced_accuracy
            assert current.macro_precision == baseline.macro_precision
            assert current.macro_recall == baseline.macro_recall
            assert current.macro_f1 == baseline.macro_f1
            assert current.log_loss == baseline.log_loss
            assert current.brier_score == baseline.brier_score
            assert current.catastrophic_error.count == baseline.catastrophic_error.count
            assert current.catastrophic_error.rate == baseline.catastrophic_error.rate
            assert current.confusion_matrix == baseline.confusion_matrix


# =============================================================================
# 8. Balanced Accuracy vs Fixed-Label Macro Recall Audit Tests
# =============================================================================

class TestBalancedAccuracyAudit:
    """
    Exhaustively audits the mathematical distinction between:
    - Balanced Accuracy: Average recall across classes actually present in y_true (support > 0).
      Matches sklearn.metrics.balanced_accuracy_score.
    - Macro Recall: Average recall across the entire fixed 3-class set [-1, 0, 1] with zero-division 0.0.
    """

    def test_all_neutral_y_true_perfect_predictions(self):
        """
        y_true = [0, 0, 0, 0]
        y_pred = [0, 0, 0, 0]
        - sklearn balanced accuracy = 1.0 (only class 0 present in y_true, recall=1.0)
        - fixed-label macro recall = 1/3 (classes -1 and +1 have zero support, recall=0.0)
        """
        y_true = [0, 0, 0, 0]
        y_pred = [0, 0, 0, 0]

        res = compute_classification_metrics(y_true, y_pred)
        sk_bal = sk_metrics.balanced_accuracy_score(y_true, y_pred)

        assert res.accuracy == 1.0
        assert math.isclose(res.balanced_accuracy, 1.0, rel_tol=1e-9)
        assert math.isclose(res.balanced_accuracy, sk_bal, rel_tol=1e-9)
        assert math.isclose(res.macro_recall, 1.0 / 3.0, rel_tol=1e-9)

        # Per-class audit
        assert res.per_class["DOWN"].support == 0
        assert res.per_class["DOWN"].recall == 0.0
        assert res.per_class["NEUTRAL"].support == 4
        assert res.per_class["NEUTRAL"].recall == 1.0
        assert res.per_class["UP"].support == 0
        assert res.per_class["UP"].recall == 0.0

    def test_all_neutral_y_true_imperfect_predictions(self):
        """
        y_true = [0, 0, 0, 0]
        y_pred = [0, 1, -1, 0]
        - NEUTRAL recall = 2/4 = 0.5
        - sklearn balanced accuracy = 0.5
        - fixed-label macro recall = 0.5 / 3 = 1/6
        """
        y_true = [0, 0, 0, 0]
        y_pred = [0, 1, -1, 0]

        res = compute_classification_metrics(y_true, y_pred)
        sk_bal = sk_metrics.balanced_accuracy_score(y_true, y_pred)

        assert res.accuracy == 0.5
        assert math.isclose(res.balanced_accuracy, 0.5, rel_tol=1e-9)
        assert math.isclose(res.balanced_accuracy, sk_bal, rel_tol=1e-9)
        assert math.isclose(res.macro_recall, 0.5 / 3.0, rel_tol=1e-9)

    def test_only_down_and_neutral_in_y_true(self):
        """
        y_true = [-1, -1, 0, 0]
        y_pred = [-1,  0, 0, 0]
        - DOWN recall = 1/2 = 0.5
        - NEUTRAL recall = 2/2 = 1.0
        - UP support = 0, recall = 0.0
        - sklearn balanced accuracy = (0.5 + 1.0) / 2 = 0.75
        - fixed-label macro recall = (0.5 + 1.0 + 0.0) / 3 = 0.50
        """
        y_true = [-1, -1, 0, 0]
        y_pred = [-1,  0, 0, 0]

        res = compute_classification_metrics(y_true, y_pred)
        sk_bal = sk_metrics.balanced_accuracy_score(y_true, y_pred)

        assert math.isclose(res.balanced_accuracy, 0.75, rel_tol=1e-9)
        assert math.isclose(res.balanced_accuracy, sk_bal, rel_tol=1e-9)
        assert math.isclose(res.macro_recall, 0.50, rel_tol=1e-9)

    def test_only_up_and_neutral_in_y_true(self):
        """
        y_true = [1, 1, 0, 0]
        y_pred = [1, 0, 0, -1]
        - UP recall = 1/2 = 0.5
        - NEUTRAL recall = 1/2 = 0.5
        - DOWN support = 0, recall = 0.0
        - sklearn balanced accuracy = (0.5 + 0.5) / 2 = 0.5
        - fixed-label macro recall = (0.0 + 0.5 + 0.5) / 3 = 1/3
        """
        y_true = [1, 1, 0, 0]
        y_pred = [1, 0, 0, -1]

        res = compute_classification_metrics(y_true, y_pred)
        sk_bal = sk_metrics.balanced_accuracy_score(y_true, y_pred)

        assert math.isclose(res.balanced_accuracy, 0.50, rel_tol=1e-9)
        assert math.isclose(res.balanced_accuracy, sk_bal, rel_tol=1e-9)
        assert math.isclose(res.macro_recall, 1.0 / 3.0, rel_tol=1e-9)

    def test_all_three_classes_present_equality(self):
        """
        When all 3 classes are present in y_true (support > 0 for all),
        Balanced Accuracy == Macro Recall.
        """
        y_true = [-1, -1, 0, 0, 1, 1]
        y_pred = [-1,  0, 0, 1, 1, 1]

        res = compute_classification_metrics(y_true, y_pred)
        sk_bal = sk_metrics.balanced_accuracy_score(y_true, y_pred)

        assert math.isclose(res.balanced_accuracy, res.macro_recall, rel_tol=1e-9)
        assert math.isclose(res.balanced_accuracy, sk_bal, rel_tol=1e-9)

    def test_class_absent_from_y_pred_but_present_in_y_true(self):
        """
        All 3 classes are present in y_true, but class DOWN (-1) is NEVER predicted in y_pred.
        - DOWN recall = 0.0 / 2 = 0.0
        - NEUTRAL recall = 1.0
        - UP recall = 1.0
        - Balanced accuracy = (0.0 + 1.0 + 1.0) / 3 = 2/3
        - Macro recall = 2/3
        - Matches sklearn balanced_accuracy_score exactly.
        """
        y_true = [-1, 0, 1, -1]
        y_pred = [ 0, 0, 1,  1]

        res = compute_classification_metrics(y_true, y_pred)
        sk_bal = sk_metrics.balanced_accuracy_score(y_true, y_pred)

        assert math.isclose(res.balanced_accuracy, 2.0 / 3.0, rel_tol=1e-9)
        assert math.isclose(res.balanced_accuracy, sk_bal, rel_tol=1e-9)
        assert math.isclose(res.macro_recall, 2.0 / 3.0, rel_tol=1e-9)
        assert res.per_class["DOWN"].precision == 0.0
        assert res.per_class["DOWN"].recall == 0.0
        assert res.per_class["DOWN"].support == 2
