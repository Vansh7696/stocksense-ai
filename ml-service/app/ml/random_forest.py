"""
StockSense AI — Random Forest ML Interface
Programmatic interface for Random Forest classification,
hyperparameter search grid construction, and model instantiation.
"""

from app.schemas.random_forest import (
    RandomForestHyperparameters,
    RandomForestCandidateRecord,
    RandomForestTuningResult,
    RandomForestModelMetadata,
)
from app.services.random_forest import (
    RandomForestModel,
    create_random_forest_model,
    get_random_forest_search_grid,
    tune_random_forest,
    RF_GRID_N_ESTIMATORS,
    RF_GRID_MAX_DEPTH,
    RF_GRID_MIN_SAMPLES_LEAF,
    RF_GRID_MAX_FEATURES,
    EXTERNAL_LABELS,
    INTERNAL_CLASSES,
    EXTERNAL_TO_INTERNAL,
    INTERNAL_TO_EXTERNAL,
)

__all__ = [
    "RandomForestHyperparameters",
    "RandomForestCandidateRecord",
    "RandomForestTuningResult",
    "RandomForestModelMetadata",
    "RandomForestModel",
    "create_random_forest_model",
    "get_random_forest_search_grid",
    "tune_random_forest",
    "RF_GRID_N_ESTIMATORS",
    "RF_GRID_MAX_DEPTH",
    "RF_GRID_MIN_SAMPLES_LEAF",
    "RF_GRID_MAX_FEATURES",
    "EXTERNAL_LABELS",
    "INTERNAL_CLASSES",
    "EXTERNAL_TO_INTERNAL",
    "INTERNAL_TO_EXTERNAL",
]
