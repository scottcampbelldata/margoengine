// The grid-particle liquid (FLUID-03, FlipSolver): checked against Martin and Moyce's dam break (1952, table 2: the
// front's position against time for a column twice as high as wide), against still water's hydrostatic pressure, for
// the APIC transfers' conservation of linear and angular momentum (Jiang et al. 2015), and for bits a snapshot and a
// second run reproduce.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FlipSolver, PARTICLE_WORDS, toGrid, toParticles } from '../dist/flip.js';
import { PhysicsWorld } from '../dist/world.js';

const G = 9.81;

test('a column of water twice as high as wide collapses as Martin and Moyce measured: the front within 4 percent', () => {
  // Their n^2 = 2 column, a = 2.25 in wide, on a 2D grid (one cell deep) of a / 12 cells. Their table 2, in Z = front / a
  // against T = n t sqrt(g / a), with T set to 1.19 at Z = 1.44 (their start was not timed).
  const a = 0.05715,
    h = a / 12,
    liquid = new FlipSolver(),
    world = new PhysicsWorld({ rate: { num: 240, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
      cells: [Math.round((16 * a) / h), Math.round((2.5 * a) / h), 1],
      cellSize: h,
      initial: (x, y) => x < a && y < 2 * a,
      rate: 2,
    });
  const measured = [
      [2.11, 1.83],
      [3.0, 2.51],
      [4.11, 3.33],
      [5.0, 4.02],
      [7.0, 5.09],
      [9.0, 6.3],
      [11.0, 7.44],
      [14.0, 9.31],
    ],
    T = (t) => Math.SQRT2 * t * Math.sqrt(G / a),
    reached = new Map();
  for (let frame = 1; frame <= 240 && reached.size < measured.length + 1; frame++) {
    world.advance(frame);
    const pos = liquid.positions();
    let front = 0;
    for (let q = 0; q < pos.length; q += 3) front = Math.max(front, pos[q]);
    for (const Z of [1.44, ...measured.map((m) => m[0])])
      if (!reached.has(Z) && front / a >= Z) reached.set(Z, T(frame / 240));
  }
  const offset = reached.get(1.44) - 1.19;
  for (const [Z, Tm] of measured) {
    const Ts = reached.get(Z) - offset;
    assert.ok(Math.abs(Ts - Tm) <= 0.04 * Tm + 0.07, `Z = ${Z}: T ${Ts.toFixed(2)} against ${Tm}`);
  }
});

test("still water stays still, its pressure rho g depth to the grid's first order", () => {
  const liquid = new FlipSolver(),
    h = 0.05,
    depth = 0.5,
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
      cells: [8, 16, 4],
      cellSize: h,
      initial: (x, y) => y < depth,
    });
  world.advance(60);
  let fastest = 0;
  for (let x = 0.1; x < 0.4; x += 0.1)
    for (let y = 0.05; y < 0.45; y += 0.1) {
      const v = liquid.velocityAt(x, y, 0.1);
      fastest = Math.max(fastest, Math.hypot(...v));
    }
  assert.ok(fastest < 1e-3, `moving at ${fastest} m/s`);
  for (const j of [1, 4, 8]) {
    const y = (j + 0.5) * h,
      p = liquid.pressureAt(0.2, y, 0.1);
    assert.ok(
      Math.abs(p - 1000 * G * (depth - y)) < 1000 * G * h,
      `at ${y} m: ${p} Pa against ${1000 * G * (depth - y)}`,
    );
  }
});

