import { ownedByEngine } from '../../../tests/support/owner-shell.js';
import { animatedTriangle } from '../../../tests/support/gltf-pbr-fixture.js';

// A lit triangle in one buffer, with optional material, node extras and an instanced node.
function triangle({ material, instanced = false } = {}) {
  const position = new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0, 0.6, 0]),
    normal = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    offsets = new Float32Array([0, 0, 0, 0.2, 0, 0]),
    bytes = new Uint8Array(position.byteLength + normal.byteLength + offsets.byteLength);
  bytes.set(new Uint8Array(position.buffer), 0);
  bytes.set(new Uint8Array(normal.buffer), position.byteLength);
  bytes.set(new Uint8Array(offsets.buffer), position.byteLength + normal.byteLength);
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bytes.byteLength, uri: 'triangle.bin' }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: position.byteLength },
      { buffer: 0, byteOffset: position.byteLength, byteLength: normal.byteLength },
      { buffer: 0, byteOffset: position.byteLength + normal.byteLength, byteLength: offsets.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.6, -0.6, 0], max: [0.6, 0.6, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, ...(material && { material: 0 }) }] }],
    nodes: [
      {
        mesh: 0,
        name: 'triangle',
        extras: { owner: true },
        ...(instanced && { extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } } }),
      },
    ],
    ...(material && { materials: [material] }),
    ...(instanced && { extensionsUsed: ['EXT_mesh_gpu_instancing'] }),
  };
  return { doc, bytes };
}
const blend = { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 1, 0.5] } };
const mask = { alphaMode: 'MASK', alphaCutoff: 0.25, pbrMetallicRoughness: { baseColorFactor: [1, 0.2, 0.2, 0.8] } };

// The app's own signal outlives the load: whatever the loader subscribes on it must go when the load settles.
function files(doc, bytes) {
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    const path = new URL(String(input)).pathname;
    if (path.endsWith('.gltf'))
      return new Response(JSON.stringify(doc), { headers: { 'content-type': 'model/gltf+json' } });
    if (path.endsWith('.bin')) return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
    return new Response('missing', { status: 404 });
  };
}

export async function fixtures(load = (entry) => import(entry)) {
  const { parseGLTF, parseGLTFAsync, loadGLTF } = await load('../dist/index.js');
  const { loadAuto } = await load('../dist/auto.js');
  const { instancing } = await load('../dist/instancing.js');
  const { meshopt } = await load('../dist/meshopt.js');
  const { quantized } = await load('../dist/quantized.js');
  const { sceneExtras, sceneData } = await load('../dist/scene-data.js');
  const { textured } = await load('../dist/textured.js');
  const entries = [];
  // A model's meshes, geometry and materials are the loader's; `model.dispose()` releases every one of them. The CPU
  // model draws no geometry, so it would not see a mesh left behind: after disposal every mesh must be gone.
  const model = (name, make, extra = {}) =>
    entries.push({
      name,
      visible: true,
      ...extra,
      async create({ engine, scene }) {
        const made = await make(engine);
        const meshes = [made.root, ...made.meshes, ...(made.nodes ?? [])].filter(Boolean);
        if (!made.meshes.length) throw new Error('OWNER_FIXTURE: the model has no renderable mesh');
        return ownedByEngine(scene, name, () => made.dispose(), {
          check({ phase }) {
            if (phase === 'disposed' && meshes.some((m) => m.engine.meshes.get(m.id) === m))
              throw new Error('OWNER_LIFETIME: a disposed model leaves meshes in the scene');
          },
        });
      },
    });
  model('parseGLTF', (engine) => {
    const { doc, bytes } = triangle();
    return parseGLTF(engine, doc, [bytes]);
  });
  model('parseGLTFAsync.extensions', async (engine) => {
    const { doc, bytes } = triangle({ instanced: true });
    const made = await parseGLTFAsync(engine, doc, [bytes], {
      extensions: [meshopt, quantized, instancing, sceneExtras],
    });
    if (made.meshes.length !== 2 || !sceneData(made)) throw new Error('OWNER_FIXTURE: two instances and scene data');
    return made;
  });
  model('loadGLTF', (engine) => {
    const { doc, bytes } = triangle();
    return loadGLTF(engine, 'https://assets.example/triangle.gltf', {
      fetch: files(doc, bytes),
      signal: new AbortController().signal,
    });
  });
  // A file the light loader refuses (BLEND) goes to gltf/pbr; either way the model is the caller's to dispose.
  for (const [name, material, loader] of [
    ['loadAuto', undefined, 'gltf'],
    ['loadAuto.gltf/pbr', blend, 'gltf/pbr'],
  ])
    model(name, async (engine) => {
      const { doc, bytes } = triangle({ material });
      const made = await loadAuto(engine, 'https://assets.example/triangle.gltf', {
        fetch: files(doc, bytes),
        signal: new AbortController().signal,
      });
      if (made.loader !== loader) throw new Error(`OWNER_FIXTURE: loadAuto took ${made.loader}, not ${loader}`);
      const { root, meshes = [], nodes = [] } = made.model;
      return { root, meshes: meshes.length ? meshes : nodes, nodes, dispose: () => made.model.dispose() };
    });
  // The textured draw is a plugin of its own, shared by every textured model of a scene and removed with the last.
  // Both loads start before the first await: a load builds in the scene active when it starts (KB-OWN-GLTF1), and
  // after an await that is the default scene again, not the one being set up.
  for (const count of [1, 2])
    model(`textured.mask${count === 1 ? '' : '.shared'}`, async (engine) => {
      const made = await Promise.all(
        Array.from({ length: count }, () => {
          const { doc, bytes } = triangle({ material: mask });
          return parseGLTFAsync(engine, doc, [bytes], { extensions: [textured] });
        }),
      );
      return {
        meshes: made.flatMap((m) => [m.root, ...m.meshes, ...m.nodes]),
        dispose: () => {
          for (const m of made) m.dispose();
        },
      };
    });
  // @margoengine/gltf/pbr: a PBR model is a plugin the engine draws; disposing it releases what it made.
  const { PBRModel, GLTFAsset } = await load('../dist/pbr.js');
  entries.push({
    name: 'PBRModel',
    visible: true,
    create({ engine }) {
      const { doc, buffers } = animatedTriangle();
      const plugin = new PBRModel(engine, new GLTFAsset(doc, buffers));
      return { plugin, dispose: () => plugin.dispose() };
    },
  });
  return entries;
}
