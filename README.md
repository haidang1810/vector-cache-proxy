# Vector Cache Proxy

Semantic cache for LLM responses, backed by Redis. Prompts that mean the same thing ("How to build a REST API?" / "How do I create a REST API?") share one cached answer, which cuts cost and latency.

- Uses Redis vector search (HNSW KNN) on Redis 8+ / Redis Stack. On older Redis it falls back to an in-process scan.
- Embeddings run locally with [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js), or come from your own embedding function.
- Entries are scoped by **context** (model, system prompt, user...), so one user's answer is never served for another context.
- TTL, a namespace, `getOrSet` with concurrent-call deduplication, and TypeScript generics.
- Logs nothing by default. Prompt text is never logged.

## Installation

```bash
npm install vector-cache-proxy
```

Requirements: Node.js >= 18 or Bun >= 1.0. For vector index search you need Redis 8+ or Redis Stack (`docker run -p 6379:6379 redis:8`). Any Redis version works in `scan` mode.

## Quick start

```typescript
import { VectorCacheProxy } from 'vector-cache-proxy';

const cache = new VectorCacheProxy<string>({
  redis: 'redis://localhost:6379',
  ttl: 60 * 60 * 24, // optional, seconds
});

const context = { model: 'gpt-4o', systemPrompt };

const answer = await cache.getOrSet(
  question,
  () => callLlm(question), // only runs on a cache miss
  { context },
);
```

## API

### `new VectorCacheProxy<T>(config)`

| Option | Default | Description |
|---|---|---|
| `redis` | required | ioredis options, a `redis://` URL, or an existing ioredis client. A client you pass in is not closed by `close()`. |
| `threshold` | `0.9` | Minimum cosine similarity (0–1) for a hit. |
| `modelName` | `'Xenova/all-MiniLM-L6-v2'` | Hugging Face model for local embeddings. |
| `embed` | – | `(text) => Promise<number[]>`. Replaces the local model, e.g. with OpenAI embeddings. |
| `namespace` | `'vcp'` | Prefix for every Redis key this cache writes. |
| `ttl` | none | Default expiry in seconds. |
| `searchMode` | `'auto'` | `'index'` (Redis Query Engine), `'scan'` (in-process) or `'auto'`. |
| `logger` | silent | `{ debug?, warn? }`. Receives scores and status, never prompt text. |

### Methods

- `initialize(): Promise<void>`: loads the model and creates the index. It runs automatically on first use. Call it at startup to avoid a slow first request.
- `getCache(text, { context?, threshold? }): Promise<T | null>`
- `search(text, { context?, threshold? }): Promise<{ response, score, text, createdAt } | null>`: like `getCache`, plus the similarity score and the matched prompt.
- `setCache(text, response, { context?, ttl? }): Promise<void>`
- `getOrSet(text, compute, { context?, threshold?, ttl? }): Promise<T>`: returns the cached answer, or runs `compute` and caches the result. Concurrent identical calls share one `compute`.
- `getEmbedding(text): Promise<number[]>`
- `clearCache(): Promise<number>`: deletes every entry in the namespace and returns the number of keys removed.
- `close(): Promise<void>`

### Context

`context` can be any JSON-serializable value. Entries only match lookups with an equal context (object key order does not matter). Put in it everything that changes the answer besides the prompt: model, system prompt, temperature, tools, the user or tenant for personalised answers, and previous turns for multi-turn chats.

### Choosing a threshold

Semantic caches fail by returning a confident wrong answer. With small embedding models, "capital of France?" and "capital of Germany?" can score above 0.85. Start strict (0.9–0.95) and check the `score` from `search()` against real traffic before lowering it.

### Models

| Model | Dims | Notes |
|---|---|---|
| `Xenova/all-MiniLM-L6-v2` | 384 | Default. Small and fast, English only. |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 384 | Use for Vietnamese and other non-English text. |
| `Xenova/bge-small-en-v1.5` | 384 | More accurate English. |

Each model and embedding size gets its own key space and index, so changing models never compares incompatible vectors. Old entries simply stop matching. Remove them with `clearCache()` or let the TTL expire them.

## Migrating from 1.x

- Entries written by 1.x are not read by 2.x. Run `clearCache()` from 1.x first, or delete the `cache:*` keys.
- The default `threshold` is now `0.9` (was `0.85`).
- Nothing is logged to the console. Pass `logger` if you want output.
- `initialize()` is optional.
- The `CacheEntry` type was removed. Use `CacheMatch` from `search()`.

## Development

```bash
npm run typecheck
REDIS_URL=redis://localhost:6379 npm test
```

## License

MIT
