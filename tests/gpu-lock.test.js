// Fake lock folders only: exercise active scheduler policy without running speed work.
process.env.MARGO_SPEED_PHASE = 'active';
// scripts/gpu-lock.mjs: `run` passes arguments exactly as given (spaces and quotes survive, on Windows too, where cmd.exe
// starts it); the nested marker covers only the lock being held, so a GPU test inside a different lock still takes the
// GPU lock; and the reader/writer rules: shared slots, an exclusive request that waits without starving, stale holders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (lock, args, env = {}, flags = []) =>
  spawnSync(
    process.execPath,
    [
      'scripts/gpu-lock.mjs',
      'run',
      '--gpu=CPU-only argument and scheduler fixture',
      ...flags,
      '--owner=test',
      '--',
      ...args,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: '', ...env },
    },
  );

test('a quoted multi-word argument reaches the command intact', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    lock = join(folder, 'test.lock');
  try {
    const printer = 'console.log(JSON.stringify(process.argv.slice(1)))';
    // Operators after an escaped quote too: cmd.exe once ran 'a"|b' as a pipe into b.
    const args = ['two words', 'a"quote', 'back\\slash\\', '50%', 'a"|b', 'x" & echo y', '(c)<d>^e'];
    const out = run(lock, [process.execPath, '-e', printer, ...args]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()), args);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Acquires the lock at `lock` in a child process whose nested marker is `nested`, and prints the lock's status.
const acquireUnder = (lock, nested) =>
  spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const m = await import('./scripts/gpu-lock.mjs'); await m.acquire({ owner: 'child', poll: 10 }); console.log(JSON.stringify(m.status()));",
    ],
    { encoding: 'utf8', env: { ...process.env, MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: nested } },
  );

