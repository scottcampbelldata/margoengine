import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { createHeadlessCanvas } from '../dist/index.js';
import { renderTiles, renderTiled } from '../dist/tiles.js';

function fixture(fill = () => [90, 120, 200, 255]) {
  let copy,
    sample = 0;
  const sizes = [],
    matrices = [],
    camera = new Camera(),
    canvas = createHeadlessCanvas({ width: 9, height: 7 }),
    gpu = {
      limits: { maxTextureDimension2D: 8 },
      createTexture({ size: [width, height] }) {
        sizes.push([width, height]);
        return { width, height, format: 'rgba8unorm', destroy() {} };
      },
      createBuffer({ size }) {
        return {
          mapAsync: async () => {},
          destroy() {},
          getMappedRange() {
            const data = new Uint8Array(size);
            for (let y = 0; y < copy.height; y++)
              for (let x = 0; x < copy.width; x++) data.set(fill(sample - 1, x, y), y * copy.bytesPerRow + x * 4);
            return data.buffer;
          },
        };
      },
      createCommandEncoder: () => ({
        finish() {},
        copyTextureToBuffer(_s, d, [width, height]) {
          copy = { width, height, bytesPerRow: d.bytesPerRow };
        },
      }),
      queue: { submit() {} },
    },
    engine = {
      canvas,
      gpu,
      camera,
      render({ camera: shot, delta }) {
        assert.equal(delta, 0);
        shot.update(canvas.width / canvas.height, true);
        matrices.push([...shot.matrix]);
        canvas.getContext('webgpu').getCurrentTexture();
        sample++;
      },
    };
  canvas.getContext('webgpu').configure({ device: gpu, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { engine, sizes, matrices };
}

test('streams past the GPU limit, covers odd edges once, restores canvas and camera', async () => {
  const { engine, sizes, matrices } = fixture(),
    original = engine.camera.update,
    tiles = [];
  for await (const tile of renderTiles(engine, { width: 19, height: 11, tileSize: 8, padding: 1 })) tiles.push(tile);
  assert.deepEqual(
    tiles.map(({ x, y, width, height }) => [x, y, width, height]),
    [
      [0, 0, 6, 6],
      [6, 0, 6, 6],
      [12, 0, 6, 6],
      [18, 0, 1, 6],
      [0, 6, 6, 5],
      [6, 6, 6, 5],
      [12, 6, 6, 5],
      [18, 6, 1, 5],
    ],
  );
  assert.ok(sizes.every(([w, h]) => w <= 8 && h <= 8));
  assert.notDeepEqual(matrices[0], matrices[1]);
  assert.deepEqual([engine.canvas.width, engine.canvas.height], [9, 7]);
  assert.equal(engine.camera.update, original);
  const image = await renderTiled(engine, { width: 19, height: 11, tileSize: 8 });
  assert.equal(image.data.length, 19 * 11 * 4);
  for (let i = 0; i < image.data.length; i += 4) assert.deepEqual([...image.data.slice(i, i + 4)], [90, 120, 200, 255]);
});

test('averages black and white in linear light and ignores hidden transparent colour', async () => {
  const first = fixture((s) => (s % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  assert.deepEqual(
    [...(await renderTiled(first.engine, { width: 1, height: 1, samples: 2 })).data],
    [188, 188, 188, 255],
  );
  const second = fixture((s) => (s % 2 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
  assert.deepEqual([...(await renderTiled(second.engine, { width: 1, height: 1, samples: 2 })).data], [255, 0, 0, 128]);
});

test('early return, cancellation, failure and concurrent capture clean up', async () => {
  const { engine } = fixture(),
    controller = new AbortController(),
    reason = new Error('cancel');
  const iterator = renderTiles(engine, { width: 20, height: 10, signal: controller.signal });
  await iterator.next();
  await assert.rejects(renderTiles(engine, { width: 1, height: 1 }).next(), { code: 'state' });
  controller.abort(reason);
  await assert.rejects(iterator.next(), (error) => error === reason);
  assert.deepEqual([engine.canvas.width, engine.canvas.height], [9, 7]);
  const early = renderTiles(engine, { width: 20, height: 10 });
  await early.next();
  await early.return();
  const saved = engine.render;
  engine.render = () => {
    throw reason;
  };
  await assert.rejects(renderTiled(engine, { width: 1, height: 1 }), (error) => error === reason);
  engine.render = saved;
  assert.deepEqual([engine.canvas.width, engine.canvas.height], [9, 7]);
  await renderTiled(engine, { width: 1, height: 1 });
});

test('rejects invalid sizes, sample counts, padding and unsupported backend', async () => {
  const { engine } = fixture();
  for (const bad of [
    { width: 0 },
    { height: NaN },
    { width: 1.2 },
    { samples: 0 },
    { samples: 1025 },
    { tileSize: 9 },
    { padding: 4 },
    { padding: -1 },
  ])
    await assert.rejects(renderTiled(engine, { width: 1, height: 1, tileSize: 8, ...bad }), RangeError);
  await assert.rejects(renderTiled({ gpu: null }, { width: 1, height: 1 }), { code: 'unsupported' });
});
