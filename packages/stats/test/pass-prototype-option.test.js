import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { Stats } from '../dist/index.js';

function overlay(t, options = {}) {
  const dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const stats = new Stats({ parent: dom.window.document.body, ...options });
  t.after(() => { stats.dispose(); dom.window.close(); });
  return stats;
}

test('low-allocation layout requires an explicit boolean and validates before creating UI', () => {
  const dom = new JSDOM('<body></body>');
  try {
    for (const lowAllocationPasses of [1, 'true', null, {}, []])
      assert.throws(() => new Stats({ parent: dom.window.document.body, lowAllocationPasses }), /lowAllocationPasses must be boolean/);
    assert.equal(dom.window.document.body.children.length, 0);
  } finally { dom.window.close(); }
});

test('default Stats never initializes native-pass inspection and opt-in initializes only on the first pass', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'GPUCommandEncoder');
  let inspected = 0;
  Object.defineProperty(globalThis, 'GPUCommandEncoder', { configurable: true, get() { inspected++; return undefined; } });
  try {
    const create = stats => {
      const encoder = { beginRenderPass() { return { draw() {}, drawIndexed() {}, drawIndirect() {}, drawIndexedIndirect() {} }; },
        beginComputePass() { return { dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {} }; }, finish() {} };
      stats.track(encoder); return encoder;
    };
    const ordinary = create(overlay(t));
    ordinary.beginRenderPass({ colorAttachments: [] }); ordinary.beginComputePass();
    assert.equal(inspected, 0);
    const selected = create(overlay(t, { lowAllocationPasses: true }));
    assert.equal(inspected, 0, 'construction and encoder tracking remain cold');
    selected.beginRenderPass({ colorAttachments: [] });
    assert.equal(inspected, 1);
    selected.beginRenderPass({ colorAttachments: [] }); selected.beginComputePass();
    assert.equal(inspected, 1, 'an unsupported host is inspected only once');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'GPUCommandEncoder', previous);
    else delete globalThis.GPUCommandEncoder;
  }
});

test('opt-in rejects native-looking JS methods and preserves the custom fallback layout, receivers and captures', (t) => {
  const calls = [], globals = ['GPUCommandEncoder', 'GPURenderPassEncoder', 'GPUComputePassEncoder'],
    descriptors = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  class Render {
    draw(...args) { calls.push(['draw', this, args]); }
    drawIndexed(...args) { calls.push(['indexed', this, args]); }
    drawIndirect(...args) { calls.push(['indirect', this, args]); }
    drawIndexedIndirect(...args) { calls.push(['indexedIndirect', this, args]); }
  }
  class Compute {
    dispatchWorkgroups(...args) { calls.push(['dispatch', this, args]); }
    dispatchWorkgroupsIndirect(...args) { calls.push(['dispatchIndirect', this, args]); }
  }
  class Encoder {
    constructor(render, compute) { this.render = render; this.compute = compute; }
    beginRenderPass() { return this.render; }
    beginComputePass() { return this.compute; }
    finish() {}
  }
  for (const prototype of [Render.prototype, Compute.prototype, Encoder.prototype])
    for (const key of Object.getOwnPropertyNames(prototype))
      if (key !== 'constructor') prototype[key].toString = () => `function ${key}() { [native code] }`;
  globals.forEach((key, i) => Object.defineProperty(globalThis, key,
    { value: [Encoder, Render, Compute][i], writable: true, configurable: true }));
  try {
    const stats = overlay(t, { lowAllocationPasses: true }), render = new Render(), compute = new Compute(),
      encoder = new Encoder(render, compute), buffer = {};
    stats.track(encoder); encoder.beginRenderPass({ colorAttachments: [] }); encoder.beginComputePass();
    assert.equal(Object.getPrototypeOf(render), Render.prototype);
    assert.equal(Object.getPrototypeOf(compute), Compute.prototype);
    assert.equal(Reflect.ownKeys(render).length, 5); assert.equal(Reflect.ownKeys(compute).length, 3);
    for (const key of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
      const property = Object.getOwnPropertyDescriptor(render, key);
      assert.equal(property.writable && property.configurable && property.enumerable, true);
    }
    Render.prototype.draw = () => { throw new Error('replacement draw'); };
    Compute.prototype.dispatchWorkgroups = () => { throw new Error('replacement dispatch'); };
    encoder.beginRenderPass({ colorAttachments: [] }); encoder.beginComputePass();
    render.draw(3); render.drawIndexed(6, 2, 3, -1, 4); render.drawIndirect(buffer, 16); render.drawIndexedIndirect(buffer, 32);
    compute.dispatchWorkgroups(8); compute.dispatchWorkgroupsIndirect(buffer, 64);
    assert.equal(stats.drawCalls, 4); assert.equal(stats.dispatches, 2);
    assert.deepEqual(calls, [
      ['draw', render, [3, 1, 0, 0]], ['indexed', render, [6, 2, 3, -1, 4]],
      ['indirect', render, [buffer, 16]], ['indexedIndirect', render, [buffer, 32]],
      ['dispatch', compute, [8, 1, 1]], ['dispatchIndirect', compute, [buffer, 64]],
    ]);
  } finally {
    globals.forEach((key, i) => descriptors[i] ? Object.defineProperty(globalThis, key, descriptors[i]) : delete globalThis[key]);
  }
});

