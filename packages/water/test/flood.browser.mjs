// water/flood on the GPU (disaster water push 3), on WebGPU and, with MARGO_COMPAT=1, the WebGL2 compatibility layer:
// the solver against test/flood-reference.js cell for cell (a dam break over a bump with a wall, a building, an inflow
// and Manning friction, 200 steps within 1e-4), then the plan's bounds on the GPU itself: Ritter's dam break, a wall
// that holds exactly and lets water through once breached, a lake at rest over steps and an island, volume in a closed
// town and with an inflow, and Water's own flow back after dispose.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { FloodReference, G } from './flood-reference.js';
import { ritter } from './flood-analytic.js';

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Flood } = await import('/packages/water/dist/flood.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:48px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [12, 40, 30], target: [12, 0, 8], near: 0.1, far: 500 },
    });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    // A map of width x height cells over [0, size] with ground(x, z), water up to level(x, z) and a Flood on it.
    const make = (width, height, size, ground, level, options = {}) => {
      const dx = size[0] / width,
        dz = size[1] / height,
        cells = (f) => Float32Array.from({ length: width * height }, (_, k) => f(((k % width) + 0.5) * dx, (Math.floor(k / width) + 0.5) * dz)),
        terrain = d.createTexture({ size: [width, height], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      d.queue.writeTexture({ texture: terrain }, cells(ground), { bytesPerRow: width * 4 }, [width, height]);
      const water = Water.attach(engine, {
        height: -100,
        size: [200, 200],
        segments: 16,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: () => terrain, origin: [0, 0], size },
        fill: level,
      });
      const flood = Flood.attach(engine, { surface: water, ...options });
      engine.render({ delta: 0 });
      return {
        water,
        flood,
        // Runs `count` more steps through the clock, at most 240 a frame.
        async run(count) {
          const target = flood.steps + count;
          flood.advanceTime(count * flood.dt);
          for (let i = 0; i < 1000 && flood.steps < target; i++) engine.render({ delta: 0 });
          if (flood.steps !== target) throw new Error(`ran ${flood.steps} steps, not ${target}`);
        },
        dispose() {
          flood.dispose();
          water.dispose();
          terrain.destroy();
        },
      };
    };
    const out = {};
    const pick = (r) => ({ ...r, depth: Array.from(r.depth), bed: Array.from(r.bed), velocity: Array.from(r.velocity) });

    // 1. Against the reference: 48 x 32 cells of 0.5 m.
    {
      const bump = (x, z) => 0.3 * Math.exp(-((x - 14) ** 2 + (z - 8) ** 2) / 4);
      const m = make(48, 32, [24, 16], bump, (x) => (x < 6 ? 2 : 0.2), {
        walls: [{ from: [6.25, 0], to: [6.25, 5.75], top: 3 }],
        obstacles: (x, z) => (x > 17 && x < 18 && z > 11 && z < 12 ? 4 : 0),
        sources: [{ position: [20.2, 3.3], discharge: 0.5 }],
        roughness: 0.03,
      });
      out.start = pick(await m.flood.read());
      out.dt = m.flood.dt;
      await m.run(200);
      out.end = pick(await m.flood.read());
      m.dispose();
    }
    // 2. Ritter: 400 x 4 cells of 0.25 m, 1 m behind a dam at x = 50 on a dry bed, 6 s, no friction.
    {
      const m = make(400, 4, [100, 1], () => 0, (x) => (x < 50 ? 1 : -1), { roughness: 0, maxDepth: 1, maxSpeed: 7 });
      out.ritterDt = m.flood.dt;
      await m.run(Math.round(6 / m.flood.dt));
      const r = await m.flood.read();
      out.ritter = { depth: Array.from(r.depth.subarray(0, 400)), u: Array.from(r.velocity.subarray(0, 800)).filter((_, i) => i % 2 === 0), time: r.time };
      m.dispose();
    }
    // 3. Walls: 2.5 m behind a wall of 3 m, straight then diagonal, 3,000 steps; then the straight one breached.
    out.walls = [];
    for (const diagonal of [false, true]) {
      const behind = (x, z) => (diagonal ? x < z : x < 20);
      const m = make(40, 40, [40, 40], () => 0, (x, z) => (behind(x, z) ? 2.5 : -1), {
        walls: [diagonal ? { from: [0, 0], to: [40, 40], top: 3 } : { from: [20.5, 0], to: [20.5, 40], top: 3 }],
        maxDepth: 3,
        maxSpeed: 3,
      });
      await m.run(3000);
      const r = await m.flood.read();
      let leak = 0,
        wallCells = 0;
      for (let j = 0; j < 40; j++)
        for (let i = 0; i < 40; i++) {
          const k = j * 40 + i;
          if (r.bed[k] > 2) wallCells++;
          else if (!behind(i + 0.5, j + 0.5)) leak = Math.max(leak, r.depth[k]);
        }
      const entry = { diagonal, leak, wallCells };
      if (!diagonal) {
        m.flood.breach(0, { over: 1 });
        await m.run(Math.round(4 / m.flood.dt));
        const after = await m.flood.read();
        let through = 0;
        for (let k = 0; k < 1600; k++) if (k % 40 > 21) through += after.depth[k];
        entry.through = through;
        entry.crest = after.bed[20 * 40 + 20];
      }
      out.walls.push(entry);
      m.dispose();
    }
    // 4. Lake at rest over steps and an island: 40 x 40 cells of 1 m, 10,000 steps.
    {
      const bed = (x, z) => (x > 10 && x < 14 ? 0.5 : 0) + (z > 20 ? 0.3 : 0) + Math.max(0, 2 - Math.hypot(x - 28, z - 12));
      const m = make(40, 40, [40, 40], bed, () => 1, { maxDepth: 1, maxSpeed: 1 });
      await m.run(10000);
      out.lake = await m.flood.read().then((r) => ({ maxSpeed: r.maxSpeed, steps: r.steps }));
      m.dispose();
    }
    // 5. A closed town: blocks as obstacles, 20,000 steps; then 5 m^3/s into a flat basin for 100 s.
    {
      const block = (x, z) => Math.floor(x / 6) % 2 === 1 && Math.floor(z / 6) % 2 === 1;
      const m = make(48, 48, [48, 48], () => 0, (x) => (x < 12 ? 2 : 0.2), {
        obstacles: (x, z) => (block(x, z) ? 5 : 0),
        roughness: 0.02,
        maxDepth: 2,
        maxSpeed: 4,
      });
      const before = (await m.flood.read()).volume;
      await m.run(20000);
      const r = await m.flood.read();
      let inside = 0;
      for (let k = 0; k < r.depth.length; k++) if (r.bed[k] > 0) inside = Math.max(inside, r.depth[k]);
      out.town = { before, after: r.volume, inside, courant: r.courant, capped: r.capped };
      m.dispose();
      const f = make(30, 30, [60, 60], () => 0, () => 0.5, { sources: [{ position: [30, 30], discharge: 5 }], maxDepth: 1, maxSpeed: 2 });
      const start = (await f.flood.read()).volume;
      await f.run(Math.round(100 / f.flood.dt));
      const end = await f.flood.read();
      out.inflow = { added: end.volume - start, time: end.time };
      f.dispose();
    }
    // 6. Dispose hands the coast back to Water's own flow.
    {
      const m = make(16, 16, [16, 16], () => 0, () => 1);
      const mine = m.water.coastalDepthTexture;
      m.flood.dispose();
      engine.render({ delta: 1 / 60 });
      out.handedBack = m.water.coastalDepthTexture !== mine && m.water.coastalDepthTexture !== undefined;
      m.water.dispose();
    }
    out.validation = (await d.popErrorScope())?.message ?? null;
    out.compat = !!globalThis.__margoCompat;
    engine.dispose();
    return out;
  });

  const label = result.compat ? 'WebGL2 layer' : 'WebGPU';
  assert.equal(result.validation, null, 'validation');
  assert.deepEqual(errors, [], 'page errors');

  // 1. Cell for cell: the reference run from the GPU's first state (its bed holds the wall and the building).
  const { start, end } = result,
    nx = 48,
    ny = 32,
    ref = new FloodReference({ nx, ny, dx: 0.5, bed: () => 0, roughness: 0.03, sources: () => ({ inflow: [{ x: 20.2, z: 3.3, discharge: 0.5 }] }) });
  ref.b.set(start.bed);
  ref.h.set(start.depth);
  assert.ok(start.bed[12] === 3 && start.bed[11 * 48 + 12] === 3 && start.bed[12 * 48 + 12] < 1, 'the wall stands on cells 0..11 of column 12');
  assert.ok(start.bed[23 * 48 + 34] > 4 && start.depth[23 * 48 + 34] === 0, 'the building stands dry');
  ref.run(Math.fround(result.dt), 200);
  let depthError = 0,
    momentumError = 0;
  for (let k = 0; k < nx * ny; k++) {
    depthError = Math.max(depthError, Math.abs(end.depth[k] - ref.h[k]));
    const h = end.depth[k];
    momentumError = Math.max(momentumError, Math.abs(end.velocity[k * 2] * h - ref.hu[k]), Math.abs(end.velocity[k * 2 + 1] * h - ref.hv[k]));
  }
  assert.ok(depthError <= 1e-4, `${label}: depth ${depthError} m from the reference after 200 steps (bound 1e-4)`);
  assert.ok(momentumError <= 1e-4, `${label}: momentum ${momentumError} m^2/s from the reference after 200 steps (bound 1e-4)`);
  assert.ok(Math.abs(end.volume - ref.volume()) / ref.volume() < 1e-6, `${label}: volume ${end.volume} against ${ref.volume()}`);

  // 2. Ritter (SWASHES 4.1.2) at 400 cells: dam depth and speed within 3%, front never ahead of 2 sqrt(g h0) t.
  const r = result.ritter,
    c = Math.sqrt(G),
    near = (actual, expected, tolerance, what) =>
      assert.ok(Math.abs(actual / expected - 1) <= tolerance, `${label}: ${what} ${actual} against ${expected}`);
  near((r.depth[199] + r.depth[200]) / 2, 4 / 9, 0.03, 'depth at the dam');
  near((r.u[199] + r.u[200]) / 2, (2 / 3) * c, 0.03, 'speed at the dam');
  let front = 0;
  for (let i = 399; i >= 0; i--)
    if (r.depth[i] > 1e-4) {
      front = (i + 1) * 0.25;
      break;
    }
  assert.ok(front <= 50 + 2 * c * r.time, `${label}: front ${front} ahead of 2 sqrt(g h0) t`);
  let l1 = 0;
  for (let i = 0; i < 400; i++) l1 += Math.abs(r.depth[i] - ritter(1, 50, (i + 0.5) * 0.25, r.time).h) * 0.25;
  assert.ok(l1 / (3 * c * r.time) < 0.02, `${label}: L1 ${l1 / (3 * c * r.time)} of h0 over the moving zone`);

  // 3. Walls: exactly no water past a standing wall; a breached wall lets it through and drops to the ground.
  for (const w of result.walls) {
    assert.equal(w.leak, 0, `${label}: water past the ${w.diagonal ? 'diagonal' : 'straight'} wall`);
    assert.ok(w.wallCells >= 40, `${label}: the ${w.diagonal ? 'diagonal' : 'straight'} wall covers ${w.wallCells} cells`);
  }
  assert.ok(result.walls[0].through > 10, `${label}: ${result.walls[0].through} through the breach`);
  assert.equal(result.walls[0].crest, 0, `${label}: the breached crest is down to the ground`);

  // 4 to 6.
  assert.ok(result.lake.maxSpeed < 1e-4, `${label}: lake at rest moves at ${result.lake.maxSpeed} m/s`);
  const t = result.town;
  assert.ok(Math.abs(t.after - t.before) / t.before < 1e-5, `${label}: town volume drift ${Math.abs(t.after - t.before) / t.before}`);
  assert.equal(t.inside, 0, `${label}: water inside a block`);
  assert.ok(t.courant <= 0.25 && t.capped === 0, `${label}: Courant ${t.courant}, ${t.capped} capped cells`);
  assert.ok(Math.abs(result.inflow.added / (5 * result.inflow.time) - 1) <= 1e-4, `${label}: inflow added ${result.inflow.added} m^3 in ${result.inflow.time} s`);
  assert.ok(result.handedBack, `${label}: Water's own flow back after dispose`);
  console.log(JSON.stringify({ label, depthError, momentumError, front, l1: l1 / (3 * c * r.time), lake: result.lake.maxSpeed, town: t, inflow: result.inflow, walls: result.walls }));
} finally {
  await closeAll({ browser });
}
