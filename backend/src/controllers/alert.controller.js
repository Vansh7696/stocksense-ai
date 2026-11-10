import * as alertService from '../services/alert.service.js';

/**
 * GET /api/alerts
 * List all alerts for the authenticated user.
 */
export async function getAlerts(req, res, next) {
  try {
    const alerts = await alertService.getUserAlerts(req.user.id);
    return res.json({
      success: true,
      data: {
        alerts,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/alerts/:id
 * Retrieve specific alert by ID.
 */
export async function getAlert(req, res, next) {
  try {
    const alert = await alertService.getAlertById(req.user.id, req.params.id);
    return res.json({
      success: true,
      data: {
        alert,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/alerts
 * Create a new stock price alert.
 */
export async function createAlert(req, res, next) {
  try {
    const { stockId, alertType, targetValue, notes } = req.body || {};
    const alert = await alertService.createAlert(req.user.id, {
      stockId,
      alertType,
      targetValue,
      notes,
    });
    return res.status(201).json({
      success: true,
      data: {
        alert,
      },
      message: 'Stock alert created successfully.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/alerts/:id
 * Update an existing stock alert.
 */
export async function updateAlert(req, res, next) {
  try {
    const { targetValue, notes, isActive } = req.body || {};
    const alert = await alertService.updateAlert(req.user.id, req.params.id, {
      targetValue,
      notes,
      isActive,
    });
    return res.json({
      success: true,
      data: {
        alert,
      },
      message: 'Stock alert updated successfully.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/alerts/:id
 * Delete a user's stock alert.
 */
export async function deleteAlert(req, res, next) {
  try {
    const result = await alertService.deleteAlert(req.user.id, req.params.id);
    return res.json({
      success: true,
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
}
