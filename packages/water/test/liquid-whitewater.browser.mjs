import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

// ParticleLiquid whitewater on the GPU against the float64 oracle (Ihmsen et al. 2012 potentials, brute-force
// neighbours, the same PCG rounding): the first step's emitted count, a fluid at rest emitting nothing, the ring
// keeping the pool full and no larger, a run repeated bit for bit, sprites reaching the composite, and work counts.
const reference = await readFile('packages/water/test/liquid-whitewater-reference.js', 'utf8');
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await browser.page.evaluate(async (referenceSource) => {
    const { potentials, settings } = await import(
      URL.createObjectURL(new Blob([referenceSource], { type: 'text/javascript' }))
    );
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { ParticleLiquid } = await import('/packages/water/dist/liquid.js');
    const { PostStack } = await import('/packages/post/dist/stack.js');
    const W = 256,
      H = 192;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${W}px;height:${H}px`;
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      exactSize: [W, H],
      camera: { position: [0, 0.6, 2.2], target: [0, 0, 0], fov: 60, near: 0.1, far: 100 },
    });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    // Two 6 x 6 x 6 lattice blobs (spacing 0.1, radius 0.05) meeting head-on at 4 m/s, 0.1 apart.
    const blobs = (speed) => {
      const x = [],
        v = [];
      for (const side of [-1, 1])
        for (let i = 0; i < 6; i++)
          for (let j = 0; j < 6; j++)
            for (let k = 0; k < 6; k++) {
              x.push(side * 0.3 + (i - 2.5) * 0.1, (j - 2.5) * 0.1, (k - 2.5) * 0.1);
              v.push(-side * speed, 0, 0);
            }
      return { positions: new Float32Array(x), velocities: new Float32Array(v) };
    };
    const options = { maxParticles: 65536, trappedAirRate: 3000, waveCrestRate: 3000 };
    const run = async (particles, whitewater, steps) => {
      const liquid = new ParticleLiquid({ particles, radius: 0.05, whitewater });
      const stack = PostStack.attach(engine, [liquid]);
      engine.render({ delta: 0 });
      await liquid.readWhitewater().catch(() => undefined);
      const counts = [];
      const stats = [];
      for (let s = 0; s < steps; s++) {
        liquid.update();
        engine.render({ delta: 0 });
        stats.push({ ...liquid.frameStats });
        counts.push(await liquid.readWhitewater());
      }
      engine.render({ delta: 0 });
      const steady = { ...liquid.frameStats };
      return { liquid, stack, counts, stats, steady };
    };
    const out = {};
    const fluid = blobs(4);
    const total = (c) => c.spray + c.foam + c.bubbles;
    // 1. First step against the oracle.
    {
      const a = await run(fluid, options, 1);
      const expected = potentials(fluid.positions, fluid.velocities, settings(0.05, options), 0);
      out.first = {
        gpu: a.counts[0],
        oracle: expected.reduce((n, p) => n + p.count, 0),
        emitters: expected.filter((p) => p.count > 0).length,
        trappedMax: Math.max(...expected.map((p) => p.trapped)),
        stepStats: a.stats[0],
        steady: a.steady,
      };
      // Sprites reach the composite: the whitewater layer holds coverage.
      const layer = a.liquid.foam.layer;
      const buffer = d.createBuffer({ size: W * H * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = d.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: layer }, { buffer, bytesPerRow: W * 8 }, [W, H]);
      d.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const half = new Uint16Array(buffer.getMappedRange());
      let covered = 0;
      for (let i = 3; i < half.length; i += 4) if (half[i] !== 0) covered++;
      buffer.destroy();
      out.first.covered = covered;
      a.stack.dispose();
      a.liquid.dispose();
    }
    // 2. Thirty steps twice: identical counts each step.
    {
      const a = await run(fluid, options, 30);
      a.stack.dispose();
      a.liquid.dispose();
      const b = await run(fluid, options, 30);
      b.stack.dispose();
      b.liquid.dispose();
      out.repeat = { a: a.counts, b: b.counts };
    }
    // 3. At rest: no kinetic energy, nothing emitted.
    {
      const a = await run(blobs(0), options, 5);
      out.rest = a.counts.map(total);
      a.stack.dispose();
      a.liquid.dispose();
    }
    // 4. A pool of 256 fills and stays at 256 (the oldest replaced first).
    {
      const a = await run(fluid, { ...options, maxParticles: 256 }, 4);
      out.ring = a.counts.map(total);
      a.stack.dispose();
      a.liquid.dispose();
    }
    // 5. Capacity probes: a swirling 64-wide lattice block at 65,536 and 262,144 particles, work counts and a
    // diagnostic GPU wait per step (timings are not asserted: speed phase).
    out.capacity = [];
    for (const n of [65536, 262144]) {
      const x = new Float32Array(n * 3),
        v = new Float32Array(n * 3);
      let seed = 7;
      const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
      for (let i = 0; i < n; i++) {
        const a = i % 64,
          b = (i >> 6) % 64,
          c = i >> 12;
        x.set([(a - 32) * 0.02 + rand() * 0.002, (b - 32) * 0.02 + rand() * 0.002, (c - 32) * 0.02], 3 * i);
        v.set([-(b - 32) * 0.1, (a - 32) * 0.1, rand()], 3 * i);
      }
      const liquid = new ParticleLiquid({
        particles: { positions: x, velocities: v },
        radius: 0.01,
        whitewater: { maxParticles: n, kineticEnergy: [0.001, 0.05] },
      });
      const stack = PostStack.attach(engine, [liquid]);
      engine.render({ delta: 0 });
      await liquid.readWhitewater();
      const times = [];
      let step;
      for (let s = 0; s < 6; s++) {
        liquid.update();
        const t0 = performance.now();
        engine.render({ delta: 0 });
        await d.queue.onSubmittedWorkDone();
        times.push(performance.now() - t0);
        step = { ...liquid.frameStats };
      }
      const still = [];
      for (let s = 0; s < 6; s++) {
        const t0 = performance.now();
        engine.render({ delta: 0 });
        await d.queue.onSubmittedWorkDone();
        still.push(performance.now() - t0);
      }
      const steady = { ...liquid.frameStats };
      out.capacity.push({
        n,
        step,
        steady,
        stepMs: Math.min(...times),
        drawMs: Math.min(...still),
        counts: await liquid.readWhitewater(),
      });
      stack.dispose();
      liquid.dispose();
    }
    out.validation = (await d.popErrorScope())?.message;
    engine.dispose?.();
    return out;
  }, reference);
  console.log(JSON.stringify({ ...result, repeat: { steps: result.repeat.a.length, last: result.repeat.a.at(-1) } }));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, undefined);
  const total = (c) => c.spray + c.foam + c.bubbles;
  // The GPU's bucket grid and float32 potentials emit what the float64 brute-force oracle emits (a float32 rate can
  // land on the other side of an integer for a few particles).
  assert.ok(result.first.oracle > 200, `oracle emits ${result.first.oracle}`);
  assert.ok(
    Math.abs(total(result.first.gpu) - result.first.oracle) <= Math.max(3, result.first.oracle * 0.01),
    `GPU ${total(result.first.gpu)} vs oracle ${result.first.oracle}`,
  );
  assert.ok(result.first.covered > 50, `whitewater pixels ${result.first.covered}`);
  assert.deepEqual(result.repeat.a, result.repeat.b, 'two runs give identical counts every step');
  assert.ok(total(result.repeat.a.at(-1)) > total(result.repeat.a[0]), 'the pool grows over 30 steps');
  assert.deepEqual(result.rest, [0, 0, 0, 0, 0]);
  assert.deepEqual(result.ring, [Math.min(256, result.first.oracle), 256, 256, 256]);
  // Work: a step adds 8 bucket passes, normals, potentials, pyramid levels, update, head and sprites; a frame without
  // update() adds one sprite pass and uploads only the two uniforms.
  assert.equal(result.first.steady.passes, 7);
  assert.equal(result.first.steady.groups, 0);
  assert.equal(result.first.steady.bytes, 480);
  for (const [i, probe] of result.capacity.entries()) {
    assert.equal(probe.steady.passes, 7);
    assert.equal(probe.steady.bytes, 480);
    assert.equal(probe.step.passes, 6 + 8 + 1 + 1 + (8 + i) + 1 + 1 + 1, 'levels: log2 of the 256 or 512 side');
    assert.equal(probe.step.groups, 0);
    assert.ok(total(probe.counts) > 1000, `probe ${probe.n} emits ${total(probe.counts)}`);
  }
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-liquid-whitewater-${compatRun() ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ ...result, hardware: browser.hardware }, null, 2),
  );
} finally {
  await browser.close();
}
