"""
StockSense AI — Logistic Regression ML Interface
Programmatic interface for Multinomial L2 Logistic Regression classification,
hyperparameter grid construction, and train/validation tuning pipeline.
"""

from app.schemas.logistic_regression import (
    LogisticRegressionHyperparameters,
    CandidateEvaluationRecord,
    LogisticRegressionTuningResult,
    LogisticRegressionModelMetadata,
)
from app.services.logistic_regression import (
    MultinomialLogisticRegression,
    get_logistic_regression_hyperparameter_grid,
    tune_logistic_regression,
    GRID_C_VALUES,
    GRID_CLASS_WEIGHTS,
    EXTERNAL_LABELS,
    INTERNAL_CLASSES,
)

__all__ = [
    "LogisticRegressionHyperparameters",
    "CandidateEvaluationRecord",
    "LogisticRegressionTuningResult",
    "LogisticRegressionModelMetadata",
    "MultinomialLogisticRegression",
    "get_logistic_regression_hyperparameter_grid",
    "tune_logistic_regression",
    "GRID_C_VALUES",
    "GRID_CLASS_WEIGHTS",
    "EXTERNAL_LABELS",
    "INTERNAL_CLASSES",
]
