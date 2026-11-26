// Water on a film clock (WaterOptions.clock, PA-03): the coastal flow and its spray step in ticks of 1/240 s that the
// clock owes, each with its own wave time and step from the ring of frame-uniform slices, so the same beach drawn at 24,
// 30, 60 and 5 fps holds the same flow state and the same spray, every byte, at 1 s and 2 s; a fresh water whose clock
// is set to 3 s and then settled holds what a continuous run holds there; and a clock set back replays to the earlier
// time. On the WebGL2 layer the kernels' routes are warmed first (its CPU path and its GL route round differently). Run on WebGPU and (MARGO_COMPAT=1) the WebGL2 compatibility layer:
//   node scripts/run-with-timeout.mjs -- node packages/water/test/film-clock.browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  const r = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { FilmClock } = await import('/packages/math/dist/clock.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 25, 30], target: [0, 0, 0], near: 0.1, far: 300 },
    });
    const device = engine.gpu;
    device.pushErrorScope('validation');
    // A 64 x 64 beach over 64 m: 3 m deep at x = -32, dry above the still level past x = 12.
    const n = 64,
      heights = new Float32Array(n * n);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) heights[z * n + x] = -3 + (x / (n - 1)) * 4.5;
    const heightmap = device.createTexture({
      size: [n, n],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: n * 4 }, [n, n]);
    async function read(buffer, offset, size) {
      const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, offset, staging, 0, size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy();
      return bytes;
    }
    // FNV-1a over the flow's current state texture and the spray's droplets.
    async function state(water) {
      const coast = water['coastal'],
        texture = coast.states[coast.current],
        row = n * 16,
        staging = device.createBuffer({ size: row * n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: row }, [n, n]);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const flow = new Uint8Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy();
      const spray = await read(water['spray'].buffer, 0, water['spray'].buffer.size),
        hash = (bytes) => {
          let h = 0x811c9dc5;
          for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
          return h.toString(16);
        },
        depth = new Float32Array(flow.buffer);
      let wet = 0;
      for (let i = 0; i < n * n; i++) if (depth[4 * i] > 0.01) wet++;
      let flying = 0;
      const droplets = new Float32Array(spray.buffer);
      for (let i = 0; i < droplets.length / 8; i++) if (droplets[8 * i + 3] > 0) flying++;
      return { flow: hash(flow), spray: hash(spray), wet, flying };
    }
    const make = (fps, clocked = true) => {
      const clock = new FilmClock({ fps }),
        water = Water.attach(engine, {
          size: [64, 64],
          segments: 64,
          terrain: { heightmap: () => heightmap, origin: [-32, -32], size: [64, 64] },
          spray: true,
          sprayCount: 1024,
          waves: [{ direction: [1, 0.2], amplitude: 0.4, wavelength: 14, steepness: 0.4, phase: 0.3 }],
          ...(clocked ? { clock } : {}),
        });
      return { clock, water, fps };
    };
    const frame = async (w, f) => {
      w.clock.frame = f;
      engine.render({ delta: 1 / w.fps });
      await device.queue.onSubmittedWorkDone();
    };
    // Warm up first: the WebGL2 layer runs a compute kernel on its CPU path until the kernel's GL route has compiled, and
    // the two round floats differently, so every measured water must run on routes that are ready (a warm-up water with
    // ticks, until no pipeline is still compiling).
    const warm = make(60);
    let warmFrame = 0;
    await waitForPipelines(() => frame(warm, ++warmFrame));
    warm.water.dispose();
    const rows = {};
    for (const fps of [24, 30, 60, 5]) {
      const w = make(fps);
      rows[fps] = {};
      for (let f = 0; f <= 2 * fps; f++) {
        await frame(w, f);
        if (f === fps || f === 2 * fps)
          rows[fps][f / fps] = { ...(await state(w.water)), time: w.water.time, ticks: w.water['flowTicks'] };
      }
      // On to 3 s, then back to 1 s: the flow starts again and replays.
      for (let f = 2 * fps + 1; f <= 3 * fps; f++) await frame(w, f);
      if (fps === 24) rows.continuous3 = await state(w.water);
      if (fps === 24) {
        await frame(w, fps);
        rows.back1 = { ...(await state(w.water)), ticks: w.water['flowTicks'] };
      }
      w.water.dispose();
    }
    // Without a clock the flow steps by the frame's delta: 24 and 60 fps hold different water at 1 s (what the clock removes).
    for (const fps of [24, 60]) {
      const w = make(fps, false);
      for (let f = 0; f <= fps; f++) await frame(w, f);
      rows[`plain${fps}`] = await state(w.water);
      w.water.dispose();
    }
    // A fresh water seeked to 3 s: one frame runs the cap of 480 ticks, settle() the other 240.
    const s = make(24);
    await frame(s, 72);
    const capped = s.water['flowTicks'];
    await s.water.settle();
    rows.seek3 = { ...(await state(s.water)), ticks: s.water['flowTicks'], capped };
    s.water.dispose();
    const error = await device.popErrorScope();
    return { rows, error: error?.message ?? null };
  });
  assert.equal(r.error, null);
  const { rows } = r;
  for (const t of [1, 2]) {
    const base = rows[24][t];
    assert.equal(base.ticks, 240 * t, `${t} s is ${240 * t} ticks`);
    assert.ok(
      base.wet > 100 && base.flying > 0,
      `the beach is wet and the spray flies at ${t} s: ${JSON.stringify(base)}`,
    );
    for (const fps of [30, 60, 5]) assert.deepEqual(rows[fps][t], base, `${fps} fps against 24 fps at ${t} s`);
    console.log(
      `ok flow and spray at ${t} s equal at 24, 30, 60 and 5 fps: ${base.wet} wet cells, ${base.flying} droplets`,
    );
  }
  assert.equal(rows.seek3.capped, 480, 'a frame runs at most 480 ticks');
  assert.equal(rows.seek3.ticks, 720);
  assert.deepEqual(
    { flow: rows.seek3.flow, spray: rows.seek3.spray },
    { flow: rows.continuous3.flow, spray: rows.continuous3.spray },
  );
  console.log('ok a seek to 3 s and settle() hold what a continuous run holds');
  assert.equal(rows.back1.ticks, 240);
  assert.deepEqual(
    { flow: rows.back1.flow, spray: rows.back1.spray },
    { flow: rows[24][1].flow, spray: rows[24][1].spray },
  );
  console.log('ok a clock set back replays to the earlier time');
  assert.notEqual(rows.plain24.flow, rows.plain60.flow, 'without a clock the frame rate changes the flow');
  console.log('ok without a clock, 24 and 60 fps flow differently');
  assert.deepEqual(errors, []);
  console.log('water film clock check passed');
} finally {
  await browser.close();
}
