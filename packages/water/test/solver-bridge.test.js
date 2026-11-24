// Disaster water push 1: the hooks `water/flood` builds on. A solver registered on the internal bridge replaces Water's
// coastal flow (and its spray reads that solver), Water rebuilds when the entry comes or goes and across a device
// restore, and the spray pool takes its size from `sprayCount`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { Water } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// The bridge is internal (not an export of the package): find the solver map in the built query-state chunk by what
// Water does with it, so the test does not depend on the bundler's short export names.
const chunk = readdirSync(new URL('../dist/', import.meta.url)).find((f) => /^query-state-.*\.js$/.test(f));
const maps = Object.values(await import(`../dist/${chunk}`)).filter((v) => v instanceof WeakMap);

const setup = (options = {}) => {
  const h = optionalGPU(),
    terrain = h.engine.gpu.createTexture({ size: [16, 16], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING }),
    water = new Water({ segments: 4, terrain: { heightmap: () => terrain, origin: [-8, -8], size: [16, 16] }, ...options });
  h.engine.use(water);
  return { h, terrain, water };
};
// A stand-in solver with CoastalFlow's shape, counting its steps.
const fakeSolver = (log) => (input) => {
  const { device, terrain } = input,
    make = () =>
      device.createTexture({ size: [terrain.width, terrain.height], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC }),
    states = [make(), make()],
    fluxes = [make(), make()],
    solver = {
      terrain,
      states,
      fluxes,
      views: states.map((s) => s.createView()),
      connected: device.createBuffer({ size: (terrain.width * terrain.height + 1) * 4, usage: GPUBufferUsage.STORAGE }),
      current: 0,
      steps: 0,
      step() {
        solver.steps++;
      },
      dispose() {
        solver.disposed = true;
        for (const t of [...states, ...fluxes]) t.destroy();
        solver.connected.destroy();
      },
    };
  log.push({ input, solver });
  return solver;
};

test('a solver on the bridge replaces the coastal flow, and Water goes back to its own when it leaves', () => {
  const { h, terrain, water } = setup({ spray: true }),
    log = [];
  h.frame();
  const own = water.coastalDepthTexture;
  assert.ok(own, 'the coastal flow runs before any solver');
  const bridge = maps.find((map) => {
    map.set(water, fakeSolver(log));
    h.frame();
    if (log.length) return true;
    map.delete(water);
    return false;
  });
  assert.ok(bridge, 'one bridge map hands Water a solver');
  const [{ input, solver }] = log;
  assert.equal(input.terrain, terrain);
  assert.equal(input.uniform.size, 560, 'the solver gets the frame uniform');
  assert.ok(own.destroyed, 'the coastal flow is released');
  assert.equal(water.coastalDepthTexture, solver.states[0]);
  assert.equal(solver.steps, 1);
  for (let i = 0; i < 5; i++) h.frame();
  assert.equal(log.length, 1, 'built once');
  assert.equal(solver.steps, 6, 'stepped every frame');
  // A device restore rebuilds through the same factory.
  water.onDeviceRestored(h.engine);
  assert.ok(solver.disposed);
  h.frame();
  assert.equal(log.length, 2);
  bridge.delete(water);
  h.frame();
  assert.ok(log[1].solver.disposed, 'the solver is released when it leaves the bridge');
  assert.ok(water.coastalDepthTexture && !log.some((l) => l.solver.states.includes(water.coastalDepthTexture)));
  water.dispose();
  terrain.destroy();
});

test('sprayCount sizes the droplet pool; a count that is not a multiple of 64 from 64 to 65,536 throws', () => {
  for (const [count, bytes] of [[undefined, 4096 * 32], [16384, 16384 * 32], [64, 64 * 32]]) {
    const { h, terrain, water } = setup({ spray: true, ...(count ? { sprayCount: count } : {}) });
    h.frame();
    assert.ok(h.resources.some((r) => r.size === bytes && !r.destroyed), `a pool of ${bytes} B`);
    water.dispose();
    terrain.destroy();
  }
  for (const sprayCount of [0, 32, 100, 65600, 1.5, '64'])
    assert.throws(() => new Water({ spray: true, sprayCount, terrain: { heightmap: () => undefined, origin: [0, 0], size: [1, 1] } }), TypeError, String(sprayCount));
});
