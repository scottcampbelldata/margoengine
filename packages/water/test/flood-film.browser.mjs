// water/flood film clock on the GPU (disaster water push 4), on WebGPU and, with MARGO_COMPAT=1, the WebGL2 layer: a
// scene with a sea side, a tsunami, a reservoir behind a wall that breaches, an inflow, wind, rain and a live roughness
// change, directed at film times. Bounds: two runs of 600 frames at 30 fps are identical bit for bit; 600 frames at 30 fps
// equal 1,200 at 60 fps; a fresh flood that replays the clock (what `seek` from @margoengine/cutscene/seek does) and then
// `settle()`s equals the continuous run; a device restore replays the history to the same state; the Courant number stays
// at or under 0.25 and no cell is capped; and sixty steady frames make no pipeline, buffer, texture or bind group.
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
      camera: { position: [32, 40, 40], target: [32, 0, 12], near: 0.1, far: 500 },
    });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    const W = 64,
      H = 24,
      ground = (x) => Math.min(4, Math.max(-6, -6 + (x - 12) * (10 / 52)));
    // The heightmap on the current device: a restore makes a new device, and the terrain asks for its map again.
    const made = new Map();
    const terrain = () => {
      const device = engine.gpu;
      if (!made.has(device)) {
        const t = device.createTexture({ size: [W, H], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        device.queue.writeTexture({ texture: t }, Float32Array.from({ length: W * H }, (_, k) => ground((k % W) + 0.5)), { bytesPerRow: W * 4 }, [W, H]);
        made.set(device, t);
      }
      return made.get(device);
    };
    // The film: what the director calls at each film time, whatever the frame rate.
    const directed = [
      [2, (f) => f.setWind({ speed: 20, direction: [1, 0.2] })],
      [3, (f) => f.setSources([{ position: [50, 12], discharge: 2 }])],
      [4, (f) => f.tsunami({ height: 0.6, period: 10, at: 4 })],
      [6, (f) => f.setRainRate(30)],
      [8, (f) => f.breach(0, { at: 8, over: 3 })],
      [10, (f) => (f.options.roughness = 0.05)],
    ];
    const direct = (flood) => {
      for (const [t, call] of directed) if (Math.abs(flood.time - t) < 1e-9) call(flood);
    };
    const world = () => {
      const water = Water.attach(engine, {
        height: 0,
        size: [200, 200],
        segments: 16,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: terrain, origin: [0, 0], size: [W, H] },
        fill: (x) => (x > 41 ? 5.5 : undefined),
      });
      const flood = Flood.attach(engine, {
        surface: water,
        walls: [{ from: [40.5, 0], to: [40.5, H], top: 6 }],
        boundary: { west: 'sea' },
        maxDepth: 12,
        maxSpeed: 12,
        surgeRise: 5,
        roughness: 0.03,
      });
      return { water, flood, dispose: () => (flood.dispose(), water.dispose()) };
    };
    // FNV-1a over the bits of a Float32Array.
    const hash = (arrays) => {
      let h = 0x811c9dc5;
      for (const a of arrays) for (const bits of new Uint32Array(a.buffer, a.byteOffset, a.length)) h = Math.imul(h ^ bits, 0x01000193) >>> 0;
      return h.toString(16);
    };
    const digest = async (flood) => {
      const r = await flood.read();
      return { hash: hash([r.depth, r.bed, r.velocity]), volume: r.volume, steps: r.steps, ticks: r.ticks, courant: r.courant, capped: r.capped, maxDepth: r.maxDepth, maxSpeed: r.maxSpeed };
    };
    const live = async (fps, seconds) => {
      const w = world(),
        frames = Math.round(seconds * fps),
        courant = [];
      for (let i = 0; i < frames; i++) {
        direct(w.flood);
        engine.render({ delta: 1 / fps });
        if (i % (fps * 4) === fps * 4 - 1) {
          const r = await w.flood.read();
          courant.push([r.courant, r.capped]);
        }
      }
      const out = { ...(await digest(w.flood)), samples: courant, level: w.water.seaLevel };
      w.dispose();
      return out;
    };
    const out = {};
    // Two runs of 600 frames at 30 fps, then 1,200 at 60 fps.
    out.a = await live(30, 20);
    out.b = await live(30, 20);
    out.c = await live(60, 20);
    // A seek: a fresh flood replays the clock without drawing, one frame starts the solver, settle() finishes the ticks.
    {
      const w = world();
      for (let i = 0; i < 1200; i++) {
        direct(w.flood);
        w.flood.advanceTime(1 / 60);
      }
      engine.render({ delta: 0 });
      out.afterOneFrame = w.flood.ticks;
      await w.flood.settle();
      out.seek = await digest(w.flood);
      out.seekLevel = w.water.seaLevel;
      w.dispose();
    }
    // A device restore replays the history to the same state.
    {
      const w = world();
      for (let i = 0; i < 600; i++) {
        direct(w.flood);
        engine.render({ delta: 1 / 60 });
      }
      out.before = await digest(w.flood);
      await engine.rebootDevice();
      engine.render({ delta: 0 });
      out.restartTicks = w.flood.ticks;
      await w.flood.settle();
      out.after = await digest(w.flood);
      w.dispose();
    }
    // Steady frames at a frame rate that divides the tick (60 fps: two ticks), nothing moving: no new objects.
    {
      const w = world();
      for (let i = 0; i < 1500; i++) {
        direct(w.flood);
        engine.render({ delta: 1 / 60 });
      }
      const count = () => {
        const g = w.flood['solver'];
        return { groups: g.groups.size, pair: g.pair };
      };
      const before = count();
      for (let i = 0; i < 120; i++) engine.render({ delta: 1 / 60 });
      out.steady = { before, after: count() };
      w.dispose();
    }
    for (const t of made.values()) t.destroy();
    out.validation = String(await d.popErrorScope().then((e) => e?.message ?? ''));
    return out;
  });
  console.log(JSON.stringify(result).slice(0, 1500));
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(result.validation, '', 'no validation errors');
  const keys = ['hash', 'volume', 'steps', 'ticks'];
  const pick = (r) => keys.map((k) => r[k]);
  assert.deepEqual(pick(result.b), pick(result.a), 'two runs of 600 frames at 30 fps are identical bit for bit');
  assert.deepEqual(pick(result.c), pick(result.a), '1,200 frames at 60 fps equal 600 at 30 fps');
  assert.deepEqual(pick(result.seek), pick(result.a), 'a seek then settle() equals the continuous run');
  assert.equal(result.a.level, result.seekLevel, 'the Water level the flood drives is the same');
  assert.ok(result.afterOneFrame <= 240, `a frame runs at most 240 ticks, ran ${result.afterOneFrame}`);
  assert.equal(result.a.ticks, 2400, '20 s is 2,400 ticks');
  assert.deepEqual(pick(result.after), pick(result.before), 'a device restore replays to the same state');
  assert.ok(result.restartTicks <= 240, 'the replay runs 240 ticks a frame');
  for (const r of [result.a, result.c, result.seek]) {
    assert.ok(r.courant <= 0.25, `Courant ${r.courant}`);
    assert.equal(r.capped, 0);
  }
  for (const [courant, capped] of result.a.samples) assert.ok(courant <= 0.25 && capped === 0, `Courant ${courant}, capped ${capped}`);
  assert.ok(result.a.maxDepth > 1 && result.a.maxSpeed > 0.5, 'the film is not an empty scene');
  assert.deepEqual(result.steady.after, result.steady.before, 'sixty steady frames make no bind group and no ring write');
  console.log('flood film: ok');
} finally {
  await closeAll({ browser });
}
