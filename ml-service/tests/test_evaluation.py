"""
StockSense AI — Model Evaluation Test Suite
Validates the evaluation guard state machine, pre-evaluation gate verification,
re-evaluation prevention, baseline comparison consistency, and controlled held-out test evaluation.
"""

import os
import json
import math
import shutil
import tempfile
import pytest
import numpy as np
import pandas as pd

from app.schemas.evaluation import (
    EvaluationLifecycleState,
    EvaluationGuardRecord,
    BaselineComparisonRecord,
    HorizonEvaluationRecord,
    FinalTestEvaluationReport,
    EvaluationIntegrityManifest,
)
from app.schemas.registry import ModelStatus
from app.services.evaluation import (
    EvaluationGuard,
    EvaluationError,
    EvaluationPreGateFailedError,
    EvaluationAlreadyCompletedError,
    ConcurrentEvaluationError,
    execute_controlled_test_evaluation,
    create_detached_integrity_manifest,
    verify_detached_integrity_manifest,
    EXPECTED_CANONICAL_DATASET_SHA256,
)
from app.services.registry import ModelRegistry, register_selected_logistic_regression_models


# =============================================================================
# 1. Evaluation Guard State Machine Tests
# =============================================================================

class TestEvaluationGuard:
    def test_guard_lifecycle_transitions(self, tmp_path):
        """Verifies clean transitions: NOT_EVALUATED -> IN_PROGRESS -> EVALUATED."""
        guard = EvaluationGuard(
            experiment_id="test_exp_001",
            evaluations_dir=str(tmp_path),
            dataset_sha256="test_sha256",
            model_ids=["model_1"],
            model_artifact_hashes={"model_1": "hash_1"},
        )

        assert guard.read_record() is None

        # Start evaluation
        rec_start = guard.start()
        assert rec_start.state == EvaluationLifecycleState.EVALUATION_IN_PROGRESS
        assert rec_start.started_at_utc is not None
        assert rec_start.completed_at_utc is None

        # Create dummy report file to finalize
        report_file = os.path.join(guard.exp_dir, "test_report.json")
        with open(report_file, "w") as f:
            f.write("{}")

        # Finalize evaluation
        rec_final = guard.finalize(report_path=report_file, report_sha256="dummy_sha")
        assert rec_final.state == EvaluationLifecycleState.EVALUATED
        assert rec_final.completed_at_utc is not None
        assert rec_final.results_artifact_path == report_file

        # Verify persisted state on disk
        persisted = guard.read_record()
        assert persisted.state == EvaluationLifecycleState.EVALUATED

    def test_re_evaluation_of_finalized_experiment_fails_closed(self, tmp_path):
        """Verifies that start() fails closed if the experiment was already evaluated."""
        guard = EvaluationGuard(
            experiment_id="test_exp_002",
            evaluations_dir=str(tmp_path),
            dataset_sha256="test_sha256",
            model_ids=["model_1"],
            model_artifact_hashes={"model_1": "hash_1"},
        )
        guard.start()

        report_file = os.path.join(guard.exp_dir, "test_report.json")
        with open(report_file, "w") as f:
            f.write("{}")
        guard.finalize(report_path=report_file, report_sha256="dummy_sha")

        # Second start call raises EvaluationAlreadyCompletedError
        with pytest.raises(EvaluationAlreadyCompletedError, match="has already been finalized"):
            guard.start()

    def test_concurrent_evaluation_attempt_fails_closed(self, tmp_path):
        """Verifies that calling start() while IN_PROGRESS raises ConcurrentEvaluationError."""
        guard = EvaluationGuard(
            experiment_id="test_exp_003",
            evaluations_dir=str(tmp_path),
            dataset_sha256="test_sha256",
            model_ids=["model_1"],
            model_artifact_hashes={"model_1": "hash_1"},
        )
        guard.start()

        # Second start call while in progress raises ConcurrentEvaluationError
        with pytest.raises(ConcurrentEvaluationError, match="is already in progress"):
            guard.start()

    def test_failure_recording(self, tmp_path):
        """Verifies that recording failure marks state as EVALUATION_FAILED."""
        guard = EvaluationGuard(
            experiment_id="test_exp_004",
            evaluations_dir=str(tmp_path),
            dataset_sha256="test_sha256",
            model_ids=["model_1"],
            model_artifact_hashes={"model_1": "hash_1"},
        )
        guard.start()
        rec_fail = guard.record_failure("Simulated CUDA/CPU crash")

        assert rec_fail.state == EvaluationLifecycleState.EVALUATION_FAILED
        assert rec_fail.error_message == "Simulated CUDA/CPU crash"

        persisted = guard.read_record()
        assert persisted.state == EvaluationLifecycleState.EVALUATION_FAILED


