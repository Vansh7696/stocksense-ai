"""
StockSense AI — Financial News & Market Sentiment Schemas (Phase 5C.9)
Pydantic V2 models for headline sentiment scoring, equity-level sentiment aggregation,
and multi-factor technical + sentiment Bayesian fusion.
"""

from enum import Enum
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field, ConfigDict, field_validator


class SentimentLabel(str, Enum):
    """Canonical 3-state sentiment classifications."""
    BEARISH = "BEARISH"
    NEUTRAL = "NEUTRAL"
    BULLISH = "BULLISH"


class AlignmentStatus(str, Enum):
    """Multi-factor directional alignment between technical ML and news sentiment."""
    CONFIRMING = "CONFIRMING"
    CONTRADICTING = "CONTRADICTING"
    NEUTRAL_ALIGNMENT = "NEUTRAL_ALIGNMENT"


class HeadlineItem(BaseModel):
    """Individual financial news headline or commentary."""
    model_config = ConfigDict(extra="forbid")

    id: Optional[str] = Field(default=None, description="Unique headline identifier")
    title: str = Field(..., min_length=3, description="Headline text")
    source: str = Field(default="Financial News", description="Publisher or news agency")
    published_at: str = Field(..., description="ISO 8601 publication timestamp")
    url: Optional[str] = Field(default=None, description="Article reference URL")


class AnalyzedHeadline(BaseModel):
    """Headline augmented with sentiment polarity and key term attributions."""
    model_config = ConfigDict(extra="forbid")

    id: Optional[str] = None
    title: str
    source: str
    published_at: str
    polarity: float = Field(..., ge=-1.0, le=1.0, description="Signed sentiment polarity in [-1.0, +1.0]")
    label: SentimentLabel
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence in sentiment score")
    key_drivers: List[str] = Field(default_factory=list, description="Terms that drove sentiment score")


class SentimentAnalysisRequest(BaseModel):
    """Batch sentiment analysis request."""
    model_config = ConfigDict(extra="forbid")

    symbol: Optional[str] = Field(default=None, description="NSE/BSE equity ticker")
    headlines: List[HeadlineItem] = Field(..., min_length=1, description="List of headlines to analyze")


class SentimentSummaryResponse(BaseModel):
    """Aggregated sentiment index and scored news feed for an equity."""
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(..., description="Equity ticker symbol")
    overall_polarity: float = Field(..., ge=-1.0, le=1.0, description="Weighted average polarity in [-1.0, +1.0]")
    overall_label: SentimentLabel
    confidence: float = Field(..., ge=0.0, le=1.0)
    sample_count: int = Field(..., ge=0)
    bullish_ratio: float = Field(..., ge=0.0, le=1.0)
    bearish_ratio: float = Field(..., ge=0.0, le=1.0)
    neutral_ratio: float = Field(..., ge=0.0, le=1.0)
    headlines: List[AnalyzedHeadline]
    analyzed_at_utc: str


class MultiFactorFusionRequest(BaseModel):
    """Request to fuse quantitative technical probabilities with news sentiment."""
    model_config = ConfigDict(extra="forbid")

    symbol: str
    horizon: int = Field(..., description="Target forecast horizon (1, 3, or 5)")
    technical_probabilities: Dict[str, float] = Field(
        ...,
        description="Calibrated technical probability distribution: {'DOWN': p, 'NEUTRAL': p, 'UP': p}",
    )
    sentiment_polarity: float = Field(..., ge=-1.0, le=1.0, description="Observed sentiment polarity")
    fusion_weight: float = Field(default=0.25, ge=0.0, le=0.5, description="Sentiment adjustment influence factor")


class MultiFactorFusionResponse(BaseModel):
    """Result of combining quantitative technical predictions with qualitative news sentiment."""
    model_config = ConfigDict(extra="forbid")

    symbol: str
    horizon: int
    technical_probabilities: Dict[str, float]
    sentiment_polarity: float
    fused_probabilities: Dict[str, float]
    fused_label: str
    confidence: float
    alignment: AlignmentStatus
    alignment_description: str
