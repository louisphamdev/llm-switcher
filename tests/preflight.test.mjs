import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preflightScript = path.join(root, 'preflight-check.mjs');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

function runPreflight(tool, dir) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [preflightScript, tool, dir], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', b => stdout += b);
    cp.stderr.on('data', b => stderr += b);
    cp.on('close', status => resolve({ status, stdout, stderr }));
    cp.on('error', reject);
  });
}

test('preflight-check: verifies available models, warns on dropped models and invalid keys', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let mockStatus = 200;
  let mockModels = [
    { id: 'zencore/space-bunny-free' },
    { id: 'zencore/muse-spark-1.3-contributor-free' },
    { id: 'codex/gpt-6-astra' }
  ];

  const mockUpstream = http.createServer((req, res) => {
    if (mockStatus !== 200) {
      res.statusCode = mockStatus;
      return res.end('{"error":{"message":"Invalid API key"}}');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: mockModels }));
  });
  await listen(mockUpstream);
  t.after(() => mockUpstream.close());

  const port = mockUpstream.address().port;
  const config = {
    activeProfiles: { claude: 'mock-prof', codex: 'mock-prof' },
    profiles: {
      'mock-prof': {
        name: 'Mock Provider',
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
        defaultModels: {
          sonnet: 'zencore/space-bunny-free',
          opus: 'zencore/space-bunny-free',
          haiku: 'zencore/muse-spark-1.3-contributor-free'
        }
      }
    }
  };

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, 'route-claude.txt'), 'claude -> mock-prof | 127.0.0.1 | zencore/space-bunny-free\n');

  // Case 1: All models available -> verified ✓
  const r1 = await runPreflight('claude', dir);
  assert.equal(r1.status, 0);
  assert.match(r1.stdout, /verified ✓/);
  assert.doesNotMatch(r1.stdout, /CẢNH BÁO/);

  // Case 2: Consecutive call hits cache
  const r2 = await runPreflight('claude', dir);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /verified ✓/);

  // Clear cache for next test cases
  fs.rmSync(path.join(dir, 'preflight-cache.json'), { force: true });

  // Case 3: One model was dropped/deprecated (e.g. haiku set to dropped-model)
  config.profiles['mock-prof'].defaultModels.haiku = 'zencore/old-dropped-model';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));

  const r3 = await runPreflight('claude', dir);
  assert.equal(r3.status, 0);
  assert.match(r3.stdout, /CẢNH BÁO/);
  assert.match(r3.stdout, /old-dropped-model/);
  assert.match(r3.stdout, /slot haiku/);
  assert.match(r3.stdout, /switch ui/);

  fs.rmSync(path.join(dir, 'preflight-cache.json'), { force: true });

  // Case 4: API key rejected (401)
  mockStatus = 401;
  const r4 = await runPreflight('claude', dir);
  assert.equal(r4.status, 0);
  assert.match(r4.stdout, /API key cho profile 'mock-prof' không hợp lệ/);
  assert.match(r4.stdout, /HTTP 401/);

  fs.rmSync(path.join(dir, 'preflight-cache.json'), { force: true });

  // Case 5: Endpoint unreachable (bad port)
  config.profiles['mock-prof'].baseURL = 'http://127.0.0.1:1';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));

  const r5 = await runPreflight('claude', dir);
  assert.equal(r5.status, 0);
  assert.match(r5.stdout, /Không thể kết nối tới endpoint/);

  // Case 6: Tool is off (no route file) -> exits quietly
  fs.rmSync(path.join(dir, 'route-claude.txt'), { force: true });
  const r6 = await runPreflight('claude', dir);
  assert.equal(r6.status, 0);
  assert.equal(r6.stdout.trim(), '');
});
