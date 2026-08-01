/**
 * memory/index.js — memory factory for ScrappyAi
 * -----------------------------------------------
 * Single entrypoint that assembles the full seven-layer MemoryManager
 * (session, workspace, episodic, semantic, long-term, tool, project —
 * ported from the Pulse Agent OS memory system in memory-manager.js and
 * layers/*.js) behind one call, with "auto mode":
 *
 *   - SCRAPPYAI_REDIS_URL unset (default) -> no network connection is even
 *     attempted; every layer runs on PulseStore's in-process Map fallback.
 *     Non-durable across restarts, but session recall, long-term facts,
 *     semantic RAG (via the deterministic offline embedding in
 *     embeddings.js), episodic recall, tool stats, and project memory all
 *     work with zero configuration.
 *   - SCRAPPYAI_REDIS_URL set -> real Redis-backed persistence, same code
 *     path. If that Redis later becomes unreachable, PulseStore/
 *     MemoryManager degrade back to the in-process fallback on their own.
 *
 * SCRAPPYAI_MEMORY_ENABLED=false turns the whole thing off; buildAgent()
 * then behaves exactly as it did before memory was wired in.
 */
import { createRedisConnection } from './redis-connection.js';
import { MemoryManager } from './memory-manager.js';
import { MemoryExtractor } from './memory-extractor.js';

export function isMemoryEnabled() {
  return process.env.SCRAPPYAI_MEMORY_ENABLED !== 'false';
}

/**
 * @param {Object} [opts]
 * @param {{chat: Function}} [opts.client] a 9router-shaped client (see clients/9router.js);
 *        used only for the fact-extraction model call. Semantic memory's
 *        embeddings always use the deterministic offline fallback since
 *        this client exposes no embed() endpoint — see embeddings.js.
 * @returns {{memoryManager: MemoryManager, extractor: MemoryExtractor, backend: 'redis'|'in-process'}|null}
 */
export function createMemory({ client } = {}) {
  if (!isMemoryEnabled()) return null;

  const redisUrl = process.env.SCRAPPYAI_REDIS_URL;
  const redisConnection = redisUrl ? createRedisConnection() : null;

  const providerRegistry = createProviderRegistryAdapter({ client });
  const memoryManager = new MemoryManager({ redisConnection, providerRegistry, eventBus: null });
  const extractor = new MemoryExtractor({ memoryManager, providerRegistry });

  return {
    memoryManager,
    extractor,
    redisConnection,
    backend: redisConnection ? 'redis' : 'in-process',
  };
}

/**
 * Adapts a 9router-shaped chat client (`client.chat({systemPrompt, messages, tools})`)
 * into the `{ getDefault(): { name, generate(), embed()? } }` shape
 * embeddings.js/memory-extractor.js expect. No embed() is exposed — those
 * modules already fall back to a deterministic offline embedding when the
 * provider doesn't support one, by design.
 */
function createProviderRegistryAdapter({ client }) {
  return {
    getDefault() {
      if (!client) return null;
      return {
        name: 'ninerouter',
        async generate({ messages = [] } = {}) {
          const systemMsg = messages.find((m) => m.role === 'system');
          const rest = messages.filter((m) => m.role !== 'system');
          const result = await client.chat({ systemPrompt: systemMsg?.content, messages: rest, tools: [] });
          return { message: { content: result.type === 'final' ? result.content : '' } };
        },
      };
    },
  };
}

export default createMemory;
