from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List, Dict


class TargetSettings(BaseModel):
    """
    Centralized threshold configuration for multi-horizon executable target generation.
    These are initial empirical research thresholds (unoptimized, heuristic),
    providing wide neutral noise buffers.
    """
    default_horizons: List[int] = Field(
        default=[1, 3, 5],
        description="Supported prediction horizons in trading days",
    )
    thresholds: Dict[int, float] = Field(
        default={1: 0.50, 3: 1.00, 5: 1.50},
        description="Symmetric percentage thresholds per horizon h: return < -theta => DOWN, > +theta => UP",
    )
    class_down: str = "DOWN"
    class_neutral: str = "NEUTRAL"
    class_up: str = "UP"
    label_down: int = -1
    label_neutral: int = 0
    label_up: int = 1


target_settings = TargetSettings()


class ValidationSettings(BaseModel):
    """
    Centralized validation and chronological splitting configuration.
    Defines baseline 70/15/15 chronological partition ratios and initial zero embargo.
    """
    train_ratio: float = Field(default=0.70, description="Nominal train partition ratio (0.70 = 70%)")
    val_ratio: float = Field(default=0.15, description="Nominal validation partition ratio (0.15 = 15%)")
    test_ratio: float = Field(default=0.15, description="Nominal held-out test partition ratio (0.15 = 15%)")
    default_horizons: List[int] = Field(default=[1, 3, 5], description="Supported prediction horizons")
    embargo_dates: int = Field(default=0, description="Additional embargo dates applied to subsequent partitions")


validation_settings = ValidationSettings()


class Settings(BaseSettings):
    app_name: str = "StockSense AI - ML Intelligence Service"
    version: str = "1.0.0"
    env: str = "development"
    port: int = 8000
    host: str = "0.0.0.0"
    backend_service_url: str = "http://localhost:5001"
    cors_origins: List[str] = ["http://localhost:5001", "http://localhost:5173"]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()
