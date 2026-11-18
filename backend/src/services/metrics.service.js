/**
 * StockSense AI — Observability & Prometheus Metrics Service
 * Collects runtime API performance metrics, ML inference latencies, cache ratios, and operational counters.
 */

class MetricsRegistry {
  constructor() {
    this.httpRequests = new Map(); // key: `${method}|${route}|${status}` -> count
    this.predictionRequests = new Map(); // key: `${horizon}|${status}` -> count
    this.cacheOperations = new Map(); // key: `${op}|${result}` -> count
    this.latencies = []; // Array of { metric, durationSeconds, labels, timestamp } (capped FIFO)
    this.maxLatencySamples = 1000;
  }

  /**
   * Records an HTTP request completion.
   */
  recordHttpRequest(method, route, statusCode, durationSeconds) {
    const key = `${method.toUpperCase()}|${route}|${statusCode}`;
    const current = this.httpRequests.get(key) || 0;
    this.httpRequests.set(key, current + 1);

    this.recordLatency('http_request_duration_seconds', durationSeconds, {
      method: method.toUpperCase(),
      route,
    });
  }

  /**
   * Records a stock prediction generation.
   *
   * @param {number|string} horizon - Forecast horizon (1, 3, 5, or 'all')
   * @param {'success'|'cache_hit'|'insufficient_data'|'rate_limited'|'error'} status
   * @param {number} [durationSeconds]
   */
  recordPrediction(horizon, status, durationSeconds) {
    const key = `${horizon}|${status}`;
    const current = this.predictionRequests.get(key) || 0;
    this.predictionRequests.set(key, current + 1);

    if (typeof durationSeconds === 'number') {
      this.recordLatency('prediction_duration_seconds', durationSeconds, {
        horizon: String(horizon),
        status,
      });
    }
  }

  /**
   * Records a downstream ML microservice call.
   */
  recordMlCall(endpoint, status, durationSeconds) {
    this.recordLatency('ml_service_call_duration_seconds', durationSeconds, {
      endpoint,
      status,
    });
  }

  /**
   * Records a Redis cache operation.
   *
   * @param {'get'|'set'|'del'} operation
   * @param {'hit'|'miss'|'error'|'ok'} result
   */
  recordCacheOp(operation, result) {
    const key = `${operation}|${result}`;
    const current = this.cacheOperations.get(key) || 0;
    this.cacheOperations.set(key, current + 1);
  }

  /**
   * Internal circular buffer for latency measurements.
   */
  recordLatency(metric, durationSeconds, labels) {
    if (this.latencies.length >= this.maxLatencySamples) {
      this.latencies.shift();
    }
    this.latencies.push({
      metric,
      durationSeconds,
      labels,
      timestamp: Date.now(),
    });
  }

  /**
   * Calculates percentiles (p50, p90, p99) for a given metric.
   */
  getPercentiles(metric) {
    const samples = this.latencies
      .filter((s) => s.metric === metric)
      .map((s) => s.durationSeconds)
      .sort((a, b) => a - b);

    if (samples.length === 0) {
      return { p50: 0, p90: 0, p99: 0, count: 0 };
    }

    const p50Idx = Math.floor(samples.length * 0.5);
    const p90Idx = Math.floor(samples.length * 0.9);
    const p99Idx = Math.floor(samples.length * 0.99);

    return {
      p50: samples[p50Idx],
      p90: samples[p90Idx],
      p99: samples[p99Idx],
      count: samples.length,
    };
  }

  /**
   * Serializes metrics into standard Prometheus OpenMetrics text format.
   *
   * @returns {string}
   */
  toPrometheusFormat() {
    const lines = [];

    lines.push('# HELP process_uptime_seconds Total application process uptime in seconds.');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${Math.round(process.uptime())}`);

    lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes.');
    lines.push('# TYPE process_resident_memory_bytes gauge');
    lines.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`);

    lines.push('# HELP http_requests_total Total number of HTTP requests by method, route, and status code.');
    lines.push('# TYPE http_requests_total counter');
    for (const [key, count] of this.httpRequests.entries()) {
      const [method, route, status] = key.split('|');
      lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`);
    }

    lines.push('# HELP prediction_requests_total Total number of prediction requests by horizon and outcome.');
    lines.push('# TYPE prediction_requests_total counter');
    for (const [key, count] of this.predictionRequests.entries()) {
      const [horizon, status] = key.split('|');
      lines.push(`prediction_requests_total{horizon="${horizon}",status="${status}"} ${count}`);
    }

    lines.push('# HELP cache_operations_total Total cache operations by type and result.');
    lines.push('# TYPE cache_operations_total counter');
    for (const [key, count] of this.cacheOperations.entries()) {
      const [op, result] = key.split('|');
      lines.push(`cache_operations_total{operation="${op}",result="${result}"} ${count}`);
    }

    // Summary percentiles for prediction duration
    const predLat = this.getPercentiles('prediction_duration_seconds');
    lines.push('# HELP prediction_duration_seconds Summary of prediction request latencies.');
    lines.push('# TYPE prediction_duration_seconds summary');
    lines.push(`prediction_duration_seconds{quantile="0.5"} ${predLat.p50}`);
    lines.push(`prediction_duration_seconds{quantile="0.9"} ${predLat.p90}`);
    lines.push(`prediction_duration_seconds{quantile="0.99"} ${predLat.p99}`);
    lines.push(`prediction_duration_seconds_count ${predLat.count}`);

    return lines.join('\n') + '\n';
  }

  /**
   * Returns a JSON snapshot of metrics for REST consumption.
   */
  toJsonSnapshot() {
    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      httpRequestsTotal: Array.from(this.httpRequests.entries()).map(([k, v]) => {
        const [method, route, status] = k.split('|');
        return { method, route, status, count: v };
      }),
      predictionRequestsTotal: Array.from(this.predictionRequests.entries()).map(([k, v]) => {
        const [horizon, status] = k.split('|');
        return { horizon, status, count: v };
      }),
      cacheOperationsTotal: Array.from(this.cacheOperations.entries()).map(([k, v]) => {
        const [operation, result] = k.split('|');
        return { operation, result, count: v };
      }),
      latencies: {
        predictionDuration: this.getPercentiles('prediction_duration_seconds'),
        httpRequestDuration: this.getPercentiles('http_request_duration_seconds'),
        mlServiceCallDuration: this.getPercentiles('ml_service_call_duration_seconds'),
      },
    };
  }

  reset() {
    this.httpRequests.clear();
    this.predictionRequests.clear();
    this.cacheOperations.clear();
    this.latencies = [];
  }
}

export const metricsRegistry = new MetricsRegistry();
export default metricsRegistry;
