"""
StockSense AI — ML Service Target Labeling Schemas
Pydantic V2 models for multi-horizon executable target returns and 3-class target labeling.
"""

from enum import Enum
from typing import List, Optional, Dict, Any, Union
from pydantic import BaseModel, Field, ConfigDict, field_validator
from app.config import target_settings
from app.schemas.market_data import CandleInput


class TargetClass(str, Enum):
    """Categorical 3-class target label."""
    DOWN = "DOWN"
    NEUTRAL = "NEUTRAL"
    UP = "UP"


class TargetType(str, Enum):
    """
    Target return computation mode:
    - OPEN_TO_CLOSE: Executable forward return ((C[t+h] - O[t+1]) / O[t+1]) * 100 (Default / Production)
    - CLOSE_TO_CLOSE: Theoretical academic return ((C[t+h] - C[t]) / C[t]) * 100 (Diagnostic Baseline)
    """
    OPEN_TO_CLOSE = "open_to_close"
    CLOSE_TO_CLOSE = "close_to_close"


class TargetThresholdConfig(BaseModel):
    """
    Centralized threshold configuration for multi-horizon target labeling.
    Initial empirical research thresholds (unoptimized, heuristic).
    """
    horizons: List[int] = Field(
        default_factory=lambda: list(target_settings.default_horizons),
        description="Supported prediction horizons in sequential trading days",
    )
    thresholds: Dict[int, float] = Field(
        default_factory=lambda: dict(target_settings.thresholds),
        description="Symmetric percentage thresholds per horizon h: return < -theta => DOWN, > +theta => UP",
    )
    target_type: TargetType = Field(
        default=TargetType.OPEN_TO_CLOSE,
        description="Target calculation type: open_to_close (executable proxy) or close_to_close (academic)",
    )


class TargetRecord(BaseModel):
    """
    Structured target record for a specific signal session and horizon.
    """
    stock_id: Optional[str] = Field(default=None, description="Unique stock identifier / UUID")
    exchange_id: Optional[str] = Field(default=None, description="Exchange code or UUID (e.g. NSE, BSE)")
    stock_symbol: str = Field(..., description="Equity ticker symbol (e.g. RELIANCE)")
    signal_session_index: int = Field(..., ge=0, description="Sequential integer index t of signal session")
    signal_date: str = Field(..., description="Timestamp or date string of signal session t close")
    entry_session_index: int = Field(..., ge=0, description="Sequential integer index of entry session (t+1 for executable)")
    entry_date: str = Field(..., description="Timestamp or date string of entry session")
    entry_open_price: float = Field(..., gt=0, description="Opening price proxy for position entry (O[t+1])")
    prediction_horizon: int = Field(..., ge=1, description="Forward trading session horizon h in sessions")
    exit_session_index: int = Field(..., ge=0, description="Sequential integer index of exit session (t+h)")
    exit_date: str = Field(..., description="Timestamp or date string of exit session")
    exit_close_price: float = Field(..., gt=0, description="Closing price proxy for position exit (C[t+h])")
    executable_return_pct: float = Field(..., description="Executable return percentage: ((C[t+h] - O[t+1]) / O[t+1]) * 100")
    target_class: TargetClass = Field(..., description="Categorical target class: DOWN, NEUTRAL, UP")
    target_label: int = Field(..., description="Discrete integer target label: -1 (DOWN), 0 (NEUTRAL), +1 (UP)")

    model_config = ConfigDict(populate_by_name=True)

    @property
    def symbol(self) -> str:
        return self.stock_symbol

    @property
    def horizon(self) -> int:
        return self.prediction_horizon

    @property
    def return_pct(self) -> float:
        return self.executable_return_pct


class TargetExclusion(BaseModel):
    """
    Detailed audit record for an observation/horizon excluded from target generation.
    Enforces the rule that observations are never silently discarded.
    """
    stock_symbol: str = Field(..., description="Equity ticker symbol")
    signal_session_index: int = Field(..., description="Sequential integer index t of signal session")
    signal_date: str = Field(..., description="Timestamp or date string of signal session")
    prediction_horizon: int = Field(..., description="Prediction horizon h that could not be evaluated")
    reason: str = Field(..., description="Machine-readable exclusion reason code")
    details: Optional[Dict[str, Any]] = Field(default=None, description="Additional context or diagnostics")


class TargetGenerateRequest(BaseModel):
    """
    Request payload for target generation API endpoint.
    """
    symbol: Optional[str] = Field(default="UNKNOWN", description="Equity symbol (e.g. RELIANCE)")
    stock_id: Optional[str] = Field(default=None, description="Optional stock UUID")
    exchange_id: Optional[str] = Field(default="NSE", description="Optional exchange code")
    candles: List[CandleInput] = Field(..., min_length=2, description="Chronological OHLCV candles")
    horizons: Optional[List[int]] = Field(default=None, description="List of horizons (defaults to [1, 3, 5])")
    target_type: Optional[TargetType] = Field(default=TargetType.OPEN_TO_CLOSE, description="Target calculation type")
    thresholds: Optional[Dict[int, float]] = Field(default=None, description="Optional custom threshold overrides")
    validate_intermediate: bool = Field(default=True, description="Whether to validate continuity of intermediate sessions")
    expected_sessions: Optional[List[str]] = Field(
        default=None,
        description="Explicitly verified chronological list of trading session dates/timestamps for session continuity validation. Required by API endpoint to prevent silent bridging.",
    )

    @field_validator("expected_sessions")
    @classmethod
    def validate_expected_sessions_contract(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is not None:
            from app.services.targets import validate_expected_sessions
            return validate_expected_sessions(v)
        return v


class TargetGenerateResponse(BaseModel):
    """
    Response payload containing structured target records and exclusions audit.
    """
    symbol: str
    stock_id: Optional[str]
    exchange_id: Optional[str]
    total_candles: int
    total_signals_evaluated: int
    total_targets_generated: int
    total_exclusions: int
    targets: List[TargetRecord]
    exclusions: List[TargetExclusion]
    metadata: Dict[str, Any]
