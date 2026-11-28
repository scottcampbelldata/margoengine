// @margoengine/physics/gpu-cloth on its CPU twin (the same passes the GPU runs; gpu-cloth-check.mjs compares the two on a
// real GPU): closed-form statics, terminal speed and Coulomb friction, pins on bodies, every collider shape, wind,
// determinism with snapshot and restore, debug lines and coded errors.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { GPUCloth, clothStateHash, MAX_GPU_CLOTH_COLLIDERS } from '../dist/gpu-cloth.js';
import { SoftBodyDesc } from '../dist/soft.js';

await Physics.load();
await GPUCloth.load();

const G = 9.81;
const DT = 1 / 60 / 30; // the default substep
const ulp = (x) => {
  const f = new Float32Array([Math.abs(x)]),
    u = new Uint32Array(f.buffer);
  u[0] += 1;
  return f[0] - Math.abs(x);
};
const coded = (fn, pattern = /errors#gpu-cloth/) =>
  assert.throws(
    fn,
    (e) => e.name === 'MargoError' && pattern.test(e.message),
    'a coded MargoError linking errors#gpu-cloth',
  );

test('a particle hung on two compliant edges settles where the springs hold its weight (XPBD statics)', () => {
  // Two edges of compliance alpha from pins at (+-a, 0): 2 (l - L) / alpha * y / l = m g, solved by bisection.
  const a = 0.3,
    h = 0.4,
    m = 0.1,
    alpha = 0.01;
  const desc = SoftBodyDesc.trimesh([-a, 0, 0, a, 0, 0, 0, -h, 0], [0, 1, 2])
    .setPinnedParticles([0, 1])
    .setParticleMass(m);
  // Tethers off: they would cap the stretch from the pins at 1 percent.
  const cloth = new GPUCloth(desc, {
    airDensity: 0,
    stretchCompliance: alpha,
    bendCompliance: 0,
    damping: 4,
    tethers: false,
  });
  cloth.step(600);
  const L = Math.hypot(a, h);
  let lo = h,
    hi = 1;
  for (let k = 0; k < 200; k++) {
    const y = (lo + hi) / 2,
      l = Math.hypot(a, y);
    if (2 * ((l - L) / alpha) * (y / l) > m * G) hi = y;
    else lo = y;
  }
  const y = -cloth.positions()[7];
  // A substep restores w dt^2 / alpha of an offset, so a float32 rounding of the position (one ulp) holds an offset of
  // ulp alpha / (w dt^2) in place: the float32 floor of the equilibrium.
  const floor = (ulp(lo) * alpha) / ((1 / m) * DT * DT);
  assert.ok(Math.abs(y - lo) <= floor, `rest depth ${y} against ${lo} (floor ${floor})`);
  assert.ok(y - h > 0.005, 'the edges stretched under the weight');
});

test('a flat sheet falls at the terminal speed of its plate drag, sqrt(rho_A g / (1/2 rho Cd))', async () => {
  // Cotton shirting (0.12 kg/m^2) by default; every particle's mass and area share are the same third of its triangles.
  // The drag balances gravity exactly in the discrete step, so only float32 rounding of the velocity is left.
  const N = 25;
  const sheet = new GPUCloth(SoftBodyDesc.cloth([0, 10, 0], [0.1, 0, 0], [0, 0, 0.1], 5, 5), { turbulence: 0 });
  sheet.step(180);
  const vt = Math.sqrt((0.12 * G) / (0.5 * 1.2 * 1.17));
  const { state } = await sheet.snapshot();
  for (let i = 0; i < N; i++) {
    const v = -state[(N + i) * 4 + 1];
    assert.ok(Math.abs(v - vt) / vt < 1e-5, `particle ${i} falls at ${v} m/s, terminal ${vt}`);
  }
});

test('cloth on a slope holds below its friction angle and slides at g (sin - mu cos) above it (Coulomb)', () => {
  const theta = (20 * Math.PI) / 180,
    thickness = 0.01;
  const along = [Math.cos(theta), Math.sin(theta), 0],
    normal = [-Math.sin(theta), Math.cos(theta), 0];
  const run = (friction) => {
    const origin = normal.map((n) => n * thickness);
    const desc = SoftBodyDesc.cloth(
      origin,
      along.map((x) => x * 0.05),
      [0, 0, 0.05],
      2,
      2,
    );
    const cloth = new GPUCloth(desc, { airDensity: 0, thickness, friction });
    cloth.addCollider({ shape: 'plane', normal });
    const before = cloth.positions();
    cloth.step(60);
    const after = cloth.positions();
    // Displacement of the first particle along the slope (positive uphill).
    return (after[0] - before[0]) * along[0] + (after[1] - before[1]) * along[1];
  };
  assert.ok(Math.abs(run(0.5)) < 1e-4, `mu 0.5 > tan 20 degrees holds: moved ${run(0.5)} m`);
  const mu = 0.2,
    a = G * (Math.sin(theta) - mu * Math.cos(theta)),
    n = 60 * 30,
    expected = -(a * DT * DT * n * (n + 1)) / 2; // the discrete sum of a dt^2 k
  const slid = run(mu);
  assert.ok(Math.abs(slid - expected) / -expected < 2e-3, `mu 0.2 slides ${slid} m, expected ${expected}`);
});

test('a particle tied to a moving, turning body follows its point exactly, and a pin moves where it is set', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, {
    type: 'kinematicPosition',
    position: [0, 2, 0],
    colliders: { shape: 'box', halfExtents: [0.05, 0.05, 0.05] },
  });
  const cloth = new GPUCloth(SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, 0, 0.1], 4, 4), { physics });
  cloth.attach(0, body, [0, 2, 0]).pin(15, [0.3, 2, 0.3]);
  assert.deepEqual(cloth.pinned, [0, 15]);
  for (let k = 1; k <= 30; k++) {
    const angle = 0.05 * k;
    body.setNextPosition([0.01 * k, 2 + 0.02 * k, 0]);
    body.setNextRotation([0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]);
    physics.step();
    cloth.step();
  }
  const p = cloth.positions(),
    at = body.position;
  for (let k = 0; k < 3; k++)
    assert.ok(Math.abs(p[k] - at[k]) < 1e-6, `tied particle ${[...p.slice(0, 3)]} on body ${at}`);
  cloth.pin(15, [0.5, 2, 0.5]);
  cloth.step();
  assert.deepEqual(
    [...p.slice(45, 48)].map((x) => +x.toFixed(4)),
    [0.3, 2, 0.3],
    'the pin was where it was set',
  );
  const moved = cloth.positions().slice(45, 48);
  assert.deepEqual(
    [...moved].map((x) => +x.toFixed(5)),
    [0.5, 2, 0.5],
    'it moved to its new point over the step',
  );
  cloth.unpin(15);
  assert.deepEqual(cloth.pinned, [0]);
  physics.dispose();
});

