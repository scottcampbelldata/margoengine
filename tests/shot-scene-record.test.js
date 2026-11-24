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
    asset: { baseURL: 'http://127.0.0.1:5173/asset-library/fauld/oak%20door/door.gltf' },
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
    textures: new Map([
      [{}, new Map([[0, { width: 512, height: 300, format: 'rgba8unorm-srgb', label: 'bark', usage: 0x06 }]])],
    ]),
  };
  // A post pass's render target (RENDER_ATTACHMENT 0x10) beside a terrain whose textures sit in a plain object.
  const gtao = {
    name: 'gtao',
    options: { radius: 2 },
    textures: [{ width: 2880, height: 1620, format: 'rgba16float', label: '', usage: 0x14 }],
  };
  const terrain = {
    name: 'terrain:0',
    options: {
      origin: [-100, -100],
      size: [200, 200],
      textures: () => null,
      layers: [
        { height: [-100, 40], slope: [0, 0.4], scale: 0.25, macro: 0.3 },
        { height: [-100, 400], slope: [0.4, 1], scale: 0.5 },
      ],
    },
    textures: {
      heightmap: { width: 1024, height: 1024, format: 'r32float', label: 'dem', usage: 0x06 },
      weights: [
        { width: 512, height: 512, format: 'rgba8unorm', label: 'w0', usage: 0x06 },
        { width: 512, height: 512, format: 'rgba8unorm', label: 'w1', usage: 0x06 },
      ],
    },
  };
  // Clustered keeps the lights last given to setLights in `list`.
  const clustered = {
    name: 'clustered',
    list: [
      { position: [1, 3, 2], range: 12, intensity: 80, color: [1, 0.6, 0.3], radius: 0.05 },
      { position: [5, 3, 2], range: 8, direction: [0, -1, 0], outerAngle: 0.6, castShadow: true },
      { position: [9, 3, 2], range: 8, shadow: true },
    ],
  };
  const engine = {
    scene: {
      meshes: new Map([
        [1, crate],
        [2, node],
        [3, lodNode],
      ]),
      plugins: new Map([stack, scatter, textured, gtao, terrain, clustered].map((p) => [p.name, p])),
      stats: { drawCalls: 7, visible: 3 },
      lighting: {
        direction: new Float32Array([0, 1, 0, 3]),
        radiance: new Float32Array([1, 0.8, 0.6, 0.2]),
        ambient: new Float32Array([0.6, 0.8, 1.2]),
      },
    },
  };
  const ground = (x) => x * 0.1;
  return read(engine, ground, registry);
}

// Runs the reader as the page does: the shot driver, the mesh-source registry and the page's origin.
function read(engine, ground, registry) {
  globalThis.__margoShot = { get: (name) => ({ engine, ground })[name] };
  globalThis[sources] = registry;
  const before = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'http://127.0.0.1:5173' }, configurable: true });
  try {
    return readSceneRecord({ engine: 'engine', ground: 'ground', step: 0.5 });
  } finally {
    delete globalThis.__margoShot;
    delete globalThis[sources];
    delete globalThis.location;
    if (before) Object.defineProperty(globalThis, 'location', before);
  }
}

