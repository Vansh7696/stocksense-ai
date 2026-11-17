"""
StockSense AI — Phase 5C.4.4 Model Comparison & Selection Unit Tests
Exhaustively tests all six eligibility gates, exact boundary behaviors,
all nine candidate classifications, quarantine protections, integrity assertions,
and confirms zero model binary unpickling or training calls during comparison.
"""

import os
import sys
import copy
import json
import pytest
from unittest.mock import patch

from app.schemas.metrics import (
    ClassificationMetrics,
    ClassMetricDetail,
    CatastrophicErrorDetail,
)
from app.schemas.comparison import (
    CandidateEligibilityStatus,
    CandidateSelectionDecision,
    ProductionReadinessStatus,
)
from app.services.comparison import (
    evaluate_eligibility_gates,
    ModelComparisonService,
    ComparisonArtifactIntegrityError,
    ComparisonError,
)
from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    QUARANTINED_TEST_START_DATE,
    QuarantinedTestDataLeakageError,
)


def _create_mock_metrics(
    cat_rate: float = 0.20,
    bal_acc: float = 0.37,
    macro_f1: float = 0.35,
    down_recall: float = 0.40,
    neu_recall: float = 0.35,
    up_recall: float = 0.35,
    log_loss: float = 1.09,
    brier: float = 0.66,
    total_samples: int = 400,
) -> ClassificationMetrics:
    """Helper to construct synthetic ClassificationMetrics with controlled parameters."""
    per_class = {
        "DOWN": ClassMetricDetail(precision=0.40, recall=down_recall, f1=0.40, support=140),
        "NEUTRAL": ClassMetricDetail(precision=0.35, recall=neu_recall, f1=0.35, support=120),
        "UP": ClassMetricDetail(precision=0.40, recall=up_recall, f1=0.40, support=140),
    }
    cat_count = int(round(cat_rate * total_samples))
    cat_err = CatastrophicErrorDetail(
        count=cat_count,
        rate=cat_rate,
        down_to_up_count=cat_count // 2,
        up_to_down_count=cat_count - (cat_count // 2),
        total_samples=total_samples,
        directional_samples_count=280,
        directional_subset_rate=cat_count / 280.0,
    )
    return ClassificationMetrics(
        accuracy=0.38,
        balanced_accuracy=bal_acc,
        macro_precision=0.38,
        macro_recall=bal_acc,
        macro_f1=macro_f1,
        per_class=per_class,
        confusion_matrix=[
            [56, 42, cat_count // 2],
            [39, 42, 39],
            [cat_count - (cat_count // 2), 49, 49],
        ],
        catastrophic_error=cat_err,
        log_loss=log_loss,
        brier_score=brier,
        total_samples=total_samples,
        horizon=1,
        model_name="MockModel",
    )


# =============================================================================
# 1. Eligibility Gates Boundary Tests
# =============================================================================

def test_gate_1_catastrophic_error_rate_boundary():
    """Gate 1: <= 25.0% passes; > 25.0% fails."""
    # Exact boundary 25.0000%
    m_pass = _create_mock_metrics(cat_rate=0.250000)
    gates_pass = evaluate_eligibility_gates(m_pass)
    assert gates_pass.catastrophic_error_gate.passed is True

    # Just above 25.0001%
    m_fail = _create_mock_metrics(cat_rate=0.250001)
    gates_fail = evaluate_eligibility_gates(m_fail)
    assert gates_fail.catastrophic_error_gate.passed is False
    assert "catastrophic_error" in gates_fail.failed_gate_names
    assert gates_fail.all_passed is False


def test_gate_2_balanced_accuracy_boundary():
    """Gate 2: > 0.3333 passes; <= 0.3333 fails."""
    # Just above boundary: 0.333301 -> PASS
    m_pass = _create_mock_metrics(bal_acc=0.333301)
    gates_pass = evaluate_eligibility_gates(m_pass)
    assert gates_pass.balanced_accuracy_gate.passed is True

    # Exactly 0.333300 -> FAIL (strictly >)
    m_fail = _create_mock_metrics(bal_acc=0.333300)
    gates_fail = evaluate_eligibility_gates(m_fail)
    assert gates_fail.balanced_accuracy_gate.passed is False
    assert "balanced_accuracy" in gates_fail.failed_gate_names


def test_gate_3_macro_f1_boundary():
    """Gate 3: >= 0.2800 passes; < 0.2800 fails."""
    # Exactly 0.280000 -> PASS
    m_pass = _create_mock_metrics(macro_f1=0.280000)
    gates_pass = evaluate_eligibility_gates(m_pass)
    assert gates_pass.macro_f1_gate.passed is True

    # Just below 0.279999 -> FAIL
    m_fail = _create_mock_metrics(macro_f1=0.279999)
    gates_fail = evaluate_eligibility_gates(m_fail)
    assert gates_fail.macro_f1_gate.passed is False
    assert "macro_f1" in gates_fail.failed_gate_names


def test_gate_4_per_class_recall_boundary():
    """Gate 4: strictly > 0.0500 for each class; <= 0.0500 fails."""
    # All classes above 0.050001 -> PASS
    m_pass = _create_mock_metrics(down_recall=0.050001, neu_recall=0.050001, up_recall=0.050001)
    gates_pass = evaluate_eligibility_gates(m_pass)
    assert gates_pass.per_class_recall_gate.passed is True

    # DOWN exactly 0.050000 -> FAIL
    m_fail_down = _create_mock_metrics(down_recall=0.050000, neu_recall=0.40, up_recall=0.40)
    gates_fail_down = evaluate_eligibility_gates(m_fail_down)
    assert gates_fail_down.per_class_recall_gate.passed is False
    assert "per_class_recall" in gates_fail_down.failed_gate_names

    # NEUTRAL exactly 0.0087 (like LR h3) -> FAIL
    m_fail_neu = _create_mock_metrics(down_recall=0.40, neu_recall=0.0087, up_recall=0.40)
    gates_fail_neu = evaluate_eligibility_gates(m_fail_neu)
    assert gates_fail_neu.per_class_recall_gate.passed is False

    # UP exactly 0.049 -> FAIL
    m_fail_up = _create_mock_metrics(down_recall=0.40, neu_recall=0.40, up_recall=0.049)
    gates_fail_up = evaluate_eligibility_gates(m_fail_up)
    assert gates_fail_up.per_class_recall_gate.passed is False


def test_gate_5_log_loss_boundary():
    """Gate 5: <= 1.1500 passes; > 1.1500 fails."""
    m_pass = _create_mock_metrics(log_loss=1.150000)
    gates_pass = evaluate_eligibility_gates(m_pass)
    assert gates_pass.log_loss_gate.passed is True

    m_fail = _create_mock_metrics(log_loss=1.150001)
    gates_fail = evaluate_eligibility_gates(m_fail)
    assert gates_fail.log_loss_gate.passed is False
    assert "log_loss" in gates_fail.failed_gate_names


def test_gate_6_brier_score_boundary():
    """Gate 6: <= 0.7000 passes; > 0.7000 fails."""
    m_pass = _create_mock_metrics(brier=0.700000)
    gates_pass = evaluate_eligibility_gates(m_pass)
    assert gates_pass.brier_score_gate.passed is True

    m_fail = _create_mock_metrics(brier=0.700001)
    gates_fail = evaluate_eligibility_gates(m_fail)
    assert gates_fail.brier_score_gate.passed is False
    assert "brier_score" in gates_fail.failed_gate_names


def test_missing_probabilistic_metrics():
    """Gates 5 and 6 fail safely if log_loss or brier_score is None."""
    m = _create_mock_metrics()
    m_dict = m.model_dump()
    m_dict["log_loss"] = None
    m_dict["brier_score"] = None
    m_missing = ClassificationMetrics(**m_dict)

    gates = evaluate_eligibility_gates(m_missing)
    assert gates.log_loss_gate.passed is False
    assert gates.brier_score_gate.passed is False
    assert gates.all_passed is False


# =============================================================================
# 2. All Nine Real Candidate Classifications
# =============================================================================

def test_all_nine_actual_candidate_classifications():
    """
    Verifies that ModelComparisonService accurately loads and evaluates
    all 9 registered models against the approved audit decisions.
    """
    svc = ModelComparisonService()
    report = svc.generate_full_comparison_report(report_id="test_classification_audit")

    expected_results = {
        (1, "logistic_regression"): {
            "eligibility": CandidateEligibilityStatus.ELIGIBLE,
            "decision": CandidateSelectionDecision.HISTORICAL_BENCHMARK,
            "is_preferred": False,
            "is_benchmark": True,
            "failed_count": 0,
        },
        (1, "random_forest"): {
            "eligibility": CandidateEligibilityStatus.INELIGIBLE,
            "decision": CandidateSelectionDecision.REJECTED,
            "is_preferred": False,
            "is_benchmark": True,
            "failed_count": 1,  # catastrophic_error (26.50%)
        },
        (1, "xgboost"): {
            "eligibility": CandidateEligibilityStatus.ELIGIBLE,
            "decision": CandidateSelectionDecision.PREFERRED_RESEARCH_CANDIDATE,
            "is_preferred": True,
            "is_benchmark": False,
            "failed_count": 0,
        },
        (3, "logistic_regression"): {
            "eligibility": CandidateEligibilityStatus.INELIGIBLE,
            "decision": CandidateSelectionDecision.REJECTED,
            "is_preferred": False,
            "is_benchmark": True,
            "failed_count": 2,  # catastrophic (31.79%) and NEU recall (0.87%)
        },
        (3, "random_forest"): {
            "eligibility": CandidateEligibilityStatus.INELIGIBLE,
            "decision": CandidateSelectionDecision.REJECTED,
            "is_preferred": False,
            "is_benchmark": True,
            "failed_count": 1,  # catastrophic (31.54%)
        },
        (3, "xgboost"): {
            "eligibility": CandidateEligibilityStatus.ELIGIBLE,
            "decision": CandidateSelectionDecision.PREFERRED_RESEARCH_CANDIDATE,
            "is_preferred": True,
            "is_benchmark": False,
            "failed_count": 0,
        },
        (5, "logistic_regression"): {
            "eligibility": CandidateEligibilityStatus.INELIGIBLE,
            "decision": CandidateSelectionDecision.REJECTED,
            "is_preferred": False,
            "is_benchmark": True,
            "failed_count": 2,  # catastrophic (31.05%) and NEU recall (1.61%)
        },
        (5, "random_forest"): {
            "eligibility": CandidateEligibilityStatus.ELIGIBLE,
            "decision": CandidateSelectionDecision.PREFERRED_RESEARCH_CANDIDATE,
            "is_preferred": True,
            "is_benchmark": False,
            "failed_count": 0,
        },
        (5, "xgboost"): {
            "eligibility": CandidateEligibilityStatus.INELIGIBLE,
            "decision": CandidateSelectionDecision.REJECTED,
            "is_preferred": False,
            "is_benchmark": True,
            "failed_count": 1,  # DOWN recall (2.76%)
        },
    }

    for h in [1, 3, 5]:
        summary = report.horizons[h]
        for c in summary.candidates:
            key = (h, c.model_family)
            exp = expected_results[key]
            assert c.eligibility_status == exp["eligibility"], f"Failed eligibility for {key}"
            assert c.selection_decision == exp["decision"], f"Failed decision for {key}"
            assert c.is_preferred_research_candidate == exp["is_preferred"], f"Failed is_preferred for {key}"
            assert c.is_historical_benchmark == exp["is_benchmark"], f"Failed is_benchmark for {key}"
            assert len(c.failed_criteria) == exp["failed_count"], f"Failed criteria count for {key}"
            assert c.production_readiness == ProductionReadinessStatus.PROHIBITED


def test_preferred_candidate_selection_per_horizon():
    """Checks that the selected preferred candidate for each horizon matches the audit."""
    svc = ModelComparisonService()
    report = svc.generate_full_comparison_report()

    # h1 preferred is XGBoost #147
    h1_summary = report.horizons[1]
    assert h1_summary.preferred_candidate_family == "xgboost"
    assert "xgboost_h1" in h1_summary.preferred_candidate_id

    # h3 preferred is XGBoost #121
    h3_summary = report.horizons[3]
    assert h3_summary.preferred_candidate_family == "xgboost"
    assert "xgboost_h3" in h3_summary.preferred_candidate_id

    # h5 preferred is Random Forest #33
    h5_summary = report.horizons[5]
    assert h5_summary.preferred_candidate_family == "random_forest"
    assert "random_forest_h5" in h5_summary.preferred_candidate_id


# =============================================================================
# 3. Class Ordering & Confusion Matrix Reconciliation Tests
# =============================================================================

def test_class_ordering_and_distribution_reconciliation():
    """
    Verifies that class ordering is strictly DOWN, NEUTRAL, UP,
    and actual/predicted distributions match confusion matrix row/column sums.
    """
    svc = ModelComparisonService()
    report = svc.generate_full_comparison_report()

    for h, summary in report.horizons.items():
        for c in summary.candidates:
            m = c.metrics
            cm = m.confusion_matrix
            assert len(cm) == 3 and all(len(row) == 3 for row in cm)

            # Actual distribution matches row sums
            assert c.actual_distribution["DOWN"] == sum(cm[0])
            assert c.actual_distribution["NEUTRAL"] == sum(cm[1])
            assert c.actual_distribution["UP"] == sum(cm[2])
            assert sum(c.actual_distribution.values()) == c.metrics.total_samples

            # Predicted distribution matches column sums
            assert c.predicted_distribution["DOWN"] == cm[0][0] + cm[1][0] + cm[2][0]
            assert c.predicted_distribution["NEUTRAL"] == cm[0][1] + cm[1][1] + cm[2][1]
            assert c.predicted_distribution["UP"] == cm[0][2] + cm[1][2] + cm[2][2]
            assert sum(c.predicted_distribution.values()) == c.metrics.total_samples

            # Catastrophic error count is cm[0][2] + cm[2][0]
            expected_cat_count = cm[0][2] + cm[2][0]
            assert c.catastrophic_error_count == expected_cat_count
            assert abs(c.catastrophic_error_rate_total - (expected_cat_count / c.metrics.total_samples)) < 1e-6


# =============================================================================
# 4. Quarantine and Date Enforcement Tests
# =============================================================================

def test_quarantined_test_partition_leakage_rejection():
    """
    Asserts that validate_validation_date_restrictions strictly raises
    QuarantinedTestDataLeakageError on any date >= 2026-07-14.
    """
    svc = ModelComparisonService()

    # Valid validation dates pass
    valid_dates = ["2026-03-12", "2026-05-01", "2026-07-13"]
    svc.validate_validation_date_restrictions(valid_dates)

    # Date on test boundary fails
    with pytest.raises(QuarantinedTestDataLeakageError, match="CRITICAL TEST LEAKAGE"):
        svc.validate_validation_date_restrictions(["2026-03-12", "2026-07-14"])

    # Date deep in test partition fails
    with pytest.raises(QuarantinedTestDataLeakageError, match="CRITICAL TEST LEAKAGE"):
        svc.validate_validation_date_restrictions(["2026-11-09"])


# =============================================================================
# 5. Integrity and Mismatch Rejection Tests
# =============================================================================

def test_artifact_hash_mismatch_rejection(tmp_path):
    """Corrupted artifact binary hash is detected and raises ComparisonArtifactIntegrityError."""
    temp_dir = tmp_path / "logistic_regression_h1_v1.0.0"
    temp_dir.mkdir()
    art_path = temp_dir / "model.joblib"
    art_path.write_bytes(b"corrupted binary data")

    meta_file = temp_dir / "metadata.json"
    meta_content = {
        "model_id": "corrupted_h1",
        "model_name": "CorruptedModel",
        "version": "1.0.0",
        "horizon": 1,
        "feature_names": list(APPROVED_FEATURE_ALLOWLIST),
        "artifact_filename": "model.joblib",
        "artifact_sha256": "expected_hash_does_not_match_actual_bytes",
    }
    meta_file.write_text(json.dumps(meta_content))

    svc_temp = ModelComparisonService(registry_base_dir=str(tmp_path))
    with pytest.raises(ComparisonArtifactIntegrityError, match="SHA-256 hash mismatch"):
        svc_temp.load_candidate_metadata(horizon=1, model_family="logistic_regression")


def test_horizon_mismatch_rejection(tmp_path):
    """Metadata with mismatched horizon raises ComparisonArtifactIntegrityError."""
    temp_dir = tmp_path / "logistic_regression_h1_v1.0.0"
    temp_dir.mkdir()
    meta_file = temp_dir / "metadata.json"
    meta_content = {
        "model_id": "test_h1",
        "horizon": 3,  # Mismatched horizon
        "feature_names": list(APPROVED_FEATURE_ALLOWLIST),
    }
    meta_file.write_text(json.dumps(meta_content))

    svc_temp = ModelComparisonService(registry_base_dir=str(tmp_path))
    with pytest.raises(ComparisonArtifactIntegrityError, match="Horizon mismatch"):
        svc_temp.load_candidate_metadata(horizon=1, model_family="logistic_regression", verify_artifact_hash=False)


def test_feature_allowlist_mismatch_rejection(tmp_path):
    """Metadata with missing feature raises ComparisonArtifactIntegrityError."""
    temp_dir = tmp_path / "logistic_regression_h1_v1.0.0"
    temp_dir.mkdir()
    meta_file = temp_dir / "metadata.json"
    meta_content = {
        "model_id": "test_h1",
        "horizon": 1,
        "feature_names": ["price_to_sma20", "rsi_14"],  # Incomplete feature list
    }
    meta_file.write_text(json.dumps(meta_content))

    svc_temp = ModelComparisonService(registry_base_dir=str(tmp_path))
    with pytest.raises(ComparisonArtifactIntegrityError, match="Feature allowlist mismatch"):
        svc_temp.load_candidate_metadata(horizon=1, model_family="logistic_regression", verify_artifact_hash=False)


# =============================================================================
# 6. Safeguard: Zero Model Binary Unpickling / Training Calls
# =============================================================================

def test_no_model_binary_unpickling_or_loading():
    """
    Verifies that ModelComparisonService never calls joblib.load or pickle.load.
    The comparison must be entirely sidecar-driven.
    """
    svc = ModelComparisonService()

    with patch("joblib.load") as mock_joblib_load, patch("pickle.load") as mock_pickle_load:
        report = svc.generate_full_comparison_report()
        assert mock_joblib_load.call_count == 0, "joblib.load was called during comparison!"
        assert mock_pickle_load.call_count == 0, "pickle.load was called during comparison!"
        assert len(report.horizons) == 3


def test_deterministic_report_generation():
    """
    Verifies that running comparison twice yields identical metrics and decisions.
    """
    svc = ModelComparisonService()
    rep1 = svc.generate_full_comparison_report(report_id="rep_det_1")
    rep2 = svc.generate_full_comparison_report(report_id="rep_det_2")

    for h in [1, 3, 5]:
        assert rep1.horizons[h].preferred_candidate_id == rep2.horizons[h].preferred_candidate_id
        for c1, c2 in zip(rep1.horizons[h].candidates, rep2.horizons[h].candidates):
            assert c1.model_id == c2.model_id
            assert c1.eligibility_status == c2.eligibility_status
            assert c1.selection_decision == c2.selection_decision
            assert c1.metrics.macro_f1 == c2.metrics.macro_f1
            assert c1.catastrophic_error_count == c2.catastrophic_error_count