test('opt-in custom fallback still transfers reused passes between Stats owners without recursion', (t) => {
  const first = overlay(t, { lowAllocationPasses: true }), second = overlay(t, { lowAllocationPasses: true });
  let draws = 0, dispatches = 0;
  const render = { draw() { draws++; }, drawIndexed() {}, drawIndirect() {}, drawIndexedIndirect() {} },
    compute = { dispatchWorkgroups() { dispatches++; }, dispatchWorkgroupsIndirect() {} },
    create = stats => {
      const encoder = { beginRenderPass() { return render; }, beginComputePass() { return compute; }, finish() {} };
      stats.track(encoder); return encoder;
    };
  for (const encoder of [create(first), create(second), create(first), create(second)]) {
    encoder.beginRenderPass({ colorAttachments: [] }); encoder.beginComputePass();
    render.draw(3); compute.dispatchWorkgroups(1);
  }
  assert.equal(draws, 4); assert.equal(dispatches, 4);
  assert.equal(first.drawCalls, 2); assert.equal(first.dispatches, 2);
  assert.equal(second.drawCalls, 2); assert.equal(second.dispatches, 2);
});

test('ordinary and opted-in custom fallback preserve inherited owner accessors and write restrictions', (t) => {
  for (const lowAllocationPasses of [false, true]) {
    const stats = overlay(t, { lowAllocationPasses }),
      methods = { draw() {}, drawIndexed() {}, drawIndirect() {}, drawIndexedIndirect() {} },
      seed = Object.create(methods),
      wrap = pass => {
        const encoder = { beginRenderPass() { return pass; }, beginComputePass() {}, finish() {} };
        stats.track(encoder); return () => encoder.beginRenderPass({ colorAttachments: [] });
      };
    wrap(seed)();
    const owner = Reflect.ownKeys(seed).find(key => typeof key === 'symbol');
    assert.equal(typeof owner, 'symbol');
    let reads = 0, writes = 0;
    const prototype = Object.create(methods);
    Object.defineProperty(prototype, owner, { configurable: true,
      get() { reads++; return undefined; },
      set(value) { writes++; Object.defineProperty(this, owner,
        { value, writable: true, enumerable: true, configurable: true }); } });
    const pass = Object.create(prototype);
    assert.equal(wrap(pass)(), pass);
    assert.equal(reads, 1); assert.equal(writes, 1);
    assert.equal(Object.getPrototypeOf(pass), prototype);
    assert.equal(Reflect.ownKeys(pass).length, 5);
    pass.draw(3); assert.equal(stats.drawCalls, 1);
    Object.defineProperty(prototype, owner, { value: undefined, writable: false, configurable: true });
    const locked = Object.create(prototype);
    assert.throws(wrap(locked), TypeError);
    assert.equal(Reflect.ownKeys(locked).length, 0);
  }
});

test('a GPUProfiler-only bundle removes the opt-in pass graph', async () => {
  const entry = '\0stats-profiler-only', source = fileURLToPath(new URL('../src/index.ts', import.meta.url)).replaceAll('\\', '/');
  const result = await build({
    root: fileURLToPath(new URL('../../../', import.meta.url)), configFile: false, publicDir: false, logLevel: 'silent',
    plugins: [{ name: 'stats-profiler-only', resolveId(id) { if (id === entry) return id; },
      load(id) { if (id === entry) return `export { GPUProfiler } from ${JSON.stringify(source)};`; } }],
    build: { write: false, minify: false, target: 'es2022', rollupOptions: { input: entry, output: { format: 'es' } } },
  });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(output => output.output).filter(item => item.type === 'chunk');
  assert.ok(chunks.length > 0);
  assert.doesNotMatch(chunks.map(chunk => chunk.code).join('\n'), /Shared Stats pass prototype|lowAllocationPasses/);
});
