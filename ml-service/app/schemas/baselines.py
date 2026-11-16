"""
StockSense AI — Baseline Model Schemas
Pydantic V2 schemas for baseline classifier configurations and metadata.
Models: MajorityClassifier, MomentumBaseline.
"""

from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field, ConfigDict


class MajorityClassifierMetadata(BaseModel):
    """
    Audit metadata for a fitted MajorityClassifier baseline instance.
    """
    majority_class: int = Field(..., description="Fitted majority target class in {-1, 0, 1}")
    class_frequencies: Dict[str, float] = Field(
        ...,
        description="Empirical training class frequencies for DOWN (-1), NEUTRAL (0), UP (+1)",
    )
    training_samples: int = Field(..., ge=1, description="Number of training observations used for fitting")
    tie_broken: bool = Field(default=False, description="Whether deterministic tie-breaking was invoked")
    tie_breaker_priority: List[int] = Field(
        default=[0, 1, -1],
        description="Deterministic tie-breaking priority order (NEUTRAL > UP > DOWN)",
    )
    horizon: Optional[int] = Field(default=None, description="Prediction horizon h in trading sessions (1, 3, 5)")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional context or diagnostics")

    model_config = ConfigDict(frozen=True)


class MomentumBaselineMetadata(BaseModel):
    """
    Audit metadata for a fitted MomentumBaseline instance.
    """
    horizon: Optional[int] = Field(default=None, description="Prediction horizon h in trading sessions (1, 3, 5)")
    threshold_delta: float = Field(..., ge=0.0, description="Training return standard deviation threshold delta_h (ddof=1)")
    temperature: float = Field(..., ge=0.01, le=100.0, description="Calibrated softmax temperature tau")
    training_samples: int = Field(..., ge=1, description="Number of training observations used for threshold fitting")
    training_mean_return: float = Field(..., description="Mean of raw return_1d in training partition")
    training_std_return: float = Field(..., description="Sample standard deviation (ddof=1) of return_1d in training partition")
    optimization_success: bool = Field(..., description="Whether bounded temperature optimization converged successfully")
    optimization_nll: Optional[float] = Field(default=None, description="Training negative log-likelihood at optimal tau")
    optimizer_candidate_temperature: Optional[float] = Field(
        default=None, description="Optimizer candidate temperature tau before endpoint comparison"
    )
    optimizer_candidate_nll: Optional[float] = Field(
        default=None, description="Training NLL at optimizer candidate temperature"
    )
    endpoint_lower_nll: Optional[float] = Field(
        default=None, description="Training NLL evaluated at lower endpoint (tau=0.1)"
    )
    endpoint_upper_nll: Optional[float] = Field(
        default=None, description="Training NLL evaluated at upper endpoint (tau=10.0)"
    )
    selected_candidate_type: Optional[str] = Field(
        default=None, description="Source of selected temperature: 'lower_endpoint', 'upper_endpoint', or 'optimizer_interior'"
    )
    feature_name: str = Field(default="return_1d", description="Raw return feature name used for thresholding")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional context or diagnostics")

    model_config = ConfigDict(frozen=True)
