/**
 * StockSense AI — Metrics API Routes
 * Exposes application telemetry in standard Prometheus OpenMetrics and JSON formats.
 */

import { Router } from 'express';
import metricsRegistry from '../services/metrics.service.js';

const router = Router();

/**
 * GET /metrics
 * Returns Prometheus OpenMetrics scrape output.
 */
router.get('/metrics', (req, res) => {
  const format = req.query.format;
  if (format === 'json') {
    return res.status(200).json({
      success: true,
      data: metricsRegistry.toJsonSnapshot(),
    });
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metricsRegistry.toPrometheusFormat());
});

/**
 * GET /api/metrics
 * Returns structured JSON telemetry metrics.
 */
router.get('/metrics/json', (req, res) => {
  res.status(200).json({
    success: true,
    data: metricsRegistry.toJsonSnapshot(),
  });
});

export default router;
