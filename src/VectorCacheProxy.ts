import { Redis, type RedisOptions } from 'ioredis';
import { createHash } from 'node:crypto';

export type EmbedFunction = (text: string) => Promise<ArrayLike<number>>;

export interface Logger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
}

export type SearchMode = 'auto' | 'index' | 'scan';

export interface VectorCacheProxyConfig {
  /** ioredis options, a redis:// URL, or an existing ioredis client (not closed by `close()`). */
  redis: RedisOptions | string | Redis;
  /** Minimum cosine similarity (0-1) for a hit. Default: 0.9 */
  threshold?: number;
  /** Hugging Face model used for local embeddings. Default: 'Xenova/all-MiniLM-L6-v2' */
  modelName?: string;
  /** Custom embedding function (e.g. OpenAI embeddings). Replaces the local model. */
  embed?: EmbedFunction;
  /** Key prefix for everything this cache writes. Default: 'vcp' */
  namespace?: string;
  /** Default time-to-live in seconds. Default: no expiry */
  ttl?: number;
  /**
   * 'index' uses the Redis Query Engine (Redis 8+ / Redis Stack) for KNN search.
   * 'scan' compares vectors in-process (works on any Redis, fine for small caches).
   * 'auto' (default) uses 'index' when available, otherwise 'scan'.
   */
  searchMode?: SearchMode;
  /** Receives debug/warn messages. Prompt text is never logged. Default: silent */
  logger?: Logger;
}

export interface CacheOptions {
  /**
   * Anything that changes the answer besides the prompt itself: model, system prompt,
   * temperature, user/tenant id, conversation id... Entries only match within the same context.
   */
  context?: unknown;
}

export interface GetCacheOptions extends CacheOptions {
  /** Override the instance threshold for this lookup. */
  threshold?: number;
}

export interface SetCacheOptions extends CacheOptions {
  /** Override the instance TTL (seconds) for this entry. */
  ttl?: number;
}

export type GetOrSetOptions = GetCacheOptions & SetCacheOptions;

export interface CacheMatch<T> {
  response: T;
  /** Cosine similarity between the query and the cached prompt (0-1). */
  score: number;
  /** The prompt the cached response was stored under. */
  text: string;
  createdAt: number;
}

const ENTRY_FIELDS = ['text', 'response', 'createdAt'] as const;

export class VectorCacheProxy<T = unknown> {
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;
  private readonly threshold: number;
  private readonly modelName: string;
  private readonly customEmbed?: EmbedFunction;
  private readonly namespace: string;
  private readonly ttl?: number;
  private readonly requestedMode: SearchMode;
  private readonly logger: Logger;

  private embedFn?: EmbedFunction;
  private dimension = 0;
  private mode: 'index' | 'scan' = 'scan';
  private keyPrefix = '';
  private indexName = '';
  private initPromise?: Promise<void>;
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(config: VectorCacheProxyConfig) {
    const threshold = config.threshold ?? 0.9;
    if (!(threshold > 0 && threshold <= 1)) {
      throw new RangeError('threshold must be in (0, 1]');
    }
    this.threshold = threshold;
    this.modelName = config.modelName ?? 'Xenova/all-MiniLM-L6-v2';
    this.customEmbed = config.embed;
    this.namespace = config.namespace ?? 'vcp';
    this.ttl = config.ttl;
    this.requestedMode = config.searchMode ?? 'auto';
    this.logger = config.logger ?? {};

    if (isRedisClient(config.redis)) {
      this.redis = config.redis;
      this.ownsRedis = false;
    } else {
      this.redis =
        typeof config.redis === 'string'
          ? new Redis(config.redis, { lazyConnect: true })
          : new Redis({ ...config.redis, lazyConnect: true });
      this.ownsRedis = true;
    }
  }

