import app from './app.js';
import { config } from './config/index.js';
import redisClient from './config/redis.js';
import prisma from './config/prisma.js';
import { initializeDatabase } from './utils/dbInit.js';
import logger from './utils/logger.js';

const PORT = config.port;

let server;

async function startServer() {
  try {
    if (config.database?.url) {
      await initializeDatabase({ throwOnFailure: config.env === 'production' });
    }
  } catch (err) {
    logger.error('Database initialization encountered fatal startup error', {
      error: err.message,
    });
    if (config.env === 'production') {
      process.exit(1);
    }
  }

  server = app.listen(PORT, () => {
    logger.info(`🚀 StockSense AI Backend Gateway Running on port ${PORT}`, {
      port: PORT,
      environment: config.env,
      healthUrl: `http://localhost:${PORT}/api/health`,
      metricsUrl: `http://localhost:${PORT}/metrics`,
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ [Server Error] Port ${PORT} is already in use.`);
      console.error(`💡 Tip: On macOS Monterey+, port 5000 is occupied by AirPlay Receiver (ControlCenter).`);
      console.error(`👉 Solution: Set PORT=5001 in backend/.env or disable AirPlay Receiver in macOS System Settings.\n`);
      process.exit(1);
    } else {
      console.error('[Server Error]', err);
      process.exit(1);
    }
  });

  return server;
}

startServer();

// Graceful shutdown handling
const handleGracefulShutdown = async (signal) => {
  console.log(`\n[Server] Received ${signal}. Commencing graceful termination...`);
  if (server) {
    server.close(async () => {
      console.log('[Server] HTTP connections closed.');
      try {
        if (redisClient) {
          await redisClient.quit();
          console.log('[Redis] Client disconnected.');
        }
        if (prisma) {
          await prisma.$disconnect();
          console.log('[Database] Prisma disconnected.');
        }
      } catch (err) {
        console.error('[Server] Error during teardown:', err);
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }

  setTimeout(() => {
    console.error('[Server] Forceful shutdown initiated after timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

export default server;
