"""
StockSense AI — Classification Metrics Schemas
Pydantic V2 schemas for deterministic 3-class directional classification metrics.
Classes: DOWN (-1), NEUTRAL (0), UP (+1).
"""

from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field, ConfigDict


class ClassMetricDetail(BaseModel):
    """
    Per-class evaluation metrics for a single target class.
    """
    precision: float = Field(..., ge=0.0, le=1.0, description="Precision: TP / (TP + FP) or 0.0 if unpredicted")
    recall: float = Field(..., ge=0.0, le=1.0, description="Recall: TP / (TP + FN) or 0.0 if class unobserved")
    f1: float = Field(..., ge=0.0, le=1.0, description="Harmonic mean of precision and recall: 2*P*R / (P + R) or 0.0")
    support: int = Field(..., ge=0, description="Actual ground-truth sample count for this class")

    model_config = ConfigDict(frozen=True)


class ConfusionMatrixData(BaseModel):
    """
    Structured 3x3 confusion matrix container with explicit fixed ordering:
    Rows = Actual classes [DOWN, NEUTRAL, UP]
    Columns = Predicted classes [DOWN, NEUTRAL, UP]
    """
    matrix: List[List[int]] = Field(
        ...,
        description="3x3 confusion matrix: matrix[actual_idx][pred_idx] where 0=DOWN, 1=NEUTRAL, 2=UP",
    )
    class_order: List[str] = Field(
        default=["DOWN", "NEUTRAL", "UP"],
        description="Fixed categorical class names corresponding to rows and columns [0, 1, 2]",
    )
    class_labels: List[int] = Field(
        default=[-1, 0, 1],
        description="Fixed integer target labels corresponding to rows and columns [0, 1, 2]",
    )

    model_config = ConfigDict(frozen=True)


class CatastrophicErrorDetail(BaseModel):
    """
    Audit record for severe opposite-direction forecasting errors:
    Actual DOWN (-1) predicted as UP (+1), or Actual UP (+1) predicted as DOWN (-1).
    """
    count: int = Field(..., ge=0, description="Total count of catastrophic opposite-direction errors")
    rate: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Catastrophic error rate against ALL evaluated samples: count / total_samples",
    )
    down_to_up_count: int = Field(..., ge=0, description="Count of actual DOWN (-1) predicted as UP (+1)")
    up_to_down_count: int = Field(..., ge=0, description="Count of actual UP (+1) predicted as DOWN (-1)")
    total_samples: int = Field(..., ge=0, description="Primary denominator: total sample count evaluated")
    directional_samples_count: int = Field(
        ...,
        ge=0,
        description="Secondary denominator: actual non-neutral observations (support_DOWN + support_UP)",
    )
    directional_subset_rate: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Catastrophic error rate restricted to directional actuals: count / (support_DOWN + support_UP)",
    )

    model_config = ConfigDict(frozen=True)


class ClassificationMetrics(BaseModel):
    """
    Deterministic classification metrics container for 3-class directional prediction.
    Enforces strict typing, immutable attributes, and comprehensive auditability.
    """
    # Global overall classification metrics
    accuracy: float = Field(..., ge=0.0, le=1.0, description="Overall accuracy: correct / total_samples")
    balanced_accuracy: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Average recall across classes actually present in y_true (matches sklearn.metrics.balanced_accuracy_score)",
    )
    macro_precision: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Unweighted arithmetic mean of per-class precision across fixed class set [-1, 0, 1]",
    )
    macro_recall: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Unweighted arithmetic mean of per-class recall across fixed class set [-1, 0, 1] with zero recall for unobserved classes",
    )
    macro_f1: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Unweighted arithmetic mean of per-class F1 score across fixed class set [-1, 0, 1]",
    )

    # Per-class metrics
    per_class: Dict[str, ClassMetricDetail] = Field(
        ...,
        description="Mapping of class name ('DOWN', 'NEUTRAL', 'UP') to ClassMetricDetail",
    )

    # Confusion matrix
    confusion_matrix: List[List[int]] = Field(
        ...,
        description="3x3 confusion matrix: rows=actual [-1, 0, 1], cols=predicted [-1, 0, 1]",
    )

    # Catastrophic error metrics
    catastrophic_error: CatastrophicErrorDetail = Field(
        ...,
        description="Audit record of catastrophic directional errors (DOWN<->UP)",
    )

    # Probabilistic metrics (None if probabilities not supplied)
    log_loss: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Multiclass cross-entropy log loss with epsilon clipping and re-normalization",
    )
    brier_score: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=2.0,
        description="Standard multiclass Brier score: mean(sum((p_k - y_k)^2)). Range [0, 2]",
    )

    # Sample audit and metadata
    total_samples: int = Field(..., ge=1, description="Total number of evaluated samples N")
    horizon: Optional[int] = Field(default=None, description="Prediction horizon h in trading sessions (1, 3, 5)")
    model_name: Optional[str] = Field(default=None, description="Name or identifier of the evaluated model")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional context or diagnostics")

    model_config = ConfigDict(frozen=True)
