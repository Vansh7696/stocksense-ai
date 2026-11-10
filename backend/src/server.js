import app from './app.js';
import { config } from './config/index.js';
import redisClient from './config/redis.js';
import prisma from './config/prisma.js';

const PORT = config.port;

const server = app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 StockSense AI Backend Gateway Running`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🩺 Health: http://localhost:${PORT}/api/health`);
  console.log(`⚙️  Environment: ${config.env}`);
  console.log(`=========================================`);
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

// Graceful shutdown handling
const handleGracefulShutdown = async (signal) => {
  console.log(`\n[Server] Received ${signal}. Commencing graceful termination...`);
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

  setTimeout(() => {
    console.error('[Server] Forceful shutdown initiated after timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

export default server;
