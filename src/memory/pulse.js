import Redis from "ioredis";
import { randomUUID } from "node:crypto";

const NULL_SENTINEL = "__$CACHE_NULL$__";
const SNAPSHOT_TAG_PART = "invalidating";

const DEFAULT_UNLINK_CHUNK_SIZE = 1000;
const DEFAULT_SETMANY_CHUNK_SIZE = 100;
const DEFAULT_SCAN_COUNT = 1000;
const DEFAULT_MAX_KEY_LENGTH = 512;

function abortError() {
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  return err;
}

export function cacheWorker({
  redis = new Redis({
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  }),

  serializer = JSON.stringify,
  deserializer = JSON.parse,

  tagTtlPadding = 300,
  allowColonInKey = false,
  logger = console,
  namespace = "",

  onEvent = null,

  unlinkChunkSize = DEFAULT_UNLINK_CHUNK_SIZE,
  setManyChunkSize = DEFAULT_SETMANY_CHUNK_SIZE,
  scanCount = DEFAULT_SCAN_COUNT,

  snapshotCleanupProbability = 0.01,
  snapshotMaxAgeMs = 10 * 60 * 1000,

  maxKeyLength = DEFAULT_MAX_KEY_LENGTH,

  defaultTtl = 60,
  lockTtl = 3,

  throwOnSerializationError = false,
  throwOnDeserializationError = false,
} = {}) {
  let releaseScriptSha = null;
  let heartbeatScriptSha = null;
  let setCacheScriptSha = null;
  let invalidateTagScriptSha = null;
  let setCacheManyScriptSha = null;

  const nsPrefix = namespace ? `${String(namespace).replace(/:+$/, "")}:` : "";

  function nsKey(key) {
    return `${nsPrefix}${key}`;
  }

  function rawKey(key) {
    return key.startsWith(nsPrefix) ? key.slice(nsPrefix.length) : key;
  }

  function lockKeyOf(key) {
    return `${nsPrefix}lock:${key}`;
  }

  function tagKeyOf(tag) {
    return `${nsPrefix}tag:${tag}`;
  }

  function snapshotKeyOf(tag) {
    return `${nsPrefix}tag:${tag}:${SNAPSHOT_TAG_PART}:${Date.now()}:${randomUUID()}`;
  }

  function snapshotScanPattern() {
    return `${nsPrefix}tag:*:${SNAPSHOT_TAG_PART}:*`;
  }

  function emit(eventName, payload = {}) {
    if (!onEvent) return;

    try {
      onEvent(eventName, payload);
    } catch (err) {
      try {
        logger.error("cacheWorker onEvent handler threw:", err);
      } catch {}
    }
  }

  const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

  function validateKey(key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`Invalid cache key: ${key}`);
    }

    if (!allowColonInKey && key.includes(":")) {
      throw new Error(`Invalid cache key: colon is not allowed: ${key}`);
    }

    if (key.length > maxKeyLength) {
      throw new Error(`Invalid cache key: exceeds max length of ${maxKeyLength}`);
    }

    if (CONTROL_CHAR_RE.test(key)) {
      throw new Error("Invalid cache key: contains control characters");
    }

    return key;
  }

  function validateTag(tag) {
    if (typeof tag !== "string" || tag.length === 0) {
      throw new Error(`Invalid tag: ${tag}`);
    }

    if (/[:\s]/.test(tag)) {
      throw new Error(`Invalid tag: whitespace or colon is not allowed: ${tag}`);
    }

    if (tag.length > maxKeyLength) {
      throw new Error(`Invalid tag: exceeds max length of ${maxKeyLength}`);
    }

    if (CONTROL_CHAR_RE.test(tag)) {
      throw new Error("Invalid tag: contains control characters");
    }

    return tag;
  }

  function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags.map(validateTag))];
  }

  function normalizeTtl(ttl) {
    if (!Number.isFinite(ttl) || ttl <= 0) return null;
    return Math.max(1, Math.floor(ttl));
  }

  function isPromiseLike(val) {
    return val !== null && typeof val === "object" && typeof val.then === "function";
  }

  function serialize(val) {
    if (val === undefined) return null;
    if (val === null) return NULL_SENTINEL;

    try {
      const result = serializer(val);

      if (isPromiseLike(result)) {
        throw new Error("cacheWorker: serializer returned a Promise.");
      }

      if (typeof result !== "string") {
        return JSON.stringify(result);
      }

      return result;
    } catch (err) {
      logger.error("Cache serialization error:", err);

      if (throwOnSerializationError) throw err;

      return null;
    }
  }

  let consecutiveDeserializeErrors = 0;
  const DESERIALIZE_ERROR_LOG_CAP = 5;

  function deserialize(str) {
    if (str === NULL_SENTINEL) return null;
    if (str === null) return undefined;

    try {
      const result = deserializer(str);

      if (isPromiseLike(result)) {
        throw new Error("cacheWorker: deserializer returned a Promise.");
      }

      consecutiveDeserializeErrors = 0;
      return result;
    } catch (err) {
      consecutiveDeserializeErrors++;

      if (consecutiveDeserializeErrors <= DESERIALIZE_ERROR_LOG_CAP) {
        logger.error("Cache deserialization error:", err);
      }

      if (throwOnDeserializationError) throw err;

      return undefined;
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());

      const timer = setTimeout(resolve, ms);

      if (!signal) return;

      function onAbort() {
        clearTimeout(timer);
        reject(abortError());
      }

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function loadScript(script) {
    return redis.script("LOAD", script);
  }

  async function evalScript(scriptName, script, shaRef, keyCount, ...args) {
    try {
      if (!shaRef.value) shaRef.value = await loadScript(script);
      return await redis.evalsha(shaRef.value, keyCount, ...args);
    } catch (err) {
      if (err?.message?.includes("NOSCRIPT")) {
        shaRef.value = await loadScript(script);
        return await redis.evalsha(shaRef.value, keyCount, ...args);
      }

      emit("script_error", {
        scriptName,
        error: err?.message,
      });

      throw err;
    }
  }

  function isUnsupportedCommandError(err, commandName) {
    const msg = err?.message || "";
    const isUnknownCommandMsg = /unknown command/i.test(msg);

    const mentionsCommand =
      new RegExp(commandName, "i").test(msg) ||
      typeof err?.command?.name === "string" &&
        err.command.name.toLowerCase() === commandName.toLowerCase();

    return isUnknownCommandMsg && mentionsCommand;
  }

  async function unlinkOrDel(keys) {
    if (!keys.length) return 0;

    let total = 0;

    for (let i = 0; i < keys.length; i += unlinkChunkSize) {
      const slice = keys.slice(i, i + unlinkChunkSize);

      try {
        total += await redis.unlink(...slice);
      } catch (err) {
        if (isUnsupportedCommandError(err, "unlink")) {
          total += await redis.del(...slice);
        } else {
          throw err;
        }
      }
    }

    return total;
  }

  function computeTtlMode(ttl, persist) {
    const normTtl = normalizeTtl(ttl);
    const ttlMode = persist || normTtl === null ? "persist" : "ttl";
    const ttlVal = ttlMode === "persist" ? "0" : String(normTtl);

    return { normTtl, ttlMode, ttlVal };
  }

  function computeTagExpiry(hasTags, ttlMode, normTtl) {
    if (!hasTags) return -1;
    if (ttlMode === "persist") return -1;

    return Math.max(normTtl + Math.max(tagTtlPadding, 5), 1);
  }

  const setCacheScript = `
    local cacheKey = ARGV[1]
    local data = ARGV[2]
    local ttlMode = ARGV[3]
    local ttlVal = ARGV[4]
    local tagExpiry = tonumber(ARGV[5])

    if ttlMode == "persist" then
      redis.call("set", cacheKey, data)
    else
      redis.call("set", cacheKey, data, "EX", ttlVal)
    end

    for i = 6, #ARGV do
      local tk = ARGV[i]
      local existedBefore = redis.call("exists", tk) == 1

      redis.call("sadd", tk, cacheKey)

      if tagExpiry == -1 then
        redis.call("persist", tk)
      elseif not existedBefore then
        redis.call("expire", tk, tagExpiry)
      else
        local currentTtl = redis.call("ttl", tk)

        if currentTtl ~= -1 and currentTtl < tagExpiry then
          redis.call("expire", tk, tagExpiry)
        end
      end
    end

    return 1
  `;

  const setCacheManyScript = `
    local ttlMode = ARGV[1]
    local ttlVal = ARGV[2]
    local tagExpiry = tonumber(ARGV[3])
    local itemCount = tonumber(ARGV[4])
    local idx = 5

    for i = 1, itemCount do
      local cacheKey = ARGV[idx]
      local data = ARGV[idx + 1]

      if ttlMode == "persist" then
        redis.call("set", cacheKey, data)
      else
        redis.call("set", cacheKey, data, "EX", ttlVal)
      end

      idx = idx + 2
    end

    for i = idx, #ARGV do
      local tk = ARGV[i]
      local existedBefore = redis.call("exists", tk) == 1

      for j = 5, 5 + (itemCount * 2) - 1, 2 do
        redis.call("sadd", tk, ARGV[j])
      end

      if tagExpiry == -1 then
        redis.call("persist", tk)
      elseif not existedBefore then
        redis.call("expire", tk, tagExpiry)
      else
        local currentTtl = redis.call("ttl", tk)

        if currentTtl ~= -1 and currentTtl < tagExpiry then
          redis.call("expire", tk, tagExpiry)
        end
      end
    end

    return itemCount
  `;

  const releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end

    return 0
  `;

  const heartbeatScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("expire", KEYS[1], ARGV[2])
    end

    return 0
  `;

  const invalidateTagScript = `
    local tagKey = KEYS[1]
    local snapshotKey = KEYS[2]
    local snapshotTtl = tonumber(ARGV[1])

    if redis.call("exists", tagKey) == 0 then
      return 0
    end

    redis.call("rename", tagKey, snapshotKey)
    redis.call("expire", snapshotKey, snapshotTtl)

    return 1
  `;

  async function setCache(key, val, ttl = defaultTtl, tags = [], persist = false) {
    validateKey(key);

    const data = serialize(val);
    if (data === null) return false;

    const normalizedTags = normalizeTags(tags);
    const { normTtl, ttlMode, ttlVal } = computeTtlMode(ttl, persist);
    const tagExpiry = computeTagExpiry(normalizedTags.length > 0, ttlMode, normTtl);
    const tagKeys = normalizedTags.map(tagKeyOf);

    const args = [
      nsKey(key),
      data,
      ttlMode,
      ttlVal,
      String(tagExpiry),
      ...tagKeys,
    ];

    await evalScript(
      "setCache",
      setCacheScript,
      {
        get value() {
          return setCacheScriptSha;
        },
        set value(v) {
          setCacheScriptSha = v;
        },
      },
      0,
      ...args,
    );

    emit("set", { key, tags: normalizedTags, ttl, persist });

    return true;
  }

  async function setCacheMany(entries, ttl = defaultTtl, tags = [], persist = false) {
    if (!Array.isArray(entries) || entries.length === 0) return 0;

    const normalizedTags = normalizeTags(tags);
    const { normTtl, ttlMode, ttlVal } = computeTtlMode(ttl, persist);
    const tagExpiry = computeTagExpiry(normalizedTags.length > 0, ttlMode, normTtl);
    const tagKeys = normalizedTags.map(tagKeyOf);

    let total = 0;

    for (let i = 0; i < entries.length; i += setManyChunkSize) {
      const chunk = entries.slice(i, i + setManyChunkSize);
      const itemArgs = [];

      for (const entry of chunk) {
        const key = Array.isArray(entry) ? entry[0] : entry.key;
        const value = Array.isArray(entry) ? entry[1] : entry.value;

        validateKey(key);

        const data = serialize(value);
        if (data === null) continue;

        itemArgs.push(nsKey(key), data);
      }

      const itemCount = itemArgs.length / 2;
      if (itemCount === 0) continue;

      const args = [
        ttlMode,
        ttlVal,
        String(tagExpiry),
        String(itemCount),
        ...itemArgs,
        ...tagKeys,
      ];

      total += Number(
        await evalScript(
          "setCacheMany",
          setCacheManyScript,
          {
            get value() {
              return setCacheManyScriptSha;
            },
            set value(v) {
              setCacheManyScriptSha = v;
            },
          },
          0,
          ...args,
        ),
      );
    }

    emit("set_many", { count: total, tags: normalizedTags, ttl, persist });

    return total;
  }

  async function getCache(key) {
    validateKey(key);

    const val = await redis.get(nsKey(key));

    if (val === null) {
      emit("miss", { key });
      return undefined;
    }

    const result = deserialize(val);

    emit(result === undefined ? "deserialize_miss" : "hit", { key });

    return result;
  }

  async function getCacheMany(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return {};

    const validKeys = keys.map(validateKey);
    const values = await redis.mget(...validKeys.map(nsKey));

    const result = {};

    for (let i = 0; i < validKeys.length; i++) {
      const value = values[i];

      if (value === null) {
        result[validKeys[i]] = undefined;
      } else {
        result[validKeys[i]] = deserialize(value);
      }
    }

    return result;
  }

  async function hasCache(key) {
    validateKey(key);
    return (await redis.exists(nsKey(key))) > 0;
  }

  async function deleteCache(key) {
    validateKey(key);

    const deleted = await redis.del(nsKey(key));

    emit("delete", { key, deleted });

    return deleted;
  }

  async function deleteCacheMany(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return 0;

    const validKeys = keys.map(validateKey).map(nsKey);
    const deleted = await unlinkOrDel(validKeys);

    emit("delete_many", { count: deleted });

    return deleted;
  }

  async function acquireLock(key, ttl = lockTtl) {
    validateKey(key);

    const token = randomUUID();
    const finalTtl = Math.max(1, Math.floor(ttl) || 1);

    const ok = await redis.set(lockKeyOf(key), token, "NX", "EX", finalTtl);

    emit(ok ? "lock_acquired" : "lock_failed", { key, ttl: finalTtl });

    return ok ? token : false;
  }

  async function releaseLock(key, token) {
    validateKey(key);

    if (!token) return false;

    const released = Number(
      await evalScript(
        "releaseLock",
        releaseScript,
        {
          get value() {
            return releaseScriptSha;
          },
          set value(v) {
            releaseScriptSha = v;
          },
        },
        1,
        lockKeyOf(key),
        token,
      ),
    ) === 1;

    emit("lock_released", { key, released });

    return released;
  }

  async function heartbeatLock(key, token, ttl = lockTtl) {
    validateKey(key);

    if (!token) return false;

    const finalTtl = Math.max(1, Math.floor(ttl) || 1);

    return Number(
      await evalScript(
        "heartbeatLock",
        heartbeatScript,
        {
          get value() {
            return heartbeatScriptSha;
          },
          set value(v) {
            heartbeatScriptSha = v;
          },
        },
        1,
        lockKeyOf(key),
        token,
        String(finalTtl),
      ),
    ) === 1;
  }

  async function withLock(
    key,
    fn,
    {
      ttl = lockTtl,
      retries = 10,
      retryDelayMs = 100,
      signal = null,
      heartbeat = true,
    } = {},
  ) {
    validateKey(key);

    let token = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      token = await acquireLock(key, ttl);

      if (token) break;

      if (attempt < retries) {
        await sleep(retryDelayMs, signal);
      }
    }

    if (!token) {
      throw new Error(`Could not acquire lock for key: ${key}`);
    }

    let heartbeatTimer = null;

    try {
      if (heartbeat) {
        const intervalMs = Math.max(250, Math.floor((ttl * 1000) / 2));

        heartbeatTimer = setInterval(() => {
          heartbeatLock(key, token, ttl).catch((err) => {
            logger.error("Cache lock heartbeat error:", err);
          });
        }, intervalMs);

        heartbeatTimer.unref?.();
      }

      return await fn(token);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await releaseLock(key, token);
    }
  }

  async function invalidateTag(tag) {
    validateTag(tag);

    const tagKey = tagKeyOf(tag);
    const snapshotKey = snapshotKeyOf(tag);
    const snapshotTtl = Math.max(1, Math.ceil(snapshotMaxAgeMs / 1000));

    const renamed = Number(
      await evalScript(
        "invalidateTag",
        invalidateTagScript,
        {
          get value() {
            return invalidateTagScriptSha;
          },
          set value(v) {
            invalidateTagScriptSha = v;
          },
        },
        2,
        tagKey,
        snapshotKey,
        String(snapshotTtl),
      ),
    );

    if (renamed === 0) {
      emit("invalidate_tag_empty", { tag });
      return 0;
    }

    let cursor = "0";
    let deleted = 0;

    do {
      const [nextCursor, members] = await redis.sscan(
        snapshotKey,
        cursor,
        "COUNT",
        scanCount,
      );

      cursor = nextCursor;

      if (members.length > 0) {
        deleted += await unlinkOrDel(members);
      }
    } while (cursor !== "0");

    await redis.del(snapshotKey);

    emit("invalidate_tag", { tag, deleted });

    if (Math.random() < snapshotCleanupProbability) {
      cleanupSnapshots().catch((err) => {
        logger.error("Cache snapshot cleanup error:", err);
      });
    }

    return deleted;
  }

  async function cleanupSnapshots() {
    const pattern = snapshotScanPattern();
    const now = Date.now();
    let cursor = "0";
    let deleted = 0;

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        scanCount,
      );

      cursor = nextCursor;

      const expiredSnapshots = [];

      for (const key of keys) {
        const parts = key.split(":");
        const timestamp = Number(parts[parts.length - 2]);

        if (!Number.isFinite(timestamp) || now - timestamp > snapshotMaxAgeMs) {
          expiredSnapshots.push(key);
        }
      }

      if (expiredSnapshots.length > 0) {
        deleted += await unlinkOrDel(expiredSnapshots);
      }
    } while (cursor !== "0");

    emit("cleanup_snapshots", { deleted });

    return deleted;
  }

  async function clearNamespace() {
    if (!nsPrefix) {
      throw new Error("clearNamespace requires a namespace to avoid deleting unrelated Redis keys.");
    }

    let cursor = "0";
    let deleted = 0;

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${nsPrefix}*`,
        "COUNT",
        scanCount,
      );

      cursor = nextCursor;

      if (keys.length > 0) {
        deleted += await unlinkOrDel(keys);
      }
    } while (cursor !== "0");

    emit("clear_namespace", { namespace, deleted });

    return deleted;
  }

  async function getOrSetCache(
    key,
    producer,
    {
      ttl = defaultTtl,
      tags = [],
      persist = false,
      lock = true,
      lockOptions = {},
    } = {},
  ) {
    const cached = await getCache(key);

    if (cached !== undefined) return cached;

    async function produceAndSet() {
      const secondCheck = await getCache(key);

      if (secondCheck !== undefined) return secondCheck;

      const value = await producer();

      if (value !== undefined) {
        await setCache(key, value, ttl, tags, persist);
      }

      return value;
    }

    if (!lock) return produceAndSet();

    return withLock(`cache-fill:${key}`, produceAndSet, lockOptions);
  }

  return {
    client: redis,
    setCache,
    setCacheMany,
    getCache,
    getCacheMany,
    getOrSetCache,
    hasCache,
    deleteCache,
    deleteCacheMany,
    invalidateTag,
    cleanupSnapshots,
    clearNamespace,
    acquireLock,
    releaseLock,
    heartbeatLock,
    withLock,
    rawKey,
  };
}

export default cacheWorker;
