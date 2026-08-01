/**
 * config/index.js — memory module config shim
 * -----------------------------------------------
 * The original redis-connection.js pulled Redis settings from a shared
 * kernel config object. ScrappyAi's own config story is "everything is an
 * env var" (see .env.example), so this just adapts that same convention
 * for the one thing the memory layer needs: how to reach Redis, if at all.
 */
export const config = {
  redis: {
    url: process.env.SCRAPPYAI_REDIS_URL || 'redis://127.0.0.1:6379',
    password: process.env.SCRAPPYAI_REDIS_PASSWORD || undefined,
  },
};

export default config;
