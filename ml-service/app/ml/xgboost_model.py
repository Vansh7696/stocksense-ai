"""
StockSense AI — XGBoost ML Interface
Programmatic interface for XGBoost gradient-boosted tree classification,
hyperparameter search grid construction, and model instantiation.
"""

from app.schemas.xgboost_model import (
    XGBoostHyperparameters,
    XGBoostCandidateRecord,
    XGBoostTuningResult,
    XGBoostModelMetadata,
)
from app.services.xgboost_model import (
    XGBoostModel,
    create_xgboost_model,
    get_xgboost_search_grid,
    tune_xgboost,
    XGBoostDependencyError,
    XGB_GRID_LEARNING_RATE,
    XGB_GRID_MAX_DEPTH,
    XGB_GRID_SUBSAMPLE,
    XGB_GRID_REG_LAMBDA,
    XGB_GRID_GAMMA,
    EXTERNAL_LABELS,
    INTERNAL_CLASSES,
    EXTERNAL_TO_INTERNAL,
    INTERNAL_TO_EXTERNAL,
)

__all__ = [
    "XGBoostHyperparameters",
    "XGBoostCandidateRecord",
    "XGBoostTuningResult",
    "XGBoostModelMetadata",
    "XGBoostModel",
    "create_xgboost_model",
    "get_xgboost_search_grid",
    "tune_xgboost",
    "XGBoostDependencyError",
    "XGB_GRID_LEARNING_RATE",
    "XGB_GRID_MAX_DEPTH",
    "XGB_GRID_SUBSAMPLE",
    "XGB_GRID_REG_LAMBDA",
    "XGB_GRID_GAMMA",
    "EXTERNAL_LABELS",
    "INTERNAL_CLASSES",
    "EXTERNAL_TO_INTERNAL",
    "INTERNAL_TO_EXTERNAL",
]
