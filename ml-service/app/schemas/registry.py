"""
StockSense AI — Model Registry Schemas
Pydantic V2 schemas for model versioning, registry metadata sidecars,
provenance tracking, and model lifecycle status management.
"""

from enum import Enum
from typing import Dict, List, Optional, Any, Union
from pydantic import BaseModel, Field, ConfigDict

from app.schemas.metrics import ClassificationMetrics


class ModelStatus(str, Enum):
    """
    Model lifecycle governance status.
    Validation-selected candidates are strictly labeled as VALIDATION_SELECTED.
    They cannot be labeled PRODUCTION_READY until after formal held-out test evaluation.
    """
    VALIDATION_SELECTED = "validation_selected"
    TEST_EVALUATED = "test_evaluated"
    PRODUCTION_READY = "production_ready"
    DEPRECATED = "deprecated"
    REJECTED = "rejected"


class ModelProvenance(BaseModel):
    """
    Cryptographic and environment provenance for a registered model.
    """
    dataset_sha256: str = Field(..., description="SHA-256 digest of historical raw dataset fixture")
    dataset_identifier: str = Field(..., description="Unique name/tag of the canonical dataset")
    git_commit: str = Field(..., description="Git commit hash of repository during training")
    python_version: str = Field(..., description="Exact Python runtime version")
    library_versions: Dict[str, str] = Field(..., description="Exact versions of core ML packages")
    training_timestamp_utc: str = Field(..., description="ISO 8601 UTC timestamp of model fitting")

    model_config = ConfigDict(frozen=True)


class ModelRegistryMetadata(BaseModel):
    """
    Comprehensive metadata sidecar accompanying each serialized model artifact.
    """
    # Registry schema governance
    registry_schema_version: str = Field(default="1.0", description="Version of the registry metadata schema")

    # Model identification and semantic version
    model_id: str = Field(..., description="Deterministic unique model identifier (e.g., logistic_regression_h1_v1.0.0)")
    model_name: str = Field(..., description="Model architecture name (e.g., logistic_regression)")
    version: str = Field(..., description="Semantic model version string (e.g., 1.0.0)")
    horizon: int = Field(..., ge=1, le=10, description="Prediction horizon h in trading sessions")
    algorithm: str = Field(..., description="Full descriptive name of the model algorithm")
    solver: Optional[str] = Field(default="not_applicable", description="Optimization solver used during training")
    hyperparameters: Dict[str, Any] = Field(..., description="Hyperparameter configuration dictionary")

    # Target & labeling provenance
    target_type: str = Field(default="open_to_close", description="Executable forward return formula: ((C[t+h] - O[t+1]) / O[t+1]) * 100")
    target_threshold_pct: float = Field(default=0.50, description="Symmetric percentage threshold theta_h (e.g. 0.50 for h=1, 1.00 for h=3, 1.50 for h=5)")
    target_definition: str = Field(
        default="UP (+1) if return > +theta_h, DOWN (-1) if return < -theta_h, NEUTRAL (0) otherwise",
        description="3-class labeling decision rule"
    )
    entry_price_convention: str = Field(default="next_session_open (O[t+1])", description="Executable entry price")
    exit_price_convention: str = Field(default="horizon_session_close (C[t+h])", description="Executable exit price")

    # Splitting and purging provenance
    split_methodology: str = Field(
        default="PurgedGroupedChronologicalSplitter",
        description="Cross-sectional grouping by calendar date with chronological partitioning"
    )
    split_ratios: Dict[str, float] = Field(
        default_factory=lambda: {"train": 0.70, "validation": 0.15, "test": 0.15},
        description="Nominal partition ratios before boundary purging"
    )
    purge_window_sessions: int = Field(default=1, description="Boundary purge window size in sessions (equal to horizon h)")
    embargo_window_sessions: int = Field(default=0, description="Embargo blackout sessions after partition boundary")

    # Dataset partition counts
    training_samples: int = Field(..., ge=1, description="Number of observations in training partition")
    validation_samples: int = Field(..., ge=1, description="Number of observations in validation partition")

    # Validation evaluation metrics
    validation_metrics: ClassificationMetrics = Field(..., description="Complete 3-class validation performance metrics")

    # Feature & class specifications
    feature_schema_version: str = Field(default="23_scale_invariant_technical_v1", description="Approved feature set schema identifier")
    feature_names: List[str] = Field(..., description="Exact 23 approved feature names in strict input order")
    class_labels: List[int] = Field(default=[-1, 0, 1], description="Target class labels in canonical order")
    class_names: List[str] = Field(default=["DOWN", "NEUTRAL", "UP"], description="Class names in canonical order")

    # Artifact integrity
    artifact_filename: str = Field(default="model.joblib", description="Filename of serialized model binary")
    artifact_sha256: str = Field(..., description="SHA-256 digest of serialized model binary")
    artifact_size_bytes: int = Field(..., ge=1, description="File size of serialized model binary in bytes")

    # Lifecycle governance
    status: ModelStatus = Field(default=ModelStatus.VALIDATION_SELECTED, description="Current governance status")
    experiment_id: str = Field(..., description="Identifier of the experiment or tuning campaign")
    notes: Optional[str] = Field(default=None, description="Optional human-readable notes or audit remarks")

    # Provenance tracking
    provenance: ModelProvenance = Field(..., description="Cryptographic provenance and runtime environment")
    created_at_utc: str = Field(..., description="ISO 8601 UTC creation timestamp")

    model_config = ConfigDict(frozen=True)


class ModelListItem(BaseModel):
    """
    Lightweight summary descriptor for listing models in the registry.
    """
    model_id: str
    model_name: str
    version: str
    horizon: int
    status: ModelStatus
    registry_schema_version: str = "1.0"
    val_balanced_accuracy: float
    val_macro_f1: float
    val_log_loss: Optional[float]
    created_at_utc: str
    artifact_sha256: str

    model_config = ConfigDict(frozen=True)