# =============================================================================
# 2. Pre-Evaluation Gate Tests
# =============================================================================

class TestPreEvaluationGate:
    def test_pre_gate_rejects_missing_dataset(self, tmp_path):
        """Verifies that missing canonical dataset stops evaluation immediately."""
        with pytest.raises(EvaluationPreGateFailedError, match="Canonical dataset fixture not found"):
            execute_controlled_test_evaluation(
                registry_dir=str(tmp_path),
                dataset_path="/nonexistent/dataset.json",
                evaluations_dir=str(tmp_path / "evals"),
                experiment_id="gate_test_missing_ds",
            )

    def test_pre_gate_rejects_corrupted_model_artifact(self, tmp_path):
        """Verifies that a tampered model artifact stops evaluation before scoring."""
        reg_dir = tmp_path / "corrupted_reg"
        register_selected_logistic_regression_models(registry_dir=str(reg_dir), overwrite=True)

        # Corrupt h1 artifact
        h1_joblib = reg_dir / "logistic_regression_h1_v1.0.0" / "model.joblib"
        with open(h1_joblib, "rb") as f:
            data = bytearray(f.read())
        data[-1] = (data[-1] + 1) % 256
        with open(h1_joblib, "wb") as f:
            f.write(data)

        with pytest.raises(EvaluationPreGateFailedError, match="Cryptographic artifact verification failed"):
            execute_controlled_test_evaluation(
                registry_dir=str(reg_dir),
                evaluations_dir=str(tmp_path / "evals"),
                experiment_id="gate_test_tampered_model",
            )


# =============================================================================
# 3. Controlled Final Test Evaluation Execution Tests
# =============================================================================

@pytest.fixture(scope="module")
def executed_evaluation(tmp_path_factory):
    """Executes the controlled final test evaluation across all three horizons."""
    base_dir = tmp_path_factory.mktemp("full_evaluation")
    reg_dir = base_dir / "registry"
    evals_dir = base_dir / "evaluations"

    # Register the models
    register_selected_logistic_regression_models(registry_dir=str(reg_dir), overwrite=True)

    exp_id = "test_eval_campaign_final"
    report = execute_controlled_test_evaluation(
        registry_dir=str(reg_dir),
        evaluations_dir=str(evals_dir),
        experiment_id=exp_id,
        force_reset=True,
    )

    return report, str(reg_dir), str(evals_dir), exp_id


