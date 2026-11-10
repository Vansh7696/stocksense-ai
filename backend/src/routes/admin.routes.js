import { Router } from 'express';

const router = Router();

/**
 * Administrative Routes (/api/admin)
 *
 * NOTE: Administrative ingestion triggers and status reporting over HTTP are
 * explicitly DISABLED pending full Role-Based Access Control (RBAC) in Milestone 4.
 *
 * The supported manual ingestion mechanism is the CLI script:
 *   npm run ingest:instruments
 *   npm run ingest:instruments -- --dry-run
 *   npm run ingest:instruments -- --limit=1000
 */

// Strict anti-caching headers for administrative routes
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/**
 * /api/admin/instruments/ingest
 * Explicitly disabled pending RBAC. Directs operators to CLI.
 */
router.all('/instruments/ingest', (req, res) => {
  return res.status(503).json({
    error: {
      code: 'ADMIN_API_DISABLED',
      message: 'Administrative ingestion via HTTP API is disabled pending RBAC implementation. Use the CLI script: npm run ingest:instruments',
    },
  });
});

/**
 * /api/admin/instruments/status
 * Explicitly disabled pending RBAC. Protects sensitive operational metrics.
 */
router.all('/instruments/status', (req, res) => {
  return res.status(503).json({
    error: {
      code: 'ADMIN_API_DISABLED',
      message: 'Administrative status reporting via HTTP API is disabled pending RBAC implementation.',
    },
  });
});

export default router;
