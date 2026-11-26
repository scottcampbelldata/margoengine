// Real-GPU check of OccluderFade, on WebGPU and then on the WebGL2 compatibility layer. Run from the repository root
// after `npm run build:packages`:
//   node scripts/run-with-timeout.mjs -- node packages/lod/test/occluder-fade-check.mjs
//   MARGO_COMPAT=1 node packages/lod/test/occluder-fade-check.mjs   (the compatibility layer only)
// A wall between the camera and a green target hides it; with the fade the wall keeps exactly `minOpacity` of the
// pixels in front of the target and the target shows through the rest, for a core mesh, a materials mesh and an
// instanced materials mesh, with both tiles. A box beside the sight line keeps every pixel.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));

const timer = setTimeout(() => {
  console.error('lod occluder-fade-check: over its 4 minute limit');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 240_000);
try {
  for (const compat of compatRun() ? [true] : [false, true]) {
    const browser = await openBrowser({ port: 'free', compat }),
      { page } = browser,
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const leg = compat ? 'compat' : 'webgpu';
    try {
      await page.waitForFunction(() => window.modern, null, { timeout: 30000 });
      const out = await page.evaluate(async () => {
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
          { UnlitMaterial, createMesh, createInstancedMesh } = await import('/packages/materials/dist/index.js'),
          { OccluderFade } = await import('/packages/lod/dist/occluder-fade.js');
        const size = 256,
          canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.style.cssText = `width:${size}px;height:${size}px;display:block`;
        document.body.prepend(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 60 },
          }),
          gpu = [];
        engine.stop();
        engine.gpu.addEventListener('uncapturederror', (e) => gpu.push(e.error.message));
        // Red, green and blue pixels of a 32 by 32 block (four whole tiles) centred `dx` pixels right of the middle.
        const count = async (dx = 0) => {
          for (let i = 0; i < 2; i++) {
            engine.render({ delta: 0 });
            await engine.gpu.queue.onSubmittedWorkDone();
          }
          engine.render({ delta: 0 });
          const copy = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
          copy.drawImage(canvas, 0, 0);
          const d = copy.getImageData(size / 2 - 16 + dx, size / 2 - 16, 32, 32).data,
            n = { red: 0, green: 0, blue: 0 };
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > d[i + 1] + 20 && d[i] > d[i + 2] + 20) n.red++;
            else if (d[i + 1] > d[i] + 20 && d[i + 1] > d[i + 2] + 20) n.green++;
            else if (d[i + 2] > d[i] + 20 && d[i + 2] > d[i + 1] + 20) n.blue++;
          }
          return n;
        };
        const solid = (color) => new PbrMaterial({ color, roughness: 1 }),
          target = engine
            .createMesh()
            .setGeometry(box(1, 1, 1))
            .setMaterial(solid([0.02, 0.9, 0.02])),
          wall = engine
            .createMesh()
            .setGeometry(box(1.6, 1.6, 0.1))
            .setMaterial(solid([0.9, 0.02, 0.02]))
            .setPosition([0, 0, 2]),
          beside = engine
            .createMesh()
            .setGeometry(box(1, 1, 0.1))
            .setMaterial(solid([0.9, 0.02, 0.02]))
            .setPosition([1.3, 0, 2]);
        // The side box draws 96 pixels right of the middle.
        const result = { gpu, core: { hidden: await count(), besideBefore: await count(96) } };
        const fade = OccluderFade.attach(engine, { targets: [target], fadeTime: 1, minOpacity: 0.25 });
        fade.update(0.5);
        result.core.half = await count();
        fade.update(10);
        result.core.faded = await count();
        result.core.besideAfter = await count(96);
        result.core.found = fade.occluders.size === 1 && fade.occluders.has(wall) && !fade.occluders.has(beside);
        fade.targets = [];
        fade.update(10);
        result.core.back = await count();
        fade.dispose();
        // The blue-noise tile, switched at once.
        const noise = OccluderFade.attach(engine, { targets: [target], fadeTime: 0, minOpacity: 0.5, pattern: 'blue' });
        noise.update(0);
        result.blue = await count();
        noise.dispose();
        result.disposed = await count();
        wall.visible = false;
        // A materials mesh, then an instanced one with a second instance beside the line: the model route.
        const h = 0.8,
          quad = {
            positions: [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
            uvs: [0, 0, 1, 0, 1, 1, 0, 1],
            indices: [0, 1, 2, 0, 2, 3],
          },
          at = (x, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];
        const pane = createMesh(engine, quad, new UnlitMaterial({ color: [0, 0, 1] }));
        pane.root.setPosition([0, 0, 2.5]);
        result.model = { hidden: await count() };
        // Each render steps the fade; with a fadeTime of 0 the first one switches at once.
        const models = OccluderFade.attach(engine, { targets: [target], fadeTime: 0, minOpacity: 0.25 });
        result.model.faded = await count();
        result.model.found = models.occluders.size === 1 && models.opacityOf(pane) === 0.25;
        pane.root.visible = false;
        const panes = createInstancedMesh(engine, quad, new UnlitMaterial({ color: [0, 0, 1] }), 2);
        panes.instances.setMatrixAt(0, at(0, 2.5));
        panes.instances.setMatrixAt(1, at(-1.7, 2.5));
        models.enabled = false;
        result.instanced = { hidden: await count() };
        models.enabled = true;
        result.instanced.faded = await count();
        result.instanced.found = models.occluders.size;
        models.dispose();
        engine.dispose();
        return result;
      });
      console.log(leg, JSON.stringify(out));
      assert.deepEqual(out.gpu, [], `${leg}: GPU errors`);
      const all = 1024,
        red = (n) => ({ red: n, green: all - n, blue: 0 }),
        blue = (n) => ({ red: 0, green: all - n, blue: n });
      assert.deepEqual(out.core.hidden, red(all), `${leg}: the wall hides the target`);
      assert.deepEqual(
        out.core.half,
        red(640),
        `${leg}: halfway, the wall keeps 62.5% and the target shows in the rest`,
      );
      assert.deepEqual(out.core.faded, red(256), `${leg}: faded, the wall keeps minOpacity of the pixels`);
      assert.equal(out.core.found, true, `${leg}: the wall is found, the box beside the line is not`);
      assert.deepEqual(out.core.besideBefore, red(all), `${leg}: the box beside the line draws`);
      assert.deepEqual(out.core.besideAfter, red(all), `${leg}: and keeps every pixel`);
      assert.deepEqual(out.core.back, red(all), `${leg}: with no target the wall is solid again`);
      assert.deepEqual(out.blue, red(512), `${leg}: the blue-noise tile keeps half`);
      assert.deepEqual(out.disposed, red(all), `${leg}: dispose restores the wall`);
      assert.deepEqual(out.model.hidden, blue(all), `${leg}: a materials mesh hides the target`);
      assert.deepEqual(out.model.faded, blue(256), `${leg}: and fades to minOpacity`);
      assert.equal(out.model.found, true, `${leg}: the materials mesh is the occluder`);
      assert.deepEqual(out.instanced.hidden, blue(all), `${leg}: disabled, an instanced mesh hides the target`);
      assert.equal(out.instanced.found, 1, `${leg}: an instanced mesh is found through its instance`);
      assert.deepEqual(out.instanced.faded, blue(256), `${leg}: and fades`);
      assert.deepEqual(errors, [], `${leg}: page errors`);
    } finally {
      await browser.close?.();
    }
  }
} finally {
  clearTimeout(timer);
}
