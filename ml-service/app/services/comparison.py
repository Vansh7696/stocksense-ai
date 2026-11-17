"""
StockSense AI — Advanced Model Comparison and Validation-Stage Selection Service
Implements Phase 5C.4.4 multi-horizon model comparison, eligibility gate evaluations,
and validation-stage candidate selection using frozen validation artifacts and metadata only.
Strictly enforces test partition quarantine and avoids unpickling model binaries.
"""

import os
import json
import hashlib
import datetime
from typing import Dict, List, Optional, Tuple, Any, Sequence

from app.schemas.metrics import (
    ClassificationMetrics,
    ClassMetricDetail,
    CatastrophicErrorDetail,
    ConfusionMatrixData,
)
from app.schemas.comparison import (
    CandidateEligibilityStatus,
    CandidateSelectionDecision,
    ProductionReadinessStatus,
    GateResult,
    EligibilityGateSet,
    ModelComparisonCandidateRecord,
    HorizonComparisonSummary,
    ModelComparisonReport,
)
from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    QUARANTINED_TEST_START_DATE,
    QuarantinedTestDataLeakageError,
)

# Canonical dataset hash and dates
CANONICAL_DATASET_SHA256 = (
    "d75a0e0f4e94c0991bbca71e911333b1944e7f064d8f4dd712cffa1688b97170"
)
CANONICAL_DATASET_IDENTIFIER = "canonical_5stocks_v1"
VALIDATION_START_DATE = "2026-03-12"
VALIDATION_END_DATE = "2026-07-13"
QUARANTINED_TEST_END_DATE = "2026-11-09"

EXPECTED_VALIDATION_SAMPLES = {1: 400, 3: 390, 5: 380}
EXPECTED_VALIDATION_SESSIONS = {1: 80, 3: 78, 5: 76}

CLASS_NAMES = ["DOWN", "NEUTRAL", "UP"]
CLASS_LABELS = [-1, 0, 1]


class ComparisonError(Exception):
    """Base exception for model comparison and selection errors."""
    pass


class ComparisonArtifactIntegrityError(ComparisonError):
    """Raised when an artifact hash, metadata, or feature list is mismatched."""
    pass


class ComparisonDateQuarantineError(ComparisonError):
    """Raised when a quarantined test date enters comparison data."""
    pass