test('the scene record reads the sun and ambient light with their colour temperatures', () => {
  const r = stage();
  assert.equal(r.version, 2);
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
    { width: 512, height: 300, format: 'rgba8unorm-srgb', label: 'bark', usage: 6, attachment: false, key: null },
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
    {
      slot: 'baseColor',
      index: 0,
      scale: [1, 1],
      width: 1024,
      height: 1024,
      format: 'rgba8unorm-srgb',
      label: 'door_basecolor.png',
    },
    {
      slot: 'normal',
      index: 1,
      scale: [1, 1],
      width: 1000,
      height: 1000,
      format: 'rgba8unorm',
      label: 'door_normal_dx.png',
    },
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

test("a render target is marked as an attachment and an asset texture is not, a plain object's textures keep their key", () => {
  const r = stage();
  const [target] = r.plugins.find((p) => p.name === 'gtao').textures;
  assert.equal(target.attachment, true, 'usage 0x14 holds RENDER_ATTACHMENT (0x10): a post pass target');
  assert.equal(target.usage, 0x14);
  const terrain = r.plugins.find((p) => p.name === 'terrain:0');
  assert.deepEqual(
    terrain.textures.map((t) => [t.key, t.label, t.attachment]),
    [
      ['heightmap', 'dem', false],
      ['weights', 'w0', false],
      ['weights', 'w1', false],
    ],
  );
  assert.deepEqual(terrain.options.layers, [
    { height: [-100, 40], slope: [0, 0.4], scale: 0.25, macro: 0.3 },
    { height: [-100, 400], slope: [0.4, 1], scale: 0.5 },
  ]);
  assert.equal(terrain.options.textures, 'function');
});

test('a texture whose usage the GPU object does not give is unknown, never an asset or a target', () => {
  const r = stage();
  const tex = r.plugins.find((p) => p.name === 'gltf-textured').textures[0];
  assert.equal(tex.attachment, false);
  const engine = {
    scene: {
      meshes: new Map(),
      plugins: new Map([['x', { name: 'x', textures: [{ width: 4, height: 4, format: 'rgba8unorm' }] }]]),
      lighting: {
        direction: new Float32Array([0, 1, 0, 1]),
        radiance: new Float32Array([1, 1, 1, 0]),
        ambient: new Float32Array([1, 1, 1]),
      },
    },
  };
  const [t] = read(engine, null, new WeakMap()).plugins[0].textures;
  assert.equal(t.usage, null);
  assert.equal(t.attachment, null);
});

test('the local lights a plugin lists are recorded in candela with their falloff, size and cone', () => {
  const r = stage();
  const local = r.lights.filter((l) => l.plugin === 'clustered');
  assert.equal(local.length, 3);
  assert.equal(local[0].kind, 'point');
  assert.deepEqual(local[0].position, [1, 3, 2]);
  assert.equal(local[0].intensity, 80);
  assert.equal(local[0].units, 'candela');
  assert.equal(local[0].decay, 2, 'inverse square, the package default');
  assert.ok(Math.abs(local[0].radius - 0.05) < 1e-9);
  assert.ok(
    local[0].temperature > 3000 && local[0].temperature < 4500,
    `linear (1, 0.6, 0.3) is about 3680 K, ${local[0].temperature} K`,
  );
  assert.equal(local[1].kind, 'spot');
  assert.deepEqual(local[1].direction, [0, -1, 0]);
  assert.ok(Math.abs(local[1].outerAngle - 0.6) < 1e-9);
  assert.equal(local[1].castShadow, true);
  assert.equal(local[1].intensity, 1, 'the package default intensity');
  assert.equal(local[0].castShadow, false);
  assert.equal(local[2].castShadow, true, "Clustered's integrated shadow map also shadows the light");
});

test("a model's mesh names the file it was loaded from, its texture repeat, vertex colours and open edges", () => {
  const r = stage();
  const door = r.meshes.find((m) => m.name === 'door');
  assert.equal(door.file, '/asset-library/fauld/oak door/door.gltf', 'the decoded URL path on the page origin');
  assert.equal(r.meshes.find((m) => m.name === 'crate').file, null, 'a core mesh has no file');
  // A quad of two triangles whose diagonal vertices are split (a UV seam): welded, it has 4 open edges, and its
  // texture coordinates run 0 to 3 by 0 to 2, so its map repeats 3 by 2 times.
  const quad = (seam) => {
    const corners = [
      [0, 0, 0, 0, 0],
      [1, 0, 0, 3, 0],
      [1, 0, 1, 3, 2],
      [0, 0, 1, 0, 2],
    ];
    const order = seam ? [0, 1, 2, 0, 2, 3] : [0, 1, 2, 3, 2, 0];
    const vertices = new Float32Array(20 * 6);
    order.forEach((c, i) => {
      vertices.set(corners[c].slice(0, 3), i * 20);
      vertices.set(corners[c].slice(3), i * 20 + 12);
    });
    return vertices;
  };
  const node = { name: 'cutaway wall', visible: true, geometry: null, matrix: matrix(0, 0, 0) },
    model = { name: 'gltf/pbr:9', disposed: false, lods: [], textures: [] },
    material = { name: 'plaster', maps: [{ index: 0, extensions: { KHR_texture_transform: { scale: [4, 4] } } }] };
  const engine = {
    scene: {
      meshes: new Map([[1, node]]),
      plugins: new Map(),
      lighting: {
        direction: new Float32Array([0, 1, 0, 1]),
        radiance: new Float32Array([1, 1, 1, 0]),
        ambient: new Float32Array([1, 1, 1]),
      },
    },
  };
  const registry = new WeakMap([
    [
      node,
      {
        model,
        bounds: new Float32Array([0, 0, 0, 1, 0, 1]),
        primitives: [
          {
            vertices: quad(true),
            indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
            material,
            definition: { attributes: { POSITION: 0, TEXCOORD_0: 1, COLOR_0: 2 } },
          },
        ],
      },
    ],
  ]);
  const [wall] = read(engine, null, registry).meshes;
  assert.equal(wall.openEdges, 4, "the seam welds shut; the quad's rim is open");
  assert.deepEqual(wall.uvSpan, [3, 2]);
  assert.equal(wall.vertexColours, true);
  const [map] = read(engine, null, registry).materials[0].maps;
  assert.deepEqual(map.scale, [4, 4], "the map's KHR_texture_transform repeat");
  assert.equal(wall.file, null, 'a model with no asset URL (parsed from memory) names no file');
  const closed = read(
    {
      ...engine,
      scene: { ...engine.scene, meshes: new Map([[1, { ...node }]]) },
    },
    null,
    new WeakMap(),
  );
  assert.deepEqual(closed.meshes, [], 'a node with no geometry and no model is a group node, not a mesh');
});
