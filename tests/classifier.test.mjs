import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  heuristicClassify,
  findJevKey,
  classifyPrompt,
  DEFAULT_JEV_URL,
  OPENROUTER_JEV_URL,
} from '../classifier.mjs';

function createServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
    server.on('error', reject);
  });
}

describe('classifier module', () => {
  describe('heuristicClassify', () => {
    it('classifies complex tasks to opus', () => {
      assert.equal(heuristicClassify('Design the system architecture for high throughput'), 'opus');
      assert.equal(heuristicClassify('Find race condition in concurrent worker pool'), 'opus');
      assert.equal(heuristicClassify('Conduct a security audit of our auth boundary'), 'opus');
    });

    it('classifies simple short tasks to haiku', () => {
      assert.equal(heuristicClassify('Fix typo in comment'), 'haiku');
      assert.equal(heuristicClassify('Format json output to string'), 'haiku');
      assert.equal(heuristicClassify('Extract date from this line'), 'haiku');
    });

    it('defaults general programming tasks to sonnet', () => {
      assert.equal(heuristicClassify('Refactor this helper function to accept options object and write tests'), 'sonnet');
    });
  });

  describe('findJevKey', () => {
    it('resolves TYPESAFE_API_KEY first', () => {
      const res = findJevKey({ TYPESAFE_API_KEY: 'ts_key', JEV_API_KEY: 'jev_key' });
      assert.deepEqual(res, { key: 'ts_key', source: 'typesafe' });
    });

    it('resolves JEV_API_KEY when TYPESAFE_API_KEY is absent', () => {
      const res = findJevKey({ JEV_API_KEY: 'jev_key' });
      assert.deepEqual(res, { key: 'jev_key', source: 'openrouter' });
    });

    it('returns null on empty env', () => {
      assert.equal(findJevKey({}), null);
    });
  });

  describe('classifyPrompt', () => {
    it('returns heuristic tier with reason no-key when no key is present', async () => {
      const res = await classifyPrompt({
        prompt: 'Design architecture for database',
        env: {},
      });
      assert.equal(res.tier, 'opus');
      assert.equal(res.source, 'heuristic');
      assert.equal(res.reason, 'no-key');
    });

    it('calls Jev endpoint and parses choice response', async () => {
      let receivedAuth = null;
      let receivedBody = null;

      const server = await createServer(async (req, res) => {
        receivedAuth = req.headers.authorization;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              recommended_tier: {
                choice: 'haiku',
                confidence: 0.94,
                distribution: { haiku: 0.94, sonnet: 0.05, opus: 0.01 },
              },
            },
          }),
        );
      });

      try {
        const res = await classifyPrompt({
          prompt: 'Translate hello to French',
          apiKey: 'test-ts-key',
          url: server.url,
        });

        assert.equal(res.tier, 'haiku');
        assert.equal(res.confidence, 0.94);
        assert.equal(res.source, 'jev');
        assert.equal(res.model, 'jev-latest');
        assert.equal(receivedAuth, 'Bearer test-ts-key');
        assert.equal(receivedBody.state, 'Translate hello to French');
        assert.ok('recommended_tier' in receivedBody.questions);
      } finally {
        await server.close();
      }
    });

    it('falls back gracefully to heuristic on HTTP error', async () => {
      const server = await createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      });

      try {
        const res = await classifyPrompt({
          prompt: 'Fix typo',
          apiKey: 'key',
          url: server.url,
        });

        assert.equal(res.tier, 'haiku');
        assert.equal(res.source, 'heuristic');
        assert.equal(res.reason, 'http-500');
      } finally {
        await server.close();
      }
    });

    it('falls back gracefully to heuristic on timeout', async () => {
      const server = await createServer((req, res) => {
        // Hang indefinitely
      });

      try {
        const res = await classifyPrompt({
          prompt: 'Fix typo',
          apiKey: 'key',
          url: server.url,
          timeoutMs: 50,
        });

        assert.equal(res.tier, 'haiku');
        assert.equal(res.source, 'heuristic');
        assert.equal(res.reason, 'timeout');
      } finally {
        await server.close();
      }
    });
  });
});
