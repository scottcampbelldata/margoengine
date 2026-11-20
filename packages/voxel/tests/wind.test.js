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
test('a large clock reaches the shader as float64-reduced phases, one per distinct speed', () => {
  const blocks = new BlockTypes();
  defineWindBlock(blocks, 'grass', { shape: 'cross' });
  const renderer = {
      world: { blocks },
      addVertexMotion: () => () => {},
      onDispose: () => () => {},
    },
    wind = new VoxelWind(renderer),
    written = [],
    device = {
      createBuffer: ({ size }) => ({ size, destroy() {} }),
      queue: { writeBuffer: (buffer, offset, data) => written.push(new Float32Array(data)) },
    },
    speed = blocks.table.find((t) => t.vertexMotion).vertexMotion.speed,
    time = 1e6 + 0.3,
    phase = time * speed;
  wind.bindings(device, time);
  // A float32 clock of 1e6 s steps by 0.0625 s, a sixth of a radian at speed 1.6; the phase is reduced first.
  assert.equal(written.at(-1)[4], Math.fround(phase - Math.floor(phase / (2 * Math.PI)) * 2 * Math.PI));
  assert.match(
    wind.shader('fn voxelPlace(w0:u32,w1:u32,c:u32,t:vec4f)->vec3f {}'),
    /windFrame\.phase\[slot>>2u\]\[slot&3u\]/,
  );
  wind.time = 5;
  wind.bindings(device, time);
  assert.equal(
    written.at(-1)[4],
    Math.fround(5 * speed - 2 * Math.PI),
    'an explicit time wins over the renderer clock',
  );
  wind.dispose();
});

test('a rebased renderer: the wind phase adds the integer frame base, per speed and frequency, in float64', () => {
  const blocks = new BlockTypes();
  defineWindBlock(blocks, 'grass', { shape: 'cross' });
  const grass = blocks.table.find((t) => t.vertexMotion).vertexMotion;
  blocks.define('reed', { shape: 'cross', textures: 1, vertexMotion: { ...grass, frequency: grass.frequency * 2 } });
  const renderer = {
      world: { blocks },
      addVertexMotion: () => () => {},
      onDispose: () => () => {},
    },
    wind = new VoxelWind(renderer, { direction: [0.6, 0.8] }),
    written = [],
    device = {
      createBuffer: ({ size }) => ({ size, destroy() {} }),
      queue: { writeBuffer: (buffer, offset, data) => written.push(new Float32Array(data)) },
    },
    base = [2 ** 24, 1024, -(2 ** 24)],
    time = 12.5,
    tau = 2 * Math.PI,
    reduce = (v) => Math.fround(v - Math.floor(v / tau) * tau);
  wind.bindings(device, time, base);
  // A shader position p is world cell p + base: dot(p + base, d) f + t s = dot(p, d) f + (dot(base, d) f + t s).
  const shift = (base[0] * Math.fround(0.6) + base[2] * Math.fround(0.8)) * Math.fround(grass.frequency);
  assert.equal(written.at(-1)[4], reduce(time * grass.speed + shift));
  assert.equal(written.at(-1)[5], reduce(time * grass.speed + 2 * shift), 'one slot per (speed, frequency) pair');
  assert.match(wind.shader('fn voxelPlace(w0:u32,w1:u32,c:u32,t:vec4f)->vec3f {}'), /vec4f\(1\.0,[^)]*,1\);\}/);
  wind.bindings(device, time);
  assert.equal(written.at(-1)[4], reduce(time * grass.speed + shift), 'the last base is kept');
  wind.dispose();
});

test('a rebased renderer with a wind shorter or longer than 1: the base phase uses the unit direction, as the shader', () => {
  // The shader adds dot(p.xz, direction / |direction|) * frequency, so the base's part must use the unit direction too:
  // otherwise a weak wind (|direction| < 1 only scales the sway) shifts its phase whenever the base moves.
  const blocks = new BlockTypes();
  defineWindBlock(blocks, 'grass', { shape: 'cross' });
  const grass = blocks.table.find((t) => t.vertexMotion).vertexMotion,
    renderer = { world: { blocks }, addVertexMotion: () => () => {}, onDispose: () => () => {} },
    written = [],
    device = {
      createBuffer: ({ size }) => ({ size, destroy() {} }),
      queue: { writeBuffer: (buffer, offset, data) => written.push(new Float32Array(data)) },
    },
    tau = 2 * Math.PI,
    reduce = (v) => Math.fround(v - Math.floor(v / tau) * tau),
    time = 3.25;
  for (const direction of [
    [0.3, 0],
    [0, -0.25],
    [30, 40],
  ]) {
    const wind = new VoxelWind(renderer, { direction }),
      length = Math.hypot(...direction),
      base = [1024, 7, -2048];
    wind.bindings(device, time, base);
    const shift =
      (base[0] * Math.fround(direction[0] / length) + base[2] * Math.fround(direction[1] / length)) *
      Math.fround(grass.frequency);
    assert.equal(written.at(-1)[4], reduce(time * grass.speed + shift), `direction ${direction}`);
    wind.dispose();
  }
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
