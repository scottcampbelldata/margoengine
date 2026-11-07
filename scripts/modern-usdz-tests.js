import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';

const data = Array.from(await readFile('test-results/usdz-textured.usdz'));
const browser = await openBrowser({ startPath: '/examples/usdz-loader/' });
try {
  const page = browser.page,
    errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Sample loaded'));
  const result = await page.evaluate(async (data) => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { engineRuntime } = await import('/packages/core/dist/extension.js'),
      { parseUSDZ } = await import('/packages/usdz/dist/index.js'),
      { SceneTarget } = await import('/packages/shared/msaa.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:256px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 32,
        camera: { position: [1.3, 2.3, 6], target: [1.3, 2.3, 3] },
      }),
      gpu = engineRuntime(engine).gpu,
      gpuErrors = [],
      bitmaps = [],
      pixels = [];
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    const native = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async (...args) => {
      const bitmap = await native(...args);
      bitmaps.push(bitmap);
      const buffer = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = buffer.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      pixels.push(Array.from(context.getImageData(0, 0, 1, 1).data));
      return bitmap;
    };
    const color = gpu.createTexture({
        size: [256, 256],
        format: 'rgba8unorm',
        usage: 21,
      }),
      read = gpu.createBuffer({ size: 256 * 256 * 4, usage: 9 });
    let target, depth;
    engineRuntime(engine).use({
      name: 'usdz-readback',
      setup() {},
      registerPasses(graph) {
        graph.add({
          name: 'usdz-target',
          order: -1000,
          execute(context) {
            if (!target) {
              depth = gpu.createTexture({
                size: [256, 256],
                format: context.descriptor.depthStencil.format,
                usage: 20,
              });
              target = new SceneTarget(gpu, color, depth, context.descriptor.multisample.count);
            }
            target.begin(context);
          },
        });
        graph.add({
          name: 'usdz-capture',
          order: 1000000,
          execute(context) {
            target.present(context);
            context.encoder.copyTextureToBuffer({ texture: color }, { buffer: read, bytesPerRow: 1024 }, [256, 256]);
          },
        });
      },
      dispose() {
        target?.dispose();
        depth?.destroy();
        color.destroy();
        read.destroy();
      },
    });
    try {
      const asset = await parseUSDZ(new Uint8Array(data)),
        model = await asset.create(engine);
      globalThis.createImageBitmap = native;
      engine.render({ culling: false });
      await read.mapAsync(1);
      const values = new Uint8Array(read.getMappedRange());
      let green = 0,
        maxGreen = 0;
      for (let i = 0; i < values.length; i += 4) {
        maxGreen = Math.max(maxGreen, values[i + 1]);
        if (values[i + 1] > 25 && values[i + 1] > values[i] * 2 && values[i + 1] > values[i + 2] * 2) green++;
      }
      read.unmap();
      const stats = { ...engine.stats },
        bounds = Array.from(model.bounds),
        vertices = Array.from(model.primitives[0].vertices.slice(0, 20));
      model.destroy();
      return {
        green,
        maxGreen,
        stats,
        bounds,
        vertices,
        packed: pixels.at(-1),
        bitmapsClosed: bitmaps.every((bitmap) => bitmap.width === 0),
        remainingMeshes: engineRuntime(engine).meshes.size,
        gpuErrors,
      };
    } finally {
      globalThis.createImageBitmap = native;
      engine.dispose();
      canvas.remove();
    }
  }, data);
  assert.ok(result.green > 100, JSON.stringify(result));
  assert.deepEqual(result.packed, [255, 128, 192, 255]);
  assert.ok(result.bitmapsClosed);
  assert.equal(result.remainingMeshes, 0);
  assert.deepEqual(result.gpuErrors, []);
  assert.deepEqual(errors, []);
  // Exercise the example's actual file-selection path with the same synthetic archive.
  await page.locator('input[type=file]').setInputFiles('test-results/usdz-textured.usdz');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Loaded 1 meshes');
  // A real rigged file: its clip plays on the GPU, so two moments of it draw differently.
  const rigged = await page.evaluate(async (data) => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { engineRuntime } = await import('/packages/core/dist/extension.js'),
      { parseUSDZ } = await import('/packages/usdz/dist/index.js'),
      { composition } = await import('/packages/usdz/dist/compose.js'),
      { skeletons } = await import('/packages/usdz/dist/skel.js'),
      { Animation } = await import('/packages/animation/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.style.cssText = 'width:256px;height:256px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 64,
        camera: { position: [0, 0.8, 3.5], target: [0, 0.7, 0] },
      }),
      gpuErrors = [];
    engineRuntime(engine).gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    try {
      const asset = await parseUSDZ(new Uint8Array(data), { extensions: [composition(), skeletons()] }),
        model = await asset.create(engine),
        animation = Animation.attach(model);
      animation.play(asset.document.animations[0].name);
      const frame = (time) => {
        animation.seek(time);
        engine.render({ culling: false });
        return canvas.toDataURL();
      };
      const first = frame(0),
        later = frame(0.7),
        again = frame(0);
      animation.dispose?.();
      model.destroy();
      return { moved: first !== later, repeats: first === again, gpuErrors };
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, Array.from(await readFile('packages/usdz/tests/fixtures/real/rigged/RiggedFigure.usdz')));
  assert.deepEqual(rigged, { moved: true, repeats: true, gpuErrors: [] });
  // A real animated file moves on the GPU, and a stand-in stage's late prim appears through its pointer channel.
  const played = await page.evaluate(
    async ({ box, stage }) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        { parseUSDZ } = await import('/packages/usdz/dist/index.js'),
        { composition, parseUSDFiles } = await import('/packages/usdz/dist/compose.js'),
        { animation } = await import('/packages/usdz/dist/anim.js'),
        { Animation } = await import('/packages/animation/dist/index.js'),
        { pointerChannels } = await import('/packages/animation/dist/pointer.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 64,
          camera: { position: [0, 0.5, 6], target: [0, 0.5, 0] },
        }),
        gpuErrors = [];
      engineRuntime(engine).gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
      const run = async (asset, times) => {
        const model = await asset.create(engine),
          player = Animation.attach(model, { pointers: pointerChannels });
        player.play(asset.document.animations[0].name);
        const frames = times.map((time) => {
          player.seek(time);
          engine.render({ culling: false });
          return canvas.toDataURL();
        });
        const { warnings } = player;
        player.dispose?.();
        model.destroy();
        return { frames, warnings };
      };
      try {
        const real = await run(await parseUSDZ(new Uint8Array(box), { extensions: [composition(), animation()] }), [0, 1.2]),
          // Without the moving parent the late mesh is the only change between these two moments.
          late = await run(
            await parseUSDFiles('late.usda', () => new TextEncoder().encode(stage), { extensions: [animation()] }),
            [0.1, 0.6, 0.9],
          );
        return {
          moved: real.frames[0] !== real.frames[1],
          appears: late.frames[0] !== late.frames[1],
          leaves: late.frames[0] === late.frames[2],
          warnings: [...real.warnings, ...late.warnings],
          gpuErrors,
        };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    },
    {
      box: Array.from(await readFile('packages/usdz/tests/fixtures/real/animated/BoxAnimated.usdz')),
      stage: `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
    timeCodesPerSecond = 10
)
def Mesh "Late"
{
    token visibility.timeSamples = { 0: "invisible", 5: "inherited", 7: "invisible" }
    uniform token subdivisionScheme = "none"
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(-1, 0, 0), (1, 0, 0), (0, 2, 0)]
}`,
    },
  );
  assert.deepEqual(played, { moved: true, appears: true, leaves: true, warnings: [], gpuErrors: [] });
  assert.deepEqual(errors, []);
  await writeFile('test-results/modern-usdz.json', JSON.stringify({ hardware: browser.hardware, ...result }, null, 2));
  console.log('USDZ texture packing, real WebGPU pixels, bitmap teardown and file-picker demo passed');
} finally {
  await browser.close();
}
