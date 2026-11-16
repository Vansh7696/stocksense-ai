"""
StockSense AI — Final Test Evaluation Schemas
Pydantic V2 schemas for evaluation guard lifecycle tracking,
horizon-level test evaluation records, baseline benchmark comparisons,
and comprehensive final evaluation audit reporting.
"""

from enum import Enum
from typing import Dict, List, Optional, Any, Union
from pydantic import BaseModel, Field, ConfigDict

from app.schemas.metrics import ClassificationMetrics
from app.schemas.registry import ModelStatus, ModelProvenance


class EvaluationLifecycleState(str, Enum):
    """
    Lifecycle states for the controlled final test evaluation guard.
    """
    NOT_EVALUATED = "not_evaluated"
    EVALUATION_IN_PROGRESS = "evaluation_in_progress"
    EVALUATED = "evaluated"
    EVALUATION_FAILED = "evaluation_failed"


class EvaluationGuardRecord(BaseModel):
    """
    State record governing the execution lifecycle of a specific evaluation experiment.
    """
    experiment_id: str = Field(..., description="Unique evaluation campaign identifier")
    state: EvaluationLifecycleState = Field(
        default=EvaluationLifecycleState.NOT_EVALUATED,
        description="Current state of evaluation lifecycle",
    )
    started_at_utc: Optional[str] = Field(default=None, description="ISO 8601 UTC evaluation start timestamp")
    completed_at_utc: Optional[str] = Field(default=None, description="ISO 8601 UTC evaluation completion timestamp")
    dataset_sha256: str = Field(..., description="SHA-256 digest of canonical dataset used for test evaluation")
    model_ids: List[str] = Field(..., description="List of model IDs evaluated under this experiment")
    model_artifact_hashes: Dict[str, str] = Field(..., description="Verified SHA-256 digests of all model artifacts")
    results_artifact_path: Optional[str] = Field(default=None, description="Path to persisted evaluation report")
    results_artifact_sha256: Optional[str] = Field(default=None, description="SHA-256 of persisted evaluation report")
    error_message: Optional[str] = Field(default=None, description="Error details if evaluation failed")

    model_config = ConfigDict(frozen=True)


class BaselineComparisonRecord(BaseModel):
    """
    Benchmark comparison record against Majority and Momentum baselines on the same test partition.
    """
    baseline_name: str = Field(..., description="Name of benchmark baseline model (Majority or Momentum)")
    metrics: ClassificationMetrics = Field(..., description="Test partition classification metrics")
    balanced_accuracy_diff: float = Field(..., description="Logistic Regression Bal Acc minus Baseline Bal Acc")
    macro_f1_diff: float = Field(..., description="Logistic Regression Macro F1 minus Baseline Macro F1")
    log_loss_diff: Optional[float] = Field(default=None, description="Logistic Regression Log Loss minus Baseline Log Loss")

    model_config = ConfigDict(frozen=True)


class HorizonEvaluationRecord(BaseModel):
    """
    Comprehensive evaluation record for a single prediction horizon.
    """
    horizon: int = Field(..., ge=1, le=10, description="Prediction horizon h in trading sessions")
    model_id: str = Field(..., description="Evaluated model ID")
    model_version: str = Field(..., description="Model version")
    model_artifact_sha256: str = Field(..., description="Cryptographically verified artifact SHA-256")
    hyperparameters: Dict[str, Any] = Field(..., description="Evaluated hyperparameters")

    # Partition sample counts
    training_samples: int = Field(..., ge=1)
    validation_samples: int = Field(..., ge=1)
    test_samples: int = Field(..., ge=1, description="Number of held-out test observations evaluated")

    # Performance metrics
    validation_metrics: ClassificationMetrics = Field(..., description="Validation partition metrics (historical reference)")
    test_metrics: ClassificationMetrics = Field(..., description="Final held-out test partition metrics")

    # Validation vs Test generalization gap
    generalization_delta: Dict[str, float] = Field(
        ...,
        description="Generalization gap: test_metric minus validation_metric (e.g. balanced_accuracy_delta)",
    )

    # Baseline benchmark comparisons
    baseline_comparisons: Dict[str, BaselineComparisonRecord] = Field(
        default_factory=dict,
        description="Comparisons against Majority and Momentum baselines on the exact same test partition",
    )

    model_config = ConfigDict(frozen=True)


