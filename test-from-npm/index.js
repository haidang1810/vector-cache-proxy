import { VectorCacheProxy } from 'vector-cache-proxy';

console.log('Testing vector-cache-proxy from npm...\n');

// Initialize the library with Redis config
const cacheProxy = new VectorCacheProxy({
  redis: {
    host: '42.96.22.106',
    port: 6380,
    password: 'Xm1b4MV2idGC84cRtP', // uncomment if needed
    db: 4,
  },
  threshold: 0.85,
  modelName: 'Xenova/all-MiniLM-L6-v2',
});

// Initialize the model
console.log('Initializing model...');
await cacheProxy.initialize();

// Test 1: Get embedding
console.log('\n📌 Test 1: Getting embedding');
const text = 'How to build a REST API?';
const embedding = await cacheProxy.getEmbedding(text);
console.log(`✅ Got embedding for "${text}"`);
console.log(`   Dimensions: ${embedding.length}`);
console.log(`   First 5 values:`, embedding.slice(0, 5));

// Test 2: Set cache
console.log('\n📌 Test 2: Setting cache');
const response = {
  answer: 'To build a REST API, you need routes, controllers, and models...',
  tokens: 150,
  model: 'gpt-4',
};

await cacheProxy.setCache('How to build a REST API?', response);
console.log('✅ Cached response');

// Test 3: Get cache with similar query
console.log('\n📌 Test 3: Getting cache with similar query');
const cached = await cacheProxy.getCache('How do I create a REST API?');

if (cached) {
  console.log('✅ Cache hit!');
  console.log('   Response:', cached);
} else {
  console.log('❌ Cache miss');
}

// Test 4: Cache miss with different query
console.log('\n📌 Test 4: Testing cache miss');
const missed = await cacheProxy.getCache('What is machine learning?');

if (missed) {
  console.log('✅ Cache hit:', missed);
} else {
  console.log('❌ Cache miss (expected)');
}

// Cleanup
console.log('\n�� Cleanup');
await cacheProxy.close();
console.log('✅ Connection closed');

console.log('\n🎉 All tests completed successfully!');
