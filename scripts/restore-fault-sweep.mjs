// Fault sweep over device restores (Rust engine port R18): core meshes with @margoengine/culling (CulledMeshes),
// @margoengine/lod, @margoengine/shadows and @margoengine/environment (Environment and EnvironmentLighting) attached. A
// clean restore records every createBuffer, createTexture and mapAsync the new device sees, through 120 frames and a
// settle, with the package that made it. Then, for each of those calls in turn, a restore fails it with
// tests/support/gpu-faults.js (an out-of-memory error, as a real device raises it; `select` counts only that package's
// calls, so an asynchronous rebuild interleaving its calls moves nothing), and a clean restore follows. Each failure
// must reach engine.onError or be thrown by engine.render (engine.start() hands that to onError); the clean restore
// must report nothing; after it the live buffers and textures (created less destroyed) and the picture must equal the
// first clean restore's, pixel for pixel. A package that keeps a failed resource, leaks the rest of a half-built set,
// or loses state a restore should rebuild fails here, named by the call that broke it. Each failure must also be
// reported exactly once, no frame may throw, and the frame after it must draw the scene (KB6434: an allocation
// failure used to stop the engine until the next restore).
//   node scripts/restore-fault-sweep.mjs [--only=shadows:createTexture:2]   (in a shared GPU slot; MARGO_COMPAT=1 for the WebGL2 layer)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { runSuite, watchExit } from './support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? '';
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async (only) => {
      const { injectGPUFaults } = await import('/tests/support/gpu-faults.js');
      // Which package asked: the first engine package on the call's stack other than core.
      const owner = () =>
        new Error().stack.match(/\/packages\/(?!core\/)([\w-]+)\/dist\//)?.[1] ??
        (/\/packages\/core\/dist\//.test(new Error().stack) ? 'core' : 'page');
      const live = new WeakMap(),
        request = GPUAdapter.prototype.requestDevice;
      let plan = null,
        calls = null,
        handle = null;
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
              destroy = resource.destroy,
              kind = `${key} ${descriptor.label ?? ''} ${descriptor.format ?? ''} ${[descriptor.size].flat().join('x')}`;
            let alive = true;
            count[key]++;
            count.kinds.set(kind, (count.kinds.get(kind) ?? 0) + 1);
            calls?.push({ method, label: descriptor.label ?? '', owner: owner() });
            if (method === 'createBuffer') {
              const map = resource.mapAsync;
              resource.mapAsync = function (...a) {
                calls?.push({ method: 'mapAsync', label: descriptor.label ?? '', owner: owner() });
                return map.apply(this, a);
              };
            }
            resource.destroy = function () {
              if (alive) {
                count[key]--;
                count.kinds.set(kind, count.kinds.get(kind) - 1);
              }
              alive = false;
              return destroy.call(this);
            };
            return resource;
          };
        }
        // A plan is for the one next device: a restore that the failure itself starts gets a clean device.
        handle = plan ? injectGPUFaults(device, plan) : handle;
        plan = null;
        return device;
      };
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { Shadows } = await import('/packages/shadows/dist/index.js'),
        { LODSystem } = await import('/packages/lod/dist/index.js'),
        { CulledMeshes } = await import('/packages/culling/dist/index.js'),
        { Environment, EnvironmentLighting } = await import('/packages/environment/dist/index.js'),
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
      // A sky with a sun texel, so the lighting depends on the environment's SH and specular cube.
      const sky = new Float32Array(64 * 32 * 4);
      for (let i = 0; i < 64 * 32; i++) sky.set([0.4, 0.5, 0.8, 1], i * 4);
      sky.set([400, 380, 300, 1], (8 * 64 + 20) * 4);
      const environment = await Environment.attach(engine, { width: 64, height: 32, data: sky }, { size: 32 });
      EnvironmentLighting.attach(engine, environment);
      Shadows.attach(engine, { resolution: 256, cascades: 2, distance: 20 });
      CulledMeshes.attach(engine);
      const lod = LODSystem.attach(engine),
        ground = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#c8c8c8' }));
      ground.setScale([6, 0.1, 6]).setPosition([0, -0.05, 0]);
      const anchor = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#d04030', metalness: 0.5 }));
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
        // The environment rebuilds asynchronously (compute passes and one SH readback).
        for (let i = 0; i < 4; i++) {
          shot();
          await engine.gpu.queue.onSubmittedWorkDone();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return shot();
      };
      // One device loss restored by core; `faults` is the plan for the new device. Core gives up after 4 losses within
      // 120 frames of each other, so each restore draws 120 frames, as a page would between real losses.
      const restore = async (faults) => {
        const old = engine.gpu;
        plan = faults;
        old.destroy();
        const until = performance.now() + 10000;
        while (engine.gpu === old) {
          if (performance.now() > until) throw new Error('device not restored');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        plan = null;
        let thrown = 0;
        for (let f = 0; f < 120; f++)
          try {
            engine.render({ delta: 1 / 60 });
          } catch (error) {
            // engine.render throws what stops the frame; engine.start()'s loop hands it to engine.onError.
            if (!thrown++) errors.push(`frame: ${error?.message ?? error}`);
          }
        return thrown;
      };
      const state = async () => {
        const image = await settle(),
          { buffers, textures, kinds } = live.get(engine.gpu);
        return {
          buffers,
          textures,
          kinds: [...kinds].filter(([, n]) => n).map(([kind, n]) => `${n} ${kind}`).sort(),
          image,
        };
      };
      // Pixels that differ between two pictures; pixels the scene covers (differ from the background corner).
      const differ = (a, b) => {
          let n = 0;
          for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
          return n;
        },
        drawnPixels = (image) => {
          let n = 0;
          for (let i = 0; i < image.length; i += 4)
            if (Math.abs(image[i] - image[0]) + Math.abs(image[i + 1] - image[1]) + Math.abs(image[i + 2] - image[2]) > 24) n++;
          return n;
        };
      await settle();
      calls = [];
      await restore(null);
      const base = await state(),
        recorded = calls;
      calls = null;
      if (errors.length) throw new Error(`a clean restore reported errors: ${errors.join('; ')}`);
      const index = {},
        cases = recorded.map((call) => {
          const key = `${call.owner} ${call.method}`;
          return { ...call, n: (index[key] = (index[key] ?? 0) + 1) };
        });
      const results = [];
      for (const call of cases) {
        if (only && only !== `${call.owner}:${call.method}:${call.n}`) continue;
        errors.length = 0;
        handle = null;
        let thrown = await restore({ [call.method]: call.n, select: () => owner() === call.owner });
        const faulted = await settle().catch((error) => errors.push(`settle: ${error?.message ?? error}`));
        // The frame after the failure renders: it throws nothing and draws the scene (with or without the failed
        // package's part), never a blank canvas.
        let next = null;
        try {
          next = shot();
        } catch (error) {
          thrown++;
          errors.push(`frame: ${error?.message ?? error}`);
        }
        const injected = handle?.injected.length ?? 0;
        const reportedCount = errors.length,
          reported = errors.slice(0, 3);
        errors.length = 0;
        thrown += await restore(null);
        const after = await state();
        results.push({
          method: call.method,
          n: call.n,
          owner: call.owner,
          label: call.label,
          injected,
          reported,
          reportedCount,
          thrown,
          drawn: next ? drawnPixels(next) : 0,
          faultedDiffer: typeof faulted === 'object' ? differ(faulted, base.image) : -1,
          cleanErrors: errors.slice(0, 3),
          buffers: after.buffers,
          textures: after.textures,
          kinds: after.kinds.join(', ') === base.kinds.join(', ') ? undefined : after.kinds,
          differ: differ(after.image, base.image),
        });
      }
      engine.dispose();
      return {
        base: { buffers: base.buffers, textures: base.textures, kinds: base.kinds, calls: cases.length, drawn: drawnPixels(base.image) },
        results,
      };
    }, only);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/restore-fault-sweep.json', JSON.stringify({ hardware, result }, null, 1));
    const { base, results } = result,
      failures = [];
    assert.ok(only || results.length === base.calls, 'every recorded call was failed once');
    for (const r of results) {
      const at = `${r.owner} ${r.method} ${r.n}${r.label ? ` (${r.label})` : ''}`;
      if (r.injected !== 1) failures.push(`${at}: the failure was not injected`);
      if (!r.reported.length) failures.push(`${at}: the failure was neither reported to engine.onError nor thrown by a frame`);
      else if (r.reportedCount !== 1) failures.push(`${at}: reported ${r.reportedCount} times, not once: ${r.reported.join('; ')}`);
      if (r.thrown) failures.push(`${at}: ${r.thrown} frames threw: the failure stopped the engine`);
      if (r.drawn < base.drawn / 2) failures.push(`${at}: the frame after the failure drew ${r.drawn} scene pixels, base ${base.drawn}`);
      if (r.cleanErrors.length) failures.push(`${at}: the clean restore after it reported ${r.cleanErrors.join('; ')}`);
      if (r.buffers !== base.buffers || r.textures !== base.textures || r.kinds)
        failures.push(`${at}: ${r.buffers} buffers and ${r.textures} textures live after the clean restore, not ${base.buffers} and ${base.textures} ${JSON.stringify(r.kinds ?? '')}`);
      if (r.differ) failures.push(`${at}: the picture after the clean restore differs on ${r.differ} pixels`);
    }
    assert.deepEqual(failures, [], `restore fault sweep:\n${failures.join('\n')}`);
    console.log(
      `ok restore fault sweep: ${results.length} calls failed one at a time, each reported once with every later frame drawn, then ${base.buffers} buffers, ${base.textures} textures and the same picture after a clean restore`,
    );
  },
  () => context.close(),
);
watchExit();
