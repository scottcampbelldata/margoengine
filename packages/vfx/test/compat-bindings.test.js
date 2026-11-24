// KB-VFX-COMPATBIND1: on the WebGL2 layer each compatibility kernel's pipeline has an auto layout, which holds only
// the bindings its entry point statically uses (WGSL 7.7). The `marks` kernel bound tickets (5) and every feature
// entry, though its entry only calls onScreen, so the layer's createBindGroup refused the group and the effect never
// drew (MARGO_COMPAT=1 seek-check and the cabin check never got ready). Each kernel now binds exactly what its entry
// uses; the oracle here is the layer's own WGSL front end, the one that makes its auto layouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { VFX } from '../dist/index.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const compatChunk = readdirSync(new URL('../dist/', import.meta.url)).find((name) => /^compat-.*\.js$/.test(name));
const { SimulationRoute, routeShaders } = await import(`../dist/${compatChunk}`);

// The bindings of group 0 that the entry point `main` of `code` reaches, as the layer's auto layout holds them.
const reached = (code) => {
  const entry = checkWGSL(code).entryPoints.find((e) => e.name === 'main');
  return entry.globals.filter((g) => g.kind === 'var' && g.group === 0).map((g) => g.binding).sort((a, b) => a - b);
};

for (const [name, options] of [
  ['a plain effect', {}],
  ['stretch', { stretch: { factor: 0.2 } }],
  ['events', { events: { on: 'death', count: 8 } }],
  ['space', { space: { mode: 'local' } }],
  ['over life', { overLife: { size: [1, 2] } }],
  ['obstacles', { obstacles: [{ kind: 'sphere', center: [0, 0, 0], radius: 1 }] }],
]) {
  test(`every compatibility kernel binds exactly what its entry point uses: ${name}`, () => {
    const h = optionalGPU();
    h.engine.stats = { drawCalls: 0 };
    let effect;
    try {
      effect = new VFX({ capacity: 8, ...options });
    } catch (error) {
      assert.fail(`${name}: ${error.message}`);
    }
    h.engine.use(effect);
    const simulation = h.pipelines.find((p) => p.compute?.module.code.includes('fn update(')).compute.module.code,
      groups = h.groups.length,
      owned = [],
      state = effect.gpuState,
      uniform = h.resources.find((r) => r.usage & 64),
      // Every binding the simulation declares, as base.ts hands the route its feature entries.
      declared = [...simulation.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((m) => +m[1]).filter((b) => b > 5 && b !== 9 && b !== 10),
      more = declared.map((binding) => ({ binding, resource: { buffer: uniform } })),
      events = routeShaders(simulation).events ? { events: uniform } : {};
    // Each auto layout names its pipeline, so every bind group is checked against its own entry point.
    const device = h.engine.gpu,
      create = device.createComputePipeline;
    device.createComputePipeline = (d) => {
      const p = create.call(device, d);
      p.getBindGroupLayout = () => ({ pipeline: p });
      return p;
    };
    new SimulationRoute(device, simulation, 8, { uniform, ...state, ...events }, more, owned);
    device.createComputePipeline = create;
    const bound = h.groups.slice(groups).filter((g) => g.layout?.pipeline);
    assert.ok(bound.length >= 5, `${bound.length} kernels`);
    for (const g of bound) {
      const code = g.layout.pipeline.compute.module.code,
        entries = g.entries.map((e) => e.binding).sort((a, b) => a - b);
      assert.deepEqual(entries, reached(code), `binds what its entry point uses:
${code.slice(-300)}`);
    }
    owned.forEach((r) => r.destroy());
    effect.dispose();
  });
}
