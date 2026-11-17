"""
StockSense AI — Model Comparison and Validation-Stage Selection Schemas
Pydantic V2 schemas for Phase 5C.4.4 multi-horizon model comparison,
eligibility gate evaluation, and validation-stage research candidate selection.
"""

from enum import Enum
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field, ConfigDict

from app.schemas.metrics import ClassificationMetrics


class CandidateEligibilityStatus(str, Enum):
    """
    Binary eligibility status under the approved 6-gate validation policy.
    """
    ELIGIBLE = "eligible"
    INELIGIBLE = "ineligible"


class CandidateSelectionDecision(str, Enum):
    """
    Operational selection decision for research tracking.
    """
    PREFERRED_RESEARCH_CANDIDATE = "preferred_research_candidate"
    HISTORICAL_BENCHMARK = "historical_benchmark"
    REJECTED = "rejected"


class ProductionReadinessStatus(str, Enum):
    """
    Mandatory governance status. Production deployment is strictly prohibited in Phase 5C.4.4.
    """
    PROHIBITED = "prohibited"


class GateResult(BaseModel):
    """
    Evaluation record for an individual eligibility gate.
    """
    gate_name: str = Field(..., description="Unique name of the eligibility gate")
    passed: bool = Field(..., description="Whether the gate criteria was met")
    observed_value: Any = Field(..., description="Observed numeric or structured metric value")
    threshold_or_target: Any = Field(..., description="Required gate threshold or constraint")
    operator: str = Field(..., description="Relational operator (<=, >=, >, ==)")
    details: str = Field(..., description="Human-readable gate evaluation summary")

    model_config = ConfigDict(frozen=True)


class EligibilityGateSet(BaseModel):
    """
    Container for all six validation eligibility gates.
    """
    catastrophic_error_gate: GateResult = Field(..., description="Gate 1: Catastrophic error rate <= 25.0%")
    balanced_accuracy_gate: GateResult = Field(..., description="Gate 2: Balanced accuracy > 0.3333")
    macro_f1_gate: GateResult = Field(..., description="Gate 3: Macro F1 >= 0.2800")
    per_class_recall_gate: GateResult = Field(..., description="Gate 4: Per-class recall strictly > 0.05 for each class")
    log_loss_gate: GateResult = Field(..., description="Gate 5: Log loss <= 1.1500")
    brier_score_gate: GateResult = Field(..., description="Gate 6: Multiclass Brier score <= 0.7000")
    all_passed: bool = Field(..., description="True if and only if all 6 gates passed")
    failed_gate_names: List[str] = Field(default_factory=list, description="List of failed gate names")

    model_config = ConfigDict(frozen=True)


class ModelComparisonCandidateRecord(BaseModel):
    """
    Complete validation evaluation record for an individual candidate model.
    """
    model_id: str = Field(..., description="Unique model registry or tuning candidate ID")
    model_family: str = Field(..., description="Model family ('logistic_regression', 'random_forest', 'xgboost')")
    horizon: int = Field(..., description="Prediction horizon in trading sessions (1, 3, 5)")
    candidate_identifier: str = Field(..., description="Human-readable candidate label (e.g. 'Champion #147')")
    grid_index: Optional[int] = Field(default=None, description="Grid index from tuning search if applicable")
    artifact_filename: str = Field(..., description="Model binary filename")
    artifact_sha256: str = Field(..., description="Cryptographic SHA-256 digest of model binary")
    artifact_size_bytes: int = Field(..., description="Size of model artifact in bytes")
    metadata_path: str = Field(..., description="Path to metadata.json sidecar")
    hyperparameters: Dict[str, Any] = Field(default_factory=dict, description="Model hyperparameters")
    feature_names: List[str] = Field(..., description="Validated 23-feature allowlist")
    metrics: ClassificationMetrics = Field(..., description="Frozen outer-validation classification metrics")
    actual_distribution: Dict[str, int] = Field(..., description="Actual sample counts by class: DOWN, NEUTRAL, UP")
    predicted_distribution: Dict[str, int] = Field(..., description="Predicted sample counts by class: DOWN, NEUTRAL, UP")
    catastrophic_error_count: int = Field(..., ge=0, description="Total catastrophic opposite-direction error count")
    catastrophic_error_rate_total: float = Field(..., ge=0.0, le=1.0, description="Catastrophic error rate / total N")
    catastrophic_error_rate_directional: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Catastrophic error rate / (DOWN support + UP support)"
    )
    gate_results: EligibilityGateSet = Field(..., description="Evaluation results for all 6 eligibility gates")
    eligibility_status: CandidateEligibilityStatus = Field(..., description="Eligibility status (eligible/ineligible)")
    failed_criteria: List[str] = Field(default_factory=list, description="Explicit list of failed criteria")
    is_preferred_research_candidate: bool = Field(..., description="Whether this is the preferred candidate for horizon")
    is_historical_benchmark: bool = Field(..., description="Whether this candidate is retained as historical benchmark")
    production_readiness: ProductionReadinessStatus = Field(
        default=ProductionReadinessStatus.PROHIBITED, description="Production readiness status (strictly prohibited)"
    )
    selection_decision: CandidateSelectionDecision = Field(..., description="Operational selection decision")
    selection_rationale: str = Field(..., description="Detailed rationale for selection or rejection")
    known_weaknesses: List[str] = Field(default_factory=list, description="Documented operational weaknesses")

    model_config = ConfigDict(frozen=True)


class HorizonComparisonSummary(BaseModel):
    """
    Summary of validation comparison and candidate selection for a single horizon.
    """
    horizon: int = Field(..., description="Prediction horizon (1, 3, 5)")
    sample_count: int = Field(..., description="Total validation samples evaluated")
    session_count: int = Field(..., description="Total validation sessions evaluated")
    candidates: List[ModelComparisonCandidateRecord] = Field(..., description="All evaluated candidates for horizon")
    preferred_candidate_id: str = Field(..., description="Model ID of preferred research candidate")
    preferred_candidate_family: str = Field(..., description="Family of preferred research candidate")
    notes: str = Field(..., description="Horizon-specific comparative analysis notes")

    model_config = ConfigDict(frozen=True)


class ModelComparisonReport(BaseModel):
    """
    Comprehensive Phase 5C.4.4 multi-horizon model comparison report.
    """
    report_id: str = Field(..., description="Unique comparison report identifier")
    created_at_utc: str = Field(..., description="ISO 8601 UTC creation timestamp")
    dataset_identifier: str = Field(..., description="Canonical dataset identifier")
    dataset_sha256: str = Field(..., description="Cryptographic SHA-256 of canonical dataset fixture")
    validation_start_date: str = Field(default="2026-03-12", description="Start date of outer validation partition")
    validation_end_date: str = Field(default="2026-07-13", description="End date of outer validation partition")
    quarantined_test_start_date: str = Field(default="2026-07-14", description="Start date of quarantined test partition")
    quarantined_test_end_date: str = Field(default="2026-11-09", description="End date of quarantined test partition")
    horizons: Dict[int, HorizonComparisonSummary] = Field(..., description="Summary per horizon (1, 3, 5)")
    provisional_latency_summary: Optional[Dict[str, Any]] = Field(
        default=None, description="Provisional workstation latency benchmark summary"
    )
    governance_notes: str = Field(..., description="Mandatory governance directives and non-production declarations")

    model_config = ConfigDict(frozen=True)