test('the APIC transfers keep linear and angular momentum (Jiang et al. 2015)', () => {
  const g = { nx: 8, ny: 8, nz: 8, h: 0.1 },
    count = 300,
    p = new Float64Array(count * PARTICLE_WORDS);
  let seed = 7;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let q = 0; q < count; q++) {
    const o = q * PARTICLE_WORDS;
    for (let a = 0; a < 3; a++) p[o + a] = 0.2 + 0.4 * rand();
    for (let a = 3; a < 15; a++) p[o + a] = rand() - 0.5;
  }
  const vel = [new Float64Array(9 * 64), new Float64Array(9 * 64), new Float64Array(9 * 64)],
    mass = vel.map((v) => new Float64Array(v.length)),
    momentum = (fromGrid) => {
      const L = [0, 0, 0, 0, 0, 0];
      if (fromGrid) {
        // Faces: their mass-weighted velocity at their place.
        for (let a = 0; a < 3; a++) {
          const [mx, my, mz] = a === 0 ? [9, 8, 8] : a === 1 ? [8, 9, 8] : [8, 8, 9];
          for (let k = 0; k < mz; k++)
            for (let j = 0; j < my; j++)
              for (let i = 0; i < mx; i++) {
                const f = i + mx * (j + my * k),
                  m = mass[a][f],
                  x = [
                    (i + (a === 0 ? 0 : 0.5)) * g.h,
                    (j + (a === 1 ? 0 : 0.5)) * g.h,
                    (k + (a === 2 ? 0 : 0.5)) * g.h,
                  ],
                  mv = [0, 0, 0];
                mv[a] = m * vel[a][f];
                L[a] += mv[a];
                L[3] += x[1] * mv[2] - x[2] * mv[1];
                L[4] += x[2] * mv[0] - x[0] * mv[2];
                L[5] += x[0] * mv[1] - x[1] * mv[0];
              }
        }
        return L;
      }
      // Particles: their velocity, and the angular momentum of their affine motion, sum of the D_p C_p terms
      // (for trilinear weights on a MAC grid the particle's own angular momentum is x_p x m v_p plus its affine part).
      for (let q = 0; q < count; q++) {
        const o = q * PARTICLE_WORDS,
          x = [p[o], p[o + 1], p[o + 2]],
          v = [p[o + 3], p[o + 4], p[o + 5]];
        for (let a = 0; a < 3; a++) L[a] += v[a];
        L[3] += x[1] * v[2] - x[2] * v[1];
        L[4] += x[2] * v[0] - x[0] * v[2];
        L[5] += x[0] * v[1] - x[1] * v[0];
      }
      return L;
    };
  toGrid(g, p, count, vel, mass);
  const grid = momentum(true),
    first = momentum(false);
  for (let a = 0; a < 3; a++)
    assert.ok(Math.abs(grid[a] - first[a]) < 1e-9 * count, `linear ${a}: ${grid[a]} against ${first[a]}`);
  // Grid to particles to grid: the grid's momentum comes back.
  toParticles(g, p, count, vel);
  toGrid(g, p, count, vel, mass);
  const again = momentum(true);
  for (let a = 0; a < 6; a++)
    assert.ok(Math.abs(again[a] - grid[a]) < 1e-9 * count, `component ${a}: ${again[a]} against ${grid[a]}`);
});

test('a lone droplet flies a parabola: spray that makes no liquid cell keeps its velocity', () => {
  // One cell's eight particles thrown up and sideways: too few to make a liquid cell, so the grid holds no liquid. They
  // must still fly as the particles' own velocity and gravity say (they froze where they were before).
  const liquid = new FlipSolver(),
    h = 0.1,
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
      cells: [40, 40, 3],
      cellSize: h,
      initial: (x, y, z) => x > 0.5 && x < 0.6 && y > 1 && y < 1.1 && z > 0.1 && z < 0.2,
    });
  const p = liquid['words'](liquid['particleRegion']);
  for (let q = 0; q < liquid.count; q++) {
    p[q * 15 + 3] = 2;
    p[q * 15 + 4] = 3;
  }
  const start = liquid.positions().slice(0, 2);
  world.advance(30);
  const end = liquid.positions(),
    t = 0.5;
  // Its first particle: x0 + 2 t, y0 + 3 t - g t^2 / 2, to the steps' first order.
  assert.ok(Math.abs(end[0] - (start[0] + 2 * t)) < 0.05, `x ${end[0]}`);
  assert.ok(Math.abs(end[1] - (start[1] + 3 * t - (G * t * t) / 2)) < 0.05, `y ${end[1]}`);
});

