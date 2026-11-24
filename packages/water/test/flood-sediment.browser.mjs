// water/flood's suspended sediment (FG-13) on the GPU, on WebGPU and, with MARGO_COMPAT=1, the WebGL2 layer:
//  - without `sediment` the record's fourth channel and the reading's load stay 0 through a dam break (the pre-FG-13
//    behaviour, regression);
//  - a lake at rest picks nothing up (bed shear 0 is under any critical shear);
//  - a dam break over soil picks up a load that never goes negative or over 100 kg/m^3, and one tick of the record pass
//    matches a JavaScript mirror of its scheme cell for cell: the semi-Lagrangian carry (Stam 1999), the Partheniades
//    (1965) entrainment under the Manning shear rho g n^2 U^2 / h^(1/3) and Krone's (1962) settling, implicit;
//  - the same dam break over paving (`soil` 0) carries no load;
//  - with no bed shear (roughness 0) nothing is picked up and the load settles out at w_s c / h;
//  - 30 fps and 60 fps frames reach the same load bit for bit (the record pass reads each tick's own uniform);
//  - with the surface tint on, the Water's surface shader takes the effect and frames render with no GPU error.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

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
      camera: { position: [25, 30, 20], target: [25, 0, 1], near: 0.1, far: 500 },
    });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    const textures = [];
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
        async run(seconds, frame = 0.5) {
          const frames = Math.round(seconds / frame);
          for (let i = 0; i < frames; i++) engine.render({ delta: frame });
          await flood.settle();
        },
        // Every texel of a flood texture, four channels, rows of increasing z.
        async texture(texture) {
          const row = Math.ceil((n * 16) / 256) * 256,
            buffer = d.createBuffer({ size: row * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
            encoder = d.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [n, 4]);
          d.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const all = new Float32Array(buffer.getMappedRange().slice(0)),
            out = [];
          for (let j = 0; j < 4; j++) out.push(...all.subarray((j * row) / 4, (j * row) / 4 + n * 4));
          buffer.destroy();
          return out;
        },
        dispose() {
          flood.dispose();
          water.dispose();
        },
      };
    };
    // A dam break: 1 m behind x = 20 m over a dry flat bed 100 m long, closed, rough.
    const dam = (options, fill = (x) => (x < 20 ? 1 : undefined)) =>
      strip(200, 0.5, () => 0, { maxDepth: 1.2, maxSpeed: 5, roughness: 0.05, ...options }, fill);
    const sediment = { erosion: 1e-3, criticalShear: 0.5, settling: 0.02 };
    const out = {};
    // 1. Off.
    {
      const m = dam({});
      await m.run(4, 0.25);
      const r = await m.flood.read(),
        w = await m.texture(m.flood.wetTexture);
      out.off = {
        record: Math.max(...w.filter((_, k) => k % 4 === 3).map(Math.abs)),
        reading: Math.max(...r.sediment),
        mass: r.sedimentMass,
        wet: r.wetArea,
      };
      m.dispose();
    }
    // 2. A lake at rest.
    {
      const m = strip(
        100,
        1,
        (x) => (x < 40 ? -2 : -1),
        { maxDepth: 3, maxSpeed: 2, sediment },
        () => 0,
      );
      await m.run(10);
      const r = await m.flood.read();
      out.rest = { load: Math.max(...r.sediment), mass: r.sedimentMass };
      m.dispose();
    }
    // 3. Over soil: 4 s in, one tick checked against the mirror, then 60 s to calm.
    {
      const m = dam({ sediment });
      await m.run(4, 0.25);
      const before = await m.texture(m.flood.wetTexture),
        r0 = await m.flood.read();
      engine.render({ delta: 1 / 120 });
      await m.flood.settle();
      const after = await m.texture(m.flood.wetTexture),
        r1 = await m.flood.read();
      out.soil = {
        n: 200,
        cell: 0.5,
        before: before.filter((_, k) => k % 4 === 3),
        after: after.filter((_, k) => k % 4 === 3),
        depth: Array.from(r1.depth),
        velocity: Array.from(r1.velocity),
        readingMatches: Math.max(...Array.from(r1.sediment).map((c, k) => Math.abs(c - after[k * 4 + 3]))),
        peak: r0.sedimentMass,
        max: Math.max(...r1.sediment),
        min: Math.min(...r1.sediment),
      };
      // Roughness 0: the bed shear is 0, nothing more is picked up, and the load settles out.
      m.flood.options.roughness = 0;
      await m.run(20, 1);
      out.soil.late = (await m.flood.read()).sedimentMass;
      m.dispose();
    }
    // 4. Over paving.
    {
      const m = dam({ sediment: { ...sediment, soil: () => 0 } });
      await m.run(4, 0.25);
      out.paved = (await m.flood.read()).sedimentMass;
      m.dispose();
    }
    // 5. 30 and 60 fps, with the roughness changed half way (each tick's own uniform).
    {
      const loads = [];
      for (const fps of [30, 60]) {
        const m = dam({ sediment });
        for (let i = 0; i < 3 * fps; i++) {
          if (i === 1.5 * fps) m.flood.options.roughness = 0.08;
          engine.render({ delta: 1 / fps });
        }
        await m.flood.settle();
        const r = await m.flood.read();
        loads.push({ load: Array.from(r.sediment), ticks: r.ticks });
        m.dispose();
      }
      out.fps = {
        ticks: loads.map((l) => l.ticks),
        differ: loads[0].load.filter((v, k) => v !== loads[1].load[k]).length,
        mass: loads[0].load.reduce((a, b) => a + b, 0),
      };
    }
    // 6. The tint on the drawn surface: frames render with the effect and no GPU error.
    {
      const m = dam({ sediment: { ...sediment, tint: true } });
      for (let i = 0; i < 8; i++) engine.render({ delta: 0.25 });
      await m.flood.settle();
      out.tint = (await m.flood.read()).sedimentMass;
      m.dispose();
    }
    const validation = await d.popErrorScope();
    out.validation = validation?.message ?? null;
    for (const t of textures) t.destroy();
    engine.dispose();
    return out;
  });
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  // 1. Off: nothing carried, the old record.
  assert.ok(result.off.wet > 0, 'the dam break runs');
  assert.equal(result.off.record, 0);
  assert.equal(result.off.reading, 0);
  assert.equal(result.off.mass, 0);
  // 2. Rest.
  assert.equal(result.rest.load, 0);
  assert.equal(result.rest.mass, 0);
  // 3. The mirror of one tick.
  const s = result.soil,
    { n, cell } = s,
    tick = 1 / 120,
    M = 1e-3,
    tauC = 0.5,
    ws = 0.02,
    rough = 0.05;
  assert.ok(s.peak > 0, `the front picks up soil (${s.peak} kg)`);
  assert.ok(s.min >= 0 && s.max <= 100, `load in 0..100 kg/m^3 (${s.min}..${s.max})`);
  assert.equal(s.readingMatches, 0, 'read() returns the record pass load');
  const load = (i, j) => s.before[Math.min(Math.max(j, 0), 3) * n + Math.min(Math.max(i, 0), n - 1)];
  let worst = 0,
    checked = 0;
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i,
        h = s.depth[k];
      let c = 0;
      if (h > 0.01) {
        const u = s.velocity[2 * k],
          v = s.velocity[2 * k + 1],
          ax = i + 0.5 - (u * tick) / cell - 0.5,
          az = j + 0.5 - (v * tick) / cell - 0.5,
          fx = Math.floor(ax),
          fz = Math.floor(az),
          tx = ax - fx,
          tz = az - fz;
        c =
          (load(fx, fz) * (1 - tx) + load(fx + 1, fz) * tx) * (1 - tz) +
          (load(fx, fz + 1) * (1 - tx) + load(fx + 1, fz + 1) * tx) * tz;
        const tau = (1000 * 9.81 * rough * rough * (u * u + v * v)) / Math.cbrt(h),
          e = M * Math.max(tau / tauC - 1, 0);
        c = Math.min((c + (tick * e) / h) / (1 + (tick * ws) / h), 100);
        checked++;
      }
      worst = Math.max(worst, Math.abs(c - s.after[k]) / Math.max(1e-3, Math.abs(c)));
    }
  assert.ok(checked > 50, `wet cells checked (${checked})`);
  assert.ok(worst < 2e-3, `one tick matches the mirror (worst relative ${worst})`);
  assert.ok(s.late < 0.5 * s.peak, `the load settles out with no bed shear (${s.peak} -> ${s.late} kg)`);
  // 4. Paving.
  assert.equal(result.paved, 0);
  // 5. Frame rate.
  assert.deepEqual(result.fps.ticks, [360, 360]);
  assert.ok(result.fps.mass > 0);
  assert.equal(result.fps.differ, 0, '30 and 60 fps carry the same load bit for bit');
  // 6. Tint.
  assert.ok(result.tint > 0);
  console.log(
    `flood sediment: peak ${s.peak.toFixed(3)} kg, late ${s.late.toFixed(3)} kg, max ${s.max.toFixed(3)} kg/m^3, mirror ${worst.toExponential(2)} over ${checked} cells`,
  );
} finally {
  await closeAll({ browser });
}
