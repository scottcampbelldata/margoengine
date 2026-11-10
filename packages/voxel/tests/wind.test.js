import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { defineWindBlock, sampleVoxelWind, VoxelWind } from '../dist/wind.js';
import { decodeQuad, meshChunk, meshInput } from '../dist/mesher.js';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
test('foliage roots stay fixed, amplitude is bounded and zero wind is exact rest', () => {
  const blocks = new BlockTypes(),
    id = defineWindBlock(blocks, 'grass', { shape: 'cross' }, { amplitude: 0.3 }),
    motion = blocks.get(id).vertexMotion;
  for (let t = 0; t < 20; t += 0.17) {
    assert.deepEqual(sampleVoxelWind(motion, [1, 0, 3], 0, t), [0, 0, 0]);
    const o = sampleVoxelWind(motion, [1, 1, 3], 0, t, [1, 2]);
    assert.ok(Math.hypot(...o) <= 0.3 + 1e-12);
    assert.deepEqual(sampleVoxelWind(motion, [1, 1, 3], 0, t, [0, 0]), [0, 0, 0]);
  }
  const a = sampleVoxelWind(motion, [0, 1, 0], 0, 1, [1, 0]),
    b = sampleVoxelWind(motion, [0, 1, 0], 0, 1, [0.5, 0]);
  close(a[0], 2 * b[0]);
  assert.equal(a[2], 0);
});
test('liquid seams are world-position continuous across cells and chunks; submerged vertices stay fixed', () => {
  const blocks = new BlockTypes(),
    id = defineWindBlock(blocks, 'water', { shape: 'liquid', liquid: true, solid: false, layer: 'translucent' }),
    m = blocks.get(id).vertexMotion;
  for (let t = 0; t < 3; t += 0.07) {
    const world = [32, 4, 17];
    assert.deepEqual(
      sampleVoxelWind(m, world, 3, t, [0.3, 0.8]),
      sampleVoxelWind(m, [31 + 1, 4, 17], 3, t, [0.3, 0.8]),
    );
    assert.deepEqual(sampleVoxelWind(m, world, 3, t, [1, 0], false), [0, 0, 0]);
    assert.ok(Math.abs(sampleVoxelWind(m, world, 3, t)[1]) <= m.amplitude + 1e-12);
  }
});
test('animated surfaces cannot merge across cells and metadata survives worker cloning', () => {
  const blocks = new BlockTypes(),
    water = defineWindBlock(blocks, 'water', { shape: 'liquid', liquid: true, solid: false, layer: 'translucent' }),
    world = new VoxelWorld({ blocks });
  for (let x = 0; x < 4; x++) for (let z = 0; z < 3; z++) world.setBlock(x, 0, z, water);
  const input = meshInput(world, '0,0,0'),
    mesh = meshChunk(input),
    copy = meshChunk(structuredClone(input));
  assert.deepEqual(mesh, copy);
  let tops = 0;
  for (let i = 0; i < mesh.translucent.length / 3; i++) {
    const q = decodeQuad(mesh.translucent, i);
    assert.equal(q.w, 1);
    assert.equal(q.h, 1);
    if (q.face === 2) tops++;
  }
  assert.equal(tops, 12);
});
test('live controls upload only changes, restore a device, and release after removing the adapter', () => {
  const blocks = new BlockTypes();
  defineWindBlock(blocks, 'grass', { shape: 'cross' });
  let removed = 0,
    uploaded = 0,
    destroyed = 0;
  const renderer = {
      world: { blocks },
      addVertexMotion() {
        return () => removed++;
      },
      onDispose() {
        return () => {};
      },
    },
    wind = new VoxelWind(renderer, { time: 0 });
  const device = () => ({
      createBuffer() {
        return {
          destroy() {
            destroyed++;
          },
        };
      },
      queue: {
        writeBuffer() {
          uploaded++;
        },
      },
    }),
    a = device(),
    b = device();
  wind.bindings(a);
  wind.bindings(a);
  assert.equal(uploaded, 1);
  wind.time = 1;
  wind.direction = [0, 1];
  wind.bindings(a);
  assert.equal(uploaded, 2);
  wind.bindings(b);
  assert.equal(uploaded, 3);
  assert.equal(destroyed, 1);
  assert.equal(wind.padding, 0.12);
  assert.deepEqual(wind.direction, [0, 1]);
  assert.equal(wind.time, 1);
  wind.time = undefined;
  assert.equal(wind.time, undefined);
  wind.dispose();
  wind.dispose();
  assert.equal(removed, 1);
  assert.equal(destroyed, 2);
  assert.throws(
    () => (wind.time = 0),
    (e) => e.code === 'disposed',
  );
});
test('invalid motion options are rejected before defining a block', () => {
  const blocks = new BlockTypes();
  for (const options of [
    { amplitude: 0.6 },
    { frequency: Infinity },
    { speed: -1 },
    { rooted: 1 },
    { kind: 'noise' },
    { kind: 'liquid' },
  ])
    assert.throws(() => defineWindBlock(blocks, 'bad', {}, options));
  assert.equal(blocks.table.length, 1);
  const renderer = {
    world: { blocks },
    addVertexMotion() {
      return () => {};
    },
    onDispose() {
      return () => {};
    },
  };
  for (const opts of [{ direction: [NaN, 1] }, { time: Infinity }]) assert.throws(() => new VoxelWind(renderer, opts));
});

test('animated texture gradients follow deformed triangle coordinates', () => {
  const blocks = new BlockTypes();
  defineWindBlock(blocks, 'grass', { shape: 'cross' });
  const renderer = {
      world: { blocks },
      addVertexMotion() {
        return () => {};
      },
      onDispose() {
        return () => {};
      },
    },
    wind = new VoxelWind(renderer);
  const code =
    'fn voxelPlace(\nstruct Out {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) words:vec3u\nlet dx=voxelTile(face,voxelHit(o.clip.xy+vec2f(1.0,0.0),n,k)-O,cell)-uv;let dy=voxelTile(face,voxelHit(o.clip.xy+vec2f(0.0,1.0),n,k)-O,cell)-uv;';
  const shader = wind.shader(code);
  assert.ok(shader.includes('dpdx(uv)'));
  assert.ok(shader.includes('dpdy(uv)'));
  wind.dispose();
});
