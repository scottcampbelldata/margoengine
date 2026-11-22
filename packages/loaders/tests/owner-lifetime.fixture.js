// Owner/lifetime fixture for @margoengine/loaders. Only five entries hold anything past their call: createMeshes (core
// meshes and their materials), createPBRMeshes (a gltf/pbrModel), createMTLMaterials (materials and the textures
// they load, with an abort listener on the app's signal while they load), createOBJMesh and loadOBJ (a materials mesh
// and its plugin, made in the scene the call started in). Every other entry (the ~30 format parsers, the geometry and
// normal helpers, zip, LZF, the outline and font readers) is a pure function of its input and holds nothing, so it is
// not an entry; fetchBytes, load and the USD worker are run on the way in, so a listener they leave on the signal or a
// worker they leave running is seen. Inputs are inline, so the browser leaves read no files.
import { ownedByEngine } from '../../../tests/support/owner-shell.js';
import { captureScene } from '../../shared/scene-scope.js';

const off = 'OFF\n4 2 0\n-1 0 -1\n1 0 -1\n-1 0 1\n1 0 1\n3 0 2 3\n3 0 3 1\n';
const xyz = '0 0 0\n1 0 0\n0 1 0\n';
const usda =
  '#usda 1.0\n(metersPerUnit = 1 upAxis = "Y")\ndef Mesh "Quad" {\n point3f[] points = [(-1,0,-1),(1,0,-1),(1,0,1),(-1,0,1)]\n int[] faceVertexCounts = [4]\n int[] faceVertexIndices = [0,3,2,1]\n color3f[] primvars:displayColor = [(0.8,0.4,0.2)] (interpolation = "constant")\n uniform token subdivisionScheme = "none"\n}\n';
const obj =
  'mtllib quad.mtl\nv -1 0 -1\nv 1 0 -1\nv 1 0 1\nv -1 0 1\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl Painted\nf 1/1 4/4 3/3 2/2\n';
const mtl = 'newmtl Painted\nKd 0.8 0.6 0.4\nmap_Kd paint.png\n';

// The app's own signal outlives the load: whatever a loader subscribes on it must go when the load settles.
const signal = () => new AbortController().signal;
const files = { '/models/quad.off': off, '/models/quad.obj': obj, '/models/quad.mtl': mtl };
const fetch = async (input, init) => {
  init?.signal?.throwIfAborted();
  const body = files[new URL(String(input)).pathname];
  return body === undefined
    ? new Response('missing', { status: 404 })
    : new Response(body, { headers: { 'content-length': String(new TextEncoder().encode(body).byteLength) } });
};

export async function fixtures(load = (entry) => import(entry)) {
  const { createMeshes, load: loadFile, parseOFF, parseOBJ, parseXYZ } = await load('../dist/index.js');
  const { parseUSDAInWorker } = await load('../dist/worker.js');
  const { createPBRMeshes } = await load('../dist/render.js');
  const { createMTLMaterials, createOBJMesh, loadOBJ } = await load('../dist/mtl.js');
  const { Material, Texture } = await load('../../materials/dist/index.js');
  // A 2x2 texture in place of a decoded image, so no file or image decoder is needed; it is the set's to dispose.
  const loadTexture = async (url, { signal: abort, fetch: _fetch, ...options }) => {
    abort?.throwIfAborted();
    return new Texture({ data: new Uint8Array(16).fill(200), width: 2, height: 2 }, options);
  };
  const entries = [];
  // Core meshes have no plugin of their own: the app ties the set to one, and every mesh must be gone after disposal.
  // createMeshes, createPBRMeshes and createOBJMesh are synchronous: after its own awaits the app makes them in the
  // scene it started in (captureScene), as it does for any other engine call.
  const meshes = (name, make) =>
    entries.push({
      name,
      async create({ engine, scene }) {
        const scope = captureScene(engine),
          input = await make(),
          loaded = scope.run(() => createMeshes(engine, input));
        if (!loaded.meshes.length) throw new Error('OWNER_FIXTURE: createMeshes made no mesh');
        return ownedByEngine(scene, name, () => loaded.dispose(), {
          check({ phase }) {
            for (const mesh of loaded.meshes) {
              if (phase === 'render' && mesh.scene !== scene)
                throw new Error('OWNER_LIFETIME: createMeshes made a mesh outside the scene it was called in');
              if (phase === 'disposed' && mesh.engine.meshes.get(mesh.id) === mesh)
                throw new Error('OWNER_LIFETIME: disposed createMeshes meshes are left in the scene');
            }
          },
        });
      },
    });
  meshes('createMeshes.off', () =>
    loadFile('https://assets.example/models/quad.off', parseOFF, { fetch, signal: signal() }),
  );
  meshes('createMeshes.points', () => parseXYZ(new TextEncoder().encode(xyz)));
  meshes('createMeshes.usdWorker', () => parseUSDAInWorker(usda, { signal: signal() }));

  // A gltf/pbr model (createPBRMeshes) or a materials mesh (createOBJMesh, loadOBJ) is itself the registration.
  // A materials mesh makes materials' 1x1 default textures once per device and keeps them: `warmUp` makes them first.
  const model = (name, make, extra = {}) =>
    entries.push({
      name,
      ...extra,
      async create(context) {
        const { plugin, release = () => plugin.dispose(), set } = await make(context);
        if (set && !set.textures.length) throw new Error('OWNER_FIXTURE: the MTL map was not loaded');
        const nodes = [plugin.root, ...plugin.nodes].filter(Boolean);
        if (!nodes.length) throw new Error('OWNER_FIXTURE: the model has no mesh');
        return {
          plugin,
          dispose: release,
          check({ phase }) {
            if (phase === 'disposed' && nodes.some((m) => m.engine.meshes.get(m.id) === m))
              throw new Error(`OWNER_LIFETIME: a disposed ${name} model leaves meshes in the scene`);
          },
        };
      },
    });
  model('createPBRMeshes', async ({ engine }) => {
    const scope = captureScene(engine),
      loaded = await parseUSDAInWorker(usda, { signal: signal() });
    return { plugin: scope.run(() => createPBRMeshes(engine, loaded)) };
  });
  model(
    'loadOBJ',
    async ({ engine }) => {
      const loaded = await loadOBJ(engine, 'https://assets.example/models/quad.obj', {
        fetch,
        signal: signal(),
        loadTexture,
      });
      return { plugin: loaded.mesh, set: loaded.materials, release: () => loaded.dispose() };
    },
    { warmUp: "materials' 1x1 default textures, made once per device" },
  );
  model(
    'createOBJMesh',
    async ({ engine }) => {
      const scope = captureScene(engine),
        parsed = await parseOBJ(obj, { resolve: async () => new TextEncoder().encode(mtl) }),
        set = await createMTLMaterials(parsed.materials, {
          baseUrl: 'https://assets.example/models/quad.obj',
          loadTexture,
          fetch,
          signal: signal(),
        }),
        fallback = new Material(),
        mesh = scope.run(() => createOBJMesh(engine, parsed, set, { fallback }));
      // The set and the fallback are the app's: it lets them go with the mesh, also when the scene removes the mesh.
      mesh.onDispose(() => {
        set.dispose();
        fallback.dispose();
      });
      return { plugin: mesh, set, release: () => mesh.destroy() };
    },
    { warmUp: "materials' 1x1 default textures, made once per device" },
  );
  return entries;
}
