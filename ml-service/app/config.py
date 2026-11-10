from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List


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
