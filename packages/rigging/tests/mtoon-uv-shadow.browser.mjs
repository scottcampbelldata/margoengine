// Real-GPU check that an MToon cut-out's shadow follows its UV animation (KB5289b): a MASK quad whose base map is clear
// on one half and solid on the other scrolls by half a texture per second; after one second the shadow it casts on a
// receiver must have swapped sides, as the colour pass's cut-out does. Before the fix the cascades cut at the static UV,
// so the shadow stayed where it was. Picking follows the same cut-out: seen from the front, a click on the clear half
// passes through to the receiver and a click on the solid half hits the quad, and the halves swap as the map moves.
// Runs on WebGPU and, with --compat, on the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const compat = process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1';
const context = await openBrowser({ port: 'free', compat, startPath: '/tests/modern-game.html' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  await context.page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js');
    const { parsePreparedPBR } = await import('/packages/gltf/dist/pbr.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const { MToon } = await import('/packages/rigging/dist/mtoon.js');
    const { Picking } = await import('/packages/selection/dist/index.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 96;
    canvas.style.cssText = 'width:128px;height:96px';
    document.body.replaceChildren(canvas);
    // The camera sits between the caster (z 0, behind it) and the receiver (z 3), so every pixel is receiver.
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      capacity: 16,
      camera: { position: [0, 0, 2], target: [0, 0, 3], fov: 90, near: 0.01, far: 20 },
    });
    const device = engine.gpu,
      validation = [];
    device.addEventListener('uncapturederror', (e) => validation.push(e.error.message));
    const vertices = new Float32Array(80);
    for (const [i, [x, y]] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].entries())
      vertices.set([x, y, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, (x + 1) / 2, (1 - y) / 2, 0, 0, 1, 1, 1, 1], i * 20);
    // Base map: left texel clear, right texel solid. Mask: white, so the whole map moves.
    const texture = new OffscreenCanvas(2, 1),
      paint = texture.getContext('2d');
    paint.clearRect(0, 0, 2, 1);
    paint.fillStyle = 'rgba(255,255,255,1)';
    paint.fillRect(1, 0, 1, 1);
    const base = await createImageBitmap(texture, { premultiplyAlpha: 'none' });
    paint.fillRect(0, 0, 2, 1);
    const mask = await createImageBitmap(texture);
    const doc = {
      asset: { version: '2.0' },
      images: [{}, {}],
      textures: [
        { source: 0, sampler: 0 },
        { source: 1, sampler: 0 },
      ],
      samplers: [{ magFilter: 9728, minFilter: 9728 }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      materials: [
        {
          alphaMode: 'MASK',
          alphaCutoff: 0.5,
          doubleSided: true,
          pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
          extensions: {
            VRMC_materials_mtoon: {
              specVersion: '1.0',
              uvAnimationMaskTexture: { index: 1 },
              uvAnimationScrollXSpeedFactor: 0.5,
            },
          },
        },
      ],
    };
    const model = parsePreparedPBR(
      engine,
      doc,
      [[{ vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }]],
      [base, mask],
    );
    const receiver = engine
      .createMesh()
      .setGeometry(box(8, 6, 0.1))
      .setPosition([0, 0, 3.05]);
    engine.lighting.direction.set([0, 0, -1]);
    engine.lighting.radiance.set([3, 3, 3, 0]);
    const effect = MToon.attach(model);
    const shadows = Shadows.attach(engine, {
      resolution: 1024,
      bias: 0,
      normalBias: 0,
      bounds: { min: [-4, -3, -1], max: [4, 3, 4] },
    });
    shadows.add(model);
    shadows.add(receiver, { castShadow: false });
    const picking = Picking.attach(engine, { capture: false });
    const frame = async () => {
      engine.render({ delta: 0 });
      await device.queue.onSubmittedWorkDone();
    };
    window.uvShadow = {
      async show(seconds) {
        if (seconds) effect.onPreUpdate(seconds);
        await waitForPipelines(frame);
        if (validation.length) throw new Error(validation.join('\n'));
      },
      // Seen from the front (the caster's side away from the receiver), which half of the quad a click hits.
      async pick(seconds) {
        if (seconds) effect.onPreUpdate(seconds);
        engine.camera.position = [0, 0, -2];
        engine.camera.target = [0, 0, 0];
        await waitForPipelines(frame);
        const hits = await picking.pickMany([
          [52, 48],
          [76, 48],
        ]);
        if (validation.length) throw new Error(validation.join('\n'));
        return hits.map((hit) => (!hit ? 'none' : hit.mesh === receiver ? 'receiver' : 'quad'));
      },
      dispose() {
        picking.dispose();
        shadows.dispose();
        effect.dispose();
        receiver.dispose();
        model.dispose();
        engine.dispose();
      },
    };
  });
  const shot = async (name) =>
    decodePNG(
      await context.page
        .locator('canvas')
        .screenshot({ path: `test-results/mtoon/uv-shadow-${name}${compat ? '-compat' : ''}.png` }),
    );
  mkdirSync('test-results/mtoon', { recursive: true });
  // Mean red of a 16 x 16 block centred at a quarter and three quarters of the width.
  const sides = (image) =>
    [0.25, 0.75].map((fx) => {
      let sum = 0;
      for (let y = image.height / 2 - 8; y < image.height / 2 + 8; y++)
        for (let x = Math.round(image.width * fx) - 8; x < Math.round(image.width * fx) + 8; x++)
          sum += image.data[(y * image.width + x) * 4];
      return sum / 256;
    });
  await context.page.evaluate(() => window.uvShadow.show(0));
  const before = sides(await shot('0s'));
  await context.page.evaluate(() => window.uvShadow.show(1));
  const after = sides(await shot('1s'));
  const picked = [
    await context.page.evaluate(() => window.uvShadow.pick(0)),
    await context.page.evaluate(() => window.uvShadow.pick(1)),
  ];
  await context.page.evaluate(() => window.uvShadow.dispose());
  const result = { compat, before, after, picked };
  console.log(JSON.stringify(result));
  writeFileSync(`test-results/mtoon/uv-shadow${compat ? '-compat' : ''}.json`, JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  // One side in shadow and one lit at each time, and the sides swap once the map has moved half a texture.
  const darker = ([a, b]) => (a < b * 0.5 ? 0 : b < a * 0.5 ? 1 : -1);
  assert.notEqual(darker(before), -1, `one side shadowed at 0 s: ${before}`);
  assert.notEqual(darker(after), -1, `one side shadowed at 1 s: ${after}`);
  assert.notEqual(darker(after), darker(before), `the shadow follows the moving cut-out: ${before} then ${after}`);
  // One half hits the quad and the other passes through to the receiver, and the halves swap once the map has moved.
  for (const sidesPicked of picked) assert.deepEqual([...sidesPicked].sort(), ['quad', 'receiver'], `picked ${picked}`);
  assert.deepEqual(
    picked[1],
    [...picked[0]].reverse(),
    `picking follows the moving cut-out: ${JSON.stringify(picked)}`,
  );
  console.log('MToon UV-animated cut-out shadow and picking check passed');
} finally {
  await context.close();
}
