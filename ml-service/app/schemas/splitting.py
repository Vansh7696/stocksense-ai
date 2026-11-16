"""
StockSense AI — ML Service Chronological Splitting & Purging Schemas
Pydantic V2 models for purged grouped chronological train/val/test splitting,
boundary accounting, and scaler isolation metadata.
"""

import math
from enum import Enum
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field, ConfigDict, model_validator
from app.config import validation_settings


class SplitPartition(str, Enum):
    """Categorical chronological dataset partition."""
    TRAIN = "train"
    VAL = "val"
    TEST = "test"
    PURGED = "purged"


class SplitConfig(BaseModel):
    """
    Configuration for chronological dataset splitting with boundary purging.
    Defaults to approved Phase 5C.1 baseline: 70% Train, 15% Val, 15% Test with E=0 embargo.
    """
    train_ratio: float = Field(
        default_factory=lambda: validation_settings.train_ratio,
        gt=0.0,
        lt=1.0,
        description="Nominal training set proportion",
    )
    val_ratio: float = Field(
        default_factory=lambda: validation_settings.val_ratio,
        gt=0.0,
        lt=1.0,
        description="Nominal validation set proportion",
    )
    test_ratio: float = Field(
        default_factory=lambda: validation_settings.test_ratio,
        gt=0.0,
        lt=1.0,
        description="Nominal held-out test set proportion",
    )
    horizons: List[int] = Field(
        default_factory=lambda: list(validation_settings.default_horizons),
        description="Prediction horizons to generate purged split bundles for",
    )
    embargo_dates: int = Field(
        default_factory=lambda: validation_settings.embargo_dates,
        ge=0,
        description="Additional blackout embargo dates applied after partition boundaries (default: E=0)",
    )

    model_config = ConfigDict(extra="ignore")

    @model_validator(mode="after")
    def validate_ratios_sum(self) -> "SplitConfig":
        total = self.train_ratio + self.val_ratio + self.test_ratio
        if not math.isclose(total, 1.0, rel_tol=1e-4):
            raise ValueError(
                f"Split ratios must sum to 1.0 (got {self.train_ratio} + {self.val_ratio} + {self.test_ratio} = {total:.4f})"
            )
        return self


class PartitionBoundary(BaseModel):
    """
    Metadata describing the exact date and clean integer index span of a nominal partition.
    """
    name: SplitPartition
    nominal_dates_count: int = Field(..., ge=1, description="Number of unique calendar dates in partition")
    start_date: str = Field(..., description="First session date in nominal partition (YYYY-MM-DD)")
    end_date: str = Field(..., description="Last session date in nominal partition (YYYY-MM-DD)")
    start_index: int = Field(..., ge=0, description="Starting 0-based integer index in clean date array")
    end_index: int = Field(..., ge=0, description="Ending 0-based integer index in clean date array (inclusive)")


class HorizonPurgeAccounting(BaseModel):
    """
    Exhaustive audit record of pre-purge observations, boundary purges,
    and post-purge retained observations for a single prediction horizon h.
    Enforces the rule that boundary purges and end-of-series exclusions are kept separate and never double-counted.
    """
    horizon: int = Field(..., ge=1, description="Prediction horizon in trading sessions (1, 3, 5)")
    pre_purge_targets_count: int = Field(..., ge=0, description="Total valid target observations before boundary purging")

    # Boundary purges (discarded exclusively to prevent forward target leakage)
    train_boundary_purged_count: int = Field(..., ge=0, description="Observations purged from end of Train set")
    val_boundary_purged_count: int = Field(..., ge=0, description="Observations purged from end of Validation set")
    total_boundary_purged_count: int = Field(..., ge=0, description="Total observations purged at partition boundaries")

    # Retained observations
    retained_train_count: int = Field(..., ge=0, description="Retained observation count in Train partition")
    retained_val_count: int = Field(..., ge=0, description="Retained observation count in Validation partition")
    retained_test_count: int = Field(..., ge=0, description="Retained observation count in Held-Out Test partition")
    total_retained_count: int = Field(..., ge=0, description="Total retained observations across all partitions")

    # Target-generation exclusions (tracked separately, never counted as boundary purges)
    end_of_dataset_exclusions_count: int = Field(..., ge=0, description="Series-end exclusions from target generation")

    # Class distributions in retained sets
    train_class_counts: Dict[str, int] = Field(default_factory=dict, description="Retained Train class counts")
    val_class_counts: Dict[str, int] = Field(default_factory=dict, description="Retained Validation class counts")
    test_class_counts: Dict[str, int] = Field(default_factory=dict, description="Retained Test class counts")

    # Date-level purge audit
    purged_train_dates: List[str] = Field(default_factory=list, description="Exact calendar dates purged from Train")
    purged_val_dates: List[str] = Field(default_factory=list, description="Exact calendar dates purged from Validation")


class SplitDataBundle(BaseModel):
    """
    Container for partitioned features and targets for a specific horizon h.
    Holds metadata and summary information. In-memory pandas DataFrames are accessible via helper properties.
    """
    horizon: int = Field(..., ge=1, description="Prediction horizon h")
    feature_names: List[str] = Field(..., description="List of approved engineered feature column names in X")
    target_name: str = Field(default="target_label", description="Name of discrete integer label column in y")

    # Accounting metadata
    accounting: HorizonPurgeAccounting
    metadata: Dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(arbitrary_types_allowed=True, extra="ignore")


class PurgedSplitResult(BaseModel):
    """
    Complete output container for purged grouped chronological splitting across all configured horizons.
    """
    boundaries: Dict[str, PartitionBoundary]
    bundles: Dict[int, SplitDataBundle] = Field(default_factory=dict)
    accounting: Dict[int, HorizonPurgeAccounting]
    total_clean_dates: int = Field(..., ge=1)
    metadata: Dict[str, Any] = Field(default_factory=dict)
