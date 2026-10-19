// Real-WebGPU check of @margoengine/animation Skin on a materials createMesh mesh: the deformed vertex buffer matches
// skin.pose() (positions and normals) after posing, a ranged weight update and a device restore, with no validation
// errors. Run after build:packages: node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/animation-skin-browser-tests.js
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5198 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { Material, createMesh } = await import('/packages/materials/dist/index.js'),
      { Skeleton, Skin } = await import('/packages/animation/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:256px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      capacity: 256,
      camera: { position: [0, 1.5, 6], target: [0, 1.5, 0] },
    });
    engine.gpu.pushErrorScope('validation');
    // A 2 x 4 vertex strip up the y axis with vertex colours, skinned to a three-bone chain.
    const positions = [],
      normals = [],
      colors = [],
      joints = [],
      weights = [],
      indices = [];
    for (let y = 0; y < 4; y++)
      for (const x of [-0.5, 0.5]) {
        positions.push(x, y, 0);
        normals.push(0, 0, 1);
        colors.push(y / 3, 0.5, 1 - y / 3);
        joints.push(Math.max(0, y - 1), Math.min(2, y), 0, 0);
        weights.push(1, y === 0 ? 0 : 1, 0, 0);
      }
    for (let y = 0; y < 3; y++) indices.push(y * 2, y * 2 + 1, y * 2 + 2, y * 2 + 2, y * 2 + 1, y * 2 + 3);
    const skeleton = new Skeleton([
        { name: 'root', parent: -1 },
        { name: 'mid', parent: 0, translation: [0, 1, 0] },
        { name: 'tip', parent: 1, translation: [0, 1, 0] },
      ]),
      mesh = createMesh(engine, { positions, normals, colors, indices }, new Material({ color: [1, 1, 1, 1] })),
      skin = Skin.attach(mesh, skeleton, joints, weights);
    const read = async () => {
      const gpu = engine.gpu,
        primitive = mesh.primitives[0],
        b = gpu.createBuffer({
          size: primitive.vertices.byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        encoder = gpu.createCommandEncoder();
      encoder.copyBufferToBuffer(primitive.deformed, 0, b, 0, b.size);
      gpu.queue.submit([encoder.finish()]);
      await b.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(b.getMappedRange()).slice();
      b.unmap();
      b.destroy();
      return out;
    };
    const check = async (label) => {
      engine.render({ culling: false });
      await engine.gpu.queue.onSubmittedWorkDone();
      const gpu = await read(),
        cpu = skin.pose(positions, normals);
      let error = 0;
      for (let v = 0; v < 8; v++)
        for (let c = 0; c < 3; c++)
          error = Math.max(
            error,
            Math.abs(gpu[v * 20 + c] - cpu.positions[v * 3 + c]),
            Math.abs(gpu[v * 20 + 4 + c] - cpu.normals[v * 3 + c]),
            Math.abs(gpu[v * 20 + 16 + c] - mesh.primitives[0].vertices[v * 20 + 16 + c]),
          );
      if (!(error < 1e-5)) throw new Error(`${label}: GPU skin differs from skin.pose() by ${error}`);
      return error;
    };
    const s = Math.SQRT1_2;
    skeleton.setPose(1, { rotation: [0, 0, s, s] }).setPose(2, { rotation: [0, 0, -0.5, Math.sqrt(0.75)] });
    const posed = await check('posed');
    skin.setInfluences(6, [2, 1, 0, 0, 2, 1, 0, 0], [1, 1, 0, 0, 0, 0, 0, 0]);
    const painted = await check('painted'),
      first = await engine.gpu.popErrorScope();
    if (first) throw new Error('Validation: ' + first.message);
    await engine.rebootDevice();
    engine.gpu.pushErrorScope('validation');
    const restored = await check('restored');
    const validation = await engine.gpu.popErrorScope();
    if (validation) throw new Error('Validation: ' + validation.message);
    skin.dispose();
    const released = mesh.primitives[0].deformed === undefined;
    mesh.dispose();
    engine.dispose();
    return { posed, painted, restored, released };
  });
  assert.equal(result.released, true);
  assert.deepEqual(errors, []);
  await writeFile('test-results/animation-skin.json', JSON.stringify({ hardware, ...result }, null, 2) + '\n');
  console.log(JSON.stringify({ hardware, ...result }, null, 2));
} finally {
  await browser.close();
}
