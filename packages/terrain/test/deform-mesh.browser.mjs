// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/deform-mesh.browser.mjs
// Deformation on a ground mesh drawn by core's standard shader (`@margoengine/terrain/deform` on a `Mesh`), seen from
// straight above, alone and over `TerrainColors`:
// 1. with no print the picture is the one without deformation;
// 2. a print darkens its own pixels and changes nothing away from it, and a second mesh beside it takes no print;
// 3. a walk marks both feet's lines;
// 4. under `persist` a print the camera left far behind is there again when it comes back.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine, PbrMaterial } = await import('/packages/core/dist/index.js'),
        { TerrainColors, heightfield } = await import('/packages/terrain/dist/index.js'),
        { TerrainDeformation } = await import('/packages/terrain/dist/deform.js');
      // 2 m of ground across 200 pixels: 1 pixel a centimetre, +x right and +z down.
      const size = 200,
        errors = [],
        out = {};
      for (const colors of [false, true]) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const fov = (2 * Math.atan(1 / 4) * 180) / Math.PI,
          eye = (x) => ({ position: [x, 4, 0.001], target: [x, 0, 0], fov, near: 0.1, far: 100 }),
          engine = await Engine.create(canvas, { backend: 'webgpu', camera: eye(0) }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set([0.6, 0.6, 0.2, 2]);
        engine.lighting.radiance.set([1, 1, 1, 0.4]);
        const ground = (x) => {
          const mesh = engine
            .createMesh()
            .setGeometry(heightfield(() => 0, { size: [2, 2], resolution: 4 }))
            .setMaterial(new PbrMaterial({ color: [0.6, 0.5, 0.38], roughness: 0.9 }))
            .setPosition([x, 0, 0]);
          if (colors) TerrainColors.attach(engine, mesh, { sand: [0.6, 0.5, 0.38], shore: [80, 90], variation: 0 });
          return mesh;
        };
        const first = ground(0);
        ground(2.05);
        const read = () => {
          for (let i = 0; i < 2; i++) engine.render({ delta: 1 / 60 });
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(canvas, 0, 0);
          return c.getImageData(0, 0, size, size).data;
        };
        const luma = (a, i) => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
        // Pixels changed by over 2 levels, and the mean change, inside and outside a world-space box.
        const change = (a, b, [x0, x1, z0, z1], cx = 0) => {
          let inside = 0,
            n = 0,
            sum = 0,
            outside = 0;
          for (let py = 0; py < size; py++)
            for (let px = 0; px < size; px++) {
              const x = (px + 0.5) / 100 - 1 + cx,
                z = (py + 0.5) / 100 - 1,
                i = (py * size + px) * 4,
                d = luma(b, i) - luma(a, i);
              if (x > x0 && x < x1 && z > z0 && z < z1) {
                n++;
                sum += d;
                if (Math.abs(d) > 2) inside++;
              } else if (Math.abs(d) > 2) outside++;
            }
          return { inside, outside, mean: sum / n };
        };
        const bare = read(),
          beside = ((engine.camera.position = [2.05, 4, 0.001]), (engine.camera.target = [2.05, 0, 0]), read());
        engine.camera.position = [0, 4, 0.001];
        engine.camera.target = [0, 0, 0];
        const deformation = TerrainDeformation.attach(engine, first, {
          size: 512,
          texel: 0.01,
          depth: 0.04,
          darken: 0.35,
          persist: true,
          distance: 40,
          follow: () => [engine.camera.position[0], engine.camera.position[2]],
        });
        const r = { empty: change(bare, read(), [-9, 9, -9, 9]) };
        deformation.footprint(0, 0, { length: 0.4, width: 0.2 });
        // A print on the second mesh's ground: the deformation shades only its own mesh.
        deformation.footprint(1.6, 0, { length: 0.4, width: 0.2 });
        const printed = read();
        // The box takes the rim too, which reaches 1.65 half axes out.
        r.print = change(bare, printed, [-0.36, 0.36, -0.2, 0.2]);
        engine.camera.position = [2.05, 4, 0.001];
        engine.camera.target = [2.05, 0, 0];
        r.neighbour = change(beside, read(), [-9, 9, -9, 9], 2.05);
        engine.camera.position = [60, 4, 0.001];
        engine.camera.target = [60, 0, 0];
        read();
        engine.camera.position = [0, 4, 0.001];
        engine.camera.target = [0, 0, 0];
        r.back = change(printed, read(), [-9, 9, -9, 9]);
        deformation.clear();
        deformation.walk(
          [
            [-0.9, 0.5],
            [0.9, 0.5],
          ],
          { step: 0.45, straddle: 0.3, jitter: 0 },
        );
        const walked = read();
        r.leftLine = change(bare, walked, [-1, 1, 0.27, 0.43]);
        r.rightLine = change(bare, walked, [-1, 1, 0.57, 0.73]);
        r.away = change(bare, walked, [-1, 1, 0.2, 0.8]);
        deformation.dispose();
        r.disposed = change(bare, read(), [-9, 9, -9, 9]);
        await device.queue.onSubmittedWorkDone();
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
        engine.dispose();
        canvas.remove();
        out[colors ? 'colors' : 'plain'] = r;
      }
      return { out, errors };
    });
    console.log(hardware?.adapter ?? '', JSON.stringify(result.out));
    assert.deepEqual(result.errors, []);
    for (const [name, r] of Object.entries(result.out)) {
      assert.deepEqual([r.empty.inside, r.empty.outside], [0, 0], `${name}: no print changes nothing`);
      assert.ok(r.print.inside > 250 && r.print.mean < -3, `${name}: the print darkens ${JSON.stringify(r.print)}`);
      assert.equal(r.print.outside, 0, `${name}: nothing away from the print`);
      assert.deepEqual([r.neighbour.inside, r.neighbour.outside], [0, 0], `${name}: the other mesh takes no print`);
      assert.equal(r.back.inside + r.back.outside, 0, `${name}: a kept print returns with the camera`);
      assert.ok(r.leftLine.inside > 150 && r.rightLine.inside > 150, `${name}: both feet's lines`);
      assert.equal(r.away.outside, 0, `${name}: the walk marks only its lines`);
      assert.deepEqual([r.disposed.inside, r.disposed.outside], [0, 0], `${name}: disposed, the ground is as before`);
    }
    console.log('terrain deform mesh passed');
  },
  () => context.close(),
);
watchExit();
