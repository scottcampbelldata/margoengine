// Real-GPU proof that a real Flood (@margoengine/water/flood) drives @margoengine/scatter/states, on WebGPU and, with
// MARGO_COMPAT=1, the WebGL2 compatibility layer (states.browser.mjs proves the plant response on stand-in textures of
// the same format). A dam break: 1.2 m of water behind x = -4 over a flat 16 m bed runs past a tree at the origin.
// Each frame the Scatter composes the map from the flood's own wetting record and current, so after the run:
// - the high-water mark of the tree's cell is the record's deepest depth at the cell centre, bit for bit;
// - the wetness is exp(-seconds since wet / dryTime) of the record;
// - the peak shear velocity (Manning, Chow 1959) is at least the last frame's, the flow direction at that peak is
//   downstream (+X), and the debris rating is at least the last frame's;
// - a cell the water never reached holds nothing.
// Run from the repository root after building packages, through scripts/run-with-timeout.mjs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { shearVelocity } from '../dist/states.js';

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const r = await page.evaluate(async () => {
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Flood } = await import('/packages/water/dist/flood.js');
    const { Scatter } = await import('/packages/scatter/dist/index.js');
    const { PlantStates, floodSource } = await import('/packages/scatter/dist/states.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.replaceChildren(canvas);
    const engine = await Engine.create(canvas, { camera: { position: [0, 6, 16], target: [0, 1, 0], near: 0.5, far: 200 } });
    engine.stop();
    const d = engine.gpu,
      found = [];
    d.pushErrorScope('validation');
    const W = 64,
      size = [16, 16],
      origin = [-8, -8],
      terrain = d.createTexture({ size: [W, W], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: terrain }, new Float32Array(W * W), { bytesPerRow: W * 4 }, [W, W]);
    const water = Water.attach(engine, {
      height: -100,
      size: [200, 200],
      segments: 16,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
      terrain: { heightmap: () => terrain, origin, size },
      fill: (x) => (x < -4 ? 1.2 : -1),
    });
    const flood = Flood.attach(engine, { surface: water, roughness: 0.03 });
    const states = PlantStates.create(engine, { bounds: [-8, -8, 8, 8], resolution: 16, flood: floodSource(flood) });
    engine.createMesh().setGeometry(box(40, 0.1, 40)).setPosition([0, -0.05, 0]);
    const tree = box(0.3, 3, 0.3);
    const scatter = Scatter.attach(engine, tree, {
      count: 1,
      area: [0.001, 0.001],
      scale: [1, 1],
      material: new PbrMaterial({ color: [0.15, 0.45, 0.1], roughness: 0.9 }),
      states: states.plant({ crownBase: 1, trunkRadius: 0.1, stiffness: 0.5 }),
    });
    engine.render({ delta: 0 });
    // 2 s of flood, every frame drawn (each frame composes the map once).
    const target = Math.round(2 / flood.dt);
    for (let i = 0; i < 4000 && flood.steps < target; i++) {
      flood.advanceTime(Math.min(target - flood.steps, 20) * flood.dt);
      engine.render({ delta: 0 });
    }
    // The flood ticks after the scatter's pass in a frame, so the map reads each record as the frame before left it: one
    // more frame with no tick owed composes the last record.
    engine.render({ delta: 0 });
    await d.queue.onSubmittedWorkDone();
    const read = async (source, bytes) => {
      const out = d.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        e = d.createCommandEncoder();
      if (source.size) e.copyBufferToBuffer(source, 0, out, 0, bytes);
      else e.copyTextureToBuffer({ texture: source }, { buffer: out, bytesPerRow: W * 16 }, [W, W]);
      d.queue.submit([e.finish()]);
      await out.mapAsync(GPUMapMode.READ);
      const data = Array.from(new Float32Array(out.getMappedRange().slice(0)));
      out.destroy();
      return data;
    };
    const record = await read(flood.wetTexture, W * W * 16),
      current = await read(flood.velocityTexture, W * W * 16),
      map = await read(states.map, states.map.size);
    const e = await d.popErrorScope();
    if (e) found.push(e.message);
    // The map cell (8, 8) is centred on (0.5, 0.5); the flood texel holding that point is (34, 34). Cell (15, 0) at
    // (7.5, -7.5), texel (62, 2).
    const texel = (data, i, j) => data.slice((j * W + i) * 4, (j * W + i) * 4 + 4),
      layer = (l, cell) => map.slice(8 + (l * 256 + cell) * 4, 8 + (l * 256 + cell) * 4 + 4);
    const out = {
      steps: flood.steps,
      record: texel(record, 34, 34),
      current: texel(current, 34, 34),
      water: layer(1, 8 * 16 + 8),
      dir: layer(2, 8 * 16 + 8),
      far: [layer(0, 15), layer(1, 15)],
      farRecord: texel(record, 62, 2),
      dryTime: states.numbers.dryTime,
      manning: states.numbers.manning,
      errors: found,
    };
    scatter.dispose();
    states.dispose();
    flood.dispose();
    water.dispose();
    terrain.destroy();
    return out;
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.record[2] === 1 && r.record[0] > 0.2, `the flood reached the tree: ${r.record}`);
  assert.equal(r.water[0], r.record[0], 'the high-water mark is the record of the real flood, bit for bit');
  assert.ok(Math.abs(r.water[3] - Math.exp(-r.record[1] / r.dryTime)) < 1e-5, `wetness ${r.water[3]} from ${r.record[1]} s`);
  const [u, v, speed, depth] = r.current;
  assert.ok(depth > 0.01 && speed > 0.05, `water still runs past the tree: ${r.current}`);
  const last = shearVelocity(depth, speed, r.manning);
  assert.ok(r.water[1] >= last * (1 - 1e-4) && r.water[1] > 0.01, `peak shear ${r.water[1]} against the last frame's ${last}`);
  assert.ok(r.dir[0] > 0.9 && Math.abs(r.dir[1]) < 0.3, `the peak flow runs downstream (+X): ${r.dir}`);
  assert.ok(u > 0, `the current runs +X: ${r.current}`);
  const hazard = Math.min(1, Math.max(0, (depth * (speed + 0.5) - 0.75) / 1.25));
  assert.ok(r.water[2] >= hazard - 1e-5, `debris ${r.water[2]} against the last frame's ${hazard}`);
  if (r.farRecord[2] === 0) {
    assert.deepEqual(r.far[0], [0, 0, 0, 0], 'a dry cell has no fire');
    assert.deepEqual(r.far[1], [0, 0, 0, 0], 'a cell the water never reached has no mark');
  }
  assert.deepEqual(errors, []);
  console.log(`states-flood: ${r.steps} steps, mark ${r.water[0].toFixed(3)} m, peak shear ${r.water[1].toFixed(3)} m/s, debris ${r.water[2].toFixed(2)}`);
} finally {
  await closeAll({ browser });
}
