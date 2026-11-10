"""
StockSense AI — ML Service Market Data Schemas
Pydantic V2 models for OHLCV input, technical indicators, and engineered features.
"""

from typing import List, Optional, Dict, Any, Union
from pydantic import BaseModel, Field, field_validator
from datetime import datetime


class CandleInput(BaseModel):
    """
    Standard OHLCV candlestick representation.
    """
    timestamp: Union[datetime, str] = Field(..., description="ISO 8601 UTC timestamp or date string")
    open: float = Field(..., description="Opening price")
    high: float = Field(..., description="Highest price during bar")
    low: float = Field(..., description="Lowest price during bar")
    close: float = Field(..., description="Closing price")
    volume: float = Field(..., ge=0, description="Trading volume (shares/contracts)")

    @field_validator("open", "high", "low", "close")
    @classmethod
    def validate_positive_prices(cls, v: float, info) -> float:
        if v < 0:
            raise ValueError(f"Price field '{info.field_name}' must be non-negative (received {v})")
        return float(v)

    @field_validator("high")
    @classmethod
    def validate_high_gte_low(cls, v: float, info) -> float:
        # High validation is checked at record level if values are available
        return float(v)


class IndicatorConfig(BaseModel):
    """
    Configuration parameters for technical indicators.
    """
    sma_periods: List[int] = Field(default=[20, 50, 200], description="SMA periods")
    ema_periods: List[int] = Field(default=[12, 26, 50], description="EMA periods")
    rsi_period: int = Field(default=14, ge=2, description="RSI period (Wilder's)")
    macd_fast: int = Field(default=12, ge=2, description="MACD fast EMA period")
    macd_slow: int = Field(default=26, ge=3, description="MACD slow EMA period")
    macd_signal: int = Field(default=9, ge=2, description="MACD signal line EMA period")
    bollinger_period: int = Field(default=20, ge=2, description="Bollinger Bands period")
    bollinger_std: float = Field(default=2.0, gt=0, description="Bollinger Bands standard deviation multiplier")
    atr_period: int = Field(default=14, ge=2, description="Average True Range period (Wilder's)")
    volatility_window: int = Field(default=20, ge=2, description="Rolling volatility window in trading days")
    volume_ma_period: int = Field(default=20, ge=2, description="Volume moving average period")


class IndicatorComputeRequest(BaseModel):
    """
    Request payload for technical indicator calculation.
    """
    symbol: Optional[str] = Field(default="UNKNOWN", description="Equity symbol (e.g. RELIANCE)")
    candles: List[CandleInput] = Field(..., min_length=1, description="Chronological OHLCV candles")
    config: Optional[IndicatorConfig] = Field(default_factory=IndicatorConfig, description="Indicator parameters")


class IndicatorSeries(BaseModel):
    """
    Calculated technical indicators aligned by timestamp.
    """
    timestamps: List[str]
    close: List[float]
    sma: Dict[str, List[Optional[float]]]
    ema: Dict[str, List[Optional[float]]]
    rsi: List[Optional[float]]
    macd: Dict[str, List[Optional[float]]]  # macd_line, signal_line, histogram
    bollinger_bands: Dict[str, List[Optional[float]]]  # upper, middle, lower, percent_b, bandwidth
    atr: List[Optional[float]]
    daily_returns_pct: List[Optional[float]]
    rolling_volatility_pct: List[Optional[float]]
    volume_sma: List[Optional[float]]
    relative_volume: List[Optional[float]]


class IndicatorComputeResponse(BaseModel):
    """
    Response payload containing technical indicator series and computation metadata.
    """
    symbol: str
    total_candles: int
    warmup_status: str
    indicators: IndicatorSeries
    latest: Dict[str, Any]
    metadata: Dict[str, Any]


class FeatureEngineerRequest(BaseModel):
    """
    Request payload for ML feature extraction.
    """
    symbol: Optional[str] = Field(default="UNKNOWN", description="Equity symbol")
    candles: List[CandleInput] = Field(..., min_length=1, description="Chronological OHLCV candles")
    drop_na: bool = Field(default=False, description="Whether to drop initial warm-up rows containing NaN")
    config: Optional[IndicatorConfig] = Field(default_factory=IndicatorConfig, description="Indicator parameters")


class FeatureEngineerResponse(BaseModel):
    """
    Response payload containing structured feature matrix for machine learning.
    """
    symbol: str
    total_rows: int
    feature_count: int
    feature_names: List[str]
    features: List[Dict[str, Any]]
    metadata: Dict[str, Any]
