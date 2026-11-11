import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

// ParticleLiquid narrow band (Oliveira and Paiva 2022) on the GPU: voxel labels against the Algorithm 1 oracle on the
// GPU's own grid, the nearest depth identical with and without the band (no holes), the voxel thickness against the
// particle chords, work counts, and a diagnostic frame time at 262,144 particles.
const reference = await readFile('packages/water/test/liquid-band-reference.js', 'utf8');
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await browser.page.evaluate(async (referenceSource) => {
    const { layeredNeighborhood, voxelBlock } = await import(
      URL.createObjectURL(new Blob([referenceSource], { type: 'text/javascript' }))
    );
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { ParticleLiquid } = await import('/packages/water/dist/liquid.js');
    const { PostStack } = await import('/packages/post/dist/stack.js');
    const make = async (W, H, position, target) => {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${W}px;height:${H}px`;
      document.body.replaceChildren(canvas);
      return EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 4,
        exactSize: [W, H],
        camera: { position, target, fov: 60, near: 0.1, far: 100 },
      });
    };
    const read = async (d, texture, bytes) => {
      const row = Math.ceil((texture.width * bytes) / 256) * 256;
      const buffer = d.createBuffer({ size: row * texture.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const e = d.createCommandEncoder();
      e.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
      d.queue.submit([e.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const copy = new Uint8Array(buffer.getMappedRange()).slice();
      buffer.destroy();
      return { copy, row, width: texture.width, height: texture.height };
    };
    const half = (h) => {
      const e = (h >> 10) & 31,
        m = h & 1023;
      return e ? (1 + m / 1024) * 2 ** (e - 15) : (m / 1024) * 2 ** -14;
    };
    const engine = await make(256, 192, [3.2, 2.6, 3.6], [0.8, 0.8, 0.8]);
    const d = engine.gpu;
    d.addEventListener?.('uncapturederror', (event) => console.error(`uncaptured: ${event.error.message}`));
    d.pushErrorScope('validation');
    const out = { blocks: [] };
    for (const per of [2, 3]) {
      const positions = voxelBlock(8, per, 0.2);
      const shot = async (narrowBand) => {
        const liquid = new ParticleLiquid({ particles: { positions }, radius: 0.05, narrowBand, bandVoxel: 0.2 });
        const stack = PostStack.attach(engine, [liquid]);
        engine.render({ delta: 0 });
        await liquid.ready();
        liquid.update();
        engine.render({ delta: 0 });
        const stats = { ...liquid.frameStats };
        engine.render({ delta: 0 });
        const steady = { ...liquid.frameStats };
        const raw = await read(d, liquid.targets[0], 4);
        const thick = await read(d, liquid.targets[3], 2);
        const band = narrowBand ? await liquid.readNarrowBand() : undefined;
        stack.dispose();
        liquid.dispose();
        return { stats, steady, raw, thick, band };
      };
      const guarded = async (narrowBand) => {
        try {
          return await shot(narrowBand);
        } catch (error) {
          const first = await d.popErrorScope();
          throw new Error(`narrowBand ${narrowBand}: ${first?.message ?? 'no scoped error'}; then ${error.message}`);
        }
      };
      const full = await guarded(false);
      const banded = await guarded(true);
      const g = banded.band;
      const oracle = layeredNeighborhood(positions, g.origin, g.voxel, g.dims);
      let covered = 0,
        differ = 0,
        worst = 0;
      const a = new Float32Array(full.raw.copy.buffer),
        b = new Float32Array(banded.raw.copy.buffer);
      for (let y = 0; y < full.raw.height; y++)
        for (let x = 0; x < full.raw.width; x++) {
          const i = y * (full.raw.row / 4) + x;
          if (a[i] > 0 || b[i] > 0) covered++;
          if (a[i] > 0 !== b[i] > 0) differ++;
          else if (a[i] > 0) worst = Math.max(worst, Math.abs(a[i] - b[i]));
        }
      const ta = new Uint16Array(full.thick.copy.buffer),
        tb = new Uint16Array(banded.thick.copy.buffer);
      let sa = 0,
        sb = 0;
      for (let y = 0; y < full.thick.height; y++)
        for (let x = 0; x < full.thick.width; x++) {
          const i = y * (full.thick.row / 2) + x;
          sa += half(ta[i]);
          sb += half(tb[i]);
        }
      out.blocks.push({
        per,
        gpu: { voxels: g.voxels, layer1: g.layer1, layer2: g.layer2, band: g.band, particles: g.particles },
        oracle,
        grid: { origin: g.origin, voxel: g.voxel, dims: g.dims },
        covered,
        differ,
        worst,
        thickness: { particles: sa, voxels: sb },
        update: banded.stats,
        steady: banded.steady,
        fullUpdate: full.stats,
        fullSteady: full.steady,
      });
    }
    out.validation = (await d.popErrorScope())?.message;
    engine.dispose?.();
    // Diagnostic only (the machine is busy): 262,144 particles, a 64^3 lattice of spacing 0.025, at 1920 x 1080.
    const big = await make(1920, 1080, [2.2, 1.8, 2.6], [0.8, 0.8, 0.8]);
    const bd = big.gpu;
    const n = 64,
      lattice = new Float32Array(n * n * n * 3);
    for (let i = 0; i < n * n * n; i++)
      lattice.set([(i % n) * 0.025, (Math.floor(i / n) % n) * 0.025, Math.floor(i / n / n) * 0.025], 3 * i);
    out.speed = {};
    for (const narrowBand of [false, true]) {
      bd.pushErrorScope('validation');
      try {
        await speed(narrowBand);
      } catch (error) {
        const first = await bd.popErrorScope();
        throw new Error(`262,144, narrowBand ${narrowBand}: ${first?.message ?? 'no scoped error'}; then ${error.message}`);
      }
      out.speedValidation = (await bd.popErrorScope())?.message;
    }
    async function speed(narrowBand) {
      const liquid = new ParticleLiquid({ particles: { positions: lattice }, radius: 0.0125, narrowBand });
      const stack = PostStack.attach(big, [liquid]);
      big.render({ delta: 0 });
      await liquid.ready();
      liquid.update();
      big.render({ delta: 0 });
      await bd.queue.onSubmittedWorkDone();
      const steady = [],
        updates = [];
      for (let s = 0; s < 10; s++) {
        const t0 = performance.now();
        big.render({ delta: 0 });
        await bd.queue.onSubmittedWorkDone();
        steady.push(performance.now() - t0);
      }
      for (let s = 0; s < 5; s++) {
        liquid.update();
        const t0 = performance.now();
        big.render({ delta: 0 });
        await bd.queue.onSubmittedWorkDone();
        updates.push(performance.now() - t0);
      }
      out.speed[narrowBand ? 'band' : 'full'] = {
        steadyMs: Math.min(...steady),
        updateMs: Math.min(...updates),
        drawn: narrowBand ? (await liquid.readNarrowBand()).band : n * n * n,
      };
      stack.dispose();
      liquid.dispose();
    }
    big.dispose?.();
    return out;
  }, reference);
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, undefined);
  for (const b of result.blocks) {
    assert.deepEqual(b.gpu, b.oracle, `labels against Algorithm 1 (${b.per}^3 per voxel)`);
    assert.ok(b.gpu.band < b.gpu.particles, 'the band leaves the core out');
    assert.ok(b.covered > 1000, `the block is on screen: ${b.covered}`);
    assert.equal(b.differ, 0, 'coverage identical with and without the band (no holes)');
    assert.ok(b.worst < 1e-6, `nearest depth identical: ${b.worst}`);
    assert.ok(Math.abs(b.thickness.voxels / b.thickness.particles - 1) < 0.1, JSON.stringify(b.thickness));
    assert.deepEqual(b.steady, b.fullSteady, 'a steady frame does the same work with the band');
  }
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-liquid-band-${compatRun() ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ ...result, hardware: browser.hardware }, null, 2),
  );
} finally {
  if (errors.length) console.error(errors.join(String.fromCharCode(10)));
  await browser.close();
}