class TestControlledEvaluationPipeline:
    def test_all_three_horizons_evaluated(self, executed_evaluation):
        """Verifies that horizons h1, h3, and h5 were all evaluated."""
        report, _, _, _ = executed_evaluation
        assert set(report.horizons.keys()) == {1, 3, 5}

    def test_test_observation_counts(self, executed_evaluation):
        """Verifies exact test sample counts: h1=410, h3=400, h5=390."""
        report, _, _, _ = executed_evaluation
        assert report.horizons[1].test_samples == 410
        assert report.horizons[3].test_samples == 400
        assert report.horizons[5].test_samples == 390

    def test_test_metrics_completeness(self, executed_evaluation):
        """Verifies all required classification metrics and confusion matrix structure."""
        report, _, _, _ = executed_evaluation

        for h in [1, 3, 5]:
            h_rec = report.horizons[h]
            tm = h_rec.test_metrics

            assert 0.0 <= tm.accuracy <= 1.0
            assert 0.0 <= tm.balanced_accuracy <= 1.0
            assert 0.0 <= tm.macro_precision <= 1.0
            assert 0.0 <= tm.macro_recall <= 1.0
            assert 0.0 <= tm.macro_f1 <= 1.0
            assert tm.log_loss is not None and tm.log_loss > 0.0
            assert tm.brier_score is not None and tm.brier_score > 0.0
            assert 0.0 <= tm.catastrophic_error.rate <= 1.0

            # Confusion matrix is 3x3
            assert len(tm.confusion_matrix) == 3
            assert all(len(row) == 3 for row in tm.confusion_matrix)
            assert sum(sum(row) for row in tm.confusion_matrix) == h_rec.test_samples

            # Per class detail has DOWN, NEUTRAL, UP
            assert set(tm.per_class.keys()) == {"DOWN", "NEUTRAL", "UP"}
            assert sum(c.support for c in tm.per_class.values()) == h_rec.test_samples

    def test_baseline_comparisons_present(self, executed_evaluation):
        """Verifies that Majority and Momentum baseline comparisons are recorded."""
        report, _, _, _ = executed_evaluation

        for h in [1, 3, 5]:
            h_rec = report.horizons[h]
            assert "majority" in h_rec.baseline_comparisons
            assert "momentum" in h_rec.baseline_comparisons

            maj_comp = h_rec.baseline_comparisons["majority"]
            mom_comp = h_rec.baseline_comparisons["momentum"]

            assert maj_comp.baseline_name == "MajorityClassifier"
            assert mom_comp.baseline_name == "MomentumBaseline"

            # Both baselines evaluated on the exact same test sample count
            assert maj_comp.metrics.total_samples == h_rec.test_samples
            assert mom_comp.metrics.total_samples == h_rec.test_samples

    def test_generalization_deltas_recorded(self, executed_evaluation):
        """Verifies generalization gap deltas between test and validation."""
        report, _, _, _ = executed_evaluation

        for h in [1, 3, 5]:
            h_rec = report.horizons[h]
            assert "balanced_accuracy_delta" in h_rec.generalization_delta
            assert "macro_f1_delta" in h_rec.generalization_delta
            assert "log_loss_delta" in h_rec.generalization_delta

            expected_bal_acc_delta = h_rec.test_metrics.balanced_accuracy - h_rec.validation_metrics.balanced_accuracy
            assert math.isclose(h_rec.generalization_delta["balanced_accuracy_delta"], expected_bal_acc_delta, abs_tol=1e-12)

    def test_guard_state_is_evaluated(self, executed_evaluation):
        """Verifies guard finalized state."""
        report, _, _, _ = executed_evaluation
        assert report.evaluation_guard.state == EvaluationLifecycleState.EVALUATED
        assert report.evaluation_guard.completed_at_utc is not None
        assert report.evaluation_guard.results_artifact_path is not None
        assert report.evaluation_guard.results_artifact_sha256 is not None

    def test_registry_metadata_status_updated_to_test_evaluated(self, executed_evaluation):
        """Verifies that model status transitioned to TEST_EVALUATED (and NOT PRODUCTION_READY)."""
        _, reg_dir, _, _ = executed_evaluation
        registry = ModelRegistry(registry_dir=reg_dir)

        for h in [1, 3, 5]:
            meta = registry.get_metadata(f"logistic_regression_h{h}_v1.0.0")
            assert meta.status == ModelStatus.TEST_EVALUATED
            assert meta.status != ModelStatus.PRODUCTION_READY

    def test_re_evaluation_fails_closed(self, executed_evaluation):
        """Verifies that executing evaluation again with the same experiment ID raises error."""
        _, reg_dir, evals_dir, exp_id = executed_evaluation

        with pytest.raises(EvaluationAlreadyCompletedError):
            execute_controlled_test_evaluation(
                registry_dir=reg_dir,
                evaluations_dir=evals_dir,
                experiment_id=exp_id,
                force_reset=False,
            )

    def test_detached_integrity_manifest_creation_and_verification(self, executed_evaluation):
        """Verifies creation and verification of detached integrity manifest without modifying artifacts."""
        report, reg_dir, evals_dir, exp_id = executed_evaluation
        manifest = create_detached_integrity_manifest(
            experiment_id=exp_id,
            evaluations_dir=evals_dir,
            registry_dir=reg_dir,
        )
        assert manifest.experiment_id == exp_id
        assert manifest.status == "VALID_IMMUTABLE"
        assert manifest.evaluation_report.final_artifact_sha256 is not None
        assert manifest.guard.state == EvaluationLifecycleState.EVALUATED
        assert manifest.evaluation_report.pre_finalization_sha256 == manifest.guard.recorded_pre_finalization_digest

        # Verification against disk artifacts
        assert verify_detached_integrity_manifest(
            experiment_id=exp_id,
            evaluations_dir=evals_dir,
            registry_dir=reg_dir,
        ) is True

    def test_detached_manifest_detects_report_tampering(self, executed_evaluation, tmp_path):
        """Verifies that modifying evaluation_report.json causes verification failure."""
        report, reg_dir, evals_dir, exp_id = executed_evaluation
        create_detached_integrity_manifest(
            experiment_id=exp_id,
            evaluations_dir=evals_dir,
            registry_dir=reg_dir,
        )

        report_path = os.path.join(evals_dir, exp_id, "evaluation_report.json")
        with open(report_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["tampered"] = True
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(data, f)

        with pytest.raises(EvaluationError, match="Report SHA-256 mismatch"):
            verify_detached_integrity_manifest(
                experiment_id=exp_id,
                evaluations_dir=evals_dir,
                registry_dir=reg_dir,
            )
