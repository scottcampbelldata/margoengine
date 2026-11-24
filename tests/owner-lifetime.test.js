import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { exerciseLifetime, leafEntries, lifecycleCases, LifetimeObserver, sameView, viewState } from './support/owner-lifetime.js';
import { nodeLifetimeAdapter, standardShader } from './support/owner-lifetime-node.js';
import { CPU_LIMIT_MS, OWNER_EXCLUSIONS, OWNER_FIXTURES, cpuRuns, ownerLeaves, pendingLine, selectOwnerPackages } from '../scripts/support/owner-lifetime-registry.mjs';
import { runOwners } from '../scripts/check-owner-lifetime.mjs';

test('registered package fixtures share every lifetime transition', { timeout: 120000 }, async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const result = await runOwners({ packages: ['cinematic', 'controls'], adapter });
    assert.deepEqual(result.failures, []);
    assert.equal(result.results.length, 156);
    for (const mode of ['direct', 'detach', 'scene', 'engine', 'loss-attached', 'loss-detached', 'cycles'])
      assert.ok(result.results.some((r) => r.mode === mode));
  } finally { adapter.close(); }
});

for (const fault of ['registration', 'listeners', 'resources', 'viewport', 'scissor', 'view-mutation', 'restore-leak',
  'frame-callback', 'views', 'cycle-growth'])
  test(`shared harness rejects ${fault} defects`, { timeout: 10000 }, async () => {
    const adapter = await nodeLifetimeAdapter();
    const fixture = { name: `broken-${fault}`, create({ engine }) {
      let gpu, listener;
      const plugin = {
        name: 'broken',
        setup() {
          if (fault === 'resources') gpu = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
          if (fault === 'frame-callback') engine.onFrame(() => {});
          if (fault === 'views') engine.views = [{ camera: engine.camera, viewport: [0, 0, 1, 1] }];
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
      // An unowned cache that gains a buffer on every disposal: only the cycles case sees it.
      return { plugin, dispose: () => {
        if (fault === 'cycle-growth') engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
        plugin.dispose();
      } };
    } };
    const expected = {
      registration: /releases its registration/, listeners: /leaked event listeners/,
      resources: /leaked GPU/, viewport: /current viewport/, scissor: /current scissor/,
      'view-mutation': /preserves view state/, 'restore-leak': /leaked event listeners/,
      'frame-callback': /leaked onFrame callbacks/, views: /engine\.views/, 'cycle-growth': /grow per attach and dispose/,
    };
    const mode = { resources: 'direct', 'cycle-growth': 'cycles' }[fault] ?? 'loss-attached';
    try {
      await assert.rejects(exerciseLifetime(fixture, adapter, { mode }), expected[fault]);
      // The growth is unowned: every case before 'cycles' passes it.
      if (fault === 'cycle-growth') await exerciseLifetime(fixture, adapter, { mode: 'direct' });
    }
    finally { adapter.close(); }
  });

// A fixed per-device set made on first use and kept for the device's life (materials' 1x1 default textures): the
// warm-up keeps it off the first owner, in every case and after a device loss; a buffer per attach still fails.
for (const variant of ['no-warm-up', 'warm-up', 'warm-up-leak'])
  test(`per-device first-use set: ${variant}`, { timeout: 30000 }, async () => {
    const adapter = await nodeLifetimeAdapter();
    const defaults = new WeakMap();
    const fixture = { name: `device-set-${variant}`, warmUp: variant !== 'no-warm-up' && 'fixed per-device set',
      create({ engine }) {
        let leak;
        const plugin = { name: 'device-set', setup() {
          if (!defaults.has(engine.gpu)) defaults.set(engine.gpu, engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM }));
          if (variant === 'warm-up-leak') leak = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
        }, dispose() {
          engine.sceneOf(this)?.removePlugin(this.name);
          void leak;
        } };
        return { plugin, dispose: () => plugin.dispose() };
      } };
    try {
      if (variant === 'warm-up') {
        for (const mode of ['direct', 'detach', 'scene', 'engine', 'loss-attached', 'loss-detached', 'cycles'])
          for (const target of ['secondary', 'default'])
            if (target === 'secondary' || mode !== 'scene') await exerciseLifetime(fixture, adapter, { mode, target });
      } else await assert.rejects(exerciseLifetime(fixture, adapter), /leaked GPU/);
    } finally { adapter.close(); }
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

test('a second DOM implementation is watched too; detached nodes count only for a fixture that says so', async () => {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM('<body></body>'), owner = {}, callback = () => {};
  const observer = new LifetimeObserver();
  observer.watchEvents();
  observer.watchEvents(window.EventTarget.prototype);
  try {
    const node = window.document.body.appendChild(window.document.createElement('div'));
    observer.scope(owner, () => node.addEventListener('click', callback));
    assert.throws(() => observer.assertReleased(owner), /1: click on HTMLDivElement/);
    node.remove();
    assert.throws(() => observer.assertReleased(owner), /leaked event listeners/, 'a removed node still counts by default');
    observer.detachedNodes = true;
    observer.assertReleased(owner);
    window.document.body.append(node);
    assert.throws(() => observer.assertReleased(owner), /leaked event listeners/, 'a node back in the page counts again');
    node.removeEventListener('click', callback);
    observer.assertReleased(owner);
  } finally { observer.close(); window.close(); }
});

test("a fixture's app scope owns nothing: its listeners and GPU objects are the application's", { timeout: 10000 }, async () => {
  const adapter = await nodeLifetimeAdapter(), page = new EventTarget(), callback = () => {};
  const fixture = { name: 'app-scope', create({ engine, scene, app }) {
    app(() => page.addEventListener('app', callback));
    const plugin = { name: 'app-scope', setup() {}, dispose() {} };
    return { plugin, dispose() { if (scene.plugins.get(plugin.name) === plugin) scene.removePlugin(plugin.name); } };
  } };
  const leak = { ...fixture, name: 'owned', create(args) {
    page.addEventListener('owned', callback);
    return fixture.create(args);
  } };
  try {
    await exerciseLifetime(fixture, adapter);
    await assert.rejects(exerciseLifetime(leak, adapter), /leaked event listeners/);
  } finally { adapter.close(); }
});

test('packages with no fixture are pending, never passed; held packages are explicit; unknown names throw', () => {
  // A package with no fixture and no exclusion is pending; the registry here is a stand-in so the test never depends
  // on which real packages still lack a fixture.
  assert.deepEqual(selectOwnerPackages(['later', 'cinematic'], { cinematic: 'fixture.js' }, () => true),
    { selected: ['cinematic'], pending: ['later'] });
  assert.throws(() => selectOwnerPackages(['unknown']), /OWNER_UNKNOWN_PACKAGE: unknown/);
  assert.deepEqual(selectOwnerPackages(['physics', 'physics2d', 'ragdoll', 'core', 'math', 'splines', 'cinematic']),
    { selected: ['physics', 'cinematic'], pending: [] });
  assert.match(pendingLine(['audio', 'stage']), /pending, no fixture yet, NOT checked \(2\): audio, stage/);
  assert.equal(pendingLine([]), '');
});

// A full CPU check:owners ran every package in one process under one 120 s limit: the fixtures summed to about 160 s
// (biomes alone about 90 s), so the run always timed out and read as a hang (2026-11-18). Each package now runs in its
// own process under its own limit, and a timeout names the case that was running.
test('check:owners runs the CPU model one package per run, each under its own limit', async () => {
  const all = Object.keys(OWNER_FIXTURES);
  const runs = cpuRuns(all);
  assert.equal(runs.length, all.length);
  assert.ok(runs.every((run) => run.length === 1));
  assert.deepEqual(runs.flat(), all);
  assert.ok(CPU_LIMIT_MS >= 90_000, 'the slowest package (biomes, about 90 s) fits one run');
  const gate = readFileSync(new URL('../scripts/check-owner-lifetime-gate.mjs', import.meta.url), 'utf8');
  assert.ok(gate.includes('for (const run of cpuRuns(selected))'), 'the gate runs one CPU process per cpuRuns entry');
  assert.doesNotMatch(gate, /limitMs: 130000/);
});

test('check:owners names each case before it runs, so a timeout points at it', { timeout: 120000 }, async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const seen = [];
    const result = await runOwners({ packages: ['cinematic'], adapter, report() {}, onCase: (label) => seen.push(label) });
    assert.equal(seen.length, result.results.length + result.failures.length);
    assert.ok(seen.every((label) => /^cinematic\/.+\/(default|secondary)\/[a-z-]+$/.test(label)), seen[0]);
    const cli = readFileSync(new URL('../scripts/check-owner-lifetime.mjs', import.meta.url), 'utf8');
    assert.ok(cli.includes('OWNER_LIFETIME_TIMEOUT: ${CPU_LIMIT_MS / 1000} seconds, still in ${running}'));
  } finally { adapter.close(); }
});