  /**
   * Loads the embedding model and prepares Redis. Called automatically on first use;
   * call it explicitly to pay the model-loading cost up front.
   */
  initialize(): Promise<void> {
    this.initPromise ??= this.doInitialize().catch((err) => {
      this.initPromise = undefined;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    if (this.ownsRedis && this.redis.status === 'wait') {
      await this.redis.connect();
    }

    if (this.customEmbed) {
      this.embedFn = this.customEmbed;
    } else {
      const { pipeline } = await import('@huggingface/transformers');
      const extractor = await pipeline('feature-extraction', this.modelName);
      this.embedFn = async (text) => {
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        return output.data as Float32Array;
      };
    }

    // Probe once to learn the vector size, so entries from a different model never mix.
    this.dimension = (await this.embedFn('dimension probe')).length;
    const modelId = this.customEmbed ? 'custom' : this.modelName;
    const space = shortHash(`${modelId}:${this.dimension}`);
    this.keyPrefix = `${this.namespace}:${space}:`;
    this.indexName = `${this.namespace}:idx:${space}`;

    this.mode = await this.resolveMode();
    if (this.mode === 'index') await this.ensureIndex();
    this.logger.debug?.('VectorCacheProxy ready', {
      model: modelId,
      dimension: this.dimension,
      mode: this.mode,
    });
  }

  /** Converts text into a normalized embedding vector. */
  async getEmbedding(text: string): Promise<number[]> {
    return Array.from(await this.embedNormalized(text));
  }

  /** Stores a response for a prompt. */
  async setCache(text: string, response: T, options: SetCacheOptions = {}): Promise<void> {
    await this.initialize();
    const vector = await this.embedNormalized(text);
    const scope = scopeOf(options.context);
    const key = `${this.keyPrefix}${shortHash(`${scope}\n${text}`, 32)}`;
    const ttl = options.ttl ?? this.ttl;

    const tx = this.redis.multi().hset(key, {
      text,
      scope,
      response: JSON.stringify(response),
      createdAt: Date.now(),
      embedding: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    });
    if (ttl && ttl > 0) tx.expire(key, Math.ceil(ttl));
    else tx.persist(key);
    await tx.exec();
  }

  /** Returns the closest cached response at or above the threshold, or null. */
  async getCache(text: string, options: GetCacheOptions = {}): Promise<T | null> {
    return (await this.search(text, options))?.response ?? null;
  }

  /** Like getCache, but also returns the similarity score and the matched prompt. */
  async search(text: string, options: GetCacheOptions = {}): Promise<CacheMatch<T> | null> {
    await this.initialize();
    const vector = await this.embedNormalized(text);
    const scope = scopeOf(options.context);
    const threshold = options.threshold ?? this.threshold;

    const match =
      this.mode === 'index'
        ? await this.searchIndex(vector, scope, threshold)
        : await this.searchScan(vector, scope, threshold);

    if (match) this.logger.debug?.('cache hit', { score: match.score });
    else this.logger.debug?.('cache miss');
    return match;
  }

  /**
   * Returns the cached response, or calls `compute`, caches and returns its result.
   * Concurrent calls with the same prompt and context share a single `compute` call.
   */
  async getOrSet(text: string, compute: () => Promise<T>, options: GetOrSetOptions = {}): Promise<T> {
    const flightKey = `${scopeOf(options.context)}\n${text}`;
    const pending = this.inFlight.get(flightKey);
    if (pending) return pending;

    const run = (async () => {
      const cached = await this.search(text, options);
      if (cached) return cached.response;
      const response = await compute();
      await this.setCache(text, response, options);
      return response;
    })();

    this.inFlight.set(flightKey, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  /** Deletes every entry in this namespace (all models and contexts). */
  async clearCache(): Promise<number> {
    let deleted = 0;
    for await (const keys of this.scanKeys(`${this.namespace}:*`)) {
      // Keep the index definitions; they hold no data of their own.
      const entries = keys.filter((k) => !k.startsWith(`${this.namespace}:idx:`));
      if (entries.length) deleted += await this.redis.unlink(...entries);
    }
    return deleted;
  }

  /** Closes the Redis connection if this instance created it. */
  async close(): Promise<void> {
    if (this.ownsRedis && this.redis.status !== 'end') await this.redis.quit();
  }

  private async embedNormalized(text: string): Promise<Float32Array> {
    await this.initialize();
    const raw = await this.embedFn!(text);
    const vector = Float32Array.from(raw);
    if (this.dimension && vector.length !== this.dimension) {
      throw new Error(`Embedding has ${vector.length} dimensions, expected ${this.dimension}`);
    }
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0 && Math.abs(norm - 1) > 1e-6) {
      for (let i = 0; i < vector.length; i++) vector[i]! /= norm;
    }
    return vector;
  }

  private async resolveMode(): Promise<'index' | 'scan'> {
    if (this.requestedMode === 'scan') return 'scan';
    try {
      await this.redis.call('FT._LIST');
      return 'index';
    } catch (err) {
      if (this.requestedMode === 'index') {
        throw new Error('searchMode "index" needs Redis 8+ or Redis Stack (FT.* commands not available)', {
          cause: err,
        });
      }
      this.logger.warn?.(
        'Redis Query Engine not available, falling back to in-process scan. Use Redis 8+ or Redis Stack for large caches.',
      );
      return 'scan';
    }
  }

  private async ensureIndex(): Promise<void> {
    try {
      await this.redis.call(
        'FT.CREATE', this.indexName,
        'ON', 'HASH',
        'PREFIX', '1', this.keyPrefix,
        'SCHEMA',
        'scope', 'TAG',
        'embedding', 'VECTOR', 'HNSW', '6',
        'TYPE', 'FLOAT32',
        'DIM', String(this.dimension),
        'DISTANCE_METRIC', 'COSINE',
      );
    } catch (err) {
      if (!/already exists/i.test(String((err as Error).message))) throw err;
    }
  }

  private async searchIndex(vector: Float32Array, scope: string, threshold: number): Promise<CacheMatch<T> | null> {
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    // scope is a hex hash, so it never needs TAG escaping.
    const reply = (await this.redis.call(
      'FT.SEARCH', this.indexName,
      `(@scope:{${scope}})=>[KNN 1 @embedding $vec AS distance]`,
      'PARAMS', '2', 'vec', blob,
      'RETURN', '4', 'distance', ...ENTRY_FIELDS,
      'SORTBY', 'distance',
      'DIALECT', '2',
    )) as [number, ...unknown[]];

    if (!reply || reply[0] === 0) return null;
    const fields = toRecord(reply[2] as string[]);
    const score = 1 - Number(fields.distance);
    if (score < threshold || fields.response === undefined) return null;
    return {
      response: JSON.parse(fields.response) as T,
      score,
      text: fields.text ?? '',
      createdAt: Number(fields.createdAt),
    };
  }

  private async searchScan(vector: Float32Array, scope: string, threshold: number): Promise<CacheMatch<T> | null> {
    let bestKey: string | null = null;
    let bestScore = -Infinity;

    for await (const keys of this.scanKeys(`${this.keyPrefix}*`)) {
      const pipe = this.redis.pipeline();
      for (const key of keys) pipe.hmgetBuffer(key, 'scope', 'embedding');
      const results = (await pipe.exec()) ?? [];

      results.forEach(([err, value], i) => {
        if (err) return;
        const [entryScope, embedding] = value as [Buffer | null, Buffer | null];
        if (!entryScope || !embedding || entryScope.toString() !== scope) return;
        if (embedding.byteLength !== vector.byteLength) return;
        const score = dot(vector, toFloat32(embedding));
        if (score > bestScore) {
          bestScore = score;
          bestKey = keys[i]!;
        }
      });
    }

    if (bestKey === null || bestScore < threshold) return null;
    const [text, response, createdAt] = await this.redis.hmget(bestKey, ...ENTRY_FIELDS);
    if (response === null) return null; // expired between scan and read
    return {
      response: JSON.parse(response) as T,
      score: bestScore,
      text: text ?? '',
      createdAt: Number(createdAt),
    };
  }

  private async *scanKeys(match: string): AsyncGenerator<string[]> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
      cursor = next;
      if (keys.length) yield keys;
    } while (cursor !== '0');
  }
}

function isRedisClient(value: unknown): value is Redis {
  // Duck-typed so a client from another copy of ioredis is still accepted.
  return (
    value instanceof Redis ||
    (typeof value === 'object' && value !== null && typeof (value as Redis).call === 'function' && 'status' in value)
  );
}

function shortHash(input: string, length = 12): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function scopeOf(context: unknown): string {
  return context === undefined ? 'global' : shortHash(stableStringify(context), 24);
}

/** JSON.stringify with sorted object keys, so { a, b } and { b, a } give the same scope. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function toFloat32(buf: Buffer): Float32Array {
  // Copy so the view is 4-byte aligned regardless of the Buffer's offset.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function toRecord(flat: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1]);
  return out;
}
