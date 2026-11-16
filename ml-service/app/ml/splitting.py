"""
StockSense AI — Purged Grouped Chronological Splitting ML Interface
Exposes clean programmatic access to purged chronological splitting,
feature-target join integrity validation, and scaler isolation.
"""

from app.schemas.splitting import (
    SplitPartition,
    SplitConfig,
    PartitionBoundary,
    HorizonPurgeAccounting,
    SplitDataBundle,
    PurgedSplitResult,
)
from app.services.splitting import (
    StandardScaler,
    PurgedChronologicalSplitter,
    fit_transform_scaler,
    get_purged_splits,
    FUTURE_OR_TARGET_DERIVED_COLUMNS,
    APPROVED_FEATURE_ALLOWLIST,
)

__all__ = [
    "SplitPartition",
    "SplitConfig",
    "PartitionBoundary",
    "HorizonPurgeAccounting",
    "SplitDataBundle",
    "PurgedSplitResult",
    "StandardScaler",
    "PurgedChronologicalSplitter",
    "fit_transform_scaler",
    "get_purged_splits",
    "FUTURE_OR_TARGET_DERIVED_COLUMNS",
    "APPROVED_FEATURE_ALLOWLIST",
]
