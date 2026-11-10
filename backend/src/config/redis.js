import Redis from 'ioredis';
import { config } from './index.js';

let redisClient = null;
let isConnected = false;

try {
  redisClient = new Redis(config.redis.url, {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 3) {
        return null; // Stop retrying if Redis is not running locally
      }
      return Math.min(times * 100, 1000);
    },
    lazyConnect: true
  });

  redisClient.on('connect', () => {
    isConnected = true;
    console.log('[Redis] Connection established successfully');
  });

  redisClient.on('error', (err) => {
    isConnected = false;
    // Suppress spammy log if running locally without Redis active
  });

  // Attempt non-blocking connection
  redisClient.connect().catch((err) => {
    console.warn(`[Redis] Notice: Redis service not connected (${err.message}). Application running with in-memory caching fallback.`);
  });
} catch (error) {
  console.warn(`[Redis] Notice: Redis client initialization skipped: ${error.message}`);
}

export const isRedisReady = () => isConnected;
export default redisClient;
