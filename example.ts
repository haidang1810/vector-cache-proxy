import { VectorCacheProxy } from './src/index.js';

type LlmAnswer = { answer: string; model: string };

const cache = new VectorCacheProxy<LlmAnswer>({
  redis: process.env.REDIS_URL ?? 'redis://localhost:6379',
  threshold: 0.9,
  ttl: 60 * 60 * 24, // 1 day
  modelName: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  logger: { debug: (msg, meta) => console.log(`[cache] ${msg}`, meta ?? '') },
});

// Optional: load the model now instead of on the first request.
await cache.initialize();

async function fakeLlm(question: string): Promise<LlmAnswer> {
  return { answer: `(generated answer for: ${question})`, model: 'gpt-4o' };
}

// Everything that changes the answer besides the prompt goes into `context`.
const context = { model: 'gpt-4o', systemPrompt: 'You are a helpful assistant.' };

console.log(await cache.getOrSet('How to build a REST API?', () => fakeLlm('How to build a REST API?'), { context }));
console.log(await cache.getOrSet('How do I create a REST API?', () => fakeLlm('How do I create a REST API?'), { context }));

const match = await cache.search('How do I create a REST API?', { context });
console.log('closest match:', match?.text, match?.score.toFixed(3));

// A different context never reuses these entries.
console.log(await cache.getCache('How to build a REST API?', { context: { model: 'gpt-4o-mini' } })); // null

await cache.clearCache();
await cache.close();