test('check:owners prints the pending list and runs only registered fixtures', { timeout: 120000 }, async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    // One real package that still has no fixture and no exclusion, if any is left.
    const waiting = readdirSync(new URL('../packages', import.meta.url)).sort()
      .filter((name) => !OWNER_FIXTURES[name] && !OWNER_EXCLUSIONS[name]).slice(0, 1);
    const result = await runOwners({ packages: [...waiting, 'cinematic'], adapter, report() {} });
    assert.deepEqual(result.pending, waiting);
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

// post's 31 entries took 208 s in one WebGL2 browser leaf on a Radeon 680M, past the leaf's 180 s limit: check:owners
// runs a leafPerEntry fixture one leaf per entry, and a leaf runs exactly the entries it names.
test('a leafPerEntry fixture gives one leaf per entry; others one leaf for all', async () => {
  const fixtures = async () => [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(await ownerLeaves({ fixtures }), [undefined]);
  assert.deepEqual(await ownerLeaves({ fixtures, leafPerEntry: true }), [['a'], ['b']]);
  await assert.rejects(ownerLeaves({ leafPerEntry: true, fixtures: async () => [{ name: 'a' }, { name: 'a' }] }),
    /OWNER_ENTRY_TWICE: a/);
  await assert.rejects(ownerLeaves({ leafPerEntry: true, fixtures: async () => [] }), /OWNER_FIXTURE_EMPTY/);
  const entries = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.equal(leafEntries(entries), entries);
  assert.deepEqual(leafEntries(entries, 'b'), [entries[1]]);
  assert.deepEqual(leafEntries(entries, ['c', 'a']), [entries[0], entries[2]]);
  assert.throws(() => leafEntries(entries, 'd'), /OWNER_ENTRY_UNKNOWN: d/);
  assert.throws(() => leafEntries(entries, ['a', 'a']), /OWNER_ENTRY_TWICE: a, a/);
});

// Water's 35 entries ran one leaf each, 70 leaves with the WebGL2 pass, and each leaf started its own dev server and
// browser and compiled the shared shaders again: check:owners for water alone ran past its 10 minutes on 2026-11-18
// with every case passing. leafCases packs entries in order into leaves of at most that many cases, every entry in
// exactly one leaf, and never more than the 208 cases a leaf may hold.
test('leafCases packs every entry, in order, into leaves of at most that many cases', async () => {
  const fixtures = async () => ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name }));
  assert.deepEqual(await ownerLeaves({ fixtures, leafCases: 26 }), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(await ownerLeaves({ fixtures, leafCases: 13 }), [['a'], ['b'], ['c'], ['d'], ['e']]);
  assert.deepEqual(await ownerLeaves({ fixtures, leafCases: 208 }), [['a', 'b', 'c', 'd', 'e']]);
  for (const leafCases of [0, 12, 20, 221, 1.5])
    await assert.rejects(ownerLeaves({ fixtures, leafCases }), /OWNER_LEAF_CASES/);
});

