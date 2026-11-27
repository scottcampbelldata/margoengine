// `npm run test:gpu:strokes` (WebGPU, then the WebGL2 layer with --compat): glTF points and lines that ask for a width
// (primitive extras `lineWidth` or `pointSize`, as @margoengine/exporters writes them, or a Bentley material style) are
// drawn that wide by parseGLTFAsync, measured in the frame: an 8 CSS px red line, a 0.2 m green world-unit line, 12 CSS
// px blue Bentley points and a 1 px reference that asks for nothing. With decoders {strokes: false} every one is 1 px,
// which is how all of them drew before 2026-11-27.
//   node scripts/run-with-timeout.mjs -- node packages/gltf/scripts/test-strokes-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const SIZE = 128,
  // Camera 4 m from the plane z = 0, vertical field of view 50 degrees: pixels a metre there.
  PER_METRE = SIZE / (2 * 4 * Math.tan((25 * Math.PI) / 180));

/** The test file: [red pixel line, green world line, blue Bentley points, white 1 px reference line]. */
function file() {
  const floats = [
      [-1.5, 0.6, 0, 1.5, 0.6, 0],
      [-0.9, -1.5, 0, -0.9, 1.5, 0],
      [0, -0.6, 0, 0.6, -0.6, 0, 1.2, -0.6, 0],
      [0.9, -1.5, 0, 0.9, 0.3, 0],
    ],
    bin = new Float32Array(floats.flat()),
    bufferViews = [],
    accessors = [];
  let offset = 0;
  for (const values of floats) {
    bufferViews.push({ buffer: 0, byteOffset: offset * 4, byteLength: values.length * 4 });
    const axis = (k) => values.filter((_, j) => j % 3 === k);
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: values.length / 3,
      type: 'VEC3',
      min: [0, 1, 2].map((k) => Math.min(...axis(k))),
      max: [0, 1, 2].map((k) => Math.max(...axis(k))),
    });
    offset += values.length;
  }
  const unlit = (c) => ({ pbrMetallicRoughness: { baseColorFactor: c }, extensions: { KHR_materials_unlit: {} } });
  const doc = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_materials_unlit', 'BENTLEY_materials_point_style'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, mode: 1, material: 0, extras: { lineWidth: 8, lineWidthUnits: 'pixels' } },
          { attributes: { POSITION: 1 }, mode: 1, material: 1, extras: { lineWidth: 0.2, lineWidthUnits: 'world' } },
          { attributes: { POSITION: 2 }, mode: 0, material: 2 },
          { attributes: { POSITION: 3 }, mode: 1, material: 3 },
        ],
      },
    ],
    materials: [
      unlit([1, 0, 0, 1]),
      unlit([0, 1, 0, 1]),
      {
        ...unlit([0, 0, 1, 1]),
        extensions: { KHR_materials_unlit: {}, BENTLEY_materials_point_style: { diameter: 12 } },
      },
      unlit([1, 1, 1, 1]),
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };
  return { doc, bin: [...new Uint8Array(bin.buffer)] };
}

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (e) => errors.push(e.message));
    const result = await browser.page.evaluate(
      async ({ fixture, SIZE }) => {
        const { Engine } = await import('/packages/core/dist/index.js'),
          { parseGLTFAsync } = await import('/packages/gltf/dist/pbr.js'),
          { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        const out = { pictures: [], widened: [], layer: !!globalThis.__margoCompat };
        for (const strokes of [undefined, false]) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = SIZE;
          canvas.style.cssText = `width:${SIZE}px;height:${SIZE}px`;
          document.body.append(canvas);
          const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            background: '#000000',
            camera: { position: [0, 0, 4], target: [0, 0, 0], fov: 50, near: 0.1, far: 20 },
          });
          engine.gpu.pushErrorScope('validation');
          try {
            const model = await parseGLTFAsync(engine, fixture.doc, [new Uint8Array(fixture.bin)], [], {
              decoders: strokes === false ? { strokes } : {},
            });
            const frame = async () => {
              engine.render();
              await engine.gpu.queue.onSubmittedWorkDone();
            };
            await waitForPipelines(frame);
            for (let i = 0; i < 3; i++) await frame();
            out.widened.push(model.pointsAndLines.map((p) => !!p.widened));
            out.pictures.push(canvas.toDataURL('image/png'));
            model.dispose();
            out.validation = (await engine.gpu.popErrorScope())?.message ?? out.validation ?? null;
          } finally {
            engine.dispose();
            canvas.remove();
          }
        }
        return out;
      },
      { fixture: file(), SIZE },
    );
    assert.deepEqual(errors, []);
    assert.equal(result.validation, null);
    assert.equal(result.layer, compatRun(), 'the page runs on the WebGL2 layer exactly when --compat is passed');
    assert.deepEqual(result.widened, [
      [true, true, true, false],
      [false, false, false, false],
    ]);
    const [wide, thin] = await Promise.all(
      result.pictures.map((p) => decodePNG(Buffer.from(p.split(',')[1], 'base64'))),
    );
    const px = (image, x, y) => [...image.data.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)];
    // Coverage of a colour along a column or row: antialiased edge pixels count by their share.
    const along = (image, channel, fixed, vertical) => {
      let sum = 0;
      for (let i = 0; i < SIZE; i++) {
        const [r, g, b] = vertical ? px(image, fixed, i) : px(image, i, fixed),
          c = [r, g, b];
        const others = Math.max(...c.filter((_, k) => k !== channel));
        sum += Math.max(0, c[channel] - others) / 255;
      }
      return sum;
    };
    const centre = (v) => Math.round(SIZE / 2 + v * PER_METRE);
    const rows = {
      red: [along(wide, 0, 40, true), along(thin, 0, 40, true), 8],
      green: [along(wide, 1, centre(-0.3), false), along(thin, 1, centre(-0.3), false), 0.2 * PER_METRE],
      // A column through the first point (a row crosses all three).
      blue: [along(wide, 2, centre(0), true), along(thin, 2, centre(0), true), 12],
    };
    const device = compatRun() ? 'webgl2-layer' : 'webgpu';
    console.log(JSON.stringify({ device, PER_METRE, rows }));
    for (const [name, [measured, before, expected]] of Object.entries(rows)) {
      assert.ok(
        Math.abs(measured - expected) <= 1.5,
        `${name}: ${measured.toFixed(2)} px drawn, ${expected.toFixed(2)} asked`,
      );
      // A 1 px point or line covers up to two pixels where it straddles a pixel edge under MSAA.
      assert.ok(before <= 2, `${name}: ${before.toFixed(2)} px with strokes false, the 1 px glTF default`);
    }
    // The reference line asks for nothing and stays 1 px in both pictures.
    const white = (image) => {
      let n = 0;
      for (let x = 0; x < SIZE; x++) if (Math.min(...px(image, x, centre(0.5))) > 60) n++;
      return n;
    };
    assert.ok(white(wide) >= 1 && white(wide) <= 2, `reference line ${white(wide)} px`);
    console.log(`glTF strokes on ${device}: lines and points draw the width the file asks for, the rest 1 px`);
  },
  () => browser.close(),
);
