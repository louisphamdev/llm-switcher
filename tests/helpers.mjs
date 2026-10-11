import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The pids of every process whose command line names `dir`, this one excluded. A gateway records
// its detached interceptor only once it answers, so a teardown that trusts the record misses one
// still starting. POSIX only: on Windows it returns [].
export function pidsNaming(dir) {
  if (process.platform === 'win32' || !dir) return [];
  const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter(m => m && m[2].includes(dir) && Number(m[1]) !== process.pid)
    .map(m => Number(m[1]));
}

// Stops a child and waits for its exit, so nothing it does later lands in a removed directory.
export async function stopChild(child, ms = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(r => child.once('exit', r));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), sleep(ms).then(() => false)])) return;
  child.kill('SIGKILL');
  await Promise.race([exited, sleep(ms)]);
}

// Stops every process that still names `dir` (SIGTERM, then SIGKILL), then removes the dir.
export async function reapDir(dir) {
  for (let i = 0; i < 30; i++) {
    const left = pidsNaming(dir);
    if (!left.length) break;
    for (const pid of left) try { process.kill(pid, i < 20 ? 'SIGTERM' : 'SIGKILL'); } catch { /* gone */ }
    await sleep(100);
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// The same, synchronous, for a process that is about to end. A negative pid is a process group.
export function reapDirSync(dir, pids = []) {
  for (const pid of [...pids.filter(Number.isInteger), ...pidsNaming(dir)]) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
}

// Runs `fn` when this process ends before its teardown did: at exit, or on a signal, which ends a
// test process with no after() hook. Returns the function that cancels it.
export function onAbnormalExit(fn) {
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const run = () => { off(); try { fn(); } catch { /* best effort at exit */ } };
  // The listener replaces the default action, so the signal is raised again once it is gone.
  const onSignal = (sig) => { run(); process.kill(process.pid, sig); };
  function off() {
    process.off('exit', run);
    for (const sig of SIGNALS) process.off(sig, onSignal);
  }
  process.once('exit', run);
  for (const sig of SIGNALS) process.on(sig, onSignal);
  return off;
}

// Validate an Anthropic event sequence: indexes increase in start order, deltas only target an open block.
export function assertValidAnthropicEvents(events) {
  const open = new Set();
  const seen = new Set();
  let expectedNext = 0;
  for (const { event, data } of events) {
    if (event === 'content_block_start') {
      assert.equal(data.index, expectedNext, `block index must be sequential (got ${data.index}, want ${expectedNext})`);
      assert.ok(!seen.has(data.index), `index ${data.index} reused`);
      seen.add(data.index);
      open.add(data.index);
      expectedNext++;
    } else if (event === 'content_block_delta') {
      assert.ok(open.has(data.index), `delta for block ${data.index} which is not open`);
    } else if (event === 'content_block_stop') {
      assert.ok(open.has(data.index), `stop for block ${data.index} which is not open`);
      open.delete(data.index);
    } else if (event === 'message_stop') {
      assert.equal(open.size, 0, 'all blocks must be closed before message_stop');
    }
  }
}
