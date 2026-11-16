"""
StockSense AI — Baseline Classifiers ML Interface
Programmatic interface for MajorityClassifier and MomentumBaseline benchmark models.
"""

from app.schemas.baselines import (
    MajorityClassifierMetadata,
    MomentumBaselineMetadata,
)
from app.services.baselines import (
    MajorityClassifier,
    MomentumBaseline,
    CANONICAL_LABELS,
    RETURN_1D_FEATURE_NAME,
    deterministic_argmax_with_neutral_tie,
)

__all__ = [
    "MajorityClassifierMetadata",
    "MomentumBaselineMetadata",
    "MajorityClassifier",
    "MomentumBaseline",
    "CANONICAL_LABELS",
    "RETURN_1D_FEATURE_NAME",
    "deterministic_argmax_with_neutral_tie",
]
