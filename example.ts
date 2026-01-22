import { VectorCacheProxy } from './src/index';

// Initialize the library with Redis config and threshold
const cacheProxy = new VectorCacheProxy({
  redis: {
    host: 'localhost',
    port: 6379,
    password: '', // optional
    db: 0, // optional
  },
  threshold: 0.85, // Similarity threshold (optional, default: 0.85)
  modelName: 'Xenova/all-MiniLM-L6-v2', // optional
});

// Initialize the model (required before use)
await cacheProxy.initialize();

// ==========================================
// USE CASE 1: Get embedding from text
// ==========================================
console.log('\n📌 USE CASE 1: getEmbedding()');
const text = 'How to build a REST API?';
const embedding = await cacheProxy.getEmbedding(text);
console.log(`Embedding for "${text}":`, embedding.slice(0, 5), '... (384 dimensions)');

// ==========================================
// USE CASE 2: Cache a query and response
// ==========================================
console.log('\n📌 USE CASE 2: setCache()');

// Simulated LLM response
const llmResponse = {
  answer: 'To build a REST API, you need to define routes, controllers, and models...',
  tokens: 150,
  model: 'gpt-4',
};

await cacheProxy.setCache('How to build a REST API?', llmResponse);
console.log('✅ Cached response for query: "How to build a REST API?"');

// Cache additional queries
await cacheProxy.setCache('What is the best way to create a REST API?', {
  answer: 'The best way to create a REST API is to use a framework like Express.js...',
  tokens: 120,
  model: 'gpt-4',
});

await cacheProxy.setCache('What is machine learning?', {
  answer: 'Machine learning is a subset of artificial intelligence...',
  tokens: 200,
  model: 'gpt-4',
});

// ==========================================
// USE CASE 3: Search cache with similar query
// ==========================================
console.log('\n📌 USE CASE 3: getCache()');

// Similar query should return cached response
const cached1 = await cacheProxy.getCache('How do I create a REST API?');
if (cached1) {
  console.log('📦 Cached response:', cached1);
} else {
  console.log('❌ Cache miss, need to call LLM');
}

// Completely different query should not return cache
console.log('\n---');
const cached2 = await cacheProxy.getCache('How to train a neural network?');
if (cached2) {
  console.log('📦 Cached response:', cached2);
} else {
  console.log('❌ Cache miss, need to call LLM');
}

// ==========================================
// BONUS: Clear cache and close connection
// ==========================================
console.log('\n📌 BONUS: Clear cache and close connection');
// await cacheProxy.clearCache(); // Uncomment to clear all cache
await cacheProxy.close();
console.log('✅ Redis connection closed');
