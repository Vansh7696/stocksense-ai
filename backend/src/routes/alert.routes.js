import { Router } from 'express';
import {
  getAlerts,
  getAlert,
  createAlert,
  updateAlert,
  deleteAlert,
} from '../controllers/alert.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';

const router = Router();

// All alert routes require authenticated user session
router.use(requireAuth);

/**
 * GET /api/alerts
 * List all stock alerts for authenticated user.
 */
router.get('/', getAlerts);

/**
 * POST /api/alerts
 * Create new stock alert.
 */
router.post('/', csrfProtection, createAlert);

/**
 * GET /api/alerts/:id
 * Retrieve specific stock alert.
 */
router.get('/:id', getAlert);

/**
 * PATCH /api/alerts/:id
 * Update stock alert.
 */
router.patch('/:id', csrfProtection, updateAlert);

/**
 * DELETE /api/alerts/:id
 * Delete stock alert.
 */
router.delete('/:id', csrfProtection, deleteAlert);

export default router;