test("a box held to the sea passes the sea's waves through: a linear wave keeps its amplitude and phase inside it", () => {
  // A regular deep-water wave 1 m long and 0.03 m high runs through a box 2 m long held to it at its sides (a band of 6
  // cells). In the middle, the surface's motion at the wave's frequency, fitted over two periods, has the sea's amplitude
  // within 15 percent and its phase within 0.15 rad, and its mean within half a cell of the still level.
  const a = 0.03,
    k = 2 * Math.PI,
    w = Math.sqrt(G * k),
    h = 0.0125,
    sea = {
      elevation: (x, _z, t) => a * Math.cos(k * x - w * t),
      water: {
        sample(x, y, _z, t, out = { velocity: [0, 0, 0], density: 1000, temperature: 288 }) {
          const e = a * w * Math.exp(k * Math.min(y, 0));
          out.velocity[0] = e * Math.cos(k * x - w * t);
          out.velocity[1] = e * Math.sin(k * x - w * t);
          out.velocity[2] = 0;
          return out;
        },
      },
    },
    liquid = new FlipSolver(),
    world = new PhysicsWorld({ rate: { num: 120, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
      cells: [160, 64, 1],
      cellSize: h,
      origin: [0, -0.6, 0],
      sea,
      blend: 6,
      rate: 1,
      maxSubsteps: 128,
    });
  let c = 0,
    s = 0,
    mean = 0,
    n = 0;
  for (let f = 1; f <= 120 * 2.4; f++) {
    world.advance(f);
    if (f <= 96) continue;
    const t = f / 120,
      phi = liquid['phi'],
      i = Math.floor(1 / h);
    // The grid's own free surface over x = 1 m (where phi crosses 0 between cell centres), the surface the waves move on.
    let y = NaN;
    for (let j = 0; j + 1 < 64; j++) {
      const lo = phi[i + 160 * j],
        hi = phi[i + 160 * (j + 1)];
      if (lo < 0 && hi >= 0) {
        y = (j + 0.5) * h + (h * lo) / (lo - hi) - 0.6;
        break;
      }
    }
    c += y * Math.cos(k - w * t);
    s += y * Math.sin(k - w * t);
    mean += y;
    n++;
  }
  const amplitude = (2 * Math.hypot(c, s)) / n,
    phase = Math.atan2(s, c);
  assert.ok(Math.abs(amplitude - a) <= 0.15 * a, `amplitude ${amplitude} m against ${a}`);
  assert.ok(Math.abs(phase) <= 0.15, `phase ${phase} rad`);
  assert.ok(Math.abs(mean / n) <= h / 2, `mean level ${mean / n} m`);
  // KB-FLIP-SEABAND1: the band neither drains the box nor pumps the sea into it. The box holds the water it started
  // with to 0.2 percent; the band that topped up only empty cells lost 1.45 percent in these 2.4 s.
  const start = 8 * 160 * 48;
  assert.ok(Math.abs(liquid.count / start - 1) <= 0.002, `${liquid.count} particles of ${start}`);
});

test('a box held to a calm sea stays still (KB-FLIP-SEABAND1)', () => {
  // The band took the sea's velocity after gravity, so the pressure solve took gravity out of the interior and not the
  // band, and still water at the band's edge ran at 0.15 m/s within half a second.
  const still = {
      elevation: () => 0,
      water: {
        sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 1000, temperature: 288 }) {
          out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
          return out;
        },
      },
    },
    liquid = new FlipSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
      cells: [24, 8, 1],
      cellSize: 0.1,
      origin: [-1.2, -0.4, 0],
      sea: still,
      blend: 4,
    });
  world.advance(30);
  const p = liquid.positions(),
    words = liquid['words'](liquid['particleRegion']);
  let fastest = 0;
  for (let q = 0; q < p.length / 3; q++)
    fastest = Math.max(fastest, Math.hypot(words[q * PARTICLE_WORDS + 3], words[q * PARTICLE_WORDS + 4]));
  assert.ok(fastest < 1e-3, `moving at ${fastest} m/s`);
  assert.equal(liquid.count, 8 * 24 * 4);
});