test('water runs check:owners in leaves of eight entries, not one leaf per entry', async () => {
  const module = await import(new URL('../' + OWNER_FIXTURES.water, import.meta.url).href);
  const names = (await module.fixtures()).map((fixture) => fixture.name), leaves = await ownerLeaves(module);
  assert.deepEqual(leaves.flat(), names);
  assert.equal(leaves.length, Math.ceil(names.length / 8));
});

// culling's 30 entries passed the same limit in one WebGL2 leaf on 2026-11-12; environment's 19 (247 cases) took 137 s
// idle and passed it under load on 2026-11-13.
// post gained HeatHaze with KB-FLAME-HEATHAZE1 (32 entries); environment gained SHLight in 882c56a49 (20 entries).
for (const [name, count, sample] of [['post', 32, 'PostStack.attach'], ['culling', 30, 'WebGL2Culling.attach'],
  ['environment', 20, 'LightProbes']])
  test(`${name} runs check:owners one leaf per entry, every entry named once`, async () => {
    const module = await import(new URL('../' + OWNER_FIXTURES[name], import.meta.url).href);
    const leaves = await ownerLeaves(module);
    assert.equal(leaves.length, count);
    assert.ok(leaves.every((leaf) => leaf.length === 1));
    assert.ok(leaves.flat().includes(sample));
  });

