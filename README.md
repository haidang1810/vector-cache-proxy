# Vector Cache Proxy

A semantic caching library using vector embeddings and Redis to cache LLM responses. Helps reduce costs and improve response times for similar queries.

## Features

- ✅ Uses vector embeddings for semantic search (no exact text match required)
- ✅ Caches responses in Redis
- ✅ Customizable similarity threshold
- ✅ Multiple embedding model support
- ✅ TypeScript support

## Installation

```bash
# With npm
npm install vector-cache-proxy

# With Bun
bun add vector-cache-proxy

# With yarn
yarn add vector-cache-proxy
```

## Requirements

- Node.js >= 18 or Bun >= 1.0.0
- Redis server

## Usage

### 1. Initialize

```typescript
import { VectorCacheProxy } from 'vector-cache-proxy';

const cacheProxy = new VectorCacheProxy({
  redis: {
    host: 'localhost',
    port: 6379,
    password: '', // optional
    db: 0, // optional
  },
  threshold: 0.85, // Similarity threshold (0-1), default: 0.85
  modelName: 'Xenova/all-MiniLM-L6-v2', // optional
});

// Initialize the model (required)
await cacheProxy.initialize();
```

### 2. API Methods

#### `getEmbedding(text: string): Promise<number[]>`

Convert text into vector embedding.

```typescript
const embedding = await cacheProxy.getEmbedding('How to train a model?');
console.log(embedding); // [0.123, -0.456, ...]
```

#### `setCache(text: string, response: any): Promise<void>`

Store text query and response in cache.

```typescript
const llmResponse = {
  answer: 'To train a model, you need data and...',
  tokens: 150,
  model: 'gpt-4',
};

await cacheProxy.setCache('How to train a model?', llmResponse);
```

#### `getCache(text: string): Promise<any | null>`

Search for cached response by semantic similarity. Returns `null` if not found.

```typescript
// Similar query will return cached response
const cached = await cacheProxy.getCache('What is model training?');

if (cached) {
  console.log('✅ Cache hit:', cached);
} else {
  console.log('❌ Cache miss, calling LLM');
  // Call LLM and save to cache
  const response = await callLLM(text);
  await cacheProxy.setCache(text, response);
}
```

### 3. Complete Example with LLM

```typescript
import { VectorCacheProxy } from 'vector-cache-proxy';

const cacheProxy = new VectorCacheProxy({
  redis: { host: 'localhost', port: 6379 },
  threshold: 0.85,
});

await cacheProxy.initialize();

async function askLLM(question: string) {
  // Check cache first
  const cached = await cacheProxy.getCache(question);

  if (cached) {
    console.log('✅ Using cache');
    return cached;
  }

  // Call LLM
  console.log('🔄 Calling LLM...');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [{ role: 'user', content: question }],
    }),
  });

  const data = await response.json();

  // Save to cache
  await cacheProxy.setCache(question, data);

  return data;
}

// Usage
const answer1 = await askLLM('How to train a model?');
const answer2 = await askLLM('What is model training?'); // ✅ Uses cache

await cacheProxy.close();
```

### 4. Additional Methods

#### `clearCache(): Promise<void>`

Clear all cached entries.

```typescript
await cacheProxy.clearCache();
```

#### `close(): Promise<void>`

Close Redis connection.

```typescript
await cacheProxy.close();
```

## Configuration

### VectorCacheProxyConfig

```typescript
interface VectorCacheProxyConfig {
  redis: {
    host: string;        // Redis host
    port: number;        // Redis port
    username?: string;   // Redis username (optional)
    password?: string;   // Redis password (optional)
    db?: number;         // Redis database (optional, default: 0)
  };
  threshold?: number;    // Similarity threshold (0-1), default: 0.85
  modelName?: string;    // Embedding model, default: 'Xenova/all-MiniLM-L6-v2'
}
```

### Threshold Guidelines

- `0.95+`: Very similar (nearly identical)
- `0.85-0.95`: Semantically similar (recommended)
- `0.70-0.85`: Related but may differ in meaning
- `< 0.70`: Different

## Supported Models

The library uses `@xenova/transformers`, you can choose different models:

- `Xenova/all-MiniLM-L6-v2` (default, 384 dimensions, fast)
- `Xenova/all-mpnet-base-v2` (768 dimensions, more accurate)
- `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (better multilingual support)

## License

MIT
