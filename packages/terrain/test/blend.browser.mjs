// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/blend.browser.mjs
// Mesh to terrain blending (`@margoengine/terrain/blend`): a 2 m box half a metre into flat sandy ground, seen square
// from 6 m. The same view is drawn without and with the blend:
// 1. the seam: across the contact line the colour jump between the box pixel just above and the ground pixel just
//    below is a fraction of what it was, and the box's lowest pixels take the ground's colour;
// 2. nothing else moves: every pixel that changes lies on the box within the fade's reach (height plus half of it for
//    noise), so the box above it, the ground and the sky are the same bytes;
// 3. noise: with noise 0 the fade's top is one row across the face; with noise 1 it wanders.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { TerrainVirtualTexture } = await import('/packages/terrain/dist/rvt.js'),
        { TerrainBlend } = await import('/packages/terrain/dist/blend.js');
      const size = 160,
        n = 65,
        errors = [];
      async function picture(blend) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 0.9, -6], target: [0, 0.5, 0], near: 0.1, far: 200 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set([0.3, 0.8, -0.5, 3]);
        const terrain = Terrain.attach(engine, {
          origin: [-32, -32],
          size: [64, 64],
          heightScale: 1,
          cellSize: 0.25,
          levels: 6,
          layers: Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 1 })),
          textures: (gpu) => {
            const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 6 }),
              layers = gpu.createTexture({ size: [4, 4, 4], format: 'rgba8unorm-srgb', usage: 6 }),
              sand = new Uint8Array(64 * 4);
            gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(n * n), { bytesPerRow: n * 4 }, [n, n]);
            for (let i = 0; i < sand.length; i += 4) sand.set([176, 140, 92, 255], i);
            gpu.queue.writeTexture({ texture: layers }, sand, { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4, 4]);
            return { heightmap, layers };
          },
        });
        const rvt = TerrainVirtualTexture.attach(engine, terrain, { texel: 0.02 });
        const rock = engine
          .createMesh()
          .setGeometry(box(2, 2, 2))
          .setMaterial(new PbrMaterial({ color: '#4f6f9f', roughness: 0.5 }))
          .setPosition([0, 0.5, 0]);
        const blending = blend ? TerrainBlend.attach(engine, terrain, rvt, blend).add(rock) : undefined;
        for (let k = 0; k < 4; k++) engine.render({ delta: 1 / 60 });
        await device.queue.onSubmittedWorkDone();
        // Read in the task that drew it: the canvas texture is gone once it is presented.
        engine.render({ delta: 1 / 60 });
        const c = new OffscreenCanvas(size, size).getContext('2d');
        c.drawImage(canvas, 0, 0);
        const pixels = c.getImageData(0, 0, size, size).data;
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
        blending?.dispose();
        rvt.dispose();
        terrain.dispose();
        engine.dispose();
        canvas.remove();
        return pixels;
      }
      const plain = await picture(undefined),
        blended = await picture({ height: 0.5, noise: 0.5 }),
        ruled = await picture({ height: 0.5, noise: 0 }),
        wandering = await picture({ height: 0.5, noise: 1 });
      const at = (p, x, y) => [p[(y * size + x) * 4], p[(y * size + x) * 4 + 1], p[(y * size + x) * 4 + 2]];
      const gap = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));
      // The box is the bluest thing in view (its blue channel well above its red); the sky is above the horizon.
      const isBox = (rgb) => rgb[2] > rgb[0] + 25;
      const middle = size / 2;
      let top = -1,
        contact = -1;
      for (let y = 0; y < size; y++)
        if (isBox(at(plain, middle, y))) {
          if (top < 0) top = y;
          contact = y;
        }
      // The box's columns on its contact row in the plain picture.
      const columns = [];
      for (let x = 0; x < size; x++)
        if (isBox(at(plain, x, contact)) && isBox(at(plain, x, contact - 1))) columns.push(x);
      // Leave its side edges out: they are lit differently and cut by the ground at an angle.
      const face = columns.slice(3, -3);
      const seam = (p) => {
        let sum = 0;
        for (const x of face) sum += gap(at(p, x, contact - 1), at(p, x, contact + 2));
        return sum / face.length;
      };
      const groundBelow = (p) => {
        let sum = 0;
        for (const x of face) sum += gap(at(p, x, contact), at(plain, x, contact + 2));
        return sum / face.length;
      };
      // Rows per metre on the face: it shows from y = 1.5 m (top) to the ground at 0.
      const perMetre = (contact + 1 - top) / 1.5;
      const changed = (p) => {
        let outside = 0,
          count = 0,
          highest = size;
        const reach = Math.ceil(0.75 * perMetre) + 2;
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            if (gap(at(p, x, y), at(plain, x, y)) === 0) continue;
            count++;
            highest = Math.min(highest, y);
            if (
              !(columns.includes(x) || columns.includes(x - 1) || columns.includes(x + 1)) ||
              y < contact - reach ||
              y > contact + 1
            )
              outside++;
          }
        return { count, outside, highest };
      };
      // Per face column, the highest row that changed: one row for a straight fade, spread for a noisy one.
      const spread = (p) => {
        const rows = face.map((x) => {
          for (let y = top; y <= contact; y++) if (gap(at(p, x, y), at(plain, x, y)) > 1) return y;
          return contact;
        });
        return Math.max(...rows) - Math.min(...rows);
      };
      return {
        errors,
        top,
        contact,
        perMetre,
        columns: columns.length,
        seam: { plain: seam(plain), blended: seam(blended), ruled: seam(ruled) },
        lowest: { plain: groundBelow(plain), blended: groundBelow(blended) },
        changed: { blended: changed(blended), ruled: changed(ruled), wandering: changed(wandering) },
        spread: { ruled: spread(ruled), wandering: spread(wandering) },
      };
    });
    console.log('terrain blend:', JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    const r = result;
    assert.ok(r.columns > 30 && r.contact - r.top > 20, `the box fills the middle of the view: ${JSON.stringify(r)}`);
    assert.ok(r.seam.plain > 40, `without the blend the contact is a hard line: ${r.seam.plain}`);
    assert.ok(r.seam.blended < r.seam.plain / 4, `the blend softens the seam: ${JSON.stringify(r.seam)}`);
    assert.ok(r.seam.ruled < r.seam.plain / 4, `also without noise: ${JSON.stringify(r.seam)}`);
    assert.ok(
      r.lowest.blended < r.lowest.plain / 4,
      `the box's lowest row takes the ground colour: ${JSON.stringify(r.lowest)}`,
    );
    for (const [name, c] of Object.entries(r.changed)) {
      assert.ok(c.count > 100, `${name}: the blend changes the box's foot: ${JSON.stringify(c)}`);
      assert.equal(c.outside, 0, `${name}: nothing outside the box's foot changes: ${JSON.stringify(c)}`);
    }
    assert.ok(r.spread.ruled <= 1, `noise 0: the fade's top is one row across the face: ${r.spread.ruled}`);
    assert.ok(r.spread.wandering >= 3, `noise 1: the fade's top wanders: ${r.spread.wandering}`);
    await writeFile('test-results/terrain-blend.json', JSON.stringify({ hardware, result }, null, 1));
    console.log('ok terrain blend');
  },
  () => context.close(),
);
watchExit();
