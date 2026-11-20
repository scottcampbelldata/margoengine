// Regression (KB-RM4, 2026-11-11): in the 15:00 full CI run two root tests ran api:check side by side; both found the same
// six packages stale and rebuilt them at once. build-modern removes a dist before writing it, so one build died on
// ENOTEMPTY in game/dist and packages/kit-web/dist stayed missing, failing check:examples-types, build:site and a dozen
// root tests. Package builds in one checkout now take scripts/support/build-lock.mjs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BUILD_LOCK_DIR, BUILD_LOCK_ENV, acquireBuildLock } from '../scripts/support/build-lock.mjs';

const quiet = () => {};
const scratch = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'margo-build-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a second build waits for the first and gives up at its limit with a coded error naming the holder', (t) => {
  const root = scratch(t);
  const release = acquireBuildLock(root, { log: quiet });
  assert.throws(
    () => acquireBuildLock(root, { timeoutMs: 300, pollMs: 20, log: quiet }),
    (error) => error.code === 'MARGO_BUILD_LOCK_TIMEOUT' && error.message.includes(String(process.pid)),
  );
  release();
  assert.equal(existsSync(join(root, BUILD_LOCK_DIR)), false);
  acquireBuildLock(root, { timeoutMs: 300, log: quiet })();
});

test('a lock left by a process that is gone is reclaimed', (t) => {
  const root = scratch(t);
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  mkdirSync(join(root, BUILD_LOCK_DIR), { recursive: true });
  writeFileSync(
    join(root, BUILD_LOCK_DIR, 'owner.json'),
    JSON.stringify({ pid: Number(gone.stdout), started: new Date().toISOString() }),
  );
  const lines = [];
  const release = acquireBuildLock(root, { timeoutMs: 2000, pollMs: 20, log: (line) => lines.push(line) });
  assert.equal(JSON.parse(readFileSync(join(root, BUILD_LOCK_DIR, 'owner.json'), 'utf8')).pid, process.pid);
  assert.match(lines.join('\n'), /reclaiming/);
  release();
});

test('a lock folder that never got its owner file is reclaimed once it is old', (t) => {
  const root = scratch(t);
  mkdirSync(join(root, BUILD_LOCK_DIR), { recursive: true });
  let clock = Date.now();
  const release = acquireBuildLock(root, { timeoutMs: 60_000, pollMs: 1, now: () => (clock += 1000), log: quiet });
  assert.equal(JSON.parse(readFileSync(join(root, BUILD_LOCK_DIR, 'owner.json'), 'utf8')).pid, process.pid);
  release();
});

test('a build the holder starts itself does not wait on its parent', (t) => {
  const root = scratch(t);
  const release = acquireBuildLock(root, { log: quiet });
  const nested = acquireBuildLock(root, { env: { [BUILD_LOCK_ENV]: String(process.pid) }, timeoutMs: 100, log: quiet });
  nested();
  assert.ok(existsSync(join(root, BUILD_LOCK_DIR)), 'the nested release leaves the parent holding the lock');
  release();
});

// Two processes that each remove a dist and write it again, the way build-modern does, side by side.
test('two builds at once both leave a complete dist', async (t) => {
  const root = scratch(t);
  const lock = new URL('../scripts/support/build-lock.mjs', import.meta.url).href;
  const builder = `
    import { acquireBuildLock } from ${JSON.stringify(lock)};
    import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
    const root = ${JSON.stringify(root)}, dist = root + '/packages/kit-web/dist';
    const release = acquireBuildLock(root, { pollMs: 10, log: () => {} });
    rmSync(dist, { recursive: true, force: true });
    for (let i = 0; i < 40; i++) {
      mkdirSync(dist + '/part' + i, { recursive: true });
      writeFileSync(dist + '/part' + i + '/index.js', 'export {};');
      await new Promise((done) => setTimeout(done, 5));
    }
    writeFileSync(dist + '/index.js', 'export {};');
    const whole = existsSync(dist + '/index.js') && existsSync(dist + '/part0/index.js');
    release();
    process.exitCode = whole ? 0 : 3;
  `;
  const run = () =>
    new Promise((done) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', builder], { stdio: 'ignore' });
      child.on('close', done);
    });
  const codes = await Promise.all([run(), run(), run()]);
  assert.deepEqual(codes, [0, 0, 0]);
  assert.ok(existsSync(join(root, 'packages/kit-web/dist/index.js')));
});

test('build-modern and the API report rebuild under the build lock', () => {
  const build = readFileSync(new URL('../scripts/build-modern.js', import.meta.url), 'utf8');
  assert.match(build, /acquireBuildLock\(/, 'build-modern takes the build lock');
  // The API report rebuilds through scripts/support/fresh-dist.mjs (KB-API-SURFACE-CHURN1), which holds the lock.
  const report = readFileSync(new URL('../scripts/api-report.js', import.meta.url), 'utf8');
  assert.match(report, /rebuildStalePackages\(/, 'the API report rebuilds stale packages through fresh-dist');
  const fresh = readFileSync(new URL('../scripts/support/fresh-dist.mjs', import.meta.url), 'utf8');
  assert.match(fresh, /acquireBuildLock\(/, 'fresh-dist decides what is stale while it holds the lock');
  assert.match(fresh, /\[BUILD_LOCK_ENV\]/, 'and hands the lock to the rebuild it starts');
});
