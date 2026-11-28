// Real-GPU check that DOF keeps valid premultiplied alpha on a transparent canvas (parity row 6), built
// packages, on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/dof/tests/gpu/alpha-check.mjs
// Two boxes over a transparent canvas, one or both out of focus, read from DOF's linear outputTexture for the full and
// half resolution gathers and lens shapes. Alpha: both boxes unlit in one colour k, so every covered input pixel holds
// (k, 1) times its coverage and every empty one 0 (T. Porter and T. Duff, "Compositing Digital Images", SIGGRAPH 1984).
// Each step of the gather, its max(behind - near, 0) included, scales with k, so every output pixel must hold k times
// its alpha. Colour: with lit boxes, the transparent canvas must hold the colour of the same blur over black. Before the
// fix the output kept the sharp pixel's alpha.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../../post/test/post-browser.mjs';

await postBrowser(
  'dof-alpha',
  5397,
  () => launchBrowser({ headless: true }),
  async (page) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { TransparentCanvas, ColorBackground } = await import('/packages/environment/dist/index.js'),
        { DOF } = await import('/packages/dof/dist/index.js'),
        { DOFLens } = await import('/packages/dof/dist/lens.js'),
        { UnlitMaterial, createMesh } = await import('/packages/materials/dist/index.js'),
        { boxGeometry } = await import('/packages/geometry/dist/index.js');
      const half = (h) => {
        const e = (h >> 10) & 31,
          m = h & 1023,
          v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15);
        return h & 0x8000 ? -v : v;
      };
      const ring = { width: 8, height: 8, data: new Uint8Array(256).fill(255) };
      for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) ring.data.fill(0, (y * 8 + x) * 4, (y * 8 + x) * 4 + 4);
      const lenses = {
        none: undefined,
        blades: () => new DOFLens({ blades: 6 }),
        optics: () => new DOFLens({ anamorphic: 2, catEye: 0.8 }),
        aperture: () => new DOFLens({ aperture: ring }),
      };
      // The blurred linear image over `background`: null for a transparent canvas, else a colour. `late` makes the
      // canvas transparent after DOF has attached; `flat` draws both boxes unlit in one colour.
      window.t = async ({ background, focus, temporal, lens, late, flat }) => {
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
          });
        engine.stop();
        const behind = () =>
          background === null
            ? TransparentCanvas.attach(engine)
            : ColorBackground.attach(engine, { color: background });
        if (!late) behind();
        // `values` turned about the view axis and moved to `at`.
        const placed = (values, at) => {
          const out = Float32Array.from(values),
            [c, d] = [Math.cos(Math.PI / 5), Math.sin(Math.PI / 5)];
          for (let i = 0; i < out.length; i += 3) {
            const [x, y] = [out[i], out[i + 1]];
            out[i] = c * x - d * y + at[0];
            out[i + 1] = d * x + c * y + at[1];
            out[i + 2] += at[2];
          }
          return out;
        };
        for (const [size, position, color] of [
          [0.8, [0.35, 0, 0.3], '#e0a050'],
          [0.7, [-0.9, 0.3, -2], '#50a0e0'],
        ]) {
          if (flat) {
            const shape = boxGeometry(size, size, size);
            createMesh(
              engine,
              {
                ...shape,
                positions: placed(shape.positions, position),
                normals: placed(shape.normals, [0, 0, 0]),
              },
              new UnlitMaterial({ color: [0.6, 0.35, 0.15] }),
            );
          } else
            engine
              .createMesh()
              .setGeometry(box(size, size, size))
              .setMaterial(new PbrMaterial({ color, roughness: 1 }))
              .setPosition(position)
              .setQuaternion([0, 0, Math.sin(Math.PI / 10), Math.cos(Math.PI / 10)]);
        }
        const dof = DOF.attach(engine, {
          focalDistance: focus,
          aperture: 0.1,
          temporal,
          lens: lenses[lens]?.(),
        });
        await dof.ready;
        if (late) behind();
        engine.render({ delta: 1 / 60 });
        await dof.ready;
        engine.render({ delta: 1 / 60 });
        const texture = dof.outputTexture,
          device = engine.gpu,
          stride = Math.ceil((texture.width * 8) / 256) * 256,
          buffer = device.createBuffer({
            size: stride * texture.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [texture.width, texture.height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const words = new Uint16Array(buffer.getMappedRange()),
          out = [];
        for (let y = 0; y < texture.height; y++)
          for (let x = 0; x < texture.width; x++)
            for (let c = 0; c < 4; c++) out.push(half(words[(y * stride) / 2 + x * 4 + c]));
        buffer.destroy();
        engine.dispose();
        return out;
      };
    });
    const cases = [
      { name: 'far blur', focus: 2.5 },
      { name: 'near blur', focus: 8 },
      { name: 'canvas made transparent after attach', focus: 8, late: true },
      { name: 'temporal far', focus: 2.5, temporal: true },
      { name: 'temporal near', focus: 8, temporal: true },
      { name: 'blades', focus: 8, lens: 'blades' },
      { name: 'cat-eye anamorphic', focus: 2.5, lens: 'optics' },
      { name: 'aperture image', focus: 8, lens: 'aperture' },
    ];
    for (const c of cases) {
      const draw = (background, flat) =>
        page.evaluate((o) => window.t(o), {
          lens: 'none',
          ...c,
          background,
          flat,
        });
      const clear = await draw(null, false),
        black = await draw('#000000', false),
        flat = await draw(null, true);
      // k, from the most opaque pixel.
      let at = 0;
      for (let i = 0; i < flat.length; i += 4) if (flat[i + 3] > flat[at + 3]) at = i;
      const k = [0, 1, 2].map((j) => flat[at + j] / flat[at + 3]);
      let partial = 0,
        empty = 0,
        colour = 0,
        alpha = 0;
      for (let i = 0; i < clear.length; i += 4) {
        const a = flat[i + 3];
        if (a > 0.05 && a < 0.95) partial++;
        if (a < 0.001) empty++;
        for (let j = 0; j < 3; j++) {
          colour = Math.max(colour, Math.abs(clear[i + j] - black[i + j]));
          alpha = Math.max(alpha, Math.abs(flat[i + j] - k[j] * a));
        }
      }
      assert.ok(k[0] > 0.1 && flat[at + 3] > 0.99, `${c.name}: flat colour ${k} at alpha ${flat[at + 3]}`);
      assert.ok(partial > 300 && empty > 10000, `${c.name}: ${partial} partly covered, ${empty} empty pixels`);
      assert.ok(colour <= 0.001, `${c.name}: colour ${colour} from the blur over black`);
      // The gathers store half floats, so k and 1 round apart, and a pixel that sees little past a near edge divides by a
      // small weight; a defect would show as tenths. The bound is one 8-bit step.
      assert.ok(alpha <= 1 / 255, `${c.name}: a pixel is ${alpha} from its alpha times the flat colour`);
      console.log(
        `ok ${c.name}: ${partial} partly covered pixels, colour within ${colour.toFixed(4)}, colour over alpha within ${alpha.toFixed(4)}`,
      );
    }
  },
  { seconds: 400 },
);
