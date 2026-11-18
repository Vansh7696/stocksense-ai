"""
StockSense AI — Financial News & Market Sentiment API Endpoints (Phase 5C.9)
Exposes endpoints for headline sentiment analysis, ticker-level summary aggregation,
and multi-factor quantitative + qualitative probability fusion.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from app.schemas.sentiment import (
    SentimentAnalysisRequest,
    SentimentSummaryResponse,
    MultiFactorFusionRequest,
    MultiFactorFusionResponse,
)
from app.services.sentiment import FinancialSentimentAnalyzer

router = APIRouter(prefix="/api/sentiment", tags=["Sentiment Intelligence"])

_sentiment_analyzer = FinancialSentimentAnalyzer()


def get_sentiment_analyzer() -> FinancialSentimentAnalyzer:
    return _sentiment_analyzer


@router.post(
    "/analyze",
    response_model=SentimentSummaryResponse,
    status_code=status.HTTP_200_OK,
    summary="Analyze Financial Headlines Sentiment",
)
async def analyze_headlines_endpoint(
    req: SentimentAnalysisRequest,
    analyzer: FinancialSentimentAnalyzer = Depends(get_sentiment_analyzer),
) -> SentimentSummaryResponse:
    """
    Analyzes an array of financial news headlines for an equity, computing
    signed polarity, individual keyword attributions, and aggregated sentiment index.
    """
    try:
        symbol = req.symbol or "EQUITY"
        return analyzer.analyze_headlines(req.headlines, symbol=symbol)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Sentiment analysis failed: {str(exc)}",
        )


@router.get(
    "/summary/{symbol}",
    response_model=SentimentSummaryResponse,
    status_code=status.HTTP_200_OK,
    summary="Get Aggregated Sentiment Summary for Equity Ticker",
)
async def get_sentiment_summary_endpoint(
    symbol: str,
    analyzer: FinancialSentimentAnalyzer = Depends(get_sentiment_analyzer),
) -> SentimentSummaryResponse:
    """
    Returns the latest aggregated news sentiment summary and scored headlines for an equity.
    """
    try:
        return analyzer.get_summary_for_symbol(symbol)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch sentiment summary: {str(exc)}",
        )


@router.post(
    "/fuse",
    response_model=MultiFactorFusionResponse,
    status_code=status.HTTP_200_OK,
    summary="Multi-Factor Probability Fusion (Technical ML + News Sentiment)",
)
async def fuse_prediction_sentiment_endpoint(
    req: MultiFactorFusionRequest,
    analyzer: FinancialSentimentAnalyzer = Depends(get_sentiment_analyzer),
) -> MultiFactorFusionResponse:
    """
    Fuses quantitative directional forecast probabilities with qualitative news sentiment
    using Bayesian probability weight updates.
    """
    try:
        return analyzer.fuse_prediction_with_sentiment(req)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Multi-factor fusion failed: {str(exc)}",
        )
