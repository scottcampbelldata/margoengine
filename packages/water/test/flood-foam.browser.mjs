// water/flood's white water, current and wetting record on the GPU (disaster water push 7), on WebGPU and, with
// MARGO_COMPAT=1, the WebGL2 layer. Each bound is the plan's section 3, measured on quasi-1D strips of cells:
//  - a lake at rest over a step and an island has no foam and no breaker anywhere, and its current is 0;
//  - a dam break's front (Froude above 1) breaks white and leaves foam behind it, and that foam decays once the water
//    calms (e-folding 3 s, Callaghan, Deane, Stokes and Ward 2012, https://doi.org/10.1029/2012JC008147);
//  - `velocityTexture` holds the reading's current and depth cell for cell, and `wetTexture` the deepest depth seen and
//    the seconds since each cell was last wet: never below the depth now, and a cell the run-up wet and left has dried
//    for no longer than the run;
//  - a bore run up a frictionless beach never climbs above U0^2 / 2g of its shoreline speed at the toe (Shen and Meyer
//    1963, J. Fluid Mech. 16(1) 113-125, https://doi.org/10.1017/S0022112063000628);
//  - a uniform supercritical chute has no breaker or foam once its front has run out (FG-07: fast flow alone is not white);
//  - a plane of 8 m cells drains as the same plane at 2 m cells does in the JavaScript reference: the cell size leaves no
//    film of water behind (FG-09);
//  - a terrain of 1,024 cells a side, over the old 512-cell cap, floods and keeps its volume (FG-02).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { boreRunup } from './flood-analytic.js';
import { FloodReference } from './flood-reference.js';

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
    const textures = [];
    // A strip of n x 4 cells of dx metres: the bed ground(x), the Water far below (or its fill), a Flood on it.
    const strip = (n, dx, ground, options = {}, fill) => {
      const size = [n * dx, 4 * dx],
        terrain = d.createTexture({
          size: [n, 4],
          format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
      textures.push(terrain);
      d.queue.writeTexture(
        { texture: terrain },
        Float32Array.from({ length: n * 4 }, (_, k) => ground(((k % n) + 0.5) * dx)),
        { bytesPerRow: n * 4 },
        [n, 4],
      );
      const water = Water.attach(engine, {
        height: -50,
        size: [200, 200],
        segments: 16,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: () => terrain, origin: [0, 0], size },
        ...(fill ? { fill } : {}),
      });
      const flood = Flood.attach(engine, { surface: water, ...options });
      engine.render({ delta: 0 });
      return {
        flood,
        async run(seconds, frame = 0.5, each) {
          const frames = Math.round(seconds / frame);
          for (let i = 0; i < frames; i++) {
            engine.render({ delta: frame });
            if (each) await each(flood.time);
          }
          await flood.settle();
        },
        // The four channels of a flood texture along row 1 of the strip.
        async texture(texture) {
          const row = Math.ceil((n * 16) / 256) * 256,
            buffer = d.createBuffer({ size: row * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
            encoder = d.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [n, 4]);
          d.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const all = new Float32Array(buffer.getMappedRange().slice(0));
          buffer.destroy();
          return Array.from(all.subarray(row / 4, row / 4 + n * 4));
        },
        dispose() {
          flood.dispose();
          water.dispose();
        },
      };
    };
    const out = {};
    // 1. A lake at rest: 2 m over a step and an island, 10 s.
    {
      const m = strip(
        100,
        1,
        (x) => (x < 40 ? -2 : x > 60 && x < 70 ? 1 : -1),
        { maxDepth: 3, maxSpeed: 2 },
        () => 0,
      );
      await m.run(10);
      const r = await m.flood.read(),
        v = await m.texture(m.flood.velocityTexture);
      out.rest = {
        foam: Math.max(...r.foam),
        breaker: Math.max(...r.breaker),
        current: Math.max(...v.map(Math.abs).filter((_, k) => k % 4 < 3)),
      };
      m.dispose();
    }
    // 2. A dam break: 1 m of water behind x = 20 m over a dry flat bed 100 m long, closed, rough; the front at 4 s, then
    // the box left to calm for 60 s.
    {
      const m = strip(
        200,
        0.5,
        () => 0,
        { maxDepth: 1.2, maxSpeed: 5, roughness: 0.05 },
        (x) => (x < 20 ? 1 : undefined),
      );
      await m.run(4, 0.25);
      const r = await m.flood.read();
      let front = 0;
      for (let i = 0; i < 200; i++) if (r.depth[i + 200] > 0.01) front = i;
      let froude = 0,
        white = 0,
        foam = 0;
      for (let i = front - 20; i <= front; i++) {
        const h = r.depth[i + 200],
          u = Math.abs(r.velocity[(i + 200) * 2]);
        if (h > 0.08) froude = Math.max(froude, u / Math.sqrt(9.81 * h));
        white = Math.max(white, r.breaker[i + 200]);
        foam = Math.max(foam, r.foam[i + 200]);
      }
      const v = await m.texture(m.flood.velocityTexture);
      let match = 0;
      for (let i = 0; i < 200; i++)
        match = Math.max(
          match,
          Math.abs(v[i * 4] - r.velocity[(i + 200) * 2]),
          Math.abs(v[i * 4 + 3] - r.depth[i + 200]),
        );
      await m.run(60, 1);
      const late = await m.flood.read();
      out.dam = {
        front: front * 0.5,
        froude,
        white,
        foam,
        area: r.foamArea,
        match,
        late: Math.max(...late.foam),
        lateSpeed: late.maxSpeed,
      };
      m.dispose();
    }
    // 3. A bore up a frictionless beach: 0.5 m behind x = 2 m, flat to x = 5 m, then a 1 : 10 slope, on 0.05 m cells.
    {
      const dx = 0.05,
        n = 400,
        m = strip(
          n,
          dx,
          (x) => (x < 5 ? 0 : (x - 5) / 10),
          { maxDepth: 0.6, maxSpeed: 5, roughness: 0 },
          (x) => (x < 2 ? 0.5 : undefined),
        );
      // The dam break's tip runs the flat 3 m to the toe at Ritter's front speed U0 = 2 sqrt(g h0) (Ritter 1892, SWASHES
      // 4.1.2), the shoreline speed of Shen and Meyer; the fastest water seen at the toe is logged beside it.
      let toe = 0,
        top = 0;
      await m.run(12, 0.05, async () => {
        const r = await m.flood.read();
        let shore = 0;
        for (let i = 0; i < n; i++) if (r.depth[i + n] > 1e-3) shore = i;
        for (let i = 90; i < 110; i++)
          if (r.depth[i + n] > 1e-4) toe = Math.max(toe, Math.abs(r.velocity[(i + n) * 2]));
        const x = (shore + 0.5) * dx;
        top = Math.max(top, x > 5 ? (x - 5) / 10 : 0);
      });
      const w = await m.texture(m.flood.wetTexture),
        r = await m.flood.read();
      let below = 0,
        dried = 0,
        longest = 0;
      for (let i = 0; i < n; i++) {
        below = Math.max(below, r.depth[i + n] - w[i * 4]);
        if (w[i * 4 + 2] === 1 && r.depth[i + n] <= 0.01) dried++;
        longest = Math.max(longest, w[i * 4 + 1]);
      }
      out.bore = { toe, top, below, dried, longest, time: m.flood.time };
      m.dispose();
    }
    // 4. A steady chute (FG-07): 400 m of bed falling 1 in 50, 16 m^3/s in at the head over 8 m, open at the foot, rough
    // (n 0.02): uniform supercritical flow at about 4 m/s and Froude 2 once the front has run out. Fast water that is not
    // compressed or steepened makes no white water, so neither the breaker nor the foam is left on for the whole run.
    {
      const m = strip(200, 2, (x) => 8 - 0.02 * x, {
        maxDepth: 1.5,
        maxSpeed: 8,
        roughness: 0.02,
        sources: [{ position: [3, 4], discharge: 16, radius: 4 }],
        boundary: { east: 'open' },
      });
      await m.run(240, 1);
      const r = await m.flood.read();
      let breaker = 0,
        foam = 0,
        froude = Infinity,
        wet = 0;
      for (let i = 25; i < 190; i++) {
        const h = r.depth[i + 200],
          u = Math.abs(r.velocity[(i + 200) * 2]);
        if (h > 0.05) wet++;
        froude = Math.min(froude, u / Math.sqrt(9.81 * Math.max(h, 1e-6)));
        breaker = Math.max(breaker, r.breaker[i + 200]);
        foam = Math.max(foam, r.foam[i + 200]);
      }
      out.chute = { breaker, foam, froude, wet, maxSpeed: r.maxSpeed };
      m.dispose();
    }
    // 5. Drying at film cell size (FG-09): 1 m of water over a 1 in 1,000 plane of 8 m cells, 4 km long, a wall at the
    // top and open at the foot, Manning n 0.045, left to drain for 800 s.
    {
      const S = 0.001,
        m = strip(
          500,
          8,
          (x) => -S * x,
          { maxDepth: 1.5, maxSpeed: 2, roughness: 0.045, boundary: { east: 'open' } },
          (x) => 1 - S * x,
        );
      await m.run(800, 1);
      const r = await m.flood.read();
      out.drain = [50, 100, 200, 400, 800].map((x) => ({ x, h: r.depth[Math.floor(x / 8) + 500] }));
      m.dispose();
    }
    // 6. A terrain wider than the old 512-cell cap (FG-02): 1,024 x 4 cells of 1 m, 2 m of water behind x = 200 m on a
    // flat closed bed; after 60 s the front has run past cell 512 and the volume is what it was.
    {
      const m = strip(
        1024,
        1,
        () => 0,
        { maxDepth: 2.5, maxSpeed: 9, roughness: 0 },
        (x) => (x < 200 ? 2 : undefined),
      );
      await m.run(0, 1);
      const before = (await m.flood.read()).volume;
      await m.run(60, 0.5);
      const r = await m.flood.read();
      let front = 0;
      for (let i = 0; i < 1024; i++) if (r.depth[i + 1024] > 0.01) front = i;
      out.wide = { width: r.width, front, drift: Math.abs(r.volume - before) / before };
      m.dispose();
    }
    for (const t of textures) t.destroy();
    out.validation = String(await d.popErrorScope().then((e) => e?.message ?? ''));
    return out;
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(result.validation, '', 'no validation errors');
  assert.ok(
    result.rest.foam === 0 && result.rest.breaker === 0,
    `no white water on a lake at rest: ${JSON.stringify(result.rest)}`,
  );
  // The solver's own lake-at-rest bound (under 1e-5 m/s; float32 rounding of the well-balanced fluxes, SWASHES 3.1.2).
  assert.ok(result.rest.current < 1e-5, `no current on a lake at rest: ${result.rest.current}`);
  const dam = result.dam;
  assert.ok(dam.froude > 1, `the dam break front is supercritical: ${dam.froude}`);
  assert.ok(
    dam.white > 0.5 && dam.foam > 0.5 && dam.area > 0,
    `the front breaks white and leaves foam: ${JSON.stringify(dam)}`,
  );
  assert.ok(dam.match < 1e-6, `velocityTexture is the reading's current and depth: ${dam.match}`);
  assert.ok(
    dam.late < 0.05 && dam.late < dam.foam,
    `the foam decays once the water calms: ${dam.late} (speed ${dam.lateSpeed})`,
  );
  // The same plane in the plain JavaScript reference at 2 m cells, which 4 m cells already match within 3 mm: the water
  // the 8 m cells hold at 800 s is the water the plane still holds, not a film the cell size leaves behind.
  const fine = new FloodReference({
    nx: 2000,
    dx: 2,
    bed: (x) => -0.001 * x,
    h: () => 1,
    roughness: 0.045,
    boundary: { east: 'open' },
  });
  fine.runTo(800, FloodReference.step(2, 1.5, 2));
  for (const { x, h } of result.drain) {
    const want = fine.h[Math.floor(x / 2)];
    assert.ok(
      Math.abs(h - want) <= 0.02 * want + 0.005,
      `drying at 8 m cells: ${h.toFixed(3)} m at ${x} m against ${want.toFixed(3)} m at 2 m cells (FG-09)`,
    );
  }
  assert.ok(
    result.wide.width === 1024 && result.wide.front > 600,
    `a 1,024-cell flood runs past cell 512: ${JSON.stringify(result.wide)}`,
  );
  assert.ok(result.wide.drift < 1e-5, `and keeps its volume: ${result.wide.drift}`);
  const chute = result.chute;
  assert.ok(chute.wet === 165 && chute.froude > 1.2, `the chute runs full and supercritical: ${JSON.stringify(chute)}`);
  assert.ok(
    chute.breaker < 0.05 && chute.foam < 0.05,
    `uniform fast flow leaves no breaker or foam behind its front (FG-07): ${JSON.stringify(chute)}`,
  );
  const bore = result.bore,
    bound = boreRunup(2 * Math.sqrt(9.81 * 0.5));
  assert.ok(bore.toe > 1, `the bore reaches the toe moving: ${bore.toe} m/s`);
  assert.ok(bore.top <= bound + 0.005, `run-up ${bore.top} m within U0^2 / 2g = ${bound} m (Shen and Meyer 1963)`);
  assert.ok(bore.top > 0.5 * bound, `the bore runs up: ${bore.top} m of ${bound} m`);
  assert.ok(bore.below <= 0, `the wetting record is never below the depth now: ${bore.below}`);
  assert.ok(
    bore.dried > 0 && bore.longest > 0 && bore.longest <= bore.time + 1e-6,
    `cells the run-up wet and left have dried, for no longer than the run: ${JSON.stringify(bore)}`,
  );
  console.log('flood foam check passed');
} finally {
  await closeAll({ browser });
}
