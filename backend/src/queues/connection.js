import { config } from '../config/index.js';

/**
 * Returns standardized connection options for BullMQ queues and workers.
 * Requires maxRetriesPerRequest: null per BullMQ architectural constraints.
 */
export function getQueueConnectionOptions() {
  const redisUrl = config.redis.url || 'redis://localhost:6379';
  try {
    const parsed = new URL(redisUrl);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  } catch {
    return {
      host: config.redis.host || 'localhost',
      port: config.redis.port || 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}
