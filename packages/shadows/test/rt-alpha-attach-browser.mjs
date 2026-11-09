// Real complete Khronos cutout model, public Shadows.attach, receiver pixels and CPU rays.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll, runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ port: 'free', compat: false });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
await runSuite(async () => {
  await browser.page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { MeshBVH, Raycaster } = await import('/packages/bvh/dist/index.js');
    const { AlphaRaycaster, modelAlphaMasks } = await import('/packages/bvh/dist/alpha.js');
    const { alphaWorldTriangles } = await import('/packages/bvh/dist/alpha-triangles.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const { rayTracedFilter } = await import('/packages/shadows/dist/rt.js');
    const { packRayTracedAlpha, alphaRayTracedFilter } = await import('/packages/shadows/dist/rt-alpha.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 192;
    canvas.style.cssText = 'width:256px;height:192px';
    document.body.replaceChildren(canvas);
    // The camera looks at the receiver from between it and the complete caster.
    // Thus every visible pixel is receiver geometry; no caster hides its shadow.
    // RT far=7.1 reaches the foreground panels but ends before the opaque backboard.
    // The map fallback has no RT distance cutoff and uses the full-distance oracle.
    const engine = await Engine.create(canvas, {
      backend: 'webgpu', capacity: 1024,
      camera: { position: [0, 1.35, 5], target: [0, 1.35, 7], fov: 100, near: 0.01, far: 30 },
    });
    const device = engine.gpu, validation = [];
    device.addEventListener('uncapturederror', (e) => validation.push(e.error.message));
    const model = await loadGLTF(engine, '/examples/assets/khronos/AlphaBlendModeTest/AlphaBlendModeTest.glb');
    const receiver = engine.createMesh().setGeometry(box(8, 6, 0.1)).setPosition([0, 1.35, 7.05]);
    engine.lighting.direction.set([0, 0, -1]);
    engine.lighting.radiance.set([3, 3, 3, 0]);
    const original = model.primitives.map((p) => p.material.maps[0]?.extensions);
    let shadows, bvh, packed;
    const frame = async () => { engine.render(); await device.queue.onSubmittedWorkDone(); };
    const dispose = () => { shadows?.dispose(); shadows = undefined; };
    window.rtAlphaScene = {
      async prepare(rotated) {
        dispose();
        model.primitives.forEach((p, i) => {
          const map = p.material.maps[0];
          if (p.material.settings[0] === 1 && map) map.extensions = rotated
            ? { KHR_texture_transform: { offset: [0.75, 0.25], rotation: Math.PI / 2, scale: [0.75, 0.5] } }
            : original[i];
        });
        const masks = await modelAlphaMasks(model);
        if (masks.skipped.length) throw new Error('Unread real-model masks');
        const triangles = alphaWorldTriangles(engine, [model]);
        bvh = MeshBVH.build({ positions: triangles.vertices, indices: triangles.indices });
        packed = packRayTracedAlpha(triangles, masks);
        const alpha = new AlphaRaycaster(); alpha.alphaMask = masks; alpha.firstHitOnly = true;
        const opaque = new Raycaster(); opaque.firstHitOnly = true;
        const samples = [];
        // Four corners plus centre exclude MSAA silhouette/cutoff mixtures, without
        // looking at rendered output or relaxing either visibility threshold.
        for (let y = 2; y < canvas.height - 2; y += 2) for (let x = 2; x < canvas.width - 2; x += 2) {
          const coverage = [], solid = [], full = [];
          for (const [dx, dy] of [[0,0],[-0.5,-0.5],[0.5,-0.5],[-0.5,0.5],[0.5,0.5]]) {
            const t = 2 * Math.tan(100 * Math.PI / 360);
            const origin = [-(2 * (x + 0.5 + dx) / canvas.width - 1) * t * canvas.width / canvas.height,
              1.35 + (1 - 2 * (y + 0.5 + dy) / canvas.height) * t, 7 - 0.001];
            alpha.far = opaque.far = 7.1;
            coverage.push(!!alpha.set(origin, [0,0,-1]).intersectObjects(engine, [model])[0]);
            alpha.far = 100;
            full.push(!!alpha.set(origin, [0,0,-1]).intersectObjects(engine, [model])[0]);
            solid.push(!!opaque.set(origin, [0,0,-1]).intersectObjects(engine, [model])[0]);
          }
          if (coverage.every((v) => v === coverage[0]) && solid.every((v) => v === solid[0]) && full.every((v) => v === full[0]))
            samples.push({ x, y, alpha: coverage[0], opaque: solid[0], full: full[0] });
        }
        return { samples, faces: bvh.triangleCount };
      },
      async show(mode) {
        if (mode === 'restored') shadows.onDeviceRestored(engineRuntime(engine));
        else {
          dispose();
          if (mode !== 'open' && mode !== 'dark') {
            const options = { rays: 1, lightSize: 0, bias: 0.001, far: 7.1, fallback: 'hard' };
            const filter = mode === 'opaque' ? rayTracedFilter(engine, bvh, options)
              : alphaRayTracedFilter(mode === 'fallback' ? { gpu: null } : engine, bvh, packed, options);
            if (mode !== 'fallback' && typeof filter !== 'object') throw new Error('RT requires fragment storage');
            if (mode === 'fallback' && filter !== 'hard') throw new Error('Missing map fallback');
            shadows = Shadows.attach(engine, {
              filter, resolution: 2048, bias: 0, normalBias: 0,
              bounds: { min: [-4,-2,-2], max: [4,5,8] },
            });
            shadows.add(model); shadows.add(receiver, { castShadow: false });
          }
        }
        engine.lighting.radiance.set(mode === 'dark' ? [0,0,0,0] : [3,3,3,0]);
        device.pushErrorScope('validation');
        await waitForPipelines(frame);
        const error = await device.popErrorScope();
        if (error) validation.push(error.message);
        if (validation.length) throw new Error(validation.join('\n'));
      },
      dispose() { dispose(); receiver.dispose(); model.dispose(); engine.dispose(); },
    };
  });
  const linear = (v) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const shot = async (mode, rotated) => {
    await browser.page.evaluate((mode) => window.rtAlphaScene.show(mode), mode);
    return decodePNG(await browser.page.locator('canvas').screenshot({ path: `test-results/shadows-rt-alpha-${rotated}-${mode}.png` }));
  };
  const rows = [];
  try {
    for (const rotated of [false, true]) {
      const { samples, faces } = await browser.page.evaluate((r) => window.rtAlphaScene.prepare(r), rotated);
      const open = await shot('open', rotated), dark = await shot('dark', rotated);
      const holes = samples.filter((s) => !s.alpha && s.opaque).length;
      const solid = samples.filter((s) => s.alpha).length;
      assert.ok(holes > 20 && solid > 20, `real coverage ${holes}/${solid}`);
      for (const mode of ['opaque', 'alpha', 'restored', 'fallback']) {
        const image = await shot(mode, rotated);
        let lit = 0, shaded = 0;
        const failures = [];
        for (const s of samples) {
          const at = (s.y * image.width + s.x) * 4;
          const sunlight = linear(open.data[at]) - linear(dark.data[at]);
          assert.ok(sunlight > 0.1, `receiver unlit at ${s.x}/${s.y}`);
          const visibility = (linear(image.data[at]) - linear(dark.data[at])) / sunlight;
          const shadowed = mode === 'opaque' ? s.opaque : mode === 'fallback' ? s.full : s.alpha;
          if (shadowed) shaded++; else lit++;
          if (shadowed ? visibility > 0.05 : visibility < 0.95) failures.push({ ...s, visibility });
        }
        assert.deepEqual(failures.slice(0,10), [], `${rotated}/${mode}: ${failures.length} incorrect receiver pixels`);
        rows.push({ rotated, mode, faces, holes, solid, lit, shaded });
      }
    }
    assert.deepEqual(errors, []);
    writeFileSync('test-results/shadows-rt-alpha-attach.json', JSON.stringify(rows, null, 2));
    console.log(JSON.stringify(rows));
  } finally { await browser.page.evaluate(() => window.rtAlphaScene.dispose()); }
}, async () => {
  try { await closeAll({ browser }); } finally { watchExit(); }
});
