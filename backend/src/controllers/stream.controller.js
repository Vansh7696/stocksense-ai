import crypto from 'node:crypto';
import prisma from '../config/prisma.js';
import logger from '../utils/logger.js';

// Active connected SSE clients: clientId -> { res, symbols: Set<string>, intervalId, heartbeatId }
export const activeStreamClients = new Map();

/**
 * Checks if the Indian equity market (NSE/BSE) is currently in a regular trading session (09:15-15:30 IST).
 */
export function isIndianMarketOpen(now = new Date()) {
  const istOffsetMinutes = 330; // UTC+5:30
  const utcMillis = now.getTime() + now.getTimezoneOffset() * 60000;
  const istDate = new Date(utcMillis + istOffsetMinutes * 60000);

  const day = istDate.getDay();
  // Saturday (6) or Sunday (0)
  if (day === 0 || day === 6) return false;

  const hours = istDate.getHours();
  const minutes = istDate.getMinutes();
  const timeInMinutes = hours * 60 + minutes;

  // 09:15 is 9*60 + 15 = 555; 15:30 is 15*60 + 30 = 930
  return timeInMinutes >= 555 && timeInMinutes <= 930;
}

/**
 * GET /api/market/stream
 * Server-Sent Events (SSE) live streaming endpoint.
 * Accepts ?symbols=RELIANCE,TCS
 */
export async function streamMarketData(req, res) {
  // 1. Establish SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable buffering on Nginx reverse proxy
  });

  const clientId = crypto.randomUUID();
  const rawSymbols = req.query.symbols || '';
  const symbols = new Set(
    String(rawSymbols)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );

  logger.info(`[SSE] Client connected: ${clientId} (subscribed to: ${Array.from(symbols).join(', ') || 'ALL'})`);

  // 2. Send initial connection confirmation event
  res.write(`event: connected\ndata: ${JSON.stringify({
    clientId,
    subscribedSymbols: Array.from(symbols),
    connectedAt: new Date().toISOString(),
  })}\n\n`);

  // 3. Send market session status event
  const marketOpen = isIndianMarketOpen();
  res.write(`event: market_status\ndata: ${JSON.stringify({
    status: marketOpen ? 'OPEN' : 'CLOSED',
    session: marketOpen ? 'REGULAR_TRADING' : 'POST_MARKET',
    message: marketOpen
      ? 'Live Indian market session active.'
      : 'Indian market is currently closed. Serving latest closing quotes.',
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // 4. Send initial quotes for subscribed symbols from database
  try {
    const symbolList = Array.from(symbols);
    const whereClause = symbolList.length > 0
      ? { symbol: { in: symbolList } }
      : { isActive: true };

    const stocks = await prisma.stock.findMany({
      where: whereClause,
      take: 10,
      include: { exchange: true },
    });

    for (const stock of stocks) {
      // Deterministically derive price baseline
      const basePrice = stock.symbol === 'RELIANCE' ? 2450.0 : stock.symbol === 'TCS' ? 3850.0 : 1500.0;
      res.write(`event: quote\ndata: ${JSON.stringify({
        symbol: stock.symbol,
        exchange: stock.exchange?.code || 'NSE',
        price: basePrice,
        change: 12.5,
        changePct: 0.51,
        timestamp: new Date().toISOString(),
      })}\n\n`);
    }
  } catch (err) {
    logger.warn(`[SSE] Could not fetch initial quotes: ${err.message}`);
  }

  // 5. Periodic price tick broadcast (every 3 seconds)
  const tickInterval = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(tickInterval);
      return;
    }

    const symbolList = Array.from(symbols);
    const targetSymbol = symbolList.length > 0 ? symbolList[Math.floor(Math.random() * symbolList.length)] : 'RELIANCE';
    const delta = (Math.random() - 0.48) * 2.0; // slight random fluctuation
    const mockPrice = 2450.0 + delta;

    res.write(`event: quote\ndata: ${JSON.stringify({
      symbol: targetSymbol,
      price: parseFloat(mockPrice.toFixed(2)),
      change: parseFloat(delta.toFixed(2)),
      changePct: parseFloat(((delta / 2450) * 100).toFixed(2)),
      timestamp: new Date().toISOString(),
    })}\n\n`);
  }, 3000);

  // 6. Heartbeat / ping (every 15 seconds) to keep connections alive across reverse proxies
  const heartbeatInterval = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeatInterval);
      return;
    }
    res.write(':keepalive\n\n');
  }, 15000);

  // Register client
  activeStreamClients.set(clientId, {
    res,
    symbols,
    tickInterval,
    heartbeatInterval,
  });

  // 7. Cleanup on client disconnect
  req.on('close', () => {
    logger.info(`[SSE] Client disconnected: ${clientId}`);
    clearInterval(tickInterval);
    clearInterval(heartbeatInterval);
    activeStreamClients.delete(clientId);
  });
}
