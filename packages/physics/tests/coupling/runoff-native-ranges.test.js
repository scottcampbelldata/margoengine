import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const DT = 1 / 60;
const PAGE = 65536;

function run(module, shared, { storage, coefficients, forcing, topology, area = 1, budget = [], dt = DT }) {
  const count = storage.length / 7;
  const memory = new WebAssembly.Memory({ initial: 20, maximum: 65536, shared });
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  exports.__stack_pointer.value = 18 * PAGE;
  let offset = 18 * PAGE;
  function allocate(values, words = values.length) {
    const view = new Float64Array(memory.buffer, offset, words);
    offset += view.byteLength;
    view.set(values);
    return view;
  }
  const state = allocate(storage);
  const model = allocate(coefficients);
  const links = new Int32Array(memory.buffer, offset, 2 * count);
  links.set(topology);
  offset += links.byteLength;
  const source = allocate(forcing);
  const scratch = allocate([], 2 * count);
  const totals = allocate(budget, 6);
  const status = exports.runoff_step(
    state.byteOffset,
    model.byteOffset,
    links.byteOffset,
    source.byteOffset,
    scratch.byteOffset,
    totals.byteOffset,
    count,
    area,
    0,
    dt,
  );
  return { status, state, totals };
}

for (const shared of [false, true]) {
  test(`runoff native ${shared ? 'shared' : 'plain'} infiltration keeps finite capillary roots at extreme scales`, async () => {
    const file = `../../src/runoff/runoff-kernel${shared ? '-shared' : ''}.wasm`;
    const module = await WebAssembly.compile(await readFile(new URL(file, import.meta.url)));
    const simulate = (depth, conductivity, rain) =>
      run(module, shared, {
        storage: [depth, 0, 0, 0, 0, 0, 0],
        coefficients: [conductivity, 1e308, 1e308, 0, 0, 0],
        forcing: [rain, 0, 0],
        topology: [-1, 0],
        area: 1e-308,
      });

    // Suction plus offered depth overflows, so the raw log difference would be infinite.
    const ponded = simulate(1e308, 1e306, 0);
    assert.equal(ponded.status, 0);
    const y = ponded.state[1] / 1e308;
    assert.ok(Math.abs(y - Math.log1p(y) - 0.01 * DT) <= 16 * Number.EPSILON * y);
    assert.ok(y > 0 && y < 1);

    // The Mein–Larson transition lies inside the tick even though K times suction overflows.
    const transition = simulate(0, 1e306, 1e308);
    assert.equal(transition.status, 0);
    const threshold = 1 / 99;
    const afterPonding = transition.state[1] / 1e308 - threshold;
    const elapsed = afterPonding - Math.log1p(afterPonding / (1 + threshold));
    assert.ok(afterPonding > 0);
    assert.ok(transition.state[0] > 0);
    assert.ok(Math.abs(elapsed - (DT - threshold) * 0.01) <= 64 * Number.EPSILON * afterPonding);

    // K dt underflows, but the early-time ponded root sqrt(2 S K dt) is representable.
    const capillary = simulate(1e-7, Number.MIN_VALUE, 0);
    assert.equal(capillary.status, 0);
    const asymptotic = Math.sqrt(1e308 * Number.MIN_VALUE * (2 * DT));
    assert.ok(Math.abs(capillary.state[1] / asymptotic - 1) < 4e-13);
  });

  test(`runoff native ${shared ? 'shared' : 'plain'} routing solves a representable depth and rejects overflowing ledgers`, async () => {
    const file = `../../src/runoff/runoff-kernel${shared ? '-shared' : ''}.wasm`;
    const module = await WebAssembly.compile(await readFile(new URL(file, import.meta.url)));
    const rating = 1e-120;
    const extreme = run(module, shared, {
      storage: [1e308, 1e308, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      coefficients: [0, 0, 0, 0, 0, 0, 0, 0, rating, rating, 0, 0],
      forcing: [0, 0, 0, 0, 0, 0],
      topology: [1, -1, 0, 1],
      area: 1e-308,
    });
    assert.equal(extreme.status, 0);
    // The outlet sees 2 m³, so W/A overflows. Its storage is negligible in the
    // implicit balance, and the Manning root has a finite positive depth.
    const depth = (2 / (rating * DT)) ** (3 / 5);
    assert.ok(Math.abs(extreme.state[1] / depth - 1) < 4e-13);
    assert.ok(Math.abs(extreme.totals[5] - 2) < 8e-13);
    // This balance stays entirely within f64, but subtracting two nearly equal
    // volumes used to create a false depth around 1.1e44 m.
    const cancellation = run(module, shared, {
      storage: [0.137e60, 0, 0, 0, 0, 0, 0],
      coefficients: [0, 0, 0, 0, 0.079, 0],
      forcing: [0, 0, 0],
      topology: [-1, 0],
      area: 1e-60,
    });
    assert.equal(cancellation.status, 0);
    const resolved = (0.137 / (0.079 * DT)) ** (3 / 5);
    assert.ok(Math.abs(cancellation.state[0] / resolved - 1) <= 8 * Number.EPSILON);
    assert.ok(Math.abs(cancellation.totals[5] - 0.137) <= 2 * Number.EPSILON * 0.137);

    const overflow = run(module, shared, {
      storage: [0, 0, 0, 0, 0, 0, 0],
      coefficients: [0, 0, 0, 0, 0, 0],
      forcing: [3e307, 0, 0],
      topology: [-1, 0],
      budget: [1.6e308],
      dt: 1,
    });
    assert.equal(overflow.status, 1);
  });
}
