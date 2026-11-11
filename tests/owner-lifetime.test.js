import assert from 'node:assert/strict';
import test from 'node:test';
import { exerciseLifetime, LifetimeObserver, sameView, viewState } from './support/owner-lifetime.js';
import { nodeLifetimeAdapter } from './support/owner-lifetime-node.js';
import { pendingLine, selectOwnerPackages } from '../scripts/support/owner-lifetime-registry.mjs';
import { runOwners } from '../scripts/check-owner-lifetime.mjs';

test('registered package fixtures share every lifetime transition', { timeout: 120000 }, async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const result = await runOwners({ packages: ['cinematic', 'controls'], adapter });
    assert.deepEqual(result.failures, []);
    assert.equal(result.results.length, 132);
    for (const mode of ['direct', 'detach', 'scene', 'engine', 'loss-attached', 'loss-detached'])
      assert.ok(result.results.some((r) => r.mode === mode));
  } finally { adapter.close(); }
});

for (const fault of ['registration', 'listeners', 'resources', 'viewport', 'scissor', 'view-mutation', 'restore-leak'])
  test(`shared harness rejects ${fault} defects`, { timeout: 10000 }, async () => {
    const adapter = await nodeLifetimeAdapter();
    const fixture = { name: `broken-${fault}`, create({ engine }) {
      let gpu, listener;
      const plugin = {
        name: 'broken',
        setup() {
          if (fault === 'resources') gpu = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
          if (fault === 'listeners') {
            listener = () => {};
            engine.canvas.addEventListener('pointerdown', listener);
          }
        },
        onDeviceRestored() {
          if (fault === 'restore-leak') engine.canvas.addEventListener('restore-leak', () => {});
        },
        registerPasses(graph) {
          graph.add({ name: 'broken-pass', order: 1, execute(context) {
            if (fault === 'view-mutation') context.view.viewport[0]++;
            if (fault !== 'viewport' && fault !== 'scissor') return;
            const pass = context.encoder.beginRenderPass({ colorAttachments: [{ view: context.color }] });
            if (fault !== 'viewport') pass.setViewport(...context.view.viewport, 0, 1);
            if (fault !== 'scissor') pass.setScissorRect(...context.view.scissor);
            pass.draw(3);
            pass.end();
          } });
        },
        dispose() {
          if (fault === 'registration') engine.removePlugin(this.name);
          else engine.sceneOf(this)?.removePlugin(this.name);
          if (fault !== 'resources') gpu?.destroy();
          if (fault !== 'listeners' && listener) engine.canvas.removeEventListener('pointerdown', listener);
        },
      };
      return { plugin, dispose: () => plugin.dispose() };
    } };
    const expected = {
      registration: /releases its registration/, listeners: /leaked event listeners/,
      resources: /leaked GPU/, viewport: /current viewport/, scissor: /current scissor/,
      'view-mutation': /preserves view state/, 'restore-leak': /leaked event listeners/,
    };
    try { await assert.rejects(exerciseLifetime(fixture, adapter,
      { mode: fault === 'resources' ? 'direct' : 'loss-attached' }), expected[fault]); }
    finally { adapter.close(); }
  });

test('listener observation respects duplicate identity, capture, once and AbortSignal', () => {
  const observer = new LifetimeObserver(), target = new EventTarget(), owner = {}, callback = () => {};
  observer.watchEvents();
  try {
    observer.scope(owner, () => {
      target.addEventListener('a', callback);
      target.addEventListener('a', callback);
      target.addEventListener('a', callback, true);
    });
    assert.equal(observer.listeners.size, 2);
    target.removeEventListener('a', callback);
    assert.equal(observer.listeners.size, 1);
    target.removeEventListener('a', callback, true);
    const abort = new AbortController();
    observer.scope(owner, () => {
      target.addEventListener('once', callback, { once: true });
      target.addEventListener('signal', callback, { signal: abort.signal });
    });
    target.dispatchEvent(new Event('once'));
    abort.abort();
    observer.assertReleased(owner);
  } finally { observer.close(); }
});

