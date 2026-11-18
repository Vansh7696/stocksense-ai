"""
StockSense AI — Technical Pattern & Breakout Analysis Schemas
Pydantic V2 models for candlestick pattern recognition, support/resistance detection,
and momentum/breakout signal synthesis.
"""

from typing import List, Optional, Dict, Any
from enum import Enum
from pydantic import BaseModel, Field


class PatternType(str, Enum):
    BULLISH = "BULLISH"
    BEARISH = "BEARISH"
    NEUTRAL = "NEUTRAL"


class SignalSeverity(str, Enum):
    STRONG = "STRONG"
    MODERATE = "MODERATE"
    MILD = "MILD"


class TechnicalStance(str, Enum):
    STRONG_BULLISH = "STRONG_BULLISH"
    BULLISH = "BULLISH"
    NEUTRAL = "NEUTRAL"
    BEARISH = "BEARISH"
    STRONG_BEARISH = "STRONG_BEARISH"


class LevelType(str, Enum):
    SUPPORT = "SUPPORT"
    RESISTANCE = "RESISTANCE"


class CandlestickPatternMatch(BaseModel):
    """A detected Japanese candlestick pattern occurrence."""
    name: str = Field(..., description="Canonical pattern name (e.g. Hammer, Bearish Engulfing)")
    code: str = Field(..., description="Machine-readable pattern identifier")
    pattern_type: PatternType = Field(..., description="Bullish, Bearish, or Neutral")
    bar_index: int = Field(..., description="0-indexed candle bar index where pattern completed")
    timestamp: Optional[str] = Field(None, description="ISO timestamp of the completing bar")
    price: float = Field(..., description="Reference close price at pattern completion")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Pattern reliability/confidence score")
    description: str = Field(..., description="Human-readable explanation of pattern implications")


class SupportResistanceLevel(BaseModel):
    """A detected support or resistance price zone."""
    level_type: LevelType = Field(..., description="SUPPORT or RESISTANCE")
    price: float = Field(..., description="Central price of the support/resistance level")
    touch_count: int = Field(..., ge=1, description="Number of historical touches/tests of this level")
    strength: float = Field(..., ge=0.0, le=1.0, description="Normalized strength score")
    distance_pct: float = Field(..., description="Percentage distance from current closing price")
    range_min: float = Field(..., description="Lower boundary of the price cluster")
    range_max: float = Field(..., description="Upper boundary of the price cluster")


class BreakoutSignal(BaseModel):
    """An active technical breakout or momentum trigger."""
    signal_type: str = Field(..., description="Identifier of the breakout/momentum signal")
    label: str = Field(..., description="Human-readable label for the signal")
    bias: PatternType = Field(..., description="BULLISH or BEARISH bias")
    severity: SignalSeverity = Field(..., description="Signal strength/conviction")
    indicator: str = Field(..., description="Technical indicator triggering signal (Donchian, RSI, MACD, Volume)")
    timestamp: Optional[str] = Field(None, description="Timestamp of signal detection")
    description: str = Field(..., description="Analytical commentary explaining the signal")


class IndicatorSnapshot(BaseModel):
    """Snapshot of primary technical indicator values on the latest bar."""
    rsi: Optional[float] = None
    macd_line: Optional[float] = None
    macd_signal: Optional[float] = None
    macd_histogram: Optional[float] = None
    sma_20: Optional[float] = None
    sma_50: Optional[float] = None
    sma_200: Optional[float] = None
    donchian_high_20: Optional[float] = None
    donchian_low_20: Optional[float] = None
    atr_14: Optional[float] = None
    rvol_20: Optional[float] = None
    close_price: float


class TechnicalAnalysisResponse(BaseModel):
    """Comprehensive technical analysis and pattern recognition response."""
    stance: TechnicalStance = Field(..., description="Overall synthesized technical stance")
    technical_score: float = Field(..., ge=-1.0, le=1.0, description="Composite score from -1.0 (strongly bearish) to +1.0 (strongly bullish)")
    summary: str = Field(..., description="Synthesized technical executive summary")
    patterns: List[CandlestickPatternMatch] = Field(default_factory=list, description="Detected candlestick patterns")
    support_resistance: List[SupportResistanceLevel] = Field(default_factory=list, description="Identified support and resistance zones")
    signals: List[BreakoutSignal] = Field(default_factory=list, description="Active breakout and momentum triggers")
    indicators: IndicatorSnapshot = Field(..., description="Key technical indicators on the latest candle")
    total_candles_analyzed: int = Field(..., description="Number of bars evaluated")
    meta: Dict[str, Any] = Field(default_factory=dict, description="Metadata and execution timing")
