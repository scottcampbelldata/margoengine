import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from './browser.js';

const data = Array.from(await readFile('test-results/usdz-textured.usdz'));
const browser = await openBrowser({ startPath: '/examples/usdz-loader/', port: 'free' });
try {
  const page = browser.page,
    errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const scatter = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { parseUSDA } = await import('/packages/usdz/dist/index.js');
    const { pointInstancers } = await import('/packages/usdz/dist/instancer.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      capacity: 32,
      camera: { position: [0, 0, 6], target: [0, 0, 0] },
    });
    try {
      const asset = parseUSDA(
        `#usda 1.0
(metersPerUnit = 1 upAxis = "Y")
def PointInstancer "Scatter" {
 rel prototypes = </Scatter/Prop>
 int[] protoIndices = [0,0]
 point3f[] positions = [(-1,0,0),(1,0,0)]
 def Mesh "Prop" {
  uniform token subdivisionScheme = "none"
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0,1,2]
  point3f[] points = [(-0.5,-0.5,0),(0.5,-0.5,0),(0,0.5,0)]
 }
}`,
        { extensions: [pointInstancers()] },
      );
      const model = await asset.create(engine);
      engine.render({ culling: false });
      const image = canvas.toDataURL();
      model.destroy();
      engine.render({ culling: false });
      return {
        sharedMeshes: asset.document.meshes.length,
        instances: asset.document.nodes.filter((n) => n.extras?.usdInstanceId !== undefined).length,
        changed: image !== canvas.toDataURL(),
      };
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });
  assert.deepEqual(scatter, { sharedMeshes: 1, instances: 2, changed: true });
  const previewBytes = Array.from((await import('../packages/usdz/tests/preview-fixture.js')).previewFixture());
  const previewResult = await page.evaluate(async (bytes) => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { parseUSDZ } = await import('/packages/usdz/dist/index.js');
    const { parseUSDInWorker } = await import('/packages/usdz/dist/worker.js');
    const { previewSurface } = await import('/packages/usdz/dist/preview-surface.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0, 5], target: [0, 0, 0] },
    });
    try {
      const results = [];
      for (const worker of [false, true]) {
        const options = { extensions: [previewSurface()] },
          input = new Uint8Array(bytes);
        const model = worker
          ? await parseUSDInWorker(engine, input, options)
          : await (await parseUSDZ(input, options)).create(engine);
        engine.render({ culling: false });
        await engineRuntime(engine).gpu.queue.onSubmittedWorkDone();
        const rendered = canvas.toDataURL();
        const bitmap = model.image(0),
          c = new OffscreenCanvas(1, 1),
          ctx = c.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const alpha = ctx.getImageData(0, 0, 1, 1).data[3];
        const material = model.primitives[0].material;
        results.push({ alpha, shader: !!material.shading, maskUV: material.pickMask.texCoord, rendered });
        model.destroy();
        engine.render({ culling: false });
        await engineRuntime(engine).gpu.queue.onSubmittedWorkDone();
        results[results.length - 1].changed = rendered !== canvas.toDataURL();
        results[results.length - 1].disposed = !engine.plugins.has('usd-preview-opacity-0');
      }
      return results;
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, previewBytes);
  for (const r of previewResult) {
    assert.equal(r.alpha, 128);
    assert.equal(r.shader, true);
    assert.equal(r.maskUV, 1);
    assert.equal(r.changed, true);
    assert.equal(r.disposed, true);
  }
  assert.equal(previewResult[0].rendered, previewResult[1].rendered);
  const readerText = (await import('../packages/usdz/tests/preview-fixture.js')).previewReaderFixture();
  const readerResult = await page.evaluate(async (text) => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { parseUSDA } = await import('/packages/usdz/dist/index.js'),
      { previewSurface } = await import('/packages/usdz/dist/preview-surface.js');
    const { parseUSDInWorker } = await import('/packages/usdz/dist/worker.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0, 5], target: [0, 0, 0] },
    });
    try {
      const outcomes = [];
      for (const worker of [false, true]) {
        const options = { extensions: [previewSurface()] };
        const model = worker
          ? await parseUSDInWorker(engine, text, options)
          : await parseUSDA(text, options).create(engine);
        engine.render({ culling: false });
        await engineRuntime(engine).gpu.queue.onSubmittedWorkDone();
        const rendered = canvas.toDataURL();
        const count = model.primitives[0].definition.extras.usdPreviewValues.inputs.length;
        model.destroy();
        engine.render({ culling: false });
        await engineRuntime(engine).gpu.queue.onSubmittedWorkDone();
        outcomes.push({ count, changed: rendered !== canvas.toDataURL(), rendered });
      }
      return outcomes;
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, readerText);
  for (const result of readerResult) {
    assert.equal(result.count, 11);
    assert.equal(result.changed, true);
  }
  assert.equal(readerResult[0].rendered, readerResult[1].rendered);
  const curvesResult = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { parseUSDA } = await import('/packages/usdz/dist/index.js');
    const { curves } = await import('/packages/usdz/dist/curves.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { parseUSDInWorker } = await import('/packages/usdz/dist/worker.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0, 5], target: [0, 0, 0] },
    });
    const text =
      '#usda 1.0\n(metersPerUnit=1 upAxis="Y")\ndef BasisCurves "C" { token type="linear" int[] curveVertexCounts=[2] point3f[] points=[(-1,0,0),(1,0,0)] float[] widths=[0.1,0.6] color3f[] primvars:displayColor=[(1,0,0)] } def Points "P" { point3f[] points=[(0,1,0)] float[] widths=[0.5] color3f[] primvars:displayColor=[(0,1,0)] }';
    try {
      const outcomes = [];
      for (const worker of [false, true]) {
        const options = { extensions: [curves()] };
        const model = worker
          ? await parseUSDInWorker(engine, text, options)
          : await parseUSDA(text, options).create(engine);
        engine.render({ culling: false });
        await engineRuntime(engine).gpu.queue.onSubmittedWorkDone();
        const image = canvas.toDataURL();
        const lines = engine.plugins.get('usd-curves-lines-0'),
          points = engine.plugins.get('usd-curves-points-0');
        outcomes.push({
          lines: lines.lines.size,
          widths: Array.from([...lines.lines][0].widths),
          clouds: !!points,
        });
        model.destroy();
        engine.render({ culling: false });
        await engineRuntime(engine).gpu.queue.onSubmittedWorkDone();
        outcomes[outcomes.length - 1].changed = image !== canvas.toDataURL();
        outcomes[outcomes.length - 1].disposed =
          !engine.plugins.has('usd-curves-lines-0') && !engine.plugins.has('usd-curves-points-0');
      }
      return outcomes;
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });
  for (const result of curvesResult) {
    assert.equal(result.lines, 1);
    assert.equal(result.clouds, true);
    assert.equal(result.changed, true);
    assert.equal(result.disposed, true);
    assert.ok(Math.abs(result.widths[0] - 0.1) < 1e-6 && Math.abs(result.widths[1] - 0.6) < 1e-6);
  }
  const shapes = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { parseUSDA } = await import('/packages/usdz/dist/index.js');
    const { implicitShapes } = await import('/packages/usdz/dist/shapes.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [7, 5, 10], target: [0, 0, 0] },
    });
    try {
      const body = ['Cube', 'Sphere', 'Cylinder', 'Capsule', 'Cone']
        .map(
          (type, i) =>
            `def ${type} "S${i}" { double3 xformOp:translate = (${(i - 2) * 2.5},0,0) uniform token[] xformOpOrder = ["xformOp:translate"] }`,
        )
        .join('\n');
      const asset = parseUSDA('#usda 1.0\n(metersPerUnit=1 upAxis="Y")\n' + body, { extensions: [implicitShapes()] });
      const model = await asset.create(engine);
      engine.render({ culling: false });
      const image = canvas.toDataURL();
      model.destroy();
      engine.render({ culling: false });
      return { count: asset.meshes.length, changed: image !== canvas.toDataURL() };
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });
  assert.deepEqual(shapes, { count: 5, changed: true });
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
  const rigged = await page.evaluate(
    async (data) => {
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
        const frame = async (time) => {
          animation.seek(time);
          engine.render({ culling: false });
          await engineRuntime(engine).gpu.queue.onSubmittedWorkDone();
          return canvas.toDataURL();
        };
        const first = await frame(0),
          later = await frame(0.7),
          again = await frame(0);
        animation.dispose?.();
        model.destroy();
        return { moved: first !== later, repeats: first === again, gpuErrors };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    },
    Array.from(await readFile('packages/usdz/tests/fixtures/real/rigged/RiggedFigure.usdz')),
  );
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
        const real = await run(
            await parseUSDZ(new Uint8Array(box), { extensions: [composition(), animation()] }),
            [0, 1.2],
          ),
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
  // A real subdivided mesh draws refined on the GPU, and refining changes what it draws.
  const refined = await page.evaluate(
    async (stage) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        { parseUSDFiles } = await import('/packages/usdz/dist/compose.js'),
        { subdivision } = await import('/packages/usdz/dist/subdiv.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 64,
          camera: { position: [3, 3, 4], target: [0, 0, 0] },
        }),
        gpuErrors = [];
      engineRuntime(engine).gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
      const frame = async (extensions) => {
        const asset = await parseUSDFiles(
            'stage.usda',
            () => new TextEncoder().encode(stage.replace('metersPerUnit = 0.01', 'metersPerUnit = 1')),
            { extensions },
          ),
          model = await asset.create(engine);
        engine.render({ culling: false });
        const image = canvas.toDataURL();
        model.destroy();
        return image;
      };
      try {
        const cage = await frame([]),
          smooth = await frame([subdivision({ level: 3 })]);
        return { differs: cage !== smooth, gpuErrors };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    },
    await readFile(
      'packages/usdz/tests/fixtures/real/usd-wg/test_assets/schemaTests/usdGeom/meshes/subdiv_catmullClark/subdiv_catmullClark.usda',
      'utf8',
    ),
  );
  assert.deepEqual(refined, { differs: true, gpuErrors: [] });
  // A lit stage draws lit: its sun moves the engine's light, its camera moves the view, and both change the picture.
  const lit = await page.evaluate(
    async (stage) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        { parseUSDFiles } = await import('/packages/usdz/dist/compose.js'),
        { lights } = await import('/packages/usdz/dist/lux.js'),
        { applyGLTFLights, viewGLTFCamera } = await import('/packages/gltf-pro/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 64,
          camera: { position: [1.5, 1.5, 3], target: [0, 0, 0] },
        }),
        gpuErrors = [];
      engineRuntime(engine).gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
      try {
        const asset = await parseUSDFiles('stage.usda', () => new TextEncoder().encode(stage), {
            extensions: [lights()],
          }),
          model = await asset.create(engine),
          frame = () => {
            engine.render({ culling: false });
            return canvas.toDataURL();
          },
          plain = frame();
        applyGLTFLights(model);
        const sunlit = frame();
        viewGLTFCamera(model, 0);
        const seen = frame();
        model.destroy();
        return { sun: plain !== sunlit, camera: sunlit !== seen, gpuErrors };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    },
    `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)
def Mesh "M"
{
    uniform token subdivisionScheme = "none"
    int[] faceVertexCounts = [4]
    int[] faceVertexIndices = [0, 1, 2, 3]
    point3f[] points = [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)]
}
def DistantLight "Sun"
{
    double3 xformOp:rotateXYZ = (-30, 40, 0)
    uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]
    color3f inputs:color = (1, 0.4, 0.2)
}
def Camera "Shot"
{
    double3 xformOp:translate = (0.5, 0, 4)
    uniform token[] xformOpOrder = ["xformOp:translate"]
}`,
  );
  assert.deepEqual(lit, { sun: true, camera: true, gpuErrors: [] });
  // Every material of the real .mtlx files compiles as a node material on the GPU, and changes the picture. Their images
  // are not stored here, so one small picture stands in for each.
  const documents = [];
  const walk = async (folder) => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const at = join(folder, item.name);
      if (item.isDirectory()) await walk(at);
      else if (item.name.endsWith('.mtlx')) documents.push({ name: item.name, text: await readFile(at, 'utf8') });
    }
  };
  await walk('packages/usdz/tests/fixtures/real/usd-wg');
  const networks = await page.evaluate(async (documents) => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { engineRuntime } = await import('/packages/core/dist/extension.js'),
      { parseUSDFiles } = await import('/packages/usdz/dist/compose.js'),
      { materialX, materialGraph } = await import('/packages/usdz/dist/materialx.js'),
      { installNodeMaterial } = await import('/packages/materials/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    canvas.style.cssText = 'width:128px;height:128px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 64,
        camera: { position: [0, 0, 3], target: [0, 0, 0] },
      }),
      gpu = engineRuntime(engine).gpu,
      gpuErrors = [];
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    const paint = new OffscreenCanvas(2, 2),
      brush = paint.getContext('2d');
    brush.fillStyle = 'rgb(128, 128, 128)';
    brush.fillRect(0, 0, 2, 2);
    const png = new Uint8Array(await (await paint.convertToBlob({ type: 'image/png' })).arrayBuffer()),
      map = gpu.createTexture({
        size: [2, 2],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    gpu.queue.writeTexture({ texture: map }, new Uint8Array(16).fill(200), { bytesPerRow: 8 }, [2, 2]);
    const stage = (file, material) => `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)
def Scope "MaterialX" (references = @./${file}@</MaterialX>) {}
def Mesh "M" (prepend apiSchemas = ["MaterialBindingAPI"])
{
    rel material:binding = </MaterialX/Materials/${material}>
    uniform token subdivisionScheme = "none"
    int[] faceVertexCounts = [4]
    int[] faceVertexIndices = [0, 1, 2, 3]
    point3f[] points = [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)]
    texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (interpolation = "vertex")
}`;
    let compiled = 0,
      changed = 0;
    const refused = [],
      skipped = [],
      unchanged = [];
    try {
      for (const { name, text } of documents)
        for (const [, material] of text.matchAll(/<surfacematerial\s+name="([^"]+)"/g)) {
          const reader = (id) =>
              id === 'stage.usda'
                ? new TextEncoder().encode(stage(name, material))
                : id.endsWith('.mtlx')
                  ? new TextEncoder().encode(text)
                  : png,
            asset = await parseUSDFiles('stage.usda', reader, { extensions: [materialX()] }),
            model = await asset.create(engine),
            frame = () => {
              engine.render({ culling: false });
              return canvas.toDataURL();
            };
          try {
            const before = frame(),
              network = await materialGraph(asset, '/MaterialX/Materials/' + material, {
                texture: () => ({ view: map.createView() }),
              });
            if (!network) throw new Error('no network');
            for (const item of network.skipped) skipped.push(item.input);
            using installed = installNodeMaterial(model, network.graph);
            await gpu.queue.onSubmittedWorkDone();
            compiled++;
            if (frame() !== before) changed++;
            else if (network.graph.nodes.some((node) => node.type === 'texture')) unchanged.push(material);
          } catch (error) {
            refused.push(name + ' ' + material + ': ' + String(error.message ?? error).slice(0, 120));
          }
          model.destroy();
        }
      // A base colour image that says it is linear reaches glTF's sRGB slot encoded: 128 of 255 linear is 188.
      const stored = await parseUSDFiles(
          'stage.usda',
          (id) =>
            id === 'stage.usda'
              ? new TextEncoder().encode(`#usda 1.0
def Material "Look"
{
    token outputs:mtlx:surface.connect = </Look/S.outputs:surface>
    def Shader "S"
    {
        uniform token info:id = "ND_standard_surface_surfaceshader"
        color3f inputs:base_color.connect = </Look/Map.outputs:out>
        token outputs:surface
    }
    def Shader "Map"
    {
        uniform token info:id = "ND_image_color3"
        asset inputs:file = @map.png@ (colorSpace = "lin_rec709")
        color3f outputs:out
    }
}
def Mesh "M" (prepend apiSchemas = ["MaterialBindingAPI"])
{
    rel material:binding = </Look>
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
}`)
              : png,
          { extensions: [materialX()] },
        ),
        [picture] = await stored.images(),
        reading = new OffscreenCanvas(picture.width, picture.height).getContext('2d');
      reading.drawImage(picture, 0, 0);
      const encodedValue = reading.getImageData(0, 0, 1, 1).data[0];
      picture.close();
      map.destroy();
      return { compiled, changed, refused, unchanged, skipped: [...new Set(skipped)], encodedValue, gpuErrors };
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, documents);
  console.log('MaterialX networks', JSON.stringify(networks));
  assert.deepEqual(networks.gpuErrors, []);
  assert.equal(networks.encodedValue, 188);
  // surface_unlit has no node material yet (docs/limits.md); it still opens as an unlit glTF material.
  assert.deepEqual(
    networks.refused.map((line) => line.split(': ').at(-1)),
    ['surface shader surface_unlit is not converted'],
  );
  assert.equal(networks.compiled, 30);
  // A network of constants may draw as its PBR material does; one with images must not.
  assert.deepEqual(networks.unchanged, []);
  assert.ok(networks.changed > 0);
  assert.deepEqual(errors, []);
  await writeFile('test-results/modern-usdz.json', JSON.stringify({ hardware: browser.hardware, ...result }, null, 2));
  console.log('USDZ texture packing, real WebGPU pixels, bitmap teardown and file-picker demo passed');
} finally {
  await browser.close();
}