test('a snapshot restores the liquid bit for bit, and a second run gives the same bits', () => {
  const make = () => {
    const liquid = new FlipSolver(),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
        cells: [24, 12, 4],
        cellSize: 0.05,
        initial: (x, y) => x < 0.3 && y < 0.4,
        solids: [{ min: [0.7, 0, 0], max: [0.8, 0.15, 0.2] }],
      });
    return { liquid, world };
  };
  const a = make();
  a.world.advance(20);
  const saved = a.world.takeSnapshot();
  a.world.advance(40);
  const hash = a.world.hash();
  a.world.restoreSnapshot(saved.bytes);
  a.world.advance(40);
  assert.equal(a.world.hash(), hash);
  const b = make();
  b.world.advance(40);
  assert.equal(b.world.hash(), hash, 'a second run');
});

test("water slips along a solid as along the box's own sides: a dam break runs alike on either floor", () => {
  // KB-FLIP-SOLIDSLIP1: the grid zeroed every face touching a solid, the faces inside it too, and the transfers read
  // those faces as the liquid's neighbours, so water beside a solid felt a drag the box's sides do not give and, through
  // APIC's affine part, ran 6.8 percent ahead of Martin and Moyce's front by Z = 14. Now a solid's side reads as the box's.
  const a = 0.05715,
    h = a / 12,
    nx = Math.round((16 * a) / h),
    fronts = (rows, wall) => {
      const liquid = new FlipSolver(),
        lift = rows * h,
        x0 = wall ? 3 * h : 0,
        solids = [];
      if (rows) solids.push({ min: [0, 0, 0], max: [(nx + (wall ? 3 : 0)) * h, lift, h] });
      if (wall) solids.push({ min: [0, 0, 0], max: [x0, (30 + rows) * h, h] });
      const world = new PhysicsWorld({ rate: { num: 240, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
        cells: [nx + (wall ? 3 : 0), 30 + rows, 1],
        cellSize: h,
        rate: 2,
        initial: (x, y) => x > x0 && x < x0 + a && y > lift && y < lift + 2 * a,
        ...(solids.length ? { solids } : {}),
      });
      const out = [];
      for (let f = 1; f <= 72; f++) {
        world.advance(f);
        if (f % 24) continue;
        const pos = liquid.positions();
        let front = 0;
        for (let q = 0; q < pos.length; q += 3) front = Math.max(front, pos[q] - x0);
        out.push(front);
      }
      return out;
    },
    box = fronts(0, false);
  for (const [rows, wall] of [
    [2, false],
    [0, true],
  ]) {
    const other = fronts(rows, wall);
    // Alike to round-off (the wall's case shifts every position by three cells): a micrometre, a 4,000th of a cell.
    for (let n = 0; n < box.length; n++)
      assert.ok(Math.abs(other[n] - box[n]) < 1e-6, `solid ${rows ? 'floor' : 'wall'}: ${other} against ${box}`);
  }
});

test('a particle carried into a solid comes back out at the face it went in by, never through a thin one', () => {
  // KB-PHYS-AUDIT2 (FLUID-03): a particle whose step ended in a solid used to stay where it was, so it froze, its
  // motion along the solid's face lost, and tried again the next substep. Now it comes out at the solid's nearest face on
  // the side it came from.
  const h = 0.05,
    liquid = new FlipSolver();
  new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
    cells: [8, 8, 1],
    cellSize: h,
    initial: () => false,
    // A shelf one cell thick (row 4, 0.2 to 0.25 m) and a block (columns 5 and 6, rows 0 to 2).
    solids: [
      { min: [0, 0.2, 0], max: [0.2, 0.25, h] },
      { min: [0.25, 0, 0], max: [0.35, 0.15, h] },
    ],
  });
  const out = (to, from) => {
    const p = [...to];
    assert.equal(liquid['outOfSolid'](p, ...from), true);
    return p;
  };
  // From above, a little way in: out at the top face, x and z kept.
  let p = out([0.1, 0.24, 0.025], [0.1, 0.27, 0.025]);
  assert.ok(Math.abs(p[1] - 0.25) < 1e-6 && p[0] === 0.1 && p[2] === 0.025, `${p}`);
  // From above, most of the way through the thin shelf: still out at the top, not through to the bottom.
  p = out([0.1, 0.205, 0.025], [0.1, 0.27, 0.025]);
  assert.ok(Math.abs(p[1] - 0.25) < 1e-6, `${p}`);
  // From below: out at the bottom face.
  p = out([0.1, 0.21, 0.025], [0.1, 0.18, 0.025]);
  assert.ok(Math.abs(p[1] - 0.2) < 1e-6, `${p}`);
  // Into the block's side, from the left: out at its left face.
  p = out([0.26, 0.05, 0.025], [0.24, 0.05, 0.025]);
  assert.ok(Math.abs(p[0] - 0.25) < 1e-6 && p[1] === 0.05, `${p}`);
  // Outside every solid: left alone.
  p = out([0.1, 0.1, 0.025], [0.1, 0.1, 0.025]);
  assert.deepEqual(p, [0.1, 0.1, 0.025]);

  // A dam break onto a block: every particle the flow carries into the block comes out of it on the side it came from.
  const flow = new FlipSolver(),
    g = 0.02,
    world = new PhysicsWorld({ rate: { num: 120, den: 1 }, gravity: [0, -G, 0] }).add(flow, {
      cells: [80, 30, 1],
      cellSize: g,
      rate: 2,
      initial: (x, y) => x < 0.4 && y < 0.4,
      solids: [{ min: [1.0, 0, 0], max: [1.1, 0.12, g] }],
    });
  const own = flow['outOfSolid'].bind(flow);
  let entered = 0,
    wrong = 0;
  flow['outOfSolid'] = (to, fx, fy, fz) => {
    const inside = to[0] > 1.0 && to[0] < 1.1 && to[1] < 0.12;
    const ok = own(to, fx, fy, fz);
    if (inside) {
      entered++;
      const stillIn = to[0] > 1.0 && to[0] < 1.1 && to[1] < 0.12,
        side = (fx <= 1.0 && to[0] <= 1.0) || (fx >= 1.1 && to[0] >= 1.1) || (fy >= 0.12 && to[1] >= 0.12);
      if (!ok || stillIn || !side) wrong++;
    }
    return ok;
  };
  for (let f = 1; f <= 120; f++) world.advance(f);
  assert.ok(entered > 0, 'the flow carries particles into the block');
  assert.equal(wrong, 0, `${wrong} of ${entered} left in the block or out the wrong side`);
});

test('bad boxes are refused, each naming its fix', () => {
  const w = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  assert.throws(() => w.add(new FlipSolver('a'), { cells: [0, 4, 4] }), RangeError);
  assert.throws(() => w.add(new FlipSolver('b'), { cellSize: -1 }), RangeError);
  assert.throws(
    () => w.add(new FlipSolver('c'), { cells: [4, 4, 4], solids: [{ min: [0, 0, 0], max: [9, 1, 1] }] }),
    /inside the liquid's box/,
  );
  assert.throws(() => w.add(new FlipSolver('d'), { initial: 3 }), TypeError);
  assert.throws(
    () => w.add(new FlipSolver('e'), { cells: [4, 4, 4], capacity: 10, initial: () => true }),
    /raise capacity/,
  );
});
