import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export const VALID_ALERT_TYPES = new Set([
  'PRICE_ABOVE',
  'PRICE_BELOW',
  'PCT_CHANGE_UP',
  'PCT_CHANGE_DOWN',
]);

/**
 * Formats a stock alert for consistent client response.
 */
function formatAlert(alert) {
  if (!alert) return null;
  return {
    id: alert.id,
    stockId: alert.stockId,
    alertType: alert.alertType,
    targetValue: alert.targetValue ? parseFloat(alert.targetValue.toString()) : null,
    notes: alert.notes || null,
    isActive: alert.isActive,
    triggeredAt: alert.triggeredAt,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    stock: alert.stock
      ? {
          id: alert.stock.id,
          symbol: alert.stock.symbol,
          companyName: alert.stock.companyName,
          exchange: alert.stock.exchange?.code || null,
          segment: alert.stock.segment,
          instrumentType: alert.stock.instrumentType,
        }
      : undefined,
  };
}

/**
 * Retrieve all stock alerts belonging to the authenticated user.
 *
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function getUserAlerts(userId) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');

  const alerts = await prisma.stockAlert.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      stock: {
        include: {
          exchange: {
            select: { code: true, name: true },
          },
        },
      },
    },
  });

  return alerts.map(formatAlert);
}

/**
 * Retrieve a specific stock alert by ID with strict user ownership enforcement.
 *
 * @param {string} userId
 * @param {string} alertId
 * @returns {Promise<Object>}
 */
export async function getAlertById(userId, alertId) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  if (!alertId) throw new AppError('Alert ID is required.', 400, 'INVALID_ALERT_ID');

  const alert = await prisma.stockAlert.findFirst({
    where: { id: alertId, userId },
    include: {
      stock: {
        include: {
          exchange: {
            select: { code: true, name: true },
          },
        },
      },
    },
  });

  if (!alert) {
    throw new AppError('Stock alert not found or access denied.', 404, 'ALERT_NOT_FOUND');
  }

  return formatAlert(alert);
}

/**
 * Create a new stock price alert.
 *
 * @param {string} userId
 * @param {{ stockId: string, alertType: string, targetValue: number|string, notes?: string }} data
 * @returns {Promise<Object>}
 */
export async function createAlert(userId, { stockId, alertType, targetValue, notes }) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');

  if (!stockId || typeof stockId !== 'string') {
    throw new AppError('A valid stockId is required.', 400, 'INVALID_STOCK_ID');
  }

  if (!alertType || !VALID_ALERT_TYPES.has(alertType.toUpperCase())) {
    throw new AppError(
      `Invalid alertType. Allowed: ${Array.from(VALID_ALERT_TYPES).join(', ')}`,
      400,
      'INVALID_ALERT_TYPE'
    );
  }

  const numValue = parseFloat(targetValue);
  if (isNaN(numValue) || numValue <= 0 || !isFinite(numValue)) {
    throw new AppError(
      'targetValue must be a positive finite number.',
      400,
      'INVALID_TARGET_VALUE'
    );
  }

  const cleanNotes = notes && typeof notes === 'string' ? notes.trim().slice(0, 255) : null;

  // Validate stock exists and is active
  const stock = await prisma.stock.findUnique({
    where: { id: stockId },
    include: { exchange: true },
  });

  if (!stock) {
    throw new AppError('Referenced stock not found.', 404, 'STOCK_NOT_FOUND');
  }

  if (!stock.isActive) {
    throw new AppError('Cannot create alert on inactive or delisted stock.', 400, 'STOCK_INACTIVE');
  }

  const alert = await prisma.stockAlert.create({
    data: {
      userId,
      stockId: stock.id,
      alertType: alertType.toUpperCase(),
      targetValue: new Prisma.Decimal(numValue.toFixed(4)),
      notes: cleanNotes,
      isActive: true,
    },
    include: {
      stock: {
        include: {
          exchange: {
            select: { code: true, name: true },
          },
        },
      },
    },
  });

  return formatAlert(alert);
}

/**
 * Update an existing stock alert.
 *
 * @param {string} userId
 * @param {string} alertId
 * @param {{ targetValue?: number|string, notes?: string, isActive?: boolean }} data
 * @returns {Promise<Object>}
 */
export async function updateAlert(userId, alertId, { targetValue, notes, isActive }) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  if (!alertId) throw new AppError('Alert ID is required.', 400, 'INVALID_ALERT_ID');

  const existing = await prisma.stockAlert.findFirst({
    where: { id: alertId, userId },
  });

  if (!existing) {
    throw new AppError('Stock alert not found or access denied.', 404, 'ALERT_NOT_FOUND');
  }

  const updateData = {};

  if (targetValue !== undefined) {
    const numValue = parseFloat(targetValue);
    if (isNaN(numValue) || numValue <= 0 || !isFinite(numValue)) {
      throw new AppError('targetValue must be a positive finite number.', 400, 'INVALID_TARGET_VALUE');
    }
    updateData.targetValue = new Prisma.Decimal(numValue.toFixed(4));
  }

  if (notes !== undefined) {
    updateData.notes = typeof notes === 'string' ? notes.trim().slice(0, 255) : null;
  }

  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') {
      throw new AppError('isActive must be a boolean value.', 400, 'INVALID_IS_ACTIVE');
    }
    updateData.isActive = isActive;
  }

  const updated = await prisma.stockAlert.update({
    where: { id: alertId },
    data: updateData,
    include: {
      stock: {
        include: {
          exchange: {
            select: { code: true, name: true },
          },
        },
      },
    },
  });

  return formatAlert(updated);
}

/**
 * Delete a user's stock alert with strict ownership validation.
 *
 * @param {string} userId
 * @param {string} alertId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function deleteAlert(userId, alertId) {
  if (!userId) throw new AppError('User ID is required.', 401, 'UNAUTHORIZED');
  if (!alertId) throw new AppError('Alert ID is required.', 400, 'INVALID_ALERT_ID');

  const existing = await prisma.stockAlert.findFirst({
    where: { id: alertId, userId },
  });

  if (!existing) {
    throw new AppError('Stock alert not found or access denied.', 404, 'ALERT_NOT_FOUND');
  }

  await prisma.stockAlert.delete({
    where: { id: alertId },
  });

  return {
    success: true,
    message: 'Stock alert deleted successfully.',
  };
}
