# Test vector-cache-proxy from npm

This folder tests the published npm package `vector-cache-proxy`.

## Setup

```bash
npm install
```

## Requirements

- Node.js >= 18
- Redis server running on localhost:6379

## Run test

```bash
npm start
```

Or:

```bash
node index.js
```

## What it tests

1. ✅ Import from npm package
2. ✅ Initialize VectorCacheProxy
3. ✅ Get embedding from text
4. ✅ Set cache
5. ✅ Get cache with similar query (semantic search)
6. ✅ Cache miss with different query
7. ✅ Close connection

## Expected output

```
Testing vector-cache-proxy from npm...

Initializing model...
🚀 Initializing model Xenova/all-MiniLM-L6-v2...
✅ Model ready!

📌 Test 1: Getting embedding
✅ Got embedding for "How to build a REST API?"
   Dimensions: 384
   First 5 values: [ ... ]

📌 Test 2: Setting cache
✅ Cached response

📌 Test 3: Getting cache with similar query
✅ Cache hit! Similarity: 95.23%
   Query: "How do I create a REST API?"
   Cached: "How to build a REST API?"
✅ Cache hit!
   Response: { answer: '...', tokens: 150, model: 'gpt-4' }

📌 Test 4: Testing cache miss
❌ Cache miss for query: "What is machine learning?"
❌ Cache miss (expected)

📌 Cleanup
✅ Connection closed

🎉 All tests completed successfully!
```
