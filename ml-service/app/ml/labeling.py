"""
StockSense AI — Target Labeling Interface
Provides direct functional access to target calculation and labeling engines.
Preserves compatibility with Phase 5C.1 Addendum Section 6.4 specifications.
"""

from typing import List, Dict, Optional
import pandas as pd

from app.services.targets import (
    generate_targets,
    calculate_executable_return,
    calculate_close_to_close_return,
    classify_target,
    TargetService,
    TargetGenerationResult,
)
from app.schemas.targets import (
    TargetClass,
    TargetType,
    TargetRecord,
    TargetExclusion,
    TargetThresholdConfig,
)

__all__ = [
    "generate_targets",
    "calculate_executable_return",
    "calculate_close_to_close_return",
    "classify_target",
    "TargetService",
    "TargetGenerationResult",
    "TargetClass",
    "TargetType",
    "TargetRecord",
    "TargetExclusion",
    "TargetThresholdConfig",
]
