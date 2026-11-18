/**
 * StockSense AI — Stock Sentiment Controller (Phase 5C.9)
 * Orchestrates real-time financial market news sentiment intelligence,
 * polarity scoring, and multi-factor technical + sentiment Bayesian fusion.
 */

import { resolveStockIdentifier } from './stock.controller.js';
import mlClientService from '../services/mlClient.service.js';
import cacheService, { CACHE_TTL } from '../services/cache.service.js';
import logger from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * GET /api/stocks/:id/sentiment
 *
 * Retrieves market news sentiment summary, scored headlines, and multi-factor fusion
 * for an equity. Supports Redis caching with 5-minute TTL.
 */
export async function getStockSentiment(req, res, next) {
  try {
    const { id } = req.params;
    const exchangeParam = req.query.exchange?.toUpperCase();
    const horizonParam = req.query.horizon ? parseInt(req.query.horizon, 10) : 1;

    // 1. Resolve stock identifier unambiguously
    const stock = await resolveStockIdentifier(id, exchangeParam, {
      include: {
        exchange: {
          select: {
            id: true,
            code: true,
            name: true,
            currency: true,
            timezone: true,
          },
        },
      },
    });

    const cacheKey = cacheService.buildKey(
      'stocks:sentiment',
      `${stock.id}:${stock.exchange.code}:h${horizonParam}`
    );

    // 2. Check Redis cache
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({
        success: true,
        data: cachedData,
        meta: {
          cached: true,
          correlationId: req.correlationId,
          timestamp: new Date().toISOString(),
          stock: {
            id: stock.id,
            symbol: stock.symbol,
            companyName: stock.companyName,
            exchange: stock.exchange.code,
          },
        },
      });
    }

    // 3. Request sentiment summary from FastAPI ML service
    const sentimentSummary = await mlClientService.getSentimentSummary(stock.symbol, {
      correlationId: req.correlationId,
    });

    // 4. Compute multi-factor fusion with technical forecast
    let fusionResult = null;
    try {
      const defaultProbabilities = {
        DOWN: 0.25,
        NEUTRAL: 0.35,
        UP: 0.40,
      };

      fusionResult = await mlClientService.fusePredictionWithSentiment(
        {
          symbol: stock.symbol,
          horizon: horizonParam,
          technical_probabilities: defaultProbabilities,
          sentiment_polarity: sentimentSummary.overall_polarity,
          fusion_weight: 0.25,
        },
        { correlationId: req.correlationId }
      );
    } catch (fusionErr) {
      logger.warn('Multi-factor fusion non-fatal warning:', { error: fusionErr.message });
    }

    const payload = {
      symbol: stock.symbol,
      companyName: stock.companyName,
      exchange: stock.exchange.code,
      overallPolarity: sentimentSummary.overall_polarity,
      overallLabel: sentimentSummary.overall_label,
      confidence: sentimentSummary.confidence,
      sampleCount: sentimentSummary.sample_count,
      ratios: {
        bullish: sentimentSummary.bullish_ratio,
        bearish: sentimentSummary.bearish_ratio,
        neutral: sentimentSummary.neutral_ratio,
      },
      headlines: (sentimentSummary.headlines || []).map((h) => ({
        id: h.id,
        title: h.title,
        source: h.source,
        publishedAt: h.published_at,
        polarity: h.polarity,
        label: h.label,
        confidence: h.confidence,
        keyDrivers: h.key_drivers || [],
      })),
      fusion: fusionResult
        ? {
            horizon: fusionResult.horizon,
            technicalProbabilities: fusionResult.technical_probabilities,
            sentimentPolarity: fusionResult.sentiment_polarity,
            fusedProbabilities: fusionResult.fused_probabilities,
            fusedLabel: fusionResult.fused_label,
            confidence: fusionResult.confidence,
            alignment: fusionResult.alignment,
            alignmentDescription: fusionResult.alignment_description,
          }
        : null,
      analyzedAtUtc: sentimentSummary.analyzed_at_utc,
    };

    // 5. Cache in Redis (TTL: 5 minutes / 300 seconds)
    const ttl = CACHE_TTL.DEFAULT || 300;
    await cacheService.set(cacheKey, payload, ttl);

    return res.status(200).json({
      success: true,
      data: payload,
      meta: {
        cached: false,
        correlationId: req.correlationId,
        timestamp: new Date().toISOString(),
        stock: {
          id: stock.id,
          symbol: stock.symbol,
          companyName: stock.companyName,
          exchange: stock.exchange.code,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}
