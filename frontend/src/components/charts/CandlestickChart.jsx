import React, { useEffect, useRef, useState, useMemo } from 'react';
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts';
import { BarChart3, Loader2, Info } from 'lucide-react';

/**
 * Format Indian Rupee currency with 2 decimals
 */
function formatCurrency(val) {
  if (val === undefined || val === null || isNaN(val)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

/**
 * Format volume into readable string with commas
 */
function formatVolume(val) {
  if (val === undefined || val === null || isNaN(val)) return '—';
  return new Intl.NumberFormat('en-IN').format(val);
}

/**
 * Format timestamp into IST date/time string
 */
function formatCandleTime(unixSeconds, interval) {
  if (!unixSeconds) return '—';
  const d = new Date(unixSeconds * 1000);
  const isIntraday = interval && !['1D', '1W', '1M'].includes(interval);

  if (isIntraday) {
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }) + ' IST';
  }

  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Interactive TradingView Lightweight Candlestick Chart with Volume Histogram
 */
export default function CandlestickChart({
  candles = [],
  interval = '1D',
  loading = false,
  symbol = '',
  exchange = 'NSE',
  height = 460,
}) {
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const latestCandleRef = useRef(null);

  // Active hover candle data for legend display (falls back to latest candle)
  const [legendData, setLegendData] = useState(null);

  // Sanitized, chronological, deduplicated candle series
  const { sanitizedCandles, sanitizedVolume, latestCandle } = useMemo(() => {
    if (!candles || candles.length === 0) {
      return { sanitizedCandles: [], sanitizedVolume: [], latestCandle: null };
    }

    const formattedC = [];
    const formattedV = [];
    let prevTime = null;

    // Strictly sort ascending by timestamp
    const sorted = [...candles].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    for (const c of sorted) {
      const timeInSec = Math.floor(new Date(c.timestamp).getTime() / 1000);
      if (isNaN(timeInSec)) continue;

      // Skip duplicate timestamps to prevent lightweight-charts monotonic assertion failures
      if (prevTime !== null && timeInSec <= prevTime) {
        continue;
      }
      prevTime = timeInSec;

      const open = parseFloat(c.open);
      const high = parseFloat(c.high);
      const low = parseFloat(c.low);
      const close = parseFloat(c.close);
      const volume = parseFloat(c.volume || 0);

      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;

      formattedC.push({
        time: timeInSec,
        open,
        high,
        low,
        close,
      });

      formattedV.push({
        time: timeInSec,
        value: volume,
        color: close >= open ? 'rgba(16, 185, 129, 0.45)' : 'rgba(239, 68, 68, 0.45)',
      });
    }

    const latest = formattedC.length > 0 ? formattedC[formattedC.length - 1] : null;
    const latestVol = formattedV.length > 0 ? formattedV[formattedV.length - 1] : null;

    return {
      sanitizedCandles: formattedC,
      sanitizedVolume: formattedV,
      latestCandle: latest
        ? {
            ...latest,
            volume: latestVol?.value || 0,
            change: latest.close - latest.open,
            changePercent: ((latest.close - latest.open) / (latest.open || 1)) * 100,
          }
        : null,
    };
  }, [candles]);

  // Keep latest candle ref synchronized to prevent stale closure in crosshair listeners
  useEffect(() => {
    latestCandleRef.current = latestCandle;
    if (latestCandle) {
      setLegendData(latestCandle);
    } else {
      setLegendData(null);
    }
  }, [latestCandle]);

  // Initialize TradingView Lightweight Chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Clean up any existing instance
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const isIntraday = interval && !['1D', '1W', '1M'].includes(interval);

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth || 800,
      height: height,
      layout: {
        background: { type: ColorType.Solid, color: '#090D16' },
        textColor: '#94a3b8',
        fontSize: 11,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Roboto Mono', Menlo, monospace",
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.35)' },
        horzLines: { color: 'rgba(30, 41, 59, 0.35)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#3b82f6',
          width: 1,
          style: 2, // Dashed
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: '#3b82f6',
          width: 1,
          style: 2, // Dashed
          labelBackgroundColor: '#1e293b',
        },
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        visible: true,
        scaleMargins: {
          top: 0.08,
          bottom: 0.22, // Space reserved for volume histogram
        },
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: isIntraday,
        secondsVisible: false,
      },
    });

    // Candlestick Series
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    // Volume Histogram Series (bottom overlay)
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '', // Overlay without separate price axis
    });

    chart.priceScale('').applyOptions({
      scaleMargins: {
        top: 0.8, // Takes the bottom 20%
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Crosshair movement handler for interactive legend
    const handleCrosshairMove = (param) => {
      if (!param || !param.time || !param.seriesData) {
        // Return to latest candle when mouse leaves chart
        setLegendData(latestCandleRef.current);
        return;
      }

      const candlePoint = param.seriesData.get(candleSeries);
      const volumePoint = param.seriesData.get(volumeSeries);

      if (candlePoint) {
        const change = candlePoint.close - candlePoint.open;
        const changePercent = ((change) / (candlePoint.open || 1)) * 100;

        setLegendData({
          time: candlePoint.time,
          open: candlePoint.open,
          high: candlePoint.high,
          low: candlePoint.low,
          close: candlePoint.close,
          volume: volumePoint?.value || 0,
          change,
          changePercent,
        });
      }
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);

    // Responsive Resize Observer
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0 || !chartContainerRef.current) return;
      const { width } = entries[0].contentRect;
      if (width > 0 && chartRef.current) {
        chartRef.current.applyOptions({ width });
      }
    });

    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [interval, height]); // Recreate chart if interval time visibility changes

  // Synchronize candle and volume data to series
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || !chartRef.current) return;

    if (sanitizedCandles.length > 0) {
      candleSeriesRef.current.setData(sanitizedCandles);
      volumeSeriesRef.current.setData(sanitizedVolume);
      chartRef.current.timeScale().fitContent();
    } else {
      candleSeriesRef.current.setData([]);
      volumeSeriesRef.current.setData([]);
    }
  }, [sanitizedCandles, sanitizedVolume]);

  const hasCandles = sanitizedCandles.length > 0;
  const isBullish = legendData ? legendData.close >= legendData.open : true;

  return (
    <div className="relative w-full rounded-xl bg-fintech-surface/70 border border-fintech-border/70 overflow-hidden shadow-2xl">
      {/* Interactive OHLCV Legend Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-fintech-surface/90 border-b border-fintech-border/60 text-xs font-mono">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex items-center gap-1.5 font-bold text-slate-200">
            <span>{symbol || 'STOCK'}</span>
            <span className="text-[10px] text-slate-400 font-normal">({exchange})</span>
            <span className="text-[10px] text-blue-400 font-semibold px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20">
              {interval}
            </span>
          </div>

          {legendData && (
            <>
              <div className="text-slate-400 text-[11px]">
                {formatCandleTime(legendData.time, interval)}
              </div>

              <div className="flex items-center gap-3">
                <div>
                  <span className="text-slate-500 text-[10px] mr-1">O</span>
                  <span className="text-slate-200">{formatCurrency(legendData.open)}</span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] mr-1">H</span>
                  <span className="text-slate-200">{formatCurrency(legendData.high)}</span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] mr-1">L</span>
                  <span className="text-slate-200">{formatCurrency(legendData.low)}</span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] mr-1">C</span>
                  <span className={isBullish ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                    {formatCurrency(legendData.close)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] mr-1">CHG</span>
                  <span className={isBullish ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                    {legendData.change >= 0 ? '+' : ''}
                    {legendData.change.toFixed(2)} ({legendData.changePercent >= 0 ? '+' : ''}
                    {legendData.changePercent.toFixed(2)}%)
                  </span>
                </div>
                {legendData.volume > 0 && (
                  <div>
                    <span className="text-slate-500 text-[10px] mr-1">VOL</span>
                    <span className="text-slate-300">{formatVolume(legendData.volume)}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="text-[10px] text-slate-500 hidden sm:flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500/80 inline-block" />
          <span>Historical OHLCV</span>
        </div>
      </div>

      {/* Chart Canvas Container */}
      <div
        ref={chartContainerRef}
        style={{ height: `${height}px` }}
        className="w-full relative transition-opacity duration-200"
      >
        {/* Loading Overlay */}
        {loading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-fintech-bg/75 backdrop-blur-xs">
            <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-2" />
            <span className="text-xs font-mono text-slate-300">Fetching historical {interval} candles...</span>
          </div>
        )}

        {/* Empty Data State Overlay */}
        {!loading && !hasCandles && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-6 text-center bg-fintech-surface/95">
            <div className="p-3.5 rounded-2xl bg-slate-800/60 border border-slate-700/50 mb-3 text-slate-400">
              <BarChart3 className="w-9 h-9" />
            </div>
            <h4 className="text-sm font-semibold text-white mb-1">
              No Historical Candle Data Available
            </h4>
            <p className="text-xs text-slate-400 max-w-md mb-4 leading-relaxed">
              Historical OHLCV candles for interval <span className="font-mono text-blue-400 font-semibold">{interval}</span> have not been ingested into the database yet for <span className="font-mono text-slate-200 font-semibold">{symbol || 'this stock'}</span>.
            </p>
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-[11px] text-blue-300 max-w-md text-left font-mono">
              <Info className="w-4 h-4 shrink-0 text-blue-400" />
              <span>Run the ingestion pipeline (<code className="text-white">npm run ingest:history</code>) or choose another interval.</span>
            </div>
          </div>
        )}
      </div>

      {/* Footer Info Strip */}
      <div className="px-4 py-2 bg-fintech-surface/80 border-t border-fintech-border/40 flex flex-wrap items-center justify-between text-[11px] font-mono text-slate-400">
        <div>
          Volume Histogram: <span className="text-emerald-400">Green (Buying)</span> / <span className="text-rose-400">Red (Selling)</span>
        </div>
        <div className="text-[10px] text-slate-500">
          Source: Verified Upstox V3 Market Data • Fixed Scale
        </div>
      </div>
    </div>
  );
}