test('cloth comes to rest on a sphere, a capsule, a box and a signed distance field at its thickness', () => {
  const thickness = 0.005;
  const sphereSDF = (r, n) => {
    const data = new Float32Array(n * n * n),
      h = 1 / (n - 1);
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) data[x + y * n + z * n * n] = Math.hypot(x * h - 0.5, y * h - 0.5, z * h - 0.5) - r;
    return { data, size: [n, n, n], min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
  };
  const q90 = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // about z: a capsule's y axis turned onto x
  const cases = [
    { collider: { shape: 'sphere', radius: 0.3 }, top: 0.3, distance: (p) => Math.hypot(...p) - 0.3, tolerance: 1e-5 },
    {
      collider: { shape: 'capsule', radius: 0.2, halfHeight: 0.3, rotation: q90 },
      top: 0.2,
      distance: ([x, y, z]) => Math.hypot(x - Math.min(Math.max(x, -0.3), 0.3), y, z) - 0.2,
      tolerance: 1e-5,
    },
    {
      collider: { shape: 'box', halfExtents: [0.3, 0.2, 0.3] },
      top: 0.2,
      distance: ([x, y, z]) => Math.max(Math.abs(x) - 0.3, Math.abs(y) - 0.2, Math.abs(z) - 0.3),
      tolerance: 1e-5,
    },
    // Trilinear interpolation of |p| - r misses by at most (h^2 / 8) times the sum of its second derivatives, 2 / r across
    // the normal: h^2 / (4 r).
    {
      collider: { shape: 'sdf', sdf: sphereSDF(0.3, 33) },
      top: 0.3,
      distance: (p) => Math.hypot(...p) - 0.3,
      tolerance: (1 / 32) ** 2 / (4 * 0.3),
    },
  ];
  for (const { collider, top, distance, tolerance } of cases) {
    const desc = SoftBodyDesc.cloth([-0.02, top + 0.1, -0.02], [0.02, 0, 0], [0, 0, 0.02], 3, 3);
    const cloth = new GPUCloth(desc, { thickness });
    cloth.addCollider(collider);
    cloth.step(90);
    const p = cloth.positions();
    for (let i = 0; i < 9; i++) {
      const d = distance([p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
      assert.ok(Number.isFinite(d) && d >= thickness - tolerance - 1e-6, `${collider.shape}: particle ${i} at ${d} m`);
    }
    const centre = distance([p[12], p[13], p[14]]);
    assert.ok(Math.abs(centre - thickness) <= tolerance, `${collider.shape}: the centre rests ${centre} m out`);
  }
});

test('a collider on a body rides it, and a removed collider is no longer met', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, {
    type: 'kinematicPosition',
    position: [0, 0, 0],
    colliders: { shape: 'sphere', radius: 0.3 },
  });
  const cloth = new GPUCloth(SoftBodyDesc.cloth([-0.02, 0.4, -0.02], [0.02, 0, 0], [0, 0, 0.02], 3, 3), {
    physics,
    thickness: 0.005,
  });
  const ball = cloth.addCollider({ shape: 'sphere', radius: 0.3, body });
  cloth.step(60);
  for (let k = 1; k <= 30; k++) {
    body.setNextPosition([0, 0.01 * k, 0]);
    physics.step();
    cloth.step();
  }
  assert.ok(Math.abs(cloth.positions()[13] - (0.3 + 0.3 + 0.005)) < 1e-4, `lifted to ${cloth.positions()[13]}`);
  assert.equal(cloth.colliders.length, 1);
  ball.remove();
  assert.equal(cloth.colliders.length, 0);
  cloth.step(30);
  assert.ok(cloth.positions()[13] < 0.5, 'falls once the collider is gone');
  physics.dispose();
});

