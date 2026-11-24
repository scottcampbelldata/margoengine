// The scene record of a shot's measure (tools/shot/scene-record.mjs): what a film pipeline's scene audit judges, read
// from the page engine's scene graph. The engine here is a stand-in with the fields the reader reads; the browser runs
// the same function through page.evaluate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSceneRecord } from '../tools/shot/scene-record.mjs';

const sources = Symbol.for('margoengine.mesh-sources.v1');
// A column-major world matrix that moves by (x, y, z) and scales by s.
const matrix = (x, y, z, s = 1) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1]);
// A 2 m cube's vertices (position and normal per vertex) and 12 triangles, as core's Geometry keeps them.
const cube = () => {
  const v = [];
  for (let c = 0; c < 8; c++) v.push(c & 1 ? 1 : -1, c & 2 ? 1 : -1, c & 4 ? 1 : -1, 0, 1, 0);
  return { vertices: new Float32Array(v), indices: new Uint32Array(36) };
};

function stage() {
  const coreMaterial = { data: new Float32Array([0.5, 0.4, 0.3, 1, 0.7, 0, 1, 0]) };
  const crate = { name: 'crate', visible: true, geometry: cube(), material: coreMaterial, matrix: matrix(10, 2, 0) };
  const node = { name: 'door', visible: true, geometry: null, matrix: matrix(0, 0, 0, 2) };
  const lodNode = { name: 'door lod1', visible: false, geometry: null, matrix: matrix(0, 0, 0) };
  const gltf = {
    name: 'oak door',
    base: [1, 1, 1, 1],
    factors: [0.6, 0, 1, 1],
    settings: [2, 0.5, 1, 0],
    ext: [0, 1.45, 0, 0],
    maps: [{ index: 0 }, undefined, { index: 1 }],
    extensions: { KHR_materials_ior: { ior: 1.45 } },
    normalTexture: { index: 1 },
  };
  const model = {
    name: 'gltf/pbr:3',
    disposed: false,
    lods: [{ levels: [node, lodNode] }],
    textures: [
      { width: 1024, height: 1024, format: 'rgba8unorm-srgb', label: 'door_basecolor.png' },
      { width: 1000, height: 1000, format: 'rgba8unorm', label: 'door_normal_dx.png' },
    ],
  };
  const primitive = (tangent) => ({
    vertices: new Float32Array(40),
    indices: new Uint32Array(6),
    material: gltf,
    definition: { attributes: tangent ? { POSITION: 0, TANGENT: 1 } : { POSITION: 0 } },
  });
  const registry = new WeakMap([
    [node, { model, primitives: [primitive(true), primitive(false)], bounds: new Float32Array([-1, 0, -1, 1, 2, 1]) }],
  ]);
  const bloom = { name: 'bloom', options: { strength: 0.3, threshold: 1, color: [1, 1, 1] } };
  const stack = {
    name: 'post:stack',
    effects: [bloom, { name: 'tonemap', options: { exposure: 1.5, vignette: 0.1 } }],
  };
  const scatter = { name: 'scatter:1', options: { heightmap: () => null, follow: true, lod: [10, 20, 30] } };
  const textured = {
    name: 'gltf-textured',
    textures: new Map([[{}, new Map([[0, { width: 512, height: 300, format: 'rgba8unorm-srgb', label: 'bark' }]])]]),
  };
  const engine = {
    scene: {
      meshes: new Map([
        [1, crate],
        [2, node],
        [3, lodNode],
      ]),
      plugins: new Map([stack, scatter, textured].map((p) => [p.name, p])),
      stats: { drawCalls: 7, visible: 3 },
      lighting: {
        direction: new Float32Array([0, 1, 0, 3]),
        radiance: new Float32Array([1, 0.8, 0.6, 0.2]),
        ambient: new Float32Array([0.6, 0.8, 1.2]),
      },
    },
  };
  const ground = (x) => x * 0.1;
  globalThis.__margoShot = { get: (name) => ({ engine, ground })[name] };
  globalThis[sources] = registry;
  try {
    return readSceneRecord({ engine: 'engine', ground: 'ground', step: 0.5 });
  } finally {
    delete globalThis.__margoShot;
    delete globalThis[sources];
  }
}

