"""
StockSense AI — Logistic Regression Schemas
Pydantic V2 schemas for Multinomial L2 Logistic Regression hyperparameters,
candidate validation evaluations, tuning results, and model metadata.
"""

from typing import Dict, List, Optional, Any, Union
from pydantic import BaseModel, Field, ConfigDict

from app.schemas.metrics import ClassificationMetrics


class LogisticRegressionHyperparameters(BaseModel):
    """
    Hyperparameter configuration for a single Logistic Regression candidate.
    """
    C: float = Field(..., gt=0.0, description="Inverse of regularization strength (smaller = stronger L2 regularization)")
    class_weight: Optional[str] = Field(default=None, description="Class weight mode: None or 'balanced'")
    solver: str = Field(default="lbfgs", description="Optimization algorithm")
    max_iter: int = Field(default=1000, ge=100, description="Maximum number of solver iterations")
    tol: float = Field(default=1e-4, gt=0.0, description="Stopping tolerance for solver")
    random_state: int = Field(default=42, description="Random seed for deterministic optimization")
    grid_index: int = Field(..., ge=0, description="Position index within the pre-defined hyperparameter grid")

    model_config = ConfigDict(frozen=True)


class CandidateEvaluationRecord(BaseModel):
    """
    Detailed validation metrics and evaluation outcome for a single hyperparameter candidate.
    """
    grid_index: int = Field(..., ge=0, description="Grid index of the evaluated candidate")
    C: float = Field(..., gt=0.0, description="Candidate C value")
    class_weight: Optional[str] = Field(default=None, description="Candidate class_weight value")
    metrics: ClassificationMetrics = Field(..., description="Full 3-class classification metrics on validation data")
    is_selected: bool = Field(default=False, description="Whether this candidate was selected as best")
    fit_time_seconds: Optional[float] = Field(default=None, ge=0.0, description="Wall-clock time to fit and evaluate")

    model_config = ConfigDict(frozen=True)


class LogisticRegressionTuningResult(BaseModel):
    """
    Comprehensive record of the hyperparameter tuning and model selection pipeline.
    """
    horizon: int = Field(..., ge=1, le=10, description="Prediction horizon h in trading sessions")
    candidates: List[CandidateEvaluationRecord] = Field(..., description="Evaluation records for all 12 grid candidates")
    selected_candidate: CandidateEvaluationRecord = Field(..., description="Best candidate selected via lexicographic ordering")
    selected_hyperparameters: LogisticRegressionHyperparameters = Field(..., description="Hyperparameters of the selected candidate")
    selection_rankings: List[int] = Field(..., description="Candidate indices ordered from best to worst")
    n_train_samples: int = Field(..., ge=1, description="Number of training observations used for fitting")
    n_val_samples: int = Field(..., ge=1, description="Number of validation observations used for evaluation")
    n_features: int = Field(default=23, ge=1, description="Number of input features")
    feature_names: List[str] = Field(..., description="Names of the approved features used")
    scaler_mean: List[float] = Field(..., description="Learned feature means from X_train")
    scaler_scale: List[float] = Field(..., description="Learned feature population std from X_train")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional audit diagnostics")

    model_config = ConfigDict(frozen=True)


class LogisticRegressionModelMetadata(BaseModel):
    """
    Audit metadata for a fitted Logistic Regression model instance.
    """
    horizon: Optional[int] = Field(default=None, description="Prediction horizon h in trading sessions")
    C: float = Field(..., gt=0.0, description="Regularization parameter C")
    class_weight: Optional[str] = Field(default=None, description="Class weight mode")
    solver: str = Field(default="lbfgs", description="Optimization solver")
    max_iter: int = Field(default=1000, description="Max solver iterations")
    tol: float = Field(default=1e-4, description="Solver tolerance")
    training_samples: int = Field(..., ge=1, description="Number of training observations used for fitting")
    feature_names: List[str] = Field(..., description="Names of the 23 features in exact column order")
    coefficients: Dict[str, List[float]] = Field(
        ...,
        description="Fitted weights per class: 'DOWN', 'NEUTRAL', 'UP'",
    )
    intercepts: Dict[str, float] = Field(
        ...,
        description="Fitted intercepts per class: 'DOWN', 'NEUTRAL', 'UP'",
    )
    classes: List[int] = Field(default=[-1, 0, 1], description="Canonical class labels in fixed column order")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional model diagnostics")

    model_config = ConfigDict(frozen=True)
