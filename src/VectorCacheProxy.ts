import { pipeline } from '@xenova/transformers';
import Redis from 'ioredis';
import { createHash } from 'crypto';

export interface VectorCacheProxyConfig {
  redis: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    db?: number;
  };
  threshold?: number; // Similarity threshold (default: 0.85)
  modelName?: "Xenova/all-MiniLM-L6-v2" | "Xenova/paraphrase-multilingual-MiniLM-L12-v2" |  "Xenova/bge-small-en-v1.5"; // Embedding model name (default: 'Xenova/all-MiniLM-L6-v2')
}

export interface CacheEntry {
  text: string;
  embedding: number[];
  response: any;
  timestamp: number;
}

export class VectorCacheProxy {
  private redis: Redis;
  private threshold: number;
  private extractor: any;
  private modelName: string;
  private isInitialized: boolean = false;

  constructor(config: VectorCacheProxyConfig) {
    this.threshold = config.threshold ?? 0.85;
    this.modelName = config.modelName ?? 'Xenova/all-MiniLM-L6-v2';

    // Initialize Redis connection with ioredis
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      username: config.redis.username,
      password: config.redis.password,
      db: config.redis.db ?? 0,
    });
  }

  /**
   * Initialize the embedding model pipeline
   * Must be called before using any other methods
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log(`🚀 Initializing model ${this.modelName}...`);
    this.extractor = await pipeline('feature-extraction', this.modelName);
    this.isInitialized = true;
    console.log('✅ Model ready!');
  }

  /**
   * Convert text into a vector embedding
   * @param text - The input text to embed
   * @returns A numerical vector representation of the text
   */
  async getEmbedding(text: string): Promise<number[]> {
    if (!this.isInitialized) {
      throw new Error('VectorCacheProxy is not initialized. Call initialize() first.');
    }

    const output = await this.extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  /**
   * Store a query text and its corresponding response in cache
   * @param text - The query text
   * @param response - The response data to cache
   */
  async setCache(text: string, response: any): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('VectorCacheProxy is not initialized. Call initialize() first.');
    }

    const embedding = await this.getEmbedding(text);

    const cacheEntry: CacheEntry = {
      text,
      embedding,
      response,
      timestamp: Date.now(),
    };

    // Store in Redis with hashed text as key
    const key = this.generateKey(text);
    await this.redis.set(key, JSON.stringify(cacheEntry));

    // Add key to the set for later retrieval
    await this.redis.sadd('cache:keys', key);
  }

  /**
   * Search for a cached response by semantic similarity
   * @param text - The query text to search for
   * @returns The cached response if found (above threshold), null otherwise
   */
  async getCache(text: string): Promise<any | null> {
    if (!this.isInitialized) {
      throw new Error('VectorCacheProxy is not initialized. Call initialize() first.');
    }

    const queryEmbedding = await this.getEmbedding(text);

    // Get all cached keys
    const keys = await this.redis.smembers('cache:keys');

    let bestMatch: CacheEntry | null = null;
    let bestScore = 0;

    // Search through all cache entries
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (!data) continue;

      const entry: CacheEntry = JSON.parse(data);
      const score = this.cosineSimilarity(queryEmbedding, entry.embedding);

      if (score > bestScore && score >= this.threshold) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    if (bestMatch) {
      console.log(`✅ Cache hit! Similarity: ${(bestScore * 100).toFixed(2)}%`);
      console.log(`   Query: "${text}"`);
      console.log(`   Cached: "${bestMatch.text}"`);
      return bestMatch.response;
    }

    console.log(`❌ Cache miss for query: "${text}"`);
    return null;
  }

  /**
   * Calculate cosine similarity between two vectors
   * Formula: (A · B) / (||A|| * ||B||)
   */
  private cosineSimilarity(vectorA: number[], vectorB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i];
      normA += vectorA[i] * vectorA[i];
      normB += vectorB[i] * vectorB[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Generate a cache key from text using SHA-256 hash
   */
  private generateKey(text: string): string {
    const hash = createHash('sha256').update(text).digest('hex');
    return `cache:${hash}`;
  }

  /**
   * Clear all cached entries from Redis
   */
  async clearCache(): Promise<void> {
    const keys = await this.redis.smembers('cache:keys');

    for (const key of keys) {
      await this.redis.del(key);
    }

    await this.redis.del('cache:keys');
    console.log('🗑️  Cache cleared');
  }

  /**
   * Close the Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
