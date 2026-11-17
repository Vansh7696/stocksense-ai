"""
StockSense AI — XGBoost Schemas
Pydantic V2 schemas for XGBoost hyperparameters, candidate records,
grid search specifications, and model audit metadata.
"""

from typing import Dict, List, Optional, Any, Union
from pydantic import BaseModel, Field, ConfigDict

from app.schemas.metrics import ClassificationMetrics


class XGBoostHyperparameters(BaseModel):
    """
    Hyperparameter configuration for a single XGBoost candidate.
    """
    learning_rate: float = Field(default=0.03, gt=0.0, le=1.0, description="Boosting shrinkage parameter (eta)")
    max_depth: int = Field(default=3, ge=1, le=15, description="Maximum tree depth for base learners")
    subsample: float = Field(default=0.85, gt=0.0, le=1.0, description="Subsample ratio of the training instances")
    reg_lambda: float = Field(default=5.0, ge=0.0, description="L2 regularization term on weights")
    gamma: float = Field(default=0.5, ge=0.0, description="Minimum loss reduction required to make a further partition (min_split_loss)")
    colsample_bytree: float = Field(default=0.8, gt=0.0, le=1.0, description="Subsample ratio of columns when constructing each tree")
    min_child_weight: float = Field(default=15.0, ge=0.0, description="Minimum sum of instance weight (Hessian) needed in a child")
    objective: str = Field(default="multi:softprob", description="Learning objective function")
    num_class: int = Field(default=3, ge=2, description="Number of target classes")
    n_estimators: int = Field(default=200, ge=1, description="Maximum number of boosting trees")
    random_state: int = Field(default=42, description="Random number seed")
    eval_metric: str = Field(default="mlogloss", description="Evaluation metric for validation / early stopping")
    early_stopping_rounds: Optional[int] = Field(default=15, ge=1, description="Validation rounds for early stopping")
    grid_index: Optional[int] = Field(default=None, ge=0, description="Position index within the pre-defined hyperparameter grid")

    model_config = ConfigDict(frozen=True)


class XGBoostCandidateRecord(BaseModel):
    """
    Validation evaluation outcome for a single XGBoost candidate.
    """
    grid_index: int = Field(..., ge=0, description="Grid index of the evaluated candidate")
    hyperparameters: XGBoostHyperparameters = Field(..., description="Candidate hyperparameters")
    best_iteration: Optional[int] = Field(default=None, ge=0, description="Optimal boosting round determined on inner validation fold")
    metrics: ClassificationMetrics = Field(..., description="Full 3-class classification metrics on outer validation data")
    is_selected: bool = Field(default=False, description="Whether this candidate was selected as champion")
    fit_time_seconds: Optional[float] = Field(default=None, ge=0.0, description="Wall-clock time to fit and evaluate")

    model_config = ConfigDict(frozen=True)


class XGBoostTuningResult(BaseModel):
    """
    Comprehensive record of the XGBoost hyperparameter tuning pipeline.
    """
    horizon: int = Field(..., ge=1, le=10, description="Prediction horizon h in trading sessions")
    candidates: List[XGBoostCandidateRecord] = Field(..., description="Evaluation records for all grid candidates")
    selected_candidate: XGBoostCandidateRecord = Field(..., description="Best candidate selected via validation criteria")
    selected_hyperparameters: XGBoostHyperparameters = Field(..., description="Hyperparameters of the champion candidate")
    selection_rankings: List[int] = Field(..., description="Candidate indices ordered from best to worst")
    n_train_samples: int = Field(..., ge=1, description="Number of training observations used for fitting")
    n_val_samples: int = Field(..., ge=1, description="Number of validation observations used for evaluation")
    n_features: int = Field(default=23, ge=1, description="Number of input features")
    feature_names: List[str] = Field(..., description="Names of the approved features used")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional audit diagnostics")

    model_config = ConfigDict(frozen=True)


class XGBoostModelMetadata(BaseModel):
    """
    Audit metadata for a fitted XGBoost model instance.
    """
    horizon: Optional[int] = Field(default=None, description="Prediction horizon h in trading sessions")
    learning_rate: float = Field(..., description="Learning rate / shrinkage")
    max_depth: int = Field(..., description="Maximum tree depth")
    subsample: float = Field(..., description="Row subsample ratio")
    reg_lambda: float = Field(..., description="L2 leaf regularization")
    gamma: float = Field(..., description="Split loss threshold penalty")
    colsample_bytree: float = Field(..., description="Column subsample ratio")
    min_child_weight: float = Field(..., description="Minimum child weight (Hessian sum)")
    n_estimators: int = Field(..., description="Max boosting iterations")
    best_iteration: Optional[int] = Field(default=None, description="Optimal iteration selected via early stopping")
    objective: str = Field(default="multi:softprob", description="Objective name")
    random_state: int = Field(default=42, description="Random seed")
    feature_importances: Optional[Dict[str, float]] = Field(default=None, description="Gain-based feature importances")

    model_config = ConfigDict(frozen=True)