class FinalTestEvaluationReport(BaseModel):
    """
    Immutable audit artifact containing the complete results of the Phase 5C.3.7 final evaluation.
    """
    experiment_id: str = Field(..., description="Unique evaluation campaign identifier")
    evaluation_timestamp_utc: str = Field(..., description="ISO 8601 UTC timestamp of evaluation execution")
    dataset_sha256: str = Field(..., description="Canonical dataset SHA-256")
    dataset_identifier: str = Field(default="canonical_5stocks_v1")
    git_commit: str = Field(..., description="Git commit SHA at evaluation time")
    runtime_environment: Dict[str, str] = Field(..., description="Python and library versions")
    evaluation_guard: EvaluationGuardRecord = Field(..., description="Final evaluation guard state record")
    horizons: Dict[int, HorizonEvaluationRecord] = Field(..., description="Per-horizon evaluation records for h1, h3, h5")
    summary_findings: str = Field(..., description="Executive interpretation of model generalizability and signal")

    model_config = ConfigDict(frozen=True)


class EvaluationReportArtifactInfo(BaseModel):
    """
    Cryptographic descriptors for the final evaluation report artifact.
    """
    filename: str = Field(default="evaluation_report.json")
    final_artifact_sha256: str = Field(..., description="Cryptographically computed SHA-256 of final report")
    final_artifact_size_bytes: int = Field(..., ge=1, description="Size in bytes of final report")
    pre_finalization_sha256: str = Field(
        ...,
        description="Initial pre-finalization report hash recorded in guard.json before guard embedding",
    )

    model_config = ConfigDict(frozen=True)


class EvaluationGuardArtifactInfo(BaseModel):
    """
    Cryptographic descriptors for the persisted evaluation guard file.
    """
    filename: str = Field(default="guard.json")
    state: EvaluationLifecycleState = Field(default=EvaluationLifecycleState.EVALUATED)
    guard_artifact_sha256: str = Field(..., description="SHA-256 of persisted guard.json")
    guard_artifact_size_bytes: int = Field(..., ge=1, description="Size in bytes of guard.json")
    recorded_pre_finalization_digest: str = Field(..., description="Digest stored in guard record")

    model_config = ConfigDict(frozen=True)


class EvaluationDatasetInfo(BaseModel):
    """
    Dataset provenance descriptor for evaluation.
    """
    dataset_identifier: str = Field(default="canonical_5stocks_v1")
    dataset_sha256: str = Field(..., description="SHA-256 of the authentic canonical dataset fixture")

    model_config = ConfigDict(frozen=True)


class EvaluationIntegrityManifest(BaseModel):
    """
    Detached cryptographic integrity manifest resolving self-referential report
    hash discrepancies without mutating historical test evaluation results or re-evaluating test partitions.
    """
    manifest_schema_version: str = Field(default="1.0")
    experiment_id: str = Field(..., description="Evaluation experiment identifier")
    created_at_utc: str = Field(..., description="ISO 8601 UTC creation timestamp of the manifest")
    evaluation_report: EvaluationReportArtifactInfo
    guard: EvaluationGuardArtifactInfo
    model_artifact_hashes: Dict[str, str] = Field(..., description="Verified SHA-256 of evaluated model artifacts")
    dataset: EvaluationDatasetInfo
    discrepancy_explanation: str = Field(..., description="Root cause explanation of self-referential hashing discrepancy")
    status: str = Field(default="VALID_IMMUTABLE")

    model_config = ConfigDict(frozen=True)