test('a flag pinned to its pole streams downwind and its threads hold their length', () => {
  const nu = 21,
    nv = 11;
  const flag = new GPUCloth(
    SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, -0.1, 0], nu, nv).setPinnedParticles(
      Array.from({ length: nv }, (_, j) => j),
    ),
    { wind: [6, 0, 0], turbulence: 0.3 },
  );
  // The worst stretch of any thread over 3 s of gusts: measured 5.53 percent at the default 30 substeps (docs/limits.md),
  // as cotton of 0.12 kg/m^2 takes 180 m/s^2 of drag in a 6 m/s wind and one solve a substep has to follow it.
  let worst = 0;
  for (let k = 0; k < 180; k++) {
    flag.step();
    const p = flag.positions();
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const a = (i * nv + j) * 3;
        for (const b of [i + 1 < nu ? ((i + 1) * nv + j) * 3 : -1, j + 1 < nv ? (i * nv + j + 1) * 3 : -1])
          if (b >= 0)
            worst = Math.max(worst, Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]) / 0.1 - 1);
      }
  }
  assert.ok(worst < 0.0554, `worst thread stretch ${worst}`);
  const p = flag.positions();
  let tip = 0;
  for (let j = 0; j < nv; j++) tip += p[((nu - 1) * nv + j) * 3] / nv;
  assert.ok(tip > 1.2, `the free edge streams downwind to x = ${tip}`);
  assert.ok(p.every(Number.isFinite));
  // A wind function of time is read once a frame, at the frame's start.
  const times = [];
  flag.options.wind = (t) => (times.push(t), [0, 0, 0]);
  flag.step();
  flag.step();
  assert.deepEqual(
    times.map((t) => +t.toFixed(6)),
    [3, 3.016667],
  );
});

