// scripts/gpu-lock.mjs against the one-holder lock it replaced (tests/fixtures/gpu-lock-v1.mjs), which agents in older
// worktrees still run on the same folder: each waits for the other, both ways, and they take turns. Also which commands
// count as benchmarks (exclusive), and a custom lock's hold limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settled = (promise, ms = 300) => {
  let timer;
  return Promise.race([
    promise.then(() => 'got'),
    new Promise((done) => {
      timer = setTimeout(() => done('waiting'), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
// As long as it takes, past any load: only a real failure reaches this bound.
const BOUND = 30_000;
const quiet = () => {};

let copies = 0;
// The new and the old lock module, both on a fresh temp gpu.lock (never the real one); `env` is set while they load
// and while `body` runs.
async function withBoth(body, env = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-compat-')),
    lock = join(folder, 'gpu.lock'),
    set = {
      MARGO_GPU_LOCK: lock,
      MARGO_GPU_LOCK_NESTED: '',
      MARGO_GPU_EXCLUSIVE: '',
      MARGO_GPU_BEAT_MS: '50',
      MARGO_GPU_FRESH_MS: '300',
      ...env,
    },
    saved = {};
  for (const [key, value] of Object.entries(set)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const now = await import(`../scripts/gpu-lock.mjs?compat=${copies}`);
    const old = await import(`./fixtures/gpu-lock-v1.mjs?compat=${copies++}`);
    assert.equal(now.lockDir, lock);
    assert.equal(old.lockDir, lock);
    await body({ now, old, lock });
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(folder, { recursive: true, force: true });
  }
}
const takeNew = (gpu, owner, mode) => gpu.acquire({ owner, mode, poll: 10, log: quiet });
const takeOld = (gpu, owner) => gpu.acquire({ owner, poll: 10, log: quiet });

test('an old-style holder blocks new shared and exclusive requests until it releases', () =>
  withBoth(async ({ now, old }) => {
    const oldRelease = await takeOld(old, 'old-agent');
    assert.equal(now.status().owner, 'old-agent');
    const shared = takeNew(now, 'shared'),
      bench = takeNew(now, 'bench', 'exclusive');
    assert.equal(await settled(shared), 'waiting');
    assert.equal(await settled(bench), 'waiting');
    oldRelease();
    // The exclusive request queued first, so it goes first; the shared one follows it.
    const benchRelease = await bench;
    assert.equal(await settled(shared), 'waiting');
    benchRelease();
    (await shared)();
    assert.equal(now.status(), null);
  }));

test('new shared holders block an old client until the last one releases; then it gets the lock', () =>
  withBoth(async ({ now, old, lock }) => {
    const held = [await takeNew(now, 'a'), await takeNew(now, 'b'), await takeNew(now, 'c')];
    const oldWaiter = takeOld(old, 'old-agent');
    assert.equal(await settled(oldWaiter), 'waiting');
    held[0]();
    held[1]();
    assert.equal(await settled(oldWaiter), 'waiting', 'one shared holder is still in');
    assert.equal(now.status().holders.length, 1, 'the old client removed nothing');
    held[2]();
    const oldRelease = await oldWaiter;
    // While the old client holds it, new requests wait.
    const next = takeNew(now, 'd');
    assert.equal(await settled(next), 'waiting');
    oldRelease();
    (await next)();
    assert.equal(existsSync(lock), false, 'the last release removes the empty folder, so old clients are not blocked');
  }));

test('a new exclusive holder blocks an old client', () =>
  withBoth(async ({ now, old }) => {
    const bench = await takeNew(now, 'bench', 'exclusive'),
      oldWaiter = takeOld(old, 'old-agent');
    assert.equal(await settled(oldWaiter), 'waiting');
    bench();
    (await oldWaiter)();
  }));

// The freshness window (MARGO_GPU_FRESH_MS, read on every poll) is set wide while a test checks "inside the window" and
// to zero for "past it": with a 300 ms window a loaded machine (8 test files at once) sometimes let it pass before the
// first poll, and the request got the lock it should have waited for.
test('a just-made empty folder is an old client between its mkdir and owner.json: waited for, then ignored', () =>
  withBoth(async ({ now, lock }) => {
    process.env.MARGO_GPU_FRESH_MS = '60000';
    mkdirSync(lock);
    const next = takeNew(now, 'new');
    // fixed-wait: nothing may be handed over in this time
    assert.equal(await settled(next, 100), 'waiting', 'inside the window it counts as a holder');
    // No owner.json ever came: an empty, ownerless folder past the window is stale and is used.
    process.env.MARGO_GPU_FRESH_MS = '0';
    assert.equal(await settled(next, BOUND), 'got');
    (await next)();
    assert.equal(existsSync(lock), false, 'and it is tidied away on release');
  }));

test('old and new clients take turns: no two holders overlap where one is old', () =>
  withBoth(async ({ now, old }) => {
    let inside = 0,
      oldInside = 0,
      overlap = false;
    const job = async (take, isOld) => {
      const release = await take();
      inside++;
      if (isOld) oldInside++;
      if ((isOld && inside > 1) || (oldInside > 0 && inside > 1)) overlap = true;
      await sleep(30);
      inside--;
      if (isOld) oldInside--;
      release();
    };
    const jobs = [];
    for (let i = 0; i < 4; i++) {
      jobs.push(job(() => takeOld(old, `old-${i}`), true));
      jobs.push(job(() => takeNew(now, `new-${i}`), false));
    }
    await Promise.all(jobs);
    assert.equal(overlap, false);
    assert.equal(now.status(), null);
  }));

test('a waiting request leaves no empty lock folder behind, which would make old clients wait forever', () =>
  withBoth(async ({ now, old, lock }) => {
    // A queued exclusive request of another live process, and nothing in the lock folder.
    mkdirSync(`${lock}-waiting`, { recursive: true });
    writeFileSync(
      join(`${lock}-waiting`, '000000000000001-other.json'),
      JSON.stringify({ owner: 'other-bench', pid: process.pid, token: 'other', mode: 'exclusive' }),
    );
    const shared = takeNew(now, 'shared');
    assert.equal(await settled(shared), 'waiting', 'it queues behind the exclusive request');
    assert.equal(existsSync(lock), false, 'no empty folder is left while it waits');
    // So an old client is not blocked by it.
    const oldRelease = await settled(takeOld(old, 'old-agent'), BOUND);
    assert.equal(oldRelease, 'got');
    rmSync(`${lock}-waiting`, { recursive: true, force: true });
  }));

test('an owner.json still being written counts as a holder; an unreadable old one is stale', () =>
  withBoth(async ({ now, lock }) => {
    process.env.MARGO_GPU_FRESH_MS = '60000';
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), '{"owner":');
    const next = takeNew(now, 'new');
    // fixed-wait: nothing may be handed over in this time
    assert.equal(await settled(next, 100), 'waiting');
    process.env.MARGO_GPU_FRESH_MS = '0';
    assert.equal(await settled(next, BOUND), 'got');
    (await next)();
  }));

test('benchmarks are exclusive: bench* npm scripts and scripts under bench/ or benchmarks/', () =>
  withBoth(async ({ now }) => {
    const yes = [
      ['npm', 'run', 'bench:render'],
      ['npm', 'run-script', 'bench'],
      ['node', 'bench/cli.mjs', 'render'],
      ['node', 'C:\\repo\\bench\\lib\\run.mjs'],
      ['node', 'benchmarks/scene.mjs'],
      ['node', 'examples/package-benchmarks/vfx-gpu.mjs'],
      ['node', 'examples/voxel-sandbox/bench.mjs'],
    ];
    const no = [
      ['npm', 'run', 'check:gpu-packages'],
      ['node', 'scripts/gpu-package-tests.mjs', '--out=test-results/benchmarks/x.json'],
      ['node', 'packages/voxel/tests/render-browser-check.mjs'],
      ['npm', 'run', 'test', '--', 'bench'],
    ];
    for (const words of yes) assert.equal(now.measuresSpeed(words, ''), true, words.join(' '));
    for (const words of no) assert.equal(now.measuresSpeed(words, ''), false, words.join(' '));
    assert.equal(now.measuresSpeed(['node', 'x.mjs'], 'bench:gltf'), true, 'run from a bench* npm script');
  }));

test('every explicitly selected lock other than gpu.lock is exclusive with a 30 min hold limit', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-compat-')),
    saved = process.env.MARGO_GPU_LOCK;
  try {
    process.env.MARGO_GPU_LOCK = join(folder, 'other.lock');
    const custom = await import(`../scripts/gpu-lock.mjs?custom=${copies++}`);
    assert.equal(custom.resolveMode(undefined), 'exclusive');
    assert.equal(custom.defaultMaxMinutes('exclusive'), 30);
    process.env.MARGO_GPU_LOCK = join(folder, 'gpu.lock');
    const gpu = await import(`../scripts/gpu-lock.mjs?defaults=${copies++}`);
    assert.equal(gpu.defaultMaxMinutes('shared'), 20);
    assert.equal(gpu.defaultMaxMinutes('exclusive'), 60);
  } finally {
    if (saved === undefined) delete process.env.MARGO_GPU_LOCK;
    else process.env.MARGO_GPU_LOCK = saved;
    rmSync(folder, { recursive: true, force: true });
  }
});
