import prisma from '../config/prisma.js';
import logger from '../utils/logger.js';

/**
 * In-memory notification delivery log for audit and verification.
 */
export const notificationHistory = [];

/**
 * Notification delivery abstraction.
 * Delivers alerts to authorized channels (in-app, logs, simulated push).
 * Strictly prevents external transmission without configuration.
 */
export async function deliverAlertNotification(alert, { currentPrice, triggerTime, channel = 'IN_APP' }) {
  const payload = {
    alertId: alert.id,
    userId: alert.userId,
    stockId: alert.stockId,
    symbol: alert.stock?.symbol || 'UNKNOWN',
    alertType: alert.alertType,
    targetValue: parseFloat(alert.targetValue.toString()),
    currentPrice: parseFloat(currentPrice),
    triggerTime: triggerTime || new Date(),
    channel,
  };

  notificationHistory.push(payload);
  if (notificationHistory.length > 500) {
    notificationHistory.shift();
  }

  logger.info(`[PriceAlert Triggered] ${payload.symbol}: ${payload.alertType} condition met! Target: ${payload.targetValue}, Current: ${payload.currentPrice}`, {
    alertId: alert.id,
    userId: alert.userId,
    channel,
  });

  return { delivered: true, payload };
}

/**
 * Evaluates all active alerts for a given stock against the latest market price.
 * Uses atomic conditional updates to prevent duplicate triggers across concurrent workers.
 *
 * @param {{ stockId: string, symbol?: string, currentPrice: number, candleTimestamp?: Date|string }} params
 * @returns {Promise<Array>} Triggered alerts
 */
export async function evaluateAlertsForStock({ stockId, symbol, currentPrice, candleTimestamp }) {
  if (!stockId || currentPrice === undefined || currentPrice === null) {
    throw new Error('stockId and currentPrice are required to evaluate alerts.');
  }

  const price = parseFloat(currentPrice);
  if (isNaN(price) || price <= 0) {
    throw new Error('currentPrice must be a valid positive number.');
  }

  // 1. Fetch all active alerts for this stock
  const activeAlerts = await prisma.stockAlert.findMany({
    where: {
      stockId,
      isActive: true,
    },
    include: {
      stock: {
        select: { id: true, symbol: true, companyName: true },
      },
    },
  });

  if (!activeAlerts || activeAlerts.length === 0) {
    return [];
  }

  const triggeredAlerts = [];
  const triggerDate = candleTimestamp ? new Date(candleTimestamp) : new Date();

  for (const alert of activeAlerts) {
    const target = parseFloat(alert.targetValue.toString());
    let isTriggered = false;

    if (alert.alertType === 'PRICE_ABOVE' && price >= target) {
      isTriggered = true;
    } else if (alert.alertType === 'PRICE_BELOW' && price <= target) {
      isTriggered = true;
    }

    if (isTriggered) {
      // 2. Atomic state transition: Only update if isActive is STILL true
      // updateMany returns { count: 1 } if won the race, 0 if already updated by another worker
      const updateResult = await prisma.stockAlert.updateMany({
        where: {
          id: alert.id,
          isActive: true,
        },
        data: {
          isActive: false,
          triggeredAt: triggerDate,
        },
      });

      if (updateResult.count === 1) {
        // Successfully transitioned alert state atomically
        await deliverAlertNotification(alert, { currentPrice: price, triggerTime: triggerDate });
        triggeredAlerts.push({
          ...alert,
          isActive: false,
          triggeredAt: triggerDate,
          executionPrice: price,
        });
      }
    }
  }

  return triggeredAlerts;
}