test('the nested marker excuses only the held lock: a different lock is still taken', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    other = join(folder, 'other.lock'),
    gpu = join(folder, 'gpu.lock');
  try {
    // A GPU test inside a different lock's run: the GPU lock is really taken.
    const inside = acquireUnder(gpu, join(other, 'nested'));
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(JSON.parse(inside.stdout.trim()).holders[0].owner, 'child');
    rmSync(gpu, { recursive: true, force: true });
    // A child of the GPU lock's own run: already held, not taken again.
    const same = acquireUnder(gpu, join(gpu, 'nested'));
    assert.equal(same.status, 0, same.stderr);
    assert.equal(JSON.parse(same.stdout.trim()).mode, 'idle');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('run under another lock points the command at the GPU lock beside it, which it then really takes', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    other = join(folder, 'other.lock'),
    gpu = join(folder, 'gpu.lock');
  try {
    // A GPU test inside another lock: its exclusive request takes the GPU lock instead of failing as nested.
    const probe = [
      "const m = await import('./scripts/gpu-lock.mjs');",
      "const release = await m.acquire({ owner: 'gpu-test', mode: 'exclusive', timing: 'CPU-only scheduler regression', poll: 10 });",
      'console.log(process.env.MARGO_GPU_LOCK + "|" + JSON.stringify(m.status()));',
      'release();',
    ].join(' ');
    const out = run(other, [process.execPath, '--input-type=module', '-e', probe]);
    assert.equal(out.status, 0, out.stderr);
    const [lock, status] = out.stdout.trim().split('|');
    assert.equal(lock, gpu);
    assert.equal(JSON.parse(status).owner, 'gpu-test');
    assert.equal(JSON.parse(status).mode, 'exclusive');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('run: --exclusive holds exclusively and tells the command; the default is a shared slot', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    lock = join(folder, 'gpu.lock');
  try {
    const probe =
      "console.log(process.env.MARGO_GPU_LOCK_NESTED_MODE + ' ' + require('fs').readdirSync(process.argv[1]).join())";
    const shared = run(lock, [process.execPath, '-e', probe, lock]);
    assert.equal(shared.status, 0, shared.stderr);
    assert.match(shared.stdout, /^shared .*shared/);
    const exclusive = run(lock, [process.execPath, '-e', probe, lock], {}, [
      '--exclusive',
      '--timing=CPU-only scheduler regression',
    ]);
    assert.equal(exclusive.status, 0, exclusive.stderr);
    assert.match(exclusive.stdout, /^exclusive .*exclusive\.json/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// In-process tests: each loads its own copy of the module, so its lock folder (read once at load) is its own.
let copies = 0;
async function lockIn(folder, env = {}) {
  const saved = {};
  const set = { MARGO_GPU_LOCK: folder, MARGO_GPU_LOCK_NESTED: '', MARGO_GPU_EXCLUSIVE: '', ...env };
  for (const [key, value] of Object.entries(set)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await import(`../scripts/gpu-lock.mjs?copy=${copies++}`);
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 'got' as soon as the promise resolves, 'waiting' if it has not within `ms`.
const settled = (promise, ms = 500) => {
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
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const take = (gpu, owner, mode) =>
  gpu.acquire({
    owner,
    worktree: join(gpu.lockDir, '..', `fake-worktree-${owner}`),
    mode,
    ...(mode === 'exclusive' ? { timing: 'CPU-only scheduler regression' } : {}),
    poll: 10,
    log: quiet,
  });
// Runs `body(gpu, folder)` against a fresh gpu.lock; `env` is set while the module loads and, for MARGO_GPU_SLOTS and
// MARGO_GPU_LOCK_NESTED*, while the body runs.
async function withLock(body, envOrFn = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    env = typeof envOrFn === 'function' ? envOrFn(folder) : envOrFn,
    gpu = await lockIn(join(folder, 'gpu.lock'), env),
    saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await body(gpu, folder);
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(folder, { recursive: true, force: true });
  }
}

test('a command publishes its bounded compile idle window for the independent heartbeat', { timeout: 15000 }, () =>
  withLock(async (gpu) => {
    const release = await gpu.acquire({ owner: 'compile-window', max: 8, log: quiet });
    try {
      const directory = join(gpu.lockDir, 'shared');
      const entry = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'));
      assert.equal(entry.idleMs, 240_000);
      assert.equal(entry.maxMinutes, 8);
    } finally {
      release();
    }
  }, { MARGO_GPU_IDLE_MIN: '4' }));

test('shared FIFO tickets preserve arrival order when timestamps tie and owner names sort backwards', () =>
  withLock(async (gpu) => {
    const held = [await take(gpu, 'hold-1'), await take(gpu, 'hold-2'), await take(gpu, 'hold-3')];
    const options = { queuedAt: 123, poll: 1, waitMax: 0.2, max: 1, log: quiet };
    const first = gpu.acquire({ ...options, owner: 'z-first', worktree: join(gpu.lockDir, '..', 'fake-z') });
    while (!gpu.status()?.waiting?.length) await sleep(1);
    const second = gpu.acquire({ ...options, owner: 'a-second', worktree: join(gpu.lockDir, '..', 'fake-a') });
    assert.equal(await settled(second), 'waiting');
    assert.deepEqual(
      gpu.status().waiting.map((w) => w.owner),
      ['z-first', 'a-second'],
    );
    held.pop()();
    const firstRelease = await first;
    assert.equal(await settled(second), 'waiting');
    firstRelease();
    (await second)();
    for (const release of held) release();
  }));

test('shared holders share: up to the slot count at once, the next waits for a free slot', () =>
  withLock(async (gpu) => {
    const held = [];
    for (const owner of ['a', 'b', 'c', 'd', 'e']) held.push(await take(gpu, owner));
    assert.equal(gpu.status().holders.length, 5);
    const sixth = take(gpu, 'f');
    assert.equal(await settled(sixth), 'waiting');
    held[1]();
    assert.equal(await settled(sixth), 'got');
    assert.equal(gpu.status().holders.length, 5);
    (await sixth)();
    for (const i of [0, 2, 3, 4]) held[i]();
    assert.equal(gpu.status().mode, 'idle');
  }));

test('MARGO_GPU_SLOTS sets the slot count; a bad value is refused', async () => {
  await withLock(
    async (gpu) => {
      const one = await take(gpu, 'a'),
        two = take(gpu, 'b');
      assert.equal(await settled(two), 'waiting');
      one();
      (await two)();
    },
    { MARGO_GPU_SLOTS: '1' },
  );
  await withLock(
    async (gpu) => {
      await assert.rejects(take(gpu, 'a'), /MARGO_GPU_SLOTS/);
      assert.throws(() => gpu.slots(), RangeError);
    },
    { MARGO_GPU_SLOTS: 'two' },
  );
});

test('an exclusive request waits until no shared holder is left', () =>
  withLock(async (gpu) => {
    const a = await take(gpu, 'a'),
      b = await take(gpu, 'b'),
      bench = take(gpu, 'bench', 'exclusive');
    assert.equal(await settled(bench), 'waiting');
    a();
    assert.equal(await settled(bench), 'waiting');
    b();
    assert.equal(await settled(bench), 'got');
    const release = await bench;
    assert.equal(release.mode, 'exclusive');
    assert.equal(gpu.status().mode, 'exclusive');
    release();
    assert.equal(gpu.status().mode, 'idle');
  }));

test('an exclusive request cannot starve: new shared holders queue behind it, though slots are free', () =>
  withLock(async (gpu) => {
    const a = await take(gpu, 'a'),
      bench = take(gpu, 'bench', 'exclusive');
    assert.equal(await settled(bench), 'waiting');
    const late = take(gpu, 'late'); // a slot is free, but the benchmark is first in line
    assert.equal(await settled(late), 'waiting');
    assert.equal(gpu.status().waiting[0].owner, 'bench');
    a();
    assert.equal(await settled(bench), 'got');
    assert.equal(await settled(late), 'waiting'); // still behind the running benchmark
    (await bench)();
    assert.equal(await settled(late), 'got');
    (await late)();
  }));

test('exclusive requests are served in the order they arrived', () =>
  withLock(async (gpu) => {
    const first = await take(gpu, 'first', 'exclusive'),
      order = [],
      second = take(gpu, 'second', 'exclusive').then((r) => (order.push('second'), r));
    await sleep(30);
    const third = take(gpu, 'third', 'exclusive').then((r) => (order.push('third'), r));
    assert.equal(await settled(second), 'waiting');
    first();
    const release = await second;
    assert.deepEqual(order, ['second']);
    release();
    (await third)();
    assert.deepEqual(order, ['second', 'third']);
  }));

test('MARGO_GPU_EXCLUSIVE raises a shared request to exclusive; other locks are always exclusive', async () => {
  await withLock(
    async (gpu) => {
      const release = await gpu.acquire({
        owner: 'a',
        mode: 'shared',
        command: 'node bench/fake.mjs',
        poll: 10,
        log: quiet,
      });
      assert.equal(release.mode, 'exclusive');
      release();
    },
    { MARGO_GPU_EXCLUSIVE: '1' },
  );
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-'));
  try {
    const other = await lockIn(join(folder, 'other.lock')),
      first = await take(other, 'one'),
      second = take(other, 'two');
    assert.equal(first.mode, 'exclusive');
    assert.equal(await settled(second), 'waiting');
    first();
    (await second)();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('holders and waiters whose process is gone are removed; live ones stay', () =>
  withLock(async (gpu, folder) => {
    const lock = join(folder, 'gpu.lock'),
      entry = (owner, pid) => JSON.stringify({ owner, pid, token: owner, mode: 'shared' });
    for (const dir of [join(lock, 'shared'), `${lock}-waiting`]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(lock, 'shared', 'ghost1.json'), entry('ghost1', deadPid()));
    writeFileSync(join(lock, 'shared', 'ghost2.json'), entry('ghost2', deadPid()));
    writeFileSync(join(`${lock}-waiting`, '000-ghost3.json'), entry('ghost3', deadPid()));
    writeFileSync(join(lock, 'exclusive.json'), entry('ghost4', deadPid()));
    writeFileSync(join(lock, 'owner.json'), entry('ghost5-legacy', deadPid()));
    const live = await take(gpu, 'live'); // all the ghosts are cleared, not waited for
    const bench = take(gpu, 'bench', 'exclusive');
    assert.equal(await settled(bench), 'waiting'); // the live holder still counts
    assert.deepEqual(
      gpu.status().holders.map((h) => h.owner),
      ['live'],
    );
    live();
    (await bench)();
    assert.equal(gpu.status().mode, 'idle');
  }));

test('a legacy owner.json holder blocks until it is released or its process is gone', () =>
  withLock(
    async (gpu, folder) => {
      const lock = join(folder, 'gpu.lock');
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ owner: 'old', pid: process.pid, token: 'old' }));
      const next = take(gpu, 'new');
      assert.equal(await settled(next), 'waiting');
      // Released the old way (the folder's owner.json goes, the folder stays empty a moment): got once the folder is
      // older than the window in which an old client is between its mkdir and its owner.json.
      rmSync(join(lock, 'owner.json'));
      assert.equal(await settled(next, BOUND), 'got');
      (await next)();
    },
    { MARGO_GPU_FRESH_MS: '200' },
  ));

test('a release removes only our own entry', () =>
  withLock(async (gpu, folder) => {
    const release = await take(gpu, 'a'),
      dir = join(folder, 'gpu.lock', 'shared'),
      [file] = readdirSync(dir);
    writeFileSync(join(dir, file), JSON.stringify({ owner: 'other', pid: process.pid, token: 'not-ours' }));
    release();
    assert.equal(gpu.status().holders[0].owner, 'other');
  }));

test('nested: a child of a shared hold takes nothing and refuses to wait on its parent for exclusive', async () => {
  const nested = (mode) => (folder) => ({
    MARGO_GPU_LOCK_NESTED: join(folder, 'gpu.lock', 'nested'),
    MARGO_GPU_LOCK_NESTED_MODE: mode,
  });
  await withLock(async (gpu) => {
    (await take(gpu, 'child'))();
    assert.equal(gpu.status().mode, 'idle', 'nothing was taken');
    await assert.rejects(take(gpu, 'bench', 'exclusive'), /run --exclusive/);
  }, nested('shared'));
  await withLock(async (gpu) => {
    (await take(gpu, 'bench', 'exclusive'))();
    assert.equal(gpu.status().mode, 'idle', 'nothing was taken');
  }, nested('exclusive'));
});

test('a worktree anywhere shares the main checkout lock folder', async () => {
  const { mainCheckout } = await import('../scripts/gpu-lock.mjs');
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    main = join(folder, 'repo'),
    outside = join(folder, 'elsewhere', 'wt'),
    inside = join(main, '.claude', 'worktrees', 'agent-x');
  try {
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(inside, { recursive: true });
    // Git writes forward slashes on Windows too.
    writeFileSync(join(outside, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt').replace(/\\/g, '/')}\n`);
    writeFileSync(join(inside, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'agent-x')}\n`);
    assert.equal(mainCheckout(outside), main, 'a worktree outside .claude/worktrees');
    assert.equal(mainCheckout(inside), main, 'a worktree inside .claude/worktrees');
    assert.equal(mainCheckout(main), main, 'the main checkout itself');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