test('the scene record reads the sun and ambient light with their colour temperatures', () => {
  const r = stage();
  assert.equal(r.version, 1);
  const [sun, ambient] = r.lights;
  assert.equal(sun.kind, 'sun');
  assert.equal(sun.intensity, 3);
  assert.ok(
    sun.temperature > 4800 && sun.temperature < 5050,
    `linear (1, 0.8, 0.6) is about 4920 K, ${sun.temperature} K`,
  );
  assert.equal(ambient.kind, 'ambient');
  assert.ok(Math.abs(ambient.intensity - 0.2) < 1e-6);
  assert.ok(ambient.temperature > sun.temperature, 'the ambient multipliers make the fill cooler than the sun');
  assert.equal(r.drawCalls, 7, "the scene's own draw count");
});

test('every plugin is recorded with its options, post effects inside a stack and the textures it keeps', () => {
  const r = stage();
  const stack = r.plugins.find((p) => p.name === 'post:stack');
  assert.deepEqual(
    stack.effects.map((e) => [e.name, e.options]),
    [
      ['bloom', { strength: 0.3, threshold: 1, color: [1, 1, 1] }],
      ['tonemap', { exposure: 1.5, vignette: 0.1 }],
    ],
  );
  const scatter = r.plugins.find((p) => p.name === 'scatter:1');
  assert.equal(scatter.options.heightmap, 'function', 'a function option is named, never read as an empty list');
  assert.deepEqual(scatter.options.lod, [10, 20, 30]);
  assert.deepEqual(r.plugins.find((p) => p.name === 'gltf-textured').textures, [
    { width: 512, height: 300, format: 'rgba8unorm-srgb', label: 'bark' },
  ]);
});

test('every mesh gives its triangles, LOD levels, tangents, materials, world bounds and the ground under it', () => {
  const r = stage();
  const crate = r.meshes.find((m) => m.name === 'crate');
  assert.equal(crate.kind, 'core');
  assert.equal(crate.triangles, 12);
  assert.equal(crate.lods, 1);
  assert.deepEqual(crate.bounds, [9, 1, -1, 11, 3, 1], 'the 2 m cube moved to (10, 2, 0)');
  // The ground x * 0.1 under the base's centre and under its corners 0.5 m out.
  const want = [1, 0.95, 1.05, 0.95, 1.05];
  assert.ok(
    crate.ground.every((v, i) => Math.abs(v - want[i]) < 1e-9),
    JSON.stringify(crate.ground),
  );
  const door = r.meshes.find((m) => m.name === 'door');
  assert.equal(door.kind, 'model');
  assert.equal(door.model, 'gltf/pbr:3');
  assert.equal(door.triangles, 4);
  assert.equal(door.lods, 2, 'one of the two levels of its MSFT_lod');
  assert.equal(door.tangents, false, 'one primitive draws a normal map with no TANGENT');
  assert.deepEqual(door.bounds, [-2, 0, -2, 2, 4, 2], 'scaled by 2');
  const m = r.materials[door.materials[0]];
  assert.equal(m.kind, 'gltf');
  assert.equal(m.name, 'oak door');
  assert.equal(m.alphaMode, 'BLEND');
  assert.equal(m.doubleSided, true);
  assert.equal(m.roughness, 0.6);
  assert.equal(m.metalness, 0);
  assert.equal(m.ior, 1.45);
  assert.deepEqual(m.extensions, ['KHR_materials_ior']);
  assert.deepEqual(m.maps, [
    { slot: 'baseColor', index: 0, width: 1024, height: 1024, format: 'rgba8unorm-srgb', label: 'door_basecolor.png' },
    { slot: 'normal', index: 1, width: 1000, height: 1000, format: 'rgba8unorm', label: 'door_normal_dx.png' },
  ]);
  const core = r.materials[crate.materials[0]];
  assert.equal(core.kind, 'core');
  assert.ok(Math.abs(core.roughness - 0.7) < 1e-6);
  assert.equal(core.doubleSided, true);
});

test('a page engine that is not an engine fails the measure, naming the page key', () => {
  globalThis.__margoShot = { get: () => ({ camera: {} }) };
  try {
    assert.throws(
      () => readSceneRecord({ engine: 'page.engine', ground: null, step: 0.5 }),
      /page\.engine is not an engine/,
    );
  } finally {
    delete globalThis.__margoShot;
  }
});
