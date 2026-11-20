import assert from 'node:assert/strict';
import test from 'node:test';
import { DISPOSE_LIMIT_MS, exerciseLifetime, lifecycleCases } from './support/owner-lifetime.js';
import { nodeLifetimeAdapter } from './support/owner-lifetime-node.js';
import { ownedByEngine } from './support/owner-shell.js';

// A stand-in for an object whose stop is asynchronous (ecs ParallelSchedule): it holds a canvas listener, and its
// release removes it only after `delay` ms. `release` is memoised, as an idempotent stop is.
function lateEntry(name, { delay = 20, removes = true, settles = true, rejects = false, asyncOnly = false } = {}) {
  return { name, create({ engine, scene }) {
    const listener = () => {};
    engine.canvas.addEventListener('pointermove', listener);
    let stopping;
    const release = () => stopping ??= settles ? new Promise((resolve, reject) => setTimeout(() => {
      if (removes) engine.canvas.removeEventListener('pointermove', listener);
      if (rejects) reject(new Error('stand-in stop failed'));
      else resolve();
    }, delay)) : new Promise(() => {});
    const handle = ownedByEngine(scene, name, release);
    if (!asyncOnly) return handle;
    // Only `Symbol.asyncDispose`, as `await using` takes it.
    return { plugin: handle.plugin, [Symbol.asyncDispose]: () => handle.dispose() };
  } };
}

async function run(fixture, options) {
  const adapter = await nodeLifetimeAdapter();
  try { return await exerciseLifetime(fixture, adapter, options); } finally { adapter.close(); }
}

test('the harness waits five seconds at most for a disposal', () => assert.equal(DISPOSE_LIMIT_MS, 5000));

for (const target of ['default', 'secondary']) for (const mode of lifecycleCases) {
  if (target === 'default' && mode === 'scene') continue;
  test(`a dispose that releases late passes (${target}/${mode})`, { timeout: 30000 }, async () => {
    const result = await run(lateEntry('late'), { target, mode });
    assert.equal(result.mode, mode);
  });
}

test('a handle with only Symbol.asyncDispose is awaited', { timeout: 30000 }, async () => {
  for (const mode of ['direct', 'cycles']) await run(lateEntry('async-only', { asyncOnly: true }), { mode });
});

for (const mode of ['direct', 'detach', 'scene', 'engine'])
  test(`a dispose that never settles fails with a clear message (${mode})`, { timeout: 30000 }, async () => {
    await assert.rejects(run(lateEntry('hangs', { settles: false }), { mode, disposeLimit: 100 }),
      /OWNER_LIFETIME: hangs dispose did not settle within 100 ms/);
  });

for (const mode of ['direct', 'detach', 'engine'])
  test(`a late dispose that releases nothing fails (${mode})`, { timeout: 30000 }, async () => {
    await assert.rejects(run(lateEntry('keeps', { removes: false }), { mode }), /no leaked event listeners/);
  });

test('a late dispose that rejects fails with its own error', { timeout: 30000 }, async () => {
  await assert.rejects(run(lateEntry('rejects', { rejects: true }), { mode: 'direct' }), /stand-in stop failed/);
});
