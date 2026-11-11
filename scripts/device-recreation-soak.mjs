// Device recreation soak (Rust engine port R20): 100 forced device losses in one page, each restored by core's own
// recovery, with core meshes, @margoengine/shadows and @margoengine/lod attached. After the first restore and after the
// hundredth, the live GPU buffers and textures on the current device (created less destroyed, counted by wrapping the
// device the engine asks for) must be the same, and so must the picture, pixel for pixel. A plugin that re-creates
// resources on every restore without freeing the old ones, or that loses state a restore should rebuild, fails here.
//   node scripts/device-recreation-soak.mjs [--cycles=100]   (in a shared GPU slot; MARGO_COMPAT=1 for the WebGL2 layer)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { runSuite, watchExit } from './support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const cycles = Number(process.argv.find((a) => a.startsWith('--cycles='))?.slice(9) ?? 100);
if (!(Number.isInteger(cycles) && cycles >= 2)) throw new RangeError('--cycles takes a whole number of 2 or more');
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async (cycles) => {
      // Live buffers and textures per device: created less destroyed, on every device requested from here on. Each
      // live texture's format and size are kept too, so a count that differs names the texture.
      const live = new WeakMap(),
        request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) {
        const device = await request.apply(this, args),
          count = { buffers: 0, textures: 0, kinds: new Map() };
        live.set(device, count);
        for (const [method, key] of [
          ['createBuffer', 'buffers'],
          ['createTexture', 'textures'],
        ]) {
          const create = device[method];
          device[method] = function (descriptor) {
            const resource = create.call(this, descriptor),
              destroy = resource.destroy;
            let alive = true;
            count[key]++;
            const kind = key === 'textures' && `${descriptor.format} ${[descriptor.size].flat().join('x')}`;
            if (kind) count.kinds.set(kind, (count.kinds.get(kind) ?? 0) + 1);
            resource.destroy = function () {
              if (alive) {
                count[key]--;
                if (kind) count.kinds.set(kind, count.kinds.get(kind) - 1);
              }
              alive = false;
              return destroy.call(this);
            };
            return resource;
          };
        }
        return device;
      };
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { Shadows } = await import('/packages/shadows/dist/index.js'),
        { LODSystem } = await import('/packages/lod/dist/index.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js'),
        size = 96,
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px`;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          exactSize: true,
          camera: { position: [3, 3, 4], target: [0, 0.5, 0], near: 0.1, far: 50 },
        }),
        errors = [];
      engine.onError = (error) => errors.push(String(error?.message ?? error));
      Shadows.attach(engine, { resolution: 256, cascades: 2, distance: 20 });
      const lod = LODSystem.attach(engine),
        ground = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#c8c8c8' }));
      ground.setScale([6, 0.1, 6]).setPosition([0, -0.05, 0]);
      const anchor = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#d04030' }));
      anchor.setPosition([0, 0.8, 0]);
      lod.add(anchor, [
        { object: anchor, distance: 0 },
        { object: box(), distance: 30 },
      ]);
      engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#3060d0' })).setPosition([1.2, 0.5, -0.6]);
      const shot = () => {
        engine.render({ delta: 1 / 60 });
        const c = new OffscreenCanvas(size, size).getContext('2d');
        c.drawImage(canvas, 0, 0);
        return c.getImageData(0, 0, size, size).data;
      };
      const settle = async () => {
        await waitForPipelines(async () => {
          shot();
          await engine.gpu.queue.onSubmittedWorkDone();
        });
        shot();
        await engine.gpu.queue.onSubmittedWorkDone();
        return shot();
      };
      await settle();
      const states = [];
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const old = engine.gpu;
        old.destroy();
        const until = performance.now() + 10000;
        while (engine.gpu === old) {
          if (performance.now() > until) throw new Error(`device not restored after loss ${cycle}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // Core gives up after 4 losses within 120 frames of each other (a driver that keeps failing), so each restore
        // draws 120 frames before the next loss, as a page would between real losses.
        for (let f = 0; f < 120; f++) engine.render({ delta: 1 / 60 });
        if (cycle === 1 || cycle === cycles) {
          const image = await settle(),
            { buffers, textures, kinds } = live.get(engine.gpu);
          const named = [...kinds].filter(([, n]) => n).map(([kind, n]) => `${n} ${kind}`).sort();
          states.push({ cycle, buffers, textures, kinds: named, image: Array.from(image) });
        }
      }
      const [first, last] = states;
      let differ = 0;
      for (let i = 0; i < first.image.length; i += 4)
        if (first.image[i] !== last.image[i] || first.image[i + 1] !== last.image[i + 1] || first.image[i + 2] !== last.image[i + 2])
          differ++;
      const corner = first.image.slice(0, 3);
      let lit = 0;
      for (let i = 0; i < first.image.length; i += 4)
        if (first.image[i] !== corner[0] || first.image[i + 1] !== corner[1] || first.image[i + 2] !== corner[2]) lit++;
      engine.dispose();
      return {
        errors,
        first: { cycle: first.cycle, buffers: first.buffers, textures: first.textures, kinds: first.kinds },
        last: { cycle: last.cycle, buffers: last.buffers, textures: last.textures, kinds: last.kinds },
        differ,
        lit,
        centre: first.image.slice(((size / 2) * size + size / 2) * 4, ((size / 2) * size + size / 2) * 4 + 3),
        corner,
      };
    }, cycles);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/device-recreation-soak.json', JSON.stringify({ hardware, cycles, result }, null, 1));
    assert.deepEqual(result.errors, []);
    assert.ok(result.lit > 500, `the scene draws over the clear colour (${result.lit} px): ${JSON.stringify(result)}`);
    assert.deepEqual(
      [result.last.buffers, result.last.textures, result.last.kinds],
      [result.first.buffers, result.first.textures, result.first.kinds],
      `live GPU resources after restore ${result.first.cycle} and ${result.last.cycle}: ${JSON.stringify(result)}`,
    );
    assert.equal(result.differ, 0, `picture after restore ${result.last.cycle} differs on ${result.differ} pixels`);
    console.log(
      `ok device recreation soak: ${cycles} restores, ${result.last.buffers} buffers and ${result.last.textures} textures live after the first and the last, the same picture`,
    );
  },
  () => context.close(),
);
watchExit();
