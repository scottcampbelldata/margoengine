// HYDRO-07 confined Darcy and Hele-Shaw cells in @margoengine/physics/groundwater: exact discrete solutions and
// Poiseuille's gap-averaged velocity.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  heleShawTransmissivity,
  solveConfinedFlow,
  streamlinePoint,
  traceStreamlines,
} from '@margoengine/physics/groundwater';

function near(actual, expected, tolerance, what = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} expected ${expected} ± ${tolerance}, got ${actual}`);
}

test('a uniform Hele-Shaw channel carries the plane-Poiseuille flow exactly', () => {
  const gap = 0.001,
    viscosity = 0.08,
    drop = 420,
    nx = 42,
    nz = 12,
    dx = 0.01;
  const t = heleShawTransmissivity(gap, viscosity);
  assert.equal(t, gap ** 3 / (12 * viscosity));
  const flow = solveConfinedFlow({
    columns: nx,
    rows: nz,
    cellSize: dx,
    transmissivity: t,
    thickness: gap,
    sides: { minX: drop, maxX: 0 },
  });
  const width = nz * dx,
    length = nx * dx,
    q = (t * width * drop) / length;
  near(flow.inflow, q, 1e-12 * q, 'inflow');
  near(flow.outflow, q, 1e-12 * q, 'outflow');
  // Mean gap velocity b²/(12 μ) Δp / L.
  near(flow.maxSpeed, ((gap * gap) / (12 * viscosity)) * (drop / length), 1e-9 * flow.maxSpeed);
  for (let col = 0; col < nx; col++) near(flow.potential[col + 5 * nx], drop * (1 - (col + 0.5) / nx), 1e-9 * drop);
  // The stream function sums the face flows across the channel. The solve stops at a 1e-12 relative residual, which
  // the grid's condition number (about nx²) can magnify into the face flows: hence 1e-9.
  near(flow.streamFunction[nx / 2 + nz * (nx + 1)], q, 1e-9 * q);
});

test('cells in series add their resistances exactly', () => {
  const nx = 30,
    nz = 4,
    dx = 0.5,
    t = new Float64Array(nx * nz);
  for (let i = 0; i < t.length; i++) t[i] = i % nx < 10 ? 2e-3 : 5e-4;
  const flow = solveConfinedFlow({
    columns: nx,
    rows: nz,
    cellSize: dx,
    transmissivity: t,
    sides: { minX: 3, maxX: 1 },
  });
  const width = nz * dx,
    q = (2 * width) / ((10 * dx) / 2e-3 + (20 * dx) / 5e-4);
  near(flow.inflow, q, 1e-12 * q);
});

test('the five-point solve is exact for a harmonic quadratic with a fixed boundary ring', () => {
  const nx = 24,
    nz = 18,
    dx = 0.1,
    fixed = new Float64Array(nx * nz).fill(Number.NaN),
    exact = (col, row) => ((col + 0.5) * dx) ** 2 - ((row + 0.5) * dx) ** 2;
  for (let row = 0; row < nz; row++)
    for (let col = 0; col < nx; col++)
      if (row === 0 || col === 0 || row === nz - 1 || col === nx - 1) fixed[col + row * nx] = exact(col, row);
  const flow = solveConfinedFlow({ columns: nx, rows: nz, cellSize: dx, transmissivity: 1, fixed });
  for (let row = 1; row < nz - 1; row++)
    for (let col = 1; col < nx - 1; col++)
      near(flow.potential[col + row * nx], exact(col, row), 1e-10, `${col},${row}`);
  near(flow.inflow, flow.outflow, 1e-10);
});

test('a plate-gap obstacle conserves the flow and its streamlines cross the cell', () => {
  const nx = 84,
    nz = 48,
    length = 0.42,
    width = 0.24,
    dx = length / nx,
    active = new Uint8Array(nx * nz);
  for (let row = 0; row < nz; row++)
    for (let col = 0; col < nx; col++)
      active[col + row * nx] = +(Math.hypot((col + 0.5) * dx - length / 2, (row + 0.5) * dx - width / 2) >= 0.04);
  const t = heleShawTransmissivity(0.001, 0.08);
  const input = {
    columns: nx,
    rows: nz,
    cellSize: dx,
    transmissivity: t,
    thickness: 0.001,
    active,
    sides: { minX: 420, maxX: 0 },
    origin: [-length / 2, -width / 2],
  };
  const flow = solveConfinedFlow(input);
  near(flow.inflow, flow.outflow, 1e-11 * flow.inflow, 'balance');
  assert.ok(flow.maxResidual < 1e-10 * flow.inflow, 'cell balance within the solve tolerance');
  const open = solveConfinedFlow({ ...input, active: undefined });
  assert.ok(flow.inflow < open.inflow);
  // Hele-Shaw flow is a potential flow: speeding past the cylinder's flanks, about twice the free stream.
  assert.ok(
    flow.maxSpeed > 1.8 * open.maxSpeed && flow.maxSpeed < 2.8 * open.maxSpeed,
    `${flow.maxSpeed / open.maxSpeed}`,
  );
  const lanes = traceStreamlines(flow, { seeds: [0.05, 0.5, 0.95] });
  for (const lane of lanes) {
    near(lane.x[0], -length / 2, 1e-15);
    near(lane.x[nx], length / 2, 1e-12);
    for (let i = 1; i <= nx; i++) assert.ok(lane.time[i] > lane.time[i - 1]);
    near(streamlinePoint(lane, lane.duration)[0], length / 2, 1e-12);
  }
  // The middle lane splits around the obstacle and stays outside it.
  assert.ok(Math.abs(lanes[1].z[nx / 2]) > 0.03);
  assert.deepEqual(solveConfinedFlow(input).potential, flow.potential, 'deterministic');
});

test('a well draws its own extraction from the fixed sides, and bad grids are refused', () => {
  const nx = 21,
    nz = 21,
    sources = new Float64Array(nx * nz);
  sources[10 + 10 * nx] = -0.002;
  const flow = solveConfinedFlow({
    columns: nx,
    rows: nz,
    cellSize: 5,
    transmissivity: 1e-3,
    sources,
    sides: { minX: 10, maxX: 10, minZ: 10, maxZ: 10 },
  });
  near(flow.inflow, 0.002, 1e-12);
  near(flow.outflow, 0.002, 1e-12);
  assert.ok(flow.potential[10 + 10 * nx] < 10);
  assert.throws(() => solveConfinedFlow({ columns: 2, rows: 2, cellSize: 1, transmissivity: [1, 1, 1] }), RangeError);
  assert.throws(() => solveConfinedFlow({ columns: 2, rows: 2, cellSize: 1, transmissivity: 1 }), {
    name: 'MargoError',
    code: 'failed',
  });
});
