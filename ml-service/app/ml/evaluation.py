"""
StockSense AI — Model Evaluation Subpackage Facade
Exposes schemas, guard state machines, and evaluation services for Phase 5C.3.7.
"""

from app.schemas.evaluation import (
    EvaluationLifecycleState,
    EvaluationGuardRecord,
    BaselineComparisonRecord,
    HorizonEvaluationRecord,
    FinalTestEvaluationReport,
    EvaluationReportArtifactInfo,
    EvaluationGuardArtifactInfo,
    EvaluationDatasetInfo,
    EvaluationIntegrityManifest,
)
from app.services.evaluation import (
    EvaluationError,
    EvaluationPreGateFailedError,
    EvaluationAlreadyCompletedError,
    ConcurrentEvaluationError,
    EvaluationGuard,
    execute_controlled_test_evaluation,
    create_detached_integrity_manifest,
    verify_detached_integrity_manifest,
    EXPECTED_CANONICAL_DATASET_SHA256,
)

__all__ = [
    "EvaluationLifecycleState",
    "EvaluationGuardRecord",
    "BaselineComparisonRecord",
    "HorizonEvaluationRecord",
    "FinalTestEvaluationReport",
    "EvaluationReportArtifactInfo",
    "EvaluationGuardArtifactInfo",
    "EvaluationDatasetInfo",
    "EvaluationIntegrityManifest",
    "EvaluationError",
    "EvaluationPreGateFailedError",
    "EvaluationAlreadyCompletedError",
    "ConcurrentEvaluationError",
    "EvaluationGuard",
    "execute_controlled_test_evaluation",
    "create_detached_integrity_manifest",
    "verify_detached_integrity_manifest",
    "EXPECTED_CANONICAL_DATASET_SHA256",
]
