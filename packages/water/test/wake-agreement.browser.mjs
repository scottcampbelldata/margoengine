// The drawn wake and the physics wake agree (WaterWake of @margoengine/water/wake; WakeSolver of @margoengine/physics/sea):
// Water draws the sea's waves and the wake a moving pressure patch leaves, so the surface the GPU computes at each mesh
// vertex (captured by WaveQuery) is the surface SpectralSea.sample gives there with the wake as its patch, to within a
// bound worked out from the waves and the wake grid (docs/limits.md, "Drawn wake"):
//
//   |h_gpu - h| <= B_sea + 16 eps H + dp D + eps (|h_sea| + |h_wake|)
//   |s_gpu - s| <= S_sea + (32 eps H + 2 dp' D + 2 eps H) / (2 c) + eps |s_wake|
//   dp = 4 eps (L / c + 2),  dp' = 4 eps (L / c + 3),  eps = 2^-24
//
// B_sea and S_sea are the drawn sea's bounds (sea-agreement.browser.mjs), H the largest wake height, D the largest
// difference of two neighbouring wake heights, c the cell size and L the farthest vertex from the grid's corner: the
// heights are rounded once to f32 and read by two f32 mixes (16 eps H), the grid coordinate (x - x0) / c - 0.5 is
// rounded in f32 (dp, which moves a bilinear reading by at most dp D), and the slope reads one cell either side (dp').
// The water mesh lies inside the wake grid's interior, so no vertex reads across the grid's zero edge. Checked at every
// 97th vertex, on WebGPU and (MARGO_COMPAT=1) on the WebGL2 compatibility layer:
//   node scripts/run-with-timeout.mjs -- node packages/water/test/wake-agreement.browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const modes = [
  ['--bilge-keels', 'bilge'],
  ['--incident-spectrum', 'incident'],
  ['--forward-course', 'course'],
  ['--hull-motion', 'hull'],
];
const motion = modes.find(([flag]) => process.argv.includes(flag))?.[1] ?? 'pressure';
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  const result = await page.evaluate(async (motion) => {
    const hullMotion = motion !== 'pressure';
    const incident = motion === 'incident';
    const bilge = motion === 'bilge';
    const forwardCourse = incident || bilge || motion === 'course';
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { WaterWake } = await import('/packages/water/dist/wake.js');
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const { SpectralSea, WakeSolver } = await import('/packages/physics/dist/sea.js');
    const { PhysicsWorld, RigidSolver } = await import('/packages/physics/dist/world.js');
    const { jonswap } = await import('/packages/physics/dist/waves.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 30, 30], target: [0, 0, 0], near: 0.1, far: 500 },
    });
    engine.gpu.pushErrorScope('validation');
    const nf = 12,
      nd = 12,
      spectrum = {
        frequencies: Float64Array.from({ length: nf }, (_, i) => 0.06 * 12 ** (i / (nf - 1))),
        directions: Float64Array.from({ length: nd }, (_, j) => (2 * Math.PI * j) / nd),
        energy: new Float64Array(nf * nd),
        depth: 25,
        density: 1025,
      };
    jonswap({ height: 1, period: 7, direction: 0.4 }, spectrum);
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] });
    let wake;
    let hash;
    if (hullMotion) {
      const { HullSolver } = await import('/packages/physics/dist/seakeeping.js');
      const { Physics } = await import('/packages/physics/dist/index.js');
      await Physics.load();
      const hull = new HullSolver('hull', { minimumRadius: 0.35 });
      wake = new WakeSolver('wake', hull.wakeSourceField);
      const loadSea = incident
        ? new SpectralSea({ waves: spectrum, seed: 5, patches: [wake] })
        : { elevation: () => 0 };
      const physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena });
      const body = physics.addBody(null, {
        position: [0, 0.25, 0],
        linearVelocity: [forwardCourse ? 1 : 0, -0.5, 0],
        angularVelocity: [0.1, 0, 0.125],
        colliders: { shape: 'box', halfExtents: [2, 0.75, 1], mass: 4100 },
      });
      const mesh = {
        vertices: new Float64Array([
          -2, -0.75, -1, 2, -0.75, -1, 2, 0.75, -1, -2, 0.75, -1, -2, -0.75, 1, 2, -0.75, 1, 2, 0.75, 1, -2, 0.75, 1,
        ]),
        indices: new Uint32Array([
          0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
        ]),
      };
      world
        .add(new RigidSolver(), { physics })
        .add(hull, {
          hulls: [
            {
              row: body.row,
              mesh,
              course: forwardCourse ? { speed: 1 } : undefined,
              bilgeKeels: bilge
                ? [
                    { root: [0, -0.45, -1], span: [-0.06, -0.08], length: 3 },
                    { root: [0, -0.45, 1], span: [-0.06, 0.08], length: 3 },
                  ]
                : undefined,
            },
          ],
          sea: loadSea,
          drift: false,
          greenWater: false,
          slamming: false,
        })
        .add(wake, { cells: [96, 96], cellSize: 0.25, depth: 3, sponge: 4, waterBelow: incident })
        .couple(['hull', 'wake', 'rigid'], 'staggered');
      world.advance(15);
      const snapshot = world.takeSnapshot();
      world.advance(45);
      hash = world.hash();
      world.restoreSnapshot(snapshot.bytes);
      world.advance(45);
      if (world.hash() !== hash)
        throw new Error('Hull-and-wake replay drift. Inspect the source state and the wake FFT.');
      physics[Symbol.dispose]();
    } else {
      // A hull-sized pressure patch crosses a 64 m wake grid at 3 m/s, leaving its crests behind it.
      wake = new WakeSolver();
      world.add(wake, {
        cells: [128, 128],
        cellSize: 0.5,
        sponge: 6,
        sources: (t) => [{ x: -14 + 3 * t, z: 1, radius: 3, pressure: 1025 * 9.81 * 0.25, volume: 0 }],
      });
      world.advance(8 * 60);
    }
    const sea = new SpectralSea({ waves: spectrum, seed: 5, patches: [wake] }),
      // 40 m on 256 segments inside the wake grid's 64 m: the farthest vertex and the cells either side of it stay
      // more than a cell and a half from the grid's edge.
      water = Water.attach(engine, { size: hullMotion ? [16, 16] : [40, 40], segments: 256, sea }),
      drawn = WaterWake.attach(engine, { surface: water, wake }),
      samples = [];
    const heights = wake.heights(),
      { cells, cellSize, origin } = wake.grid;
    let H = 0,
      D = 0;
    for (let j = 0; j < cells[1]; j++)
      for (let i = 0; i < cells[0]; i++) {
        const h = heights[i + cells[0] * j];
        H = Math.max(H, Math.abs(h));
        if (i + 1 < cells[0]) D = Math.max(D, Math.abs(heights[i + 1 + cells[0] * j] - h));
        if (j + 1 < cells[1]) D = Math.max(D, Math.abs(heights[i + cells[0] * (j + 1)] - h));
      }
    for (const time of [0, 7.25]) {
      water.setTime(time);
      engine.render({ delta: 0 });
      const query = await WaveQuery.capture(water),
        v = query['vertices'],
        rows = new Float32Array(4 * sea.waveCount);
      sea.waveComponents(time, rows);
      const count = v.length / 12;
      for (let i = 0; i < count; i += 97) {
        const x = v[12 * i + 3],
          z = v[12 * i + 7],
          w = wake.sample(x, z);
        samples.push({
          time,
          x,
          z,
          height: v[12 * i + 1],
          normal: [v[12 * i + 4], v[12 * i + 5], v[12 * i + 6]],
          expected: sea.sample(x, z, time),
          wake: { height: w.height, slope: [...w.slope] },
          rows: Array.from({ length: sea.waveCount }, (_, n) => [
            Math.abs(rows[4 * n] * x) + Math.abs(rows[4 * n + 1] * z) + Math.abs(rows[4 * n + 3]),
            rows[4 * n + 2],
            Math.hypot(rows[4 * n], rows[4 * n + 1]),
          ]),
        });
      }
    }
    drawn.dispose();
    const error = await engine.gpu.popErrorScope();
    return {
      samples,
      hash,
      radiated: hullMotion ? wake.sample(3.5, 0).height : null,
      waves: sea.waveCount,
      H,
      D,
      cellSize,
      origin,
      error: error?.message ?? null,
    };
  }, motion);
  assert.equal(result.error, null);
  if (motion !== 'pressure') {
    assert.ok(Math.abs(result.radiated) > 1e-4, 'the radiated wave reaches a distant gauge');
    console.log('Hull-and-wake replay', result.hash, 'distant gauge', result.radiated);
  }
  assert.ok(result.waves > 50, `a real sea: ${result.waves} waves`);
  assert.ok(result.H > 0.02, `a real wake: ${result.H} m at its highest`);
  const eps = 2 ** -24,
    sinBound = 2 ** -11,
    { H, D, cellSize: c, origin } = result;
  let worstHeight = 0,
    worstNormal = 0,
    wakeSeen = 0;
  for (const s of result.samples) {
    const N = s.rows.length;
    let hBound = 0,
      sBound = 0,
      sumA = 0,
      sumAK = 0;
    for (const [phaseTerms, a, k] of s.rows) {
      const d = 4 * eps * (phaseTerms + 2 * Math.PI);
      hBound += a * (sinBound + d);
      sBound += a * k * (sinBound + d);
      sumA += a;
      sumAK += a * k;
    }
    hBound += (N + 2) * eps * sumA;
    sBound += (N + 2) * eps * sumAK;
    const L = Math.max(Math.abs(s.x - origin[0]), Math.abs(s.z - origin[1])),
      dp = 4 * eps * (L / c + 2),
      dp2 = 4 * eps * (L / c + 3),
      wh = s.wake.height;
    hBound += 16 * eps * H + dp * D + eps * (Math.abs(s.expected.height - wh) + Math.abs(wh));
    sBound +=
      (32 * eps * H + 2 * dp2 * D + 2 * eps * H) / (2 * c) +
      eps * Math.max(Math.abs(s.wake.slope[0]), Math.abs(s.wake.slope[1]));
    // A vertex counts as on the wake where the wake is ten times the bound, so a surface without it fails here.
    if (Math.abs(wh) > 10 * hBound) wakeSeen++;
    const dh = Math.abs(s.height - s.expected.height);
    assert.ok(
      dh <= hBound,
      `height at (${s.x}, ${s.z}, t ${s.time}): ${s.height} drawn, ${s.expected.height} simulated (wake ${wh}), bound ${hBound}`,
    );
    for (const k of [0, 2]) {
      const dn = Math.abs(s.normal[k] - s.expected.normal[k]);
      assert.ok(dn <= sBound + 8 * eps, `normal ${k} at (${s.x}, ${s.z}, t ${s.time}): off by ${dn}, bound ${sBound}`);
      worstNormal = Math.max(worstNormal, dn / (sBound + 8 * eps));
    }
    worstHeight = Math.max(worstHeight, dh / hBound);
  }
  assert.ok(wakeSeen > 200, `vertices on the wake: ${wakeSeen} of ${result.samples.length}`);
  assert.deepEqual(errors, []);
  console.log(
    `ok drawn wake agrees with SpectralSea and its WakeSolver at ${result.samples.length} vertices (${wakeSeen} on the wake, highest ${result.H.toFixed(3)} m; ${result.waves} waves): worst height ${(worstHeight * 100).toFixed(3)}% and normal ${(worstNormal * 100).toFixed(3)}% of their bounds`,
  );
} finally {
  await browser.close();
}