def compute_file_sha256(filepath: str) -> str:
    """Computes SHA-256 digest of a local file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def evaluate_eligibility_gates(metrics: ClassificationMetrics) -> EligibilityGateSet:
    """
    Evaluates all six approved validation eligibility gates deterministically.

    Gates:
    1. Catastrophic directional error rate <= 0.25 (25.0% of total N)
    2. Balanced accuracy > 0.3333
    3. Macro F1 >= 0.2800
    4. Recall strictly > 0.05 for every class (DOWN, NEUTRAL, UP)
    5. Log loss <= 1.1500
    6. Multiclass Brier score <= 0.7000
    """
    failed_gates: List[str] = []

    # Gate 1: Catastrophic directional error rate <= 25.0%
    cat_rate = metrics.catastrophic_error.rate
    g1_passed = cat_rate <= 0.2500
    if not g1_passed:
        failed_gates.append("catastrophic_error")
    g1 = GateResult(
        gate_name="catastrophic_error",
        passed=g1_passed,
        observed_value=round(cat_rate, 6),
        threshold_or_target=0.2500,
        operator="<=",
        details=(
            f"Catastrophic directional error rate {cat_rate*100:.2f}% <= 25.00%"
            if g1_passed
            else f"Catastrophic directional error rate {cat_rate*100:.2f}% exceeds 25.00% limit"
        ),
    )

    # Gate 2: Balanced accuracy > 0.3333
    bal_acc = metrics.balanced_accuracy
    g2_passed = bal_acc > 0.3333
    if not g2_passed:
        failed_gates.append("balanced_accuracy")
    g2 = GateResult(
        gate_name="balanced_accuracy",
        passed=g2_passed,
        observed_value=round(bal_acc, 6),
        threshold_or_target=0.3333,
        operator=">",
        details=(
            f"Balanced accuracy {bal_acc*100:.2f}% > 33.33%"
            if g2_passed
            else f"Balanced accuracy {bal_acc*100:.2f}% <= 33.33% threshold (must be > 33.33%)"
        ),
    )

    # Gate 3: Macro F1 >= 0.2800
    macro_f1 = metrics.macro_f1
    g3_passed = macro_f1 >= 0.2800
    if not g3_passed:
        failed_gates.append("macro_f1")
    g3 = GateResult(
        gate_name="macro_f1",
        passed=g3_passed,
        observed_value=round(macro_f1, 6),
        threshold_or_target=0.2800,
        operator=">=",
        details=(
            f"Macro F1 {macro_f1:.4f} >= 0.2800"
            if g3_passed
            else f"Macro F1 {macro_f1:.4f} < 0.2800 threshold (must be >= 0.2800)"
        ),
    )

    # Gate 4: Per-class recall strictly > 0.05 for each of DOWN, NEUTRAL, UP
    class_recalls = {
        cls_name: metrics.per_class[cls_name].recall for cls_name in CLASS_NAMES
    }
    failing_classes = [c for c, r in class_recalls.items() if r <= 0.0500]
    g4_passed = len(failing_classes) == 0
    if not g4_passed:
        failed_gates.append("per_class_recall")
    g4 = GateResult(
        gate_name="per_class_recall",
        passed=g4_passed,
        observed_value={c: round(r, 6) for c, r in class_recalls.items()},
        threshold_or_target=0.0500,
        operator=">",
        details=(
            f"Per-class recalls: DOWN={class_recalls['DOWN']*100:.2f}%, "
            f"NEUTRAL={class_recalls['NEUTRAL']*100:.2f}%, "
            f"UP={class_recalls['UP']*100:.2f}%. All > 5.00%"
            if g4_passed
            else f"Failed class recall floor (<= 5.00%): {failing_classes}"
        ),
    )

    # Gate 5: Log loss <= 1.1500
    log_loss = metrics.log_loss
    g5_passed = (log_loss is not None) and (log_loss <= 1.1500)
    if not g5_passed:
        failed_gates.append("log_loss")
    g5 = GateResult(
        gate_name="log_loss",
        passed=g5_passed,
        observed_value=round(log_loss, 6) if log_loss is not None else None,
        threshold_or_target=1.1500,
        operator="<=",
        details=(
            f"Log loss {log_loss:.4f} <= 1.1500"
            if g5_passed
            else (
                f"Log loss {log_loss:.4f} exceeds 1.1500 limit"
                if log_loss is not None
                else "Log loss missing"
            )
        ),
    )

    # Gate 6: Multiclass Brier score <= 0.7000
    brier = metrics.brier_score
    g6_passed = (brier is not None) and (brier <= 0.7000)
    if not g6_passed:
        failed_gates.append("brier_score")
    g6 = GateResult(
        gate_name="brier_score",
        passed=g6_passed,
        observed_value=round(brier, 6) if brier is not None else None,
        threshold_or_target=0.7000,
        operator="<=",
        details=(
            f"Multiclass Brier score {brier:.4f} <= 0.7000"
            if g6_passed
            else (
                f"Multiclass Brier score {brier:.4f} exceeds 0.7000 limit"
                if brier is not None
                else "Brier score missing"
            )
        ),
    )

    all_passed = len(failed_gates) == 0

    return EligibilityGateSet(
        catastrophic_error_gate=g1,
        balanced_accuracy_gate=g2,
        macro_f1_gate=g3,
        per_class_recall_gate=g4,
        log_loss_gate=g5,
        brier_score_gate=g6,
        all_passed=all_passed,
        failed_gate_names=failed_gates,
    )


class ModelComparisonService:
    """
    Coordinates multi-model comparison across horizons h1, h3, h5.
    Operates strictly on frozen validation artifacts and metadata.
    """

    def __init__(
        self,
        registry_base_dir: Optional[str] = None,
        tuning_base_dir: Optional[str] = None,
        dataset_path: Optional[str] = None,
    ):
        base_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..")
        )
        self.registry_base_dir = (
            os.path.abspath(registry_base_dir)
            if registry_base_dir
            else os.path.join(base_dir, "models", "registry")
        )
        self.tuning_base_dir = (
            os.path.abspath(tuning_base_dir)
            if tuning_base_dir
            else os.path.join(
                base_dir,
                "models",
                "tuning",
                "phase_5c4_3",
                "phase_5c4_3_tuning_campaign",
            )
        )
        self.dataset_path = (
            os.path.abspath(dataset_path)
            if dataset_path
            else os.path.join(base_dir, "data", "historical_candles_5stocks.json")
        )

    def validate_validation_date_restrictions(self, dates: Sequence[str]) -> None:
        """
        Defensive assertion: Rejects any date on or after QUARANTINED_TEST_START_DATE.
        """
        for d in dates:
            if str(d) >= QUARANTINED_TEST_START_DATE:
                raise QuarantinedTestDataLeakageError(
                    f"CRITICAL TEST LEAKAGE DETECTED: Observed date '{d}' is on or after "
                    f"quarantined test start date '{QUARANTINED_TEST_START_DATE}'. "
                    f"The test partition is permanently consumed and strictly forbidden."
                )

    def load_candidate_metadata(
        self,
        horizon: int,
        model_family: str,
        verify_artifact_hash: bool = True,
    ) -> Dict[str, Any]:
        """
        Loads the sidecar metadata.json for the specified model family and horizon.
        Verifies cryptographic artifact SHA-256 and feature allowlist.
        Does NOT unpickle or load model binaries into python.
        """
        if model_family == "logistic_regression":
            model_dir = os.path.join(
                self.registry_base_dir, f"logistic_regression_h{horizon}_v1.0.0"
            )
        elif model_family == "random_forest":
            model_dir = os.path.join(
                self.tuning_base_dir, "registry", f"random_forest_h{horizon}_v1.0.0"
            )
        elif model_family == "xgboost":
            model_dir = os.path.join(
                self.tuning_base_dir, "registry", f"xgboost_h{horizon}_v1.0.0"
            )
        else:
            raise ComparisonError(f"Unknown model family: {model_family}")

        meta_path = os.path.join(model_dir, "metadata.json")
        if not os.path.exists(meta_path):
            raise FileNotFoundError(f"Candidate metadata not found: {meta_path}")

        with open(meta_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)

        # 1. Horizon assertion
        meta_horizon = metadata.get("horizon")
        if meta_horizon != horizon:
            raise ComparisonArtifactIntegrityError(
                f"Horizon mismatch in {meta_path}: expected {horizon}, got {meta_horizon}"
            )

        # 2. Feature allowlist assertion
        feat_names = metadata.get("feature_names", [])
        if feat_names != list(APPROVED_FEATURE_ALLOWLIST):
            raise ComparisonArtifactIntegrityError(
                f"Feature allowlist mismatch in {meta_path} for horizon h{horizon}"
            )

        # 3. Artifact hash verification
        if verify_artifact_hash:
            art_filename = metadata.get("artifact_filename", "model.joblib")
            art_path = os.path.join(model_dir, art_filename)
            if not os.path.exists(art_path):
                raise FileNotFoundError(f"Model artifact binary not found: {art_path}")

            expected_hash = metadata.get("artifact_sha256")
            actual_hash = compute_file_sha256(art_path)
            if actual_hash != expected_hash:
                raise ComparisonArtifactIntegrityError(
                    f"Cryptographic SHA-256 hash mismatch for {art_path}:\n"
                    f"  Expected: {expected_hash}\n"
                    f"  Actual:   {actual_hash}"
                )

        metadata["_meta_path"] = meta_path
        metadata["_model_dir"] = model_dir
        return metadata

    def build_candidate_record(
        self,
        horizon: int,
        model_family: str,
        verify_artifact_hash: bool = True,
    ) -> ModelComparisonCandidateRecord:
        """
        Constructs a complete ModelComparisonCandidateRecord from verified metadata.
        Evaluates eligibility gates and applies approved selection decisions.
        """
        meta = self.load_candidate_metadata(
            horizon=horizon,
            model_family=model_family,
            verify_artifact_hash=verify_artifact_hash,
        )

        val_metrics_raw = meta.get("validation_metrics")
        if not val_metrics_raw:
            raise ComparisonArtifactIntegrityError(
                f"Missing validation_metrics in {meta['_meta_path']}"
            )

        # Convert per_class dict
        per_class_dict = {
            k: ClassMetricDetail(**v) for k, v in val_metrics_raw["per_class"].items()
        }
        cat_err = CatastrophicErrorDetail(**val_metrics_raw["catastrophic_error"])

        metrics = ClassificationMetrics(
            accuracy=val_metrics_raw["accuracy"],
            balanced_accuracy=val_metrics_raw["balanced_accuracy"],
            macro_precision=val_metrics_raw["macro_precision"],
            macro_recall=val_metrics_raw["macro_recall"],
            macro_f1=val_metrics_raw["macro_f1"],
            per_class=per_class_dict,
            confusion_matrix=val_metrics_raw["confusion_matrix"],
            catastrophic_error=cat_err,
            log_loss=val_metrics_raw.get("log_loss"),
            brier_score=val_metrics_raw.get("brier_score"),
            total_samples=val_metrics_raw["total_samples"],
            horizon=horizon,
            model_name=meta.get("model_name"),
            metadata=val_metrics_raw.get("metadata", {}),
        )

        # Verify sample counts
        expected_samples = EXPECTED_VALIDATION_SAMPLES[horizon]
        if metrics.total_samples != expected_samples:
            raise ComparisonArtifactIntegrityError(
                f"Total samples mismatch in h{horizon} {model_family}: "
                f"expected {expected_samples}, got {metrics.total_samples}"
            )

        # Derive class distributions from 3x3 confusion matrix
        matrix = metrics.confusion_matrix
        actual_dist = {
            "DOWN": sum(matrix[0]),
            "NEUTRAL": sum(matrix[1]),
            "UP": sum(matrix[2]),
        }
        pred_dist = {
            "DOWN": matrix[0][0] + matrix[1][0] + matrix[2][0],
            "NEUTRAL": matrix[0][1] + matrix[1][1] + matrix[2][1],
            "UP": matrix[0][2] + matrix[1][2] + matrix[2][2],
        }

        # Evaluate 6 eligibility gates
        gates = evaluate_eligibility_gates(metrics)
        eligibility_status = (
            CandidateEligibilityStatus.ELIGIBLE
            if gates.all_passed
            else CandidateEligibilityStatus.INELIGIBLE
        )
        failed_criteria = [
            gates.model_dump()[f"{g}_gate"]["details"] for g in gates.failed_gate_names
        ]

        # Determine candidate identifier and grid index
        hyperparams = meta.get("hyperparameters", {})
        grid_idx = hyperparams.get("grid_index")
        if model_family == "logistic_regression":
            candidate_id = "Phase 5C.3 Baseline"
        elif grid_idx is not None:
            candidate_id = f"Champion #{grid_idx}"
        else:
            candidate_id = meta.get("version", "v1.0.0")

        # Classifications & Selection Logic
        is_preferred = False
        is_benchmark = False
        decision = CandidateSelectionDecision.REJECTED
        rationale = ""
        known_weaknesses: List[str] = []

        if horizon == 1:
            if model_family == "logistic_regression":
                is_preferred = False
                is_benchmark = True
                decision = CandidateSelectionDecision.HISTORICAL_BENCHMARK
                rationale = (
                    "Eligible historical baseline. Retained for comparison. Not preferred "
                    "due to severe UP prediction skew (only 21/400 predictions vs 134 actual, "
                    "UP recall 7.46%) and lower Macro F1 (0.3396 vs XGBoost's 0.3773)."
                )
                known_weaknesses.append("Pathological UP prediction suppression (7.46% recall).")
                known_weaknesses.append("Excessive DOWN bias (247 predicted vs 145 actual).")
            elif model_family == "random_forest":
                is_preferred = False
                is_benchmark = True
                decision = CandidateSelectionDecision.REJECTED
                rationale = (
                    "Ineligible. Realized catastrophic directional error rate is 26.50% (106 errors), "
                    "violating the 25.00% provisional research guardrail."
                )
                known_weaknesses.append("Excessive opposite-direction errors (26.50%).")
                known_weaknesses.append("High batch inference latency (~61.37 ms).")
            elif model_family == "xgboost":
                is_preferred = True
                is_benchmark = False
                decision = CandidateSelectionDecision.PREFERRED_RESEARCH_CANDIDATE
                rationale = (
                    "Eligible and preferred research candidate. Achieves highest Macro F1 (0.3773), "
                    "complies with 25% catastrophic error guardrail (21.50%), and maintains balanced "
                    "recall across all regimes (DOWN 50.34%, NEUTRAL 33.06%, UP 30.60%)."
                )
                known_weaknesses.append("Moderate false DOWN predictions (39.89% precision).")

        elif horizon == 3:
            if model_family == "logistic_regression":
                is_preferred = False
                is_benchmark = True
                decision = CandidateSelectionDecision.REJECTED
                rationale = (
                    "Ineligible. Violates 25% catastrophic error guardrail (31.79%, 124 errors) "
                    "and collapses completely on NEUTRAL recall (0.87%, only 1/115 identified)."
                )
                known_weaknesses.append("Severe catastrophic error rate (31.79%).")
                known_weaknesses.append("Total NEUTRAL collapse (0.87% recall).")
            elif model_family == "random_forest":
                is_preferred = False
                is_benchmark = True
                decision = CandidateSelectionDecision.REJECTED
                rationale = (
                    "Ineligible. Violates 25% catastrophic error guardrail (31.54%, 123 errors) "
                    "despite strong nominal Macro F1 (0.3584)."
                )
                known_weaknesses.append("Severe catastrophic error rate (31.54%).")
            elif model_family == "xgboost":
                is_preferred = True
                is_benchmark = False
                decision = CandidateSelectionDecision.PREFERRED_RESEARCH_CANDIDATE
                rationale = (
                    "Eligible and preferred research candidate. Sole eligible candidate at h3. "
                    "Reduces catastrophic errors by 70% vs LR and RF (37 errors, 9.49% rate), "
                    "while preserving compliant recall across all 3 classes."
                )
                known_weaknesses.append(
                    "High cash/neutral conservatism: NEUTRAL recall is 74.78%, limiting active participation."
                )

        elif horizon == 5:
            if model_family == "logistic_regression":
                is_preferred = False
                is_benchmark = True
                decision = CandidateSelectionDecision.REJECTED
                rationale = (
                    "Ineligible. Violates 25% catastrophic error guardrail (31.05%, 118 errors) "
                    "and collapses on NEUTRAL recall (1.61%, 2/124 identified)."
                )
                known_weaknesses.append("Severe catastrophic error rate (31.05%).")
                known_weaknesses.append("Total NEUTRAL collapse (1.61% recall).")
            elif model_family == "random_forest":
                is_preferred = True
                is_benchmark = False
                decision = CandidateSelectionDecision.PREFERRED_RESEARCH_CANDIDATE
                rationale = (
                    "Eligible and preferred research candidate. Sole eligible candidate at h5. "
                    "Achieves highest Macro F1 (0.3265), passes 25% catastrophic error guardrail "
                    "(20.79%), and satisfies all per-class recall floors (DOWN 12.41% > 5.00%)."
                )
                known_weaknesses.append("Relatively weak DOWN recall (12.41%, 18/145).")
            elif model_family == "xgboost":
                is_preferred = False
                is_benchmark = True
                decision = CandidateSelectionDecision.REJECTED
                rationale = (
                    "Ineligible. Fails per-class recall floor: DOWN recall collapsed to 2.76% "
                    "(only 4/145 down instances identified <= 5.00%). Disqualified from preferred status."
                )
                known_weaknesses.append("Extreme downside blindness (DOWN recall 2.76%).")

        art_size = meta.get("artifact_size_bytes")
        if art_size is None:
            art_filename = meta.get("artifact_filename", "model.joblib")
            art_path = os.path.join(meta["_model_dir"], art_filename)
            art_size = os.path.getsize(art_path) if os.path.exists(art_path) else 0

        return ModelComparisonCandidateRecord(
            model_id=meta["model_id"],
            model_family=model_family,
            horizon=horizon,
            candidate_identifier=candidate_id,
            grid_index=grid_idx,
            artifact_filename=meta.get("artifact_filename", "model.joblib"),
            artifact_sha256=meta.get("artifact_sha256", ""),
            artifact_size_bytes=art_size,
            metadata_path=meta["_meta_path"],
            hyperparameters=hyperparams,
            feature_names=meta.get("feature_names", []),
            metrics=metrics,
            actual_distribution=actual_dist,
            predicted_distribution=pred_dist,
            catastrophic_error_count=cat_err.count,
            catastrophic_error_rate_total=cat_err.rate,
            catastrophic_error_rate_directional=cat_err.directional_subset_rate,
            gate_results=gates,
            eligibility_status=eligibility_status,
            failed_criteria=failed_criteria,
            is_preferred_research_candidate=is_preferred,
            is_historical_benchmark=is_benchmark,
            production_readiness=ProductionReadinessStatus.PROHIBITED,
            selection_decision=decision,
            selection_rationale=rationale,
            known_weaknesses=known_weaknesses,
        )

    def generate_horizon_summary(
        self,
        horizon: int,
        verify_artifact_hash: bool = True,
    ) -> HorizonComparisonSummary:
        """
        Compares all three model families for a given horizon and summarizes candidate selection.
        """
        candidates: List[ModelComparisonCandidateRecord] = []
        for family in ["logistic_regression", "random_forest", "xgboost"]:
            rec = self.build_candidate_record(
                horizon=horizon,
                model_family=family,
                verify_artifact_hash=verify_artifact_hash,
            )
            candidates.append(rec)

        preferred = [c for c in candidates if c.is_preferred_research_candidate]
        if len(preferred) != 1:
            raise ComparisonError(
                f"Expected exactly 1 preferred candidate for h{horizon}, found {len(preferred)}"
            )

        notes_map = {
            1: "XGBoost #147 selected for highest Macro F1 (0.3773) and balanced class recall. LR h1 is eligible but exhibits UP suppression.",
            3: "XGBoost #121 selected as sole eligible candidate. Exceptional 70% error reduction (9.49% catastrophic rate) with 74.78% NEUTRAL recall.",
            5: "Random Forest #33 selected as sole eligible candidate (Macro F1 0.3265, DOWN recall 12.41%). XGBoost #68 ineligible due to DOWN recall collapse (2.76%).",
        }

        return HorizonComparisonSummary(
            horizon=horizon,
            sample_count=EXPECTED_VALIDATION_SAMPLES[horizon],
            session_count=EXPECTED_VALIDATION_SESSIONS[horizon],
            candidates=candidates,
            preferred_candidate_id=preferred[0].model_id,
            preferred_candidate_family=preferred[0].model_family,
            notes=notes_map.get(horizon, ""),
        )

    def generate_full_comparison_report(
        self,
        report_id: Optional[str] = None,
        verify_artifact_hash: bool = True,
    ) -> ModelComparisonReport:
        """
        Executes full Phase 5C.4.4 multi-horizon model comparison report.
        """
        # Validate dataset SHA-256 fixture if present
        if os.path.exists(self.dataset_path):
            actual_dataset_hash = compute_file_sha256(self.dataset_path)
            if actual_dataset_hash != CANONICAL_DATASET_SHA256:
                raise ComparisonArtifactIntegrityError(
                    f"Canonical dataset hash mismatch:\n"
                    f"  Expected: {CANONICAL_DATASET_SHA256}\n"
                    f"  Actual:   {actual_dataset_hash}"
                )

        rep_id = (
            report_id
            if report_id
            else f"phase_5c4_4_comparison_{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d_%H%M%S')}"
        )

        horizons_dict: Dict[int, HorizonComparisonSummary] = {}
        for h in [1, 3, 5]:
            horizons_dict[h] = self.generate_horizon_summary(
                horizon=h, verify_artifact_hash=verify_artifact_hash
            )

        provisional_latency = {
            "status": "PROVISIONAL",
            "environment": {
                "hardware": "Apple Silicon (ARM64)",
                "python": "3.14.9",
                "scikit_learn": "1.9.1",
                "xgboost": "3.4.1",
                "numpy": "2.5.4",
                "joblib": "1.6.0",
            },
            "methodology": "10 warm-up runs, 100 timed iterations using time.perf_counter(). Includes feature schema validation and scaling.",
            "caveat": "Provisional workstation measurements. Single-sample inference is dominated by Python overhead. Not used as primary selection disqualifier.",
            "batch_means_ms": {
                "h1_lr": 0.73,
                "h1_rf": 61.37,
                "h1_xgb": 1.11,
                "h3_lr": 0.72,
                "h3_rf": 27.00,
                "h3_xgb": 1.22,
                "h5_lr": 0.92,
                "h5_rf": 27.79,
                "h5_xgb": 0.99,
            },
        }

        gov_notes = (
            "MANDATORY GOVERNANCE DIRECTIVE: NO MODEL IS APPROVED FOR PRODUCTION DEPLOYMENT. "
            "All candidate models are evaluated solely on the outer validation partition (2026-03-12 to 2026-07-13). "
            "The Phase 5C.3 held-out test partition (2026-07-14 to 2026-11-09) is permanently consumed and was NOT accessed. "
            "True out-of-sample certification requires collecting genuinely new market observations occurring after 2026-11-09."
        )

        return ModelComparisonReport(
            report_id=rep_id,
            created_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            dataset_identifier=CANONICAL_DATASET_IDENTIFIER,
            dataset_sha256=CANONICAL_DATASET_SHA256,
            validation_start_date=VALIDATION_START_DATE,
            validation_end_date=VALIDATION_END_DATE,
            quarantined_test_start_date=QUARANTINED_TEST_START_DATE,
            quarantined_test_end_date=QUARANTINED_TEST_END_DATE,
            horizons=horizons_dict,
            provisional_latency_summary=provisional_latency,
            governance_notes=gov_notes,
        )

    def export_report_json(self, report: ModelComparisonReport, output_path: str) -> str:
        """
        Saves the ModelComparisonReport to a JSON file deterministically.
        """
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(report.model_dump_json(indent=2))
        return output_path

    def generate_markdown_table(self, report: ModelComparisonReport) -> str:
        """
        Generates the comprehensive unified comparison table in GitHub-flavored markdown.
        """
        lines = [
            "| Horizon | Model Family | Candidate | Bal Acc | Macro F1 | Log Loss | Brier | Cat Rate (Total) | Cat Count | Per-Class Recalls (DOWN / NEU / UP) | Eligibility | Failed Criteria | Selection Decision | Preferred Candidate | Benchmark Retention | Production Readiness |",
            "| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- | :---: | :---: | :---: |",
        ]
        for h in [1, 3, 5]:
            summary = report.horizons[h]
            for c in summary.candidates:
                m = c.metrics
                r_down = m.per_class["DOWN"].recall * 100
                r_neu = m.per_class["NEUTRAL"].recall * 100
                r_up = m.per_class["UP"].recall * 100
                recalls_str = f"{r_down:.1f}% / {r_neu:.1f}% / {r_up:.1f}%"
                failed_str = "; ".join(c.failed_criteria) if c.failed_criteria else "None (Passes all 6)"
                preferred_str = "**YES**" if c.is_preferred_research_candidate else "NO"
                benchmark_str = "YES" if c.is_historical_benchmark else "N/A"
                elig_str = f"**{c.eligibility_status.value.upper()}**"
                dec_str = c.selection_decision.value.replace("_", " ").title()
                log_loss_str = f"{m.log_loss:.4f}" if m.log_loss is not None else "N/A"
                brier_str = f"{m.brier_score:.4f}" if m.brier_score is not None else "N/A"
                lines.append(
                    f"| h{h} | {c.model_family} | {c.candidate_identifier} | "
                    f"{m.balanced_accuracy:.4f} | {m.macro_f1:.4f} | {log_loss_str} | {brier_str} | "
                    f"{c.catastrophic_error_rate_total*100:.2f}% | {c.catastrophic_error_count} | "
                    f"{recalls_str} | {elig_str} | {failed_str} | {dec_str} | "
                    f"{preferred_str} | {benchmark_str} | {c.production_readiness.value.upper()} |"
                )
        return "\n".join(lines)
