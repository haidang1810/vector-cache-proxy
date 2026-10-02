// Integration tests against a real Redis. Run with:
//   REDIS_URL=redis://localhost:6379 npm test
// Use Redis 8+ / Redis Stack to also cover the vector index mode.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { VectorCacheProxy } from '../dist/index.js';

const REDIS_URL = process.env.REDIS_URL;

// Deterministic bag-of-words embedding, so tests don't download a model.
const DIM = 64;
async function fakeEmbed(text) {
  const v = new Array(DIM).fill(0);
  for (const word of text.toLowerCase().match(/\w+/g) ?? []) {
    v[createHash('md5').update(word).digest()[0] % DIM] += 1;
  }
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasQueryEngine() {
  const redis = new Redis(REDIS_URL);
  try {
    await redis.call('FT._LIST');
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

for (const mode of ['scan', 'index']) {
  describe(`searchMode: ${mode}`, { skip: !REDIS_URL && 'REDIS_URL not set' }, () => {
    let cache;
    const namespace = `vcp-test-${mode}-${process.pid}`;

    before(async (t) => {
      if (mode === 'index' && !(await hasQueryEngine())) {
        t.skip?.('Redis Query Engine not available');
        return;
      }
      cache = new VectorCacheProxy({ redis: REDIS_URL, embed: fakeEmbed, namespace, searchMode: mode, threshold: 0.8 });
      await cache.initialize();
      await cache.clearCache();
    });

    after(async () => {
      if (!cache) return;
      await cache.clearCache();
      await cache.close();
    });

    const it = (name, fn) => test(name, async (t) => (cache ? fn(t) : t.skip('not initialized')));

    it('returns a hit for a similar prompt and a miss for an unrelated one', async () => {
      await cache.setCache('how to build a rest api', { answer: 'routes' });
      const match = await cache.search('how do I build a rest api');
      assert.deepEqual(match?.response, { answer: 'routes' });
      assert.equal(match.text, 'how to build a rest api');
      assert.ok(match.score >= 0.8 && match.score <= 1.0001, `score ${match.score}`);
      assert.equal(await cache.getCache('train a neural network'), null);
    });

    it('picks the closest of several entries', async () => {
      await cache.setCache('python list comprehension syntax', 'A');
      await cache.setCache('python dict comprehension syntax', 'B');
      assert.equal(await cache.getCache('python dict comprehension syntax'), 'B');
    });

    it('isolates entries by context, regardless of key order', async () => {
      await cache.setCache('summarize this', 'for alice', { context: { user: 'alice', model: 'm1' } });
      assert.equal(await cache.getCache('summarize this', { context: { model: 'm1', user: 'alice' } }), 'for alice');
      assert.equal(await cache.getCache('summarize this', { context: { user: 'bob', model: 'm1' } }), null);
      assert.equal(await cache.getCache('summarize this'), null);
    });

    it('honours a per-call threshold', async () => {
      await cache.setCache('red green blue yellow', 'colors');
      assert.equal(await cache.getCache('red green blue purple', { threshold: 0.99 }), null);
      assert.equal(await cache.getCache('red green blue purple', { threshold: 0.5 }), 'colors');
    });

    it('expires entries after ttl', async () => {
      await cache.setCache('short lived prompt', 'x', { ttl: 1 });
      assert.equal(await cache.getCache('short lived prompt'), 'x');
      await sleep(1500);
      assert.equal(await cache.getCache('short lived prompt'), null);
    });

    it('getOrSet computes once for concurrent identical calls', async () => {
      let calls = 0;
      const compute = async () => {
        calls++;
        await sleep(50);
        return 'computed';
      };
      const results = await Promise.all([
        cache.getOrSet('expensive question here', compute),
        cache.getOrSet('expensive question here', compute),
        cache.getOrSet('expensive question here', compute),
      ]);
      assert.deepEqual(results, ['computed', 'computed', 'computed']);
      assert.equal(calls, 1);
      assert.equal(await cache.getOrSet('expensive question here', compute), 'computed');
      assert.equal(calls, 1);
    });

    it('clearCache removes all entries', async () => {
      await cache.setCache('to be cleared', 1);
      assert.ok((await cache.clearCache()) > 0);
      assert.equal(await cache.getCache('to be cleared'), null);
    });
  });
}

test('does not write to the console', { skip: !REDIS_URL && 'REDIS_URL not set' }, async () => {
  const original = console.log;
  let logged = 0;
  console.log = () => logged++;
  const cache = new VectorCacheProxy({ redis: REDIS_URL, embed: fakeEmbed, namespace: `vcp-test-quiet-${process.pid}` });
  try {
    await cache.setCache('secret prompt', 1);
    await cache.getCache('secret prompt');
    await cache.getCache('something else entirely');
  } finally {
    console.log = original;
    await cache.clearCache();
    await cache.close();
  }
  assert.equal(logged, 0);
});

test('does not close a Redis client it did not create', { skip: !REDIS_URL && 'REDIS_URL not set' }, async () => {
  const redis = new Redis(REDIS_URL);
  const cache = new VectorCacheProxy({ redis, embed: fakeEmbed, namespace: `vcp-test-shared-${process.pid}` });
  await cache.initialize();
  await cache.close();
  assert.equal(await redis.ping(), 'PONG');
  redis.disconnect();
});

test('rejects an invalid threshold', () => {
  assert.throws(() => new VectorCacheProxy({ redis: { lazyConnect: true }, threshold: 1.5 }), RangeError);
});