test('the same steps give the same state, and a restored snapshot repeats them to the bit', async () => {
  const make = () => {
    const cloth = new GPUCloth(
      SoftBodyDesc.cloth([0, 1.5, -0.5], [0.08, 0, 0], [0, 0, 0.08], 14, 13).setPinnedParticles([0, 12]),
      { wind: [3, 0, 1], turbulence: 0.4 },
    );
    cloth.addCollider({ shape: 'sphere', radius: 0.4, position: [0.5, 0.9, 0] });
    cloth.addCollider({ shape: 'plane' });
    return cloth;
  };
  const a = make();
  a.step(60);
  const first = await a.hash();
  const b = make();
  b.step(30);
  const mid = await b.snapshot();
  b.step(30);
  assert.equal(await b.hash(), first, 'two runs of the same steps');
  b.step(10);
  b.restore(mid);
  b.step(30);
  assert.equal(await b.hash(), first, 'restored at step 30 and stepped on');
  assert.equal(b.stats.steps, 60);
  assert.equal(clothStateHash(mid.state), clothStateHash(mid.state.slice()));
  assert.equal(b.stats.backend, 'cpu');
  // The whole snapshot is checked before anything is written.
  const bad = { ...mid, state: mid.state.slice() };
  bad.state[bad.state.length - 1] = NaN;
  const before = await b.hash();
  coded(() => b.restore(bad));
  coded(() => b.restore({ ...mid, count: 3 }));
  assert.equal(await b.hash(), before, 'a refused restore changes nothing');
});

test('debug lines: an edge a segment coloured by strain, pin crosses, collider outlines and the wind arrow', () => {
  // A 2 x 2 cloth: 4 structural edges and 2 diagonals (no bend edges).
  const cloth = new GPUCloth(SoftBodyDesc.cloth([0, 1, 0], [0.1, 0, 0], [0, 0, 0.1], 2, 2).setPinnedParticles([0]), {
    wind: [2, 0, 0],
  });
  const segments = (lines) => lines.vertices.length / 6;
  assert.equal(segments(cloth.debugRender({ pins: false, colliders: false, wind: false })), 6);
  assert.equal(
    segments(cloth.debugRender({ edges: false, colliders: false, wind: false })),
    3,
    'a cross of three lines',
  );
  assert.equal(segments(cloth.debugRender({ edges: false, pins: false })), 2, 'the wind arrow and its head');
  cloth.addCollider({ shape: 'sphere', radius: 0.1, position: [0, 0, 0] });
  assert.equal(segments(cloth.debugRender({ edges: false, pins: false, wind: false })), 72, 'three rings of 24');
  const lines = cloth.debugRender();
  assert.equal(lines.colors.length, (lines.vertices.length / 3) * 4);
  coded(() => cloth.debugRender({ strainRange: 0 }));
});

test('tethers keep every particle within 1 + slack of its rest distance along the cloth from its pin (Kim et al. 2012)', () => {
  // A soft strip 2 m long hung from its top corners: its edges alone let it stretch far; the tethers cap it.
  const make = (tethers) => {
    const cloth = new GPUCloth(
      SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, -0.1, 0], 2, 21).setPinnedParticles([0, 21]),
      {
        stretchCompliance: 0.05,
        shearCompliance: 0.05,
        airDensity: 0,
        tethers,
      },
    );
    cloth.step(120);
    const p = cloth.positions();
    return Math.hypot(p[20 * 3] - 0, p[20 * 3 + 1] - 2, p[20 * 3 + 2]); // the bottom of the pinned side, 2 m down the cloth
  };
  const free = make(false),
    held = make(true);
  assert.ok(free > 2.05, `without tethers the soft strip stretches to ${free} m`);
  assert.ok(held <= 2 * 1.01 * (1 + 1e-6), `with tethers it stays within ${held} m of 2.02 m`);
  assert.ok(held > 2, 'and still takes the slack');
});

test('bad input is a coded MargoError naming the fix', () => {
  coded(() => new GPUCloth(SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 5)), /triangles/);
  coded(() => new GPUCloth(SoftBodyDesc.clothTube([0, 0, 0], [0.1, 0, 0], [0, 0.1, 0], 6, 4)), /clothTube/);
  coded(() => new GPUCloth({}), /SoftBodyDesc/);
  const desc = SoftBodyDesc.cloth([0, 1, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3);
  coded(() => new GPUCloth(desc, { substeps: 0 }));
  coded(() => new GPUCloth(desc, { wind: [1, 2] }));
  coded(() => new GPUCloth(desc, { stretchCompliance: -1 }));
  const cloth = new GPUCloth(desc);
  coded(() => cloth.pin(9));
  coded(() => cloth.pin(0, [0, NaN, 0]));
  coded(() => cloth.attach(0, {}));
  coded(() => cloth.step(0));
  coded(() => cloth.addCollider({ shape: 'cone' }));
  coded(() => cloth.addCollider({ shape: 'sphere', radius: -1 }));
  coded(() =>
    cloth.addCollider({
      shape: 'sdf',
      sdf: { data: new Float32Array(7), size: [2, 2, 2], min: [0, 0, 0], max: [1, 1, 1] },
    }),
  );
  for (let i = 0; i < MAX_GPU_CLOTH_COLLIDERS; i++) cloth.addCollider({ shape: 'plane' });
  coded(() => cloth.addCollider({ shape: 'plane' }));
  coded(() => cloth.setup({ backend: 'webgl2' }), /WebGPU/);
  cloth.dispose();
  coded(() => cloth.step(), /dispose/);
});

