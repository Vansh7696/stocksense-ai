import { Router } from 'express';
import { isRedisReady } from '../config/redis.js';
import prisma from '../config/prisma.js';
import { config } from '../config/index.js';
import axios from 'axios';

const router = Router();

// Helper to probe promise with timeout
const withTimeout = (promise, ms, timeoutErrorMsg) => {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutErrorMsg)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
};

router.get('/health', async (req, res) => {
  const issues = [];
  let dbStatus = 'DISCONNECTED';
  let mlStatus = 'DISCONNECTED';

  // 1. Probe PostgreSQL Database
  try {
    if (config.database.url) {
      await withTimeout(prisma.$queryRaw`SELECT 1`, 1000, 'Database probe timed out after 1000ms');
      dbStatus = 'CONNECTED';
    } else {
      issues.push('DATABASE_URL is not configured');
    }
  } catch (err) {
    dbStatus = 'DISCONNECTED';
    issues.push(`PostgreSQL unreachable at ${config.database.url.split('@')[1] || 'localhost:5432'} (${err.message})`);
  }

  // 2. Probe Redis
  const redisStatus = isRedisReady() ? 'CONNECTED' : 'DISCONNECTED';
  if (redisStatus === 'DISCONNECTED') {
    issues.push(`Redis cache unreachable at ${config.redis.host}:${config.redis.port} (operating with in-memory fallback)`);
  }

  // 3. Probe ML Microservice
  try {
    const mlHealthUrl = `${config.mlService.url}/api/health`;
    const mlResponse = await axios.get(mlHealthUrl, {
      timeout: 600,
      headers: { Connection: 'close' },
    });
    if (mlResponse.status === 200 && mlResponse.data?.status === 'UP') {
      mlStatus = 'CONNECTED';
    }
  } catch (err) {
    mlStatus = 'DISCONNECTED';
    issues.push(`FastAPI ML service unreachable at ${config.mlService.url} (${err.message})`);
  }

  // Determine overall health state
  const isHealthy = dbStatus === 'CONNECTED' && redisStatus === 'CONNECTED' && mlStatus === 'CONNECTED';
  const isPartial = dbStatus === 'CONNECTED' || redisStatus === 'CONNECTED' || mlStatus === 'CONNECTED';

  let overallStatus = 'UNHEALTHY';
  if (isHealthy) {
    overallStatus = 'HEALTHY';
  } else if (isPartial && dbStatus === 'CONNECTED') {
    // If DB is up but cache or ML is down, system can still serve basic data in degraded mode
    overallStatus = 'DEGRADED';
  } else {
    // If DB is down, platform cannot persist or query real records
    overallStatus = 'UNHEALTHY';
  }

  const httpStatus = req.query.strict === 'true' && !isHealthy ? 503 : 200;

  res.status(httpStatus).json({
    success: true,
    data: {
      status: overallStatus,
      service: 'stocksense-backend',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      environment: config.env,
      dependencies: {
        database: dbStatus,
        redis: redisStatus,
        mlService: mlStatus
      },
      issues: issues.length > 0 ? issues : undefined
    }
  });
});

export default router;
