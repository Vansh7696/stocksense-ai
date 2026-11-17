"""
StockSense AI — Random Forest Schemas
Pydantic V2 schemas for Random Forest hyperparameters, candidate records,
grid search specifications, and model audit metadata.
"""

from typing import Dict, List, Optional, Any, Union
from pydantic import BaseModel, Field, ConfigDict

from app.schemas.metrics import ClassificationMetrics


class RandomForestHyperparameters(BaseModel):
    """
    Hyperparameter configuration for a single Random Forest candidate.
    """
    n_estimators: int = Field(default=100, ge=10, description="Number of trees in the forest")
    max_depth: Optional[int] = Field(default=4, ge=1, le=20, description="Maximum tree depth")
    min_samples_leaf: int = Field(default=25, ge=1, description="Minimum number of samples required at a leaf node")
    max_features: Union[str, float] = Field(default="sqrt", description="Number or fraction of features to consider when looking for the best split")
    class_weight: Optional[str] = Field(default=None, description="Class weight mode: None or 'balanced'")
    bootstrap: bool = Field(default=True, description="Whether bootstrap samples are used when building trees")
    random_state: int = Field(default=42, description="Random seed for deterministic tree construction")
    grid_index: Optional[int] = Field(default=None, ge=0, description="Position index within the pre-defined hyperparameter grid")

    model_config = ConfigDict(frozen=True)


class RandomForestCandidateRecord(BaseModel):
    """
    Validation evaluation outcome for a single Random Forest candidate.
    """
    grid_index: int = Field(..., ge=0, description="Grid index of the evaluated candidate")
    hyperparameters: RandomForestHyperparameters = Field(..., description="Candidate hyperparameters")
    metrics: ClassificationMetrics = Field(..., description="Full 3-class classification metrics on outer validation data")
    is_selected: bool = Field(default=False, description="Whether this candidate was selected as champion")
    fit_time_seconds: Optional[float] = Field(default=None, ge=0.0, description="Wall-clock time to fit and evaluate")

    model_config = ConfigDict(frozen=True)


class RandomForestTuningResult(BaseModel):
    """
    Comprehensive record of the Random Forest hyperparameter tuning pipeline.
    """
    horizon: int = Field(..., ge=1, le=10, description="Prediction horizon h in trading sessions")
    candidates: List[RandomForestCandidateRecord] = Field(..., description="Evaluation records for all grid candidates")
    selected_candidate: RandomForestCandidateRecord = Field(..., description="Best candidate selected via validation criteria")
    selected_hyperparameters: RandomForestHyperparameters = Field(..., description="Hyperparameters of the champion candidate")
    selection_rankings: List[int] = Field(..., description="Candidate indices ordered from best to worst")
    n_train_samples: int = Field(..., ge=1, description="Number of training observations used for fitting")
    n_val_samples: int = Field(..., ge=1, description="Number of validation observations used for evaluation")
    n_features: int = Field(default=23, ge=1, description="Number of input features")
    feature_names: List[str] = Field(..., description="Names of the approved features used")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional audit diagnostics")

    model_config = ConfigDict(frozen=True)


class RandomForestModelMetadata(BaseModel):
    """
    Audit metadata for a fitted Random Forest model instance.
    """
    horizon: Optional[int] = Field(default=None, description="Prediction horizon h in trading sessions")
    n_estimators: int = Field(..., description="Number of fitted trees")
    max_depth: Optional[int] = Field(default=None, description="Maximum tree depth")
    min_samples_leaf: int = Field(..., description="Min samples per leaf")
    max_features: Union[str, float] = Field(..., description="Max features specification")
    class_weight: Optional[str] = Field(default=None, description="Class weight mode")
    bootstrap: bool = Field(default=True, description="Bootstrap sampling enabled")
    random_state: int = Field(default=42, description="Random seed")
    feature_importances: Optional[Dict[str, float]] = Field(default=None, description="Gini feature importances")

    model_config = ConfigDict(frozen=True)
