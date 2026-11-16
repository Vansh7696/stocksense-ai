"""
StockSense AI — Classification Metrics ML Interface
Programmatic interface for 3-class stock return direction forecasting metrics.
"""

from app.schemas.metrics import (
    ClassMetricDetail,
    ConfusionMatrixData,
    CatastrophicErrorDetail,
    ClassificationMetrics,
)
from app.services.metrics import (
    CLASS_LABELS,
    CLASS_NAMES,
    LABEL_TO_INDEX,
    INDEX_TO_LABEL,
    LABEL_TO_NAME,
    NAME_TO_LABEL,
    NAME_TO_INDEX,
    INDEX_TO_NAME,
    DEFAULT_EPSILON,
    validate_classification_inputs,
    validate_and_normalize_probabilities,
    compute_confusion_matrix,
    compute_catastrophic_error,
    compute_multiclass_log_loss,
    compute_brier_score,
    compute_classification_metrics,
    MetricsEngine,
)

__all__ = [
    "ClassMetricDetail",
    "ConfusionMatrixData",
    "CatastrophicErrorDetail",
    "ClassificationMetrics",
    "CLASS_LABELS",
    "CLASS_NAMES",
    "LABEL_TO_INDEX",
    "INDEX_TO_LABEL",
    "LABEL_TO_NAME",
    "NAME_TO_LABEL",
    "NAME_TO_INDEX",
    "INDEX_TO_NAME",
    "DEFAULT_EPSILON",
    "validate_classification_inputs",
    "validate_and_normalize_probabilities",
    "compute_confusion_matrix",
    "compute_catastrophic_error",
    "compute_multiclass_log_loss",
    "compute_brier_score",
    "compute_classification_metrics",
    "MetricsEngine",
]