// A fixture that runs in one leaf runs all its cases inside the leaf's 180 s limit. The largest one-leaf fixtures today,
// animation and splats, hold 208 cases (animation: 69 s on the WebGL2 layer of a busy workstation); environment's 247
// took 137 s on an idle Radeon 680M and passed the limit under load, so a larger fixture runs one leaf per entry.
test('no fixture runs more than 208 owner cases in one browser leaf', async () => {
  const perEntry = ['default', 'secondary'].flatMap((target) =>
    lifecycleCases.filter((mode) => !(target === 'default' && mode === 'scene'))).length;
  assert.equal(perEntry, 13);
  const over = [];
  for (const [name, file] of Object.entries(OWNER_FIXTURES)) {
    const module = await import(new URL('../' + file, import.meta.url).href);
    for (const leaf of await ownerLeaves(module)) {
      const cases = leafEntries(await module.fixtures(), leaf).length * perEntry;
      if (cases > 208) over.push(`${name}${leaf === undefined ? '' : '/' + leaf}: ${cases}`);
    }
  }
  assert.deepEqual(over, []);
});

// Plugins (sky, environment, scatter, clustered, toon) anchor on core's `let linear=` line; a stand-in line that
// differs made sky's PresetScene refuse the CPU model's shader. The CPU model must hand over core's own line.
test("the CPU model's stand-in shader carries core's own let linear= line", () => {
  const core = readFileSync(new URL('../packages/core/src/shaders.ts', import.meta.url), 'utf8');
  const line = (text) => /let linear=[^;]+;/.exec(text)?.[0];
  assert.ok(line(core), 'core has a let linear= line');
  assert.equal(line(standardShader), line(core));
});

// Surface hooks (weather Puddles and Snow, its field's centroid position) anchor on core's fragment signature, its
// Output struct, its model transform and its o.position line; a stand-in fragment of another shape made them refuse
// the CPU model's shader as a replaced one.
test("the CPU model's stand-in shader carries core's fragment signature, Output struct and position lines", () => {
  const core = readFileSync(new URL('../packages/core/src/shaders.ts', import.meta.url), 'utf8');
  for (const anchor of [/@fragment fn fragment\(i:Output,[^{]*\{/, /struct Output \{[^}]*\}/, /let p=model\*vec4f\(i\.position,1\);/, /o\.position=p\.xyz;/]) {
    assert.ok(anchor.exec(core), `core has ${anchor}`);
    assert.equal(anchor.exec(standardShader)?.[0], anchor.exec(core)[0], `the stand-in carries ${anchor}`);
  }
});
