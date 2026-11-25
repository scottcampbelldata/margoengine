// Real-GPU check of SceneTargets' sun light values and look masks (KB-LOOK-SHADOWMASK1), built packages, on WebGPU and
// (MARGO_COMPAT=1) the WebGL2 layer. A flat terrain (left) and a core floor (right) under a high sun, a core box
// floating over each so both grounds carry a soft shadow, and a gltf/pbr box added as the subject. The `shadow`
// value is the sun's visibility; `penumbra`, `litGround`, `shadedGround` and `subject` are the masks headless/look
// reads. The masks must sit where the frame itself is lit and shaded, and with the Shadows plugin gone every surface
// reads visibility 1 (no shaded ground, no penumbra).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-scene-targets-shadow',
  5371,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { SceneTargets } = await import('/packages/post/dist/mrt.js'),
        { Shadows } = await import('/packages/shadows/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { loadGLTF } = await import('/packages/gltf/dist/pbr.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 11, 13], target: [0, 0, 0.5] },
        }),
        device = engine.gpu,
        errors = [];
      engine.stop();
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      engine.lighting.direction.set([0.25, 1, 0.35]);
      const terrain = Terrain.attach(engine, {
        resolution: 32,
        levels: 3,
        cellSize: 0.5,
        origin: [-12, -8],
        size: [12, 16],
        heightScale: 1,
        layers: [0, 1, 2, 3].map(() => ({ height: [-10, 10], slope: [0, 1], scale: 0.5 })),
        textures: (gpu) => {
          const heightmap = gpu.createTexture({ size: [4, 4], format: 'r32float', usage: 6 });
          gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(16), { bytesPerRow: 16 }, [4, 4]);
          const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array(16).fill(170),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap, layers };
        },
      });
      const grey = new PbrMaterial({ color: '#b0b0a8', roughness: 1 }),
        floor = engine
          .createMesh()
          .setGeometry(box(12, 0.2, 16))
          .setPosition([6, -0.1, 0])
          .setMaterial(grey),
        casters = [
          [-5, 2.2, 0],
          [5, 2.2, 0],
        ].map((position) =>
          engine
            .createMesh()
            .setGeometry(box(2, 0.4, 2))
            .setPosition(position)
            .setMaterial(grey),
        );
      const subject = await loadGLTF(engine, '/packages/exporters/tests/fixtures/Box.glb');
      subject.root.setPosition([0, 0.5, 4]);
      let shadows = Shadows.attach(engine, { resolution: 2048, bounds: { min: [-12, -1, -8], max: [12, 4, 8] } });
      const register = () => {
        shadows.add(terrain, { static: true });
        shadows.add(floor, { static: true });
        for (const caster of casters) shadows.add(caster);
        shadows.add(subject);
      };
      register();
      const targets = SceneTargets.attach(engine, {
        outputs: { sun: 'shadow', penumbra: 'penumbra', lit: 'litGround', shade: 'shadedGround', subject: 'subject' },
      });
      targets.add(terrain);
      targets.add(subject, { subject: true });
      // Each output's first channel, row by row, as numbers 0..1.
      const read = async (name) => {
        const texture = targets.texture(name),
          { width, height, format } = texture,
          size = format === 'rg16float' ? 4 : 1,
          row = Math.ceil((width * size) / 256) * 256,
          buffer = device.createBuffer({ size: row * height, usage: 1 | 8 }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const bytes = new Uint8Array(buffer.getMappedRange().slice(0)),
          out = new Float32Array(width * height),
          half = (h) => {
            const e = (h >> 10) & 31,
              m = h & 1023;
            return e === 0 ? m * 2 ** -24 : e === 31 ? Number.NaN : (1 + m / 1024) * 2 ** (e - 15) * (h >> 15 ? -1 : 1);
          };
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            out[y * width + x] =
              size === 4 ? half(bytes[y * row + x * 4] | (bytes[y * row + x * 4 + 1] << 8)) : bytes[y * row + x] / 255;
        buffer.unmap();
        buffer.destroy();
        return Array.from(out);
      };
      window.t = {
        frames: async (n) => {
          for (let i = 0; i < n; i++) engine.render({ delta: 1 / 60 });
          await device.queue.onSubmittedWorkDone();
          if (errors.length) throw new Error(errors.join('\n'));
        },
        read: async () => ({
          width: targets.texture('sun').width,
          height: targets.texture('sun').height,
          sun: await read('sun'),
          penumbra: await read('penumbra'),
          lit: await read('lit'),
          shade: await read('shade'),
          subject: await read('subject'),
        }),
        unshadow: () => {
          shadows.dispose();
          shadows = undefined;
        },
        dispose: () => {
          targets.dispose();
          shadows?.dispose();
          subject.dispose();
          engine.dispose();
        },
      };
    });
    await page.evaluate(() => window.t.frames(4));
    const frame = await shot(),
      masks = await page.evaluate(() => window.t.read());
    await page.evaluate(() => window.t.unshadow());
    await page.evaluate(() => window.t.frames(2));
    const open = await page.evaluate(() => window.t.read());
    await page.evaluate(() => window.t.dispose());
    const { width, height } = masks;
    assert.deepEqual([width, height], [frame.width, frame.height], 'the masks are the frame size');
    const luma = (i) => 0.2126 * frame.data[i * 4] + 0.7152 * frame.data[i * 4 + 1] + 0.0722 * frame.data[i * 4 + 2];
    const stats = (m, half) => {
      let n = 0,
        sun = 0,
        y = 0;
      for (let i = 0; i < width * height; i++)
        if (m[i] > 0.5 && (half === undefined || i % width < width / 2 === (half === 'left'))) {
          n++;
          sun += masks.sun[i];
          y += luma(i);
        }
      return { n, sun: sun / n, luma: y / n };
    };
    const result = {};
    for (const half of ['left', 'right'])
      result[half] = {
        lit: stats(masks.lit, half),
        shade: stats(masks.shade, half),
        penumbra: stats(masks.penumbra, half),
      };
    result.subject = stats(masks.subject);
    // The gltf box sits on the centre line, in front of the casters: low in the middle of the frame.
    let cx = 0,
      cy = 0;
    for (let i = 0; i < width * height; i++)
      if (masks.subject[i] > 0.5) {
        cx += (i % width) / result.subject.n;
        cy += Math.floor(i / width) / result.subject.n;
      }
    result.subject.centre = [cx, cy];
    result.open = {
      shade: open.shade.filter((v) => v > 0.5).length,
      penumbra: open.penumbra.filter((v) => v > 0.5).length,
      lit: open.lit.filter((v) => v > 0.5).length,
      sunMin: Math.min(...open.sun.filter((_, i) => open.lit[i] > 0.5)),
    };
    console.log(JSON.stringify(result));
    for (const half of ['left', 'right']) {
      const { lit, shade, penumbra } = result[half];
      const ground = half === 'left' ? 'terrain' : 'core floor';
      assert.ok(lit.n > 2000, `${ground}: lit ground in view (${lit.n} px)`);
      assert.ok(shade.n > 150, `${ground}: the caster's shadow is shaded ground (${shade.n} px)`);
      assert.ok(penumbra.n > 20, `${ground}: a soft edge around it (${penumbra.n} px)`);
      assert.ok(lit.sun >= 0.98 && shade.sun <= 0.02, `${ground}: visibility ${lit.sun} lit, ${shade.sun} shaded`);
      assert.ok(penumbra.sun > 0.02 && penumbra.sun < 0.98, `${ground}: penumbra visibility ${penumbra.sun}`);
      assert.ok(
        shade.luma < 0.6 * lit.luma,
        `${ground}: the frame is darker where the mask says shaded (${shade.luma} against ${lit.luma})`,
      );
    }
    assert.ok(result.subject.n > 150, `the subject mask covers the gltf box (${result.subject.n} px)`);
    assert.ok(
      Math.abs(cx - width / 2) < 20 && cy > height / 2,
      `the subject mask is where the gltf box is (${cx}, ${cy})`,
    );
    assert.equal(result.open.shade, 0, 'with no shadow plugin nothing is shaded');
    assert.equal(result.open.penumbra, 0, 'and nothing is partial');
    assert.ok(
      result.open.lit > result.left.lit.n + result.right.lit.n && result.open.sunMin === 1,
      'all ground reads visibility 1',
    );
  },
);
