import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PAGE = 65536;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ZERO = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const SENTINEL = -17;

function run(module, shared, points, { density, bulk, shear, solvent = 0, mask = 63, dt = 1 / 60 }) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared });
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  exports.__stack_pointer.value = PAGE;
  let top = PAGE;
  function allocate(words) {
    const region = new Float64Array(memory.buffer, top, words);
    top += region.byteLength;
    return region;
  }
  const grains = allocate(27 * points.length);
  points.forEach(({ position = [1, 1, 1], velocity = [0, 0, 0], reference, ratio = 1, affine = ZERO }, index) => {
    grains.set([...position, ...velocity, reference, ratio, ...IDENTITY, ...affine, 0], index * 27);
  });
  const extent = 2;
  const nodeCount = (extent + 3) ** 3;
  const nodes = allocate(nodeCount * 4);
  const active = allocate(nodeCount);
  const diffusion = solvent ? allocate(nodeCount * 10).byteOffset : 0;
  const model = allocate(16);
  model.set([density, bulk, shear, 25, 20, 1, solvent, 0.25, mask, 1, 0, 0, 0, 0, 0, 0]);
  const records = allocate(11 * points.length).fill(SENTINEL);
  const budget = allocate(7).fill(SENTINEL);
  const status = exports.viscoplastic_step(
    grains.byteOffset,
    points.length,
    extent,
    extent,
    extent,
    nodes.byteOffset,
    active.byteOffset,
    diffusion,
    0,
    model.byteOffset,
    records.byteOffset,
    budget.byteOffset,
    dt,
  );
  return { status, records, budget };
}

for (const shared of [false, true]) {
  test(`viscoplastic native ${shared ? 'shared' : 'plain'} arena rejects improper candidates and completes representable CFL bounds`, async () => {
    const file = `../../src/viscoplastic/viscoplastic-kernel${shared ? '-shared' : ''}.wasm`;
    const module = await WebAssembly.compile(await readFile(new URL(file, import.meta.url)));

    // The unscaled sum of moduli overflows even though c²=(K+4μ/3)/ρ=7/3.
    const acoustic = run(module, shared, [{ reference: 1e-305 }], { density: 1e308, bulk: 1e308, shear: 1e308 });
    assert.equal(acoustic.status, 0);
    assert.equal(acoustic.budget[4], 1);
    assert.equal(acoustic.records[6], 1e-305);
    assert.ok(acoustic.records.every(Number.isFinite));

    // Finite stress and volume in a compressed grain can still give infinite Cauchy pressure.
    const pressure = run(module, shared, [{ reference: 1e-305, ratio: 0.01 }], {
      density: 1e308,
      bulk: 1e308,
      shear: 1,
      dt: 1e-6,
    });
    assert.equal(pressure.status, 1);
    assert.ok(pressure.records.every((value) => value === SENTINEL));
    assert.ok(pressure.budget.every((value) => value === SENTINEL));

    // The diagonal and vectors are finite, but Inf <= Inf would report unearned PCG convergence.
    const diffusion = run(module, shared, [{ reference: 1e160, affine: [0, 5, 0, 0, 0, 0, 0, 0, 0] }], {
      density: 1,
      bulk: 10,
      shear: 1,
      solvent: 1e166,
    });
    assert.equal(diffusion.status, 3);
    assert.ok(diffusion.budget.every((value) => value === SENTINEL));

    // Both grains exit through the open +X face. Their deformed volume fits, but
    // their summed, positive reference volumes exceed f64.
    const escaped = run(
      module,
      shared,
      [
        { position: [1.995, 0.8, 0.9], velocity: [2, 0, 0], reference: 1e308, ratio: 0.2 },
        { position: [1.995, 1.2, 1.1], velocity: [2, 0, 0], reference: 1e308, ratio: 0.2 },
      ],
      { density: 1e-307, bulk: 1e-307, shear: 1e-310, mask: 61 },
    );
    assert.equal(escaped.status, 1);
    assert.ok(escaped.budget.every((value) => value === SENTINEL));

    // At rest the acoustic bound requires about 29,500 explicit substeps in one tick.
    const stiff = run(module, shared, [{ reference: 0.01 }], { density: 1, bulk: 5e11, shear: 1000 });
    assert.equal(stiff.status, 4);
    assert.ok(stiff.records.every((value) => value === SENTINEL));
    assert.ok(stiff.budget.every((value) => value === SENTINEL));
  });

  test(`viscoplastic native ${shared ? 'shared' : 'plain'} arena requires a positive Jacobian throughout the step`, async () => {
    const file = `../../src/viscoplastic/viscoplastic-kernel${shared ? '-shared' : ''}.wasm`;
    const module = await WebAssembly.compile(await readFile(new URL(file, import.meta.url)));
    const options = { density: 1600, bulk: 10_000, shear: 100 };
    const reference = 0.01;
    const gradient = -93.75;
    // (1+s*gradient/60)^2 touches zero at s=0.64, between binary subdivision endpoints.
    const touching = run(module, shared, [{ reference, affine: [gradient, 0, 0, 0, gradient, 0, 0, 0, 0] }], options);
    assert.equal(touching.status, 2);
    assert.ok(touching.budget.every((value) => value === SENTINEL));

    // Opposite perturbations produce a narrow negative determinant interval between nearby roots.
    const gap = 0.0001;
    const crossing = run(
      module,
      shared,
      [{ reference, affine: [gradient - gap, 0, 0, 0, gradient + gap, 0, 0, 0, 0] }],
      options,
    );
    assert.equal(crossing.status, 2);
    assert.ok(crossing.records.every((value) => value === SENTINEL));

    // A skew perturbation instead gives (1+s*gradient/60)^2+(s*skew/60)^2 > 0.
    const skew = 0.001;
    const valid = run(
      module,
      shared,
      [{ reference, affine: [gradient, -skew, 0, skew, gradient, 0, 0, 0, 0] }],
      options,
    );
    assert.equal(valid.status, 0);
    assert.equal(valid.budget[4], 1);
    const expected = reference * ((1 + gradient / 60) ** 2 + (skew / 60) ** 2);
    assert.ok(Math.abs(valid.records[6] - expected) <= 16 * Number.EPSILON * reference);
  });
}