test('packages with no fixture are pending, never passed; held packages are explicit; unknown names throw', () => {
  assert.deepEqual(selectOwnerPackages(['math', 'cinematic']), { selected: ['cinematic'], pending: ['math'] });
  assert.throws(() => selectOwnerPackages(['unknown']), /OWNER_UNKNOWN_PACKAGE: unknown/);
  assert.deepEqual(selectOwnerPackages(['physics', 'physics2d', 'ragdoll', 'core', 'stage', 'cinematic']),
    { selected: ['cinematic'], pending: ['stage'] });
  assert.match(pendingLine(['audio', 'stage']), /pending, no fixture yet, NOT checked \(2\): audio, stage/);
  assert.equal(pendingLine([]), '');
});

test('check:owners prints the pending list and runs only registered fixtures', { timeout: 120000 }, async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const result = await runOwners({ packages: ['math', 'cinematic'], adapter, report() {} });
    assert.deepEqual(result.pending, ['math']);
    assert.ok(result.results.length > 0 && result.results.every((r) => r.package === 'cinematic'));
  } finally { adapter.close(); }
});

test('async factory attachment cannot migrate to the default scene after awaiting input', async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    await assert.rejects(exerciseLifetime({ name: 'async-owner', async create({ engine }) {
      await Promise.resolve();
      const plugin = { name: 'async-owner', setup() {}, dispose() { engine.sceneOf(this)?.removePlugin(this.name); } };
      engine.use(plugin);
      return { plugin, dispose: () => plugin.dispose() };
    } }, adapter), /async factory retains its originating scene/);
  } finally { adapter.close(); }
});

for (const leak of [false, true]) test(`caller dependency joint cleanup ${leak ? 'rejects leaks' : 'releases shared pages'}`, async () => {
  const adapter = await nodeLifetimeAdapter();
  const fixture = { name: 'joint-lifetime', create({ engine, scene, dependency }) {
    let shared;
    const caller = { name: 'caller', setup() {}, dispose() {
      engine.sceneOf(this)?.removePlugin(this.name);
      if (!leak) shared?.destroy();
    } };
    dependency(() => scene.use(caller));
    const plugin = { name: 'joint-lifetime', setup() {}, onPreUpdate() {
      shared ??= engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
    }, dispose() { engine.sceneOf(this)?.removePlugin(this.name); } };
    return { plugin, dependencies: [caller], dispose: () => plugin.dispose(), cleanup: () => caller.dispose() };
  } };
  try {
    if (leak) await assert.rejects(exerciseLifetime(fixture, adapter), /leaked GPU/);
    else await exerciseLifetime(fixture, adapter);
  } finally { adapter.close(); }
});

// Work an async factory does after its first await is the factory's own; it used to escape the owner scope.
for (const leak of ['resources', 'listeners']) test(`async factory work after an await is owned (${leak})`, async () => {
  const adapter = await nodeLifetimeAdapter();
  const fixture = { name: `async-${leak}`, async create({ engine, scene }) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (leak === 'resources') engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
    else engine.canvas.addEventListener('pointerdown', () => {});
    const plugin = { name: `async-${leak}`, setup() {}, dispose() { engine.sceneOf(this)?.removePlugin(this.name); } };
    scene.use(plugin);
    return { plugin, dispose: () => plugin.dispose() };
  } };
  const expected = leak === 'resources' ? /leaked GPU/ : /leaked event listeners/;
  try { await assert.rejects(exerciseLifetime(fixture, adapter), expected); }
  finally { adapter.close(); }
});

// The WebGL2 layer's view holds its device, whose queue points back at it: JSON threw on every case there.
test('view state compares numbers by value and objects by identity, cycles included', () => {
  const device = {}; device.queue = { device };
  const view = { id: 'a', viewport: [0, 0, 32, 32], device }, before = viewState(view);
  assert.ok(sameView(viewState(view), before));
  view.viewport[0]++;
  assert.ok(!sameView(viewState(view), before));
  view.viewport[0]--; view.device = { ...device };
  assert.ok(!sameView(viewState(view), before));
});
