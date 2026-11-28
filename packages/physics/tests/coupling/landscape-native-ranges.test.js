import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function native(
  module,
  shared,
  {
    nx = 2,
    nz = 2,
    dx = 1,
    dz = 1,
    dt = 1,
    height = [10, 10, 10, 0],
    rain = Array(nx * nz).fill(0),
    shear = Array(nx * nz).fill(1),
    area = Array(nx * nz).fill(1),
    uplift = Array(nx * nz).fill(0),
    floor = Array(nx * nz).fill(-Infinity),
    settings = [0, 0, 0.035, 1000, 9.80665, 0, 0.35, 0, 0, 0.58],
    budget = [0, 0, 0, 0],
  },
) {
  const page = 65536;
  const memory = new WebAssembly.Memory({ initial: 20, maximum: 65536, shared });
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  exports.__stack_pointer.value = 18 * page;
  let offset = 18 * page;
  function allocate(count, values = []) {
    const view = new Float64Array(memory.buffer, offset, count);
    offset += view.byteLength;
    view.set(values);
    return view;
  }
  const n = nx * nz;
  const input = allocate(4 * n, [...height, ...rain, ...shear]);
  const controls = allocate(3 * n, [...area, ...uplift, ...floor]);
  const model = allocate(10, settings);
  const grain = allocate(5, [0.01, 2.65, 1e5, 1, 0]);
  const state = allocate(4 * n);
  const delta = allocate(n);
  const totals = allocate(4, budget);
  const scratch = allocate(7 * n);
  const status = exports.landscape_step(
    input.byteOffset,
    controls.byteOffset,
    model.byteOffset,
    grain.byteOffset,
    state.byteOffset,
    delta.byteOffset,
    totals.byteOffset,
    scratch.byteOffset,
    offset,
    nx,
    nz,
    dx,
    dz,
    1,
    0,
    dt,
  );
  return { status, state, delta, totals };
}

for (const shared of [false, true]) {
  test(`landscape native ${shared ? 'shared' : 'plain'} weights remain conservative across extreme grid aspect and lengths`, async () => {
    const file = `../../src/landscape/landscape-kernel${shared ? '-shared' : ''}.wasm`;
    const module = await WebAssembly.compile(await readFile(new URL(file, import.meta.url)));

    // This sole downhill receiver is diagonal. dx² + dz² overflows while the diagonal fits.
    const diagonal = native(module, shared, { dx: 1e154, dz: 1e154, height: [2, 2, 2, 0], rain: [0.5, 0, 0, 0] });
    assert.equal(diagonal.status, 0);
    assert.equal(diagonal.state[3], 0.5);

    // The three fall directions differ by hundreds of exponents. The dominant
    // Freeman weight overflows, but its normalized share is indistinguishable from one.
    const aspect = native(module, shared, {
      dx: 1e-300,
      dz: 1e300,
      height: [3e8, 2e8, 2e8, 2e8],
      rain: [1, 0, 0, 0],
    });
    assert.equal(aspect.status, 0);
    assert.equal(aspect.state[2], 1);
  });

  test(`landscape native ${shared ? 'shared' : 'plain'} stiff incision, diffusion and budgets keep finite candidates`, async () => {
    const file = `../../src/landscape/landscape-kernel${shared ? '-shared' : ''}.wasm`;
    const module = await WebAssembly.compile(await readFile(new URL(file, import.meta.url)));
    const stiffSettings = [1.6e308, 0, 0.035, 1000, 9.80665, 0, 0.35, 0, 0, 0.58];
    const stiff = native(module, shared, { settings: stiffSettings, rain: [1, 0, 0, 0] });
    assert.equal(stiff.status, 0);
    assert.equal(stiff.state[4], 10);
    const clipped = native(module, shared, { settings: stiffSettings, floor: [6, -Infinity, -Infinity, -Infinity] });
    assert.equal(clipped.status, 0);
    assert.equal(clipped.state[4], 4);

    // Equal volumes and a single half-width face give a contrast governed by dΔh/dt = −DΔh/A.
    const area = 1e-310;
    const diffusivity = 1e-311;
    const diffused = native(module, shared, {
      nx: 2,
      nz: 1,
      dx: 1e-155,
      dz: 1e-155,
      height: [2, 1],
      area: [area, area],
      settings: [0, 0, 0.035, 1000, 9.80665, 0, 0.35, diffusivity, 0, 0.58],
    });
    assert.equal(diffused.status, 0);
    const moved = -Math.expm1(-diffusivity / area) * 0.5;
    const bound = 16 * Number.EPSILON * Math.abs(Math.log(area));
    assert.ok(Math.abs(diffused.delta[0] + moved) < bound);
    assert.ok(Math.abs(diffused.delta[1] - moved) < bound);

    const invalid = native(module, shared, { budget: [0, 1.6e308, 0, 0], uplift: [3e307, 0, 0, 0] });
    assert.equal(invalid.status, 1);
  });
}
