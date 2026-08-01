// ── Shared Redis Connection ──
// One physical connection (or none, if Redis is unreachable) shared by
// every Pulse-backed memory layer and the background job queue. Kept
// separate from pulse.js so the connection's lifecycle (connect/retry/
// health) is a single, testable concern.

import Redis from 'ioredis';
import { config } from './config/index.js';
import { childLogger } from './kernel/logger.js';

const log = childLogger('redis');

export function createRedisConnection() {
  let ready = false;
  const redis = new Redis(config.redis.url, {
    password: config.redis.password,
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    retryStrategy(times) {
      // Cap retry backoff — we never want a boot-time Redis outage to hang
      // the process; fallback stores keep the OS usable in the meantime.
      return Math.min(times * 200, 5000);
    },
  });

  redis.on('ready', () => {
    ready = true;
    log.info('Redis (PulseJS backend) connected');
  });
  redis.on('error', (err) => {
    if (ready) log.warn({ err: err.message }, 'Redis connection error — memory layers degrade to in-process fallback');
    ready = false;
  });
  redis.on('end', () => { ready = false; });

  return {
    client: redis,
    isReady: () => ready,
    async close() {
      try { await redis.quit(); } catch { redis.disconnect(); }
    },
  };
}