test('the CPU route counts its work exactly: substeps, particle updates, edge solves and collider tests (Rust kernel)', () => {
  // A 3 by 3 cloth with no pins over the ground, one step of the default 30 substeps: every particle integrates and meets the
  // one collider each substep, and each edge is solved once a substep: 12 structural, 8 cell diagonals and 6 bend edges.
  const cloth = new GPUCloth(SoftBodyDesc.cloth([0, 1, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3), {
    colliders: [{ shape: 'plane' }],
  });
  assert.equal(cloth.colliders.length, 1, 'the colliders option adds them');
  cloth.step();
  assert.deepEqual(cloth.stats.work, {
    substeps: 30,
    particles: 9 * 30,
    edges: (12 + 8 + 6) * 30,
    colliderTests: 9 * 30,
  });
  // A pinned particle is neither integrated nor tested, and an edge between two pins is not solved.
  cloth.pin(0).pin(1);
  cloth.step();
  assert.deepEqual(cloth.stats.work, {
    substeps: 60,
    particles: 270 + 7 * 30,
    edges: 780 + (26 - 1) * 30,
    colliderTests: 270 + 7 * 30,
  });
  coded(() => new GPUCloth(SoftBodyDesc.cloth([0, 1, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3), { colliders: {} }));
});

test("the shared wind: a FlowField is sampled at the cloth's centre each frame, its density the air's (ATMO-01 to SOFT-01)", async () => {
  // A uniform field moves the cloth exactly as the same velocity does.
  const field = (velocity, density, seen) => ({
    medium: 'air',
    cell: [0, 0, 0],
    sample(x, y, z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
      seen?.push([x, y, z, t]);
      out.velocity = [...velocity];
      out.density = density;
      out.temperature = 288;
      return out;
    },
  });
  const desc = () => SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, -0.1, 0], 6, 5).setPinnedParticles([0, 4]);
  const seen = [];
  const a = new GPUCloth(desc(), { wind: field([6, 0, 1], 1.2, seen) });
  const b = new GPUCloth(desc(), { wind: [6, 0, 1] });
  for (let k = 0; k < 30; k++) {
    a.step();
    b.step();
  }
  assert.equal(await a.hash(), await b.hash(), 'a uniform field and its velocity give the same bits');
  // Sampled once a frame, at the cloth's mean point as it last was, at the cloth's time.
  assert.equal(seen.filter(([, , , t]) => t > 0).length >= 29, true);
  const [x, y, z, t] = seen.at(-1);
  assert.ok(
    Number.isFinite(x + y + z) && Math.abs(y - 1.8) < 0.5 && Math.abs(t - 29 / 60) < 1e-9,
    `sampled at ${x}, ${y}, ${z}, ${t}`,
  );
  // The field's density sets the drag: a falling sheet's terminal speed in air of 0.6 kg/m^3.
  const sheet = new GPUCloth(SoftBodyDesc.cloth([0, 10, 0], [0.1, 0, 0], [0, 0, 0.1], 5, 5), {
    turbulence: 0,
    wind: field([0, 0, 0], 0.6),
  });
  sheet.step(180);
  const vt = Math.sqrt((0.12 * G) / (0.5 * 0.6 * 1.17));
  const { state } = await sheet.snapshot();
  const v = -state[(25 + 12) * 4 + 1];
  assert.ok(Math.abs(v - vt) / vt < 1e-5, `falls at ${v}, terminal ${vt}`);
  coded(() => new GPUCloth(desc(), { wind: field([NaN, 0, 0], 1.2) }));
});
