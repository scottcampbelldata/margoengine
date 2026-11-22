import { Geometry, PbrMaterial as CoreMaterial } from '../../core/dist/index.js';
import { GLTFAsset, PBRModel } from '../../gltf/dist/pbr.js';
import { PbrMaterial, createMesh } from '../../materials/dist/index.js';

// The CPU bakers (bakeLightmap, bakeMeshLightmap, bakeLightProbes, denoise) return plain arrays and hold nothing. The
// entries are what holds a GPU texture or a registration: the imported-bake plugin, applyLightmap on a glTF PBR model,
// a materials mesh and a core mesh, and a GPULightmapBaker drawn live on a model.
const positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
  normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uv1 = [0, 1, 1, 1, 1, 0, 0, 0],
  indices = [0, 1, 2, 0, 2, 3];
// A 4 x 1 bake: left half lit, right half dark.
const baked = () => {
  const lightmap = new Uint8Array(16);
  for (const i of [0, 1]) lightmap.set([255, 255, 255, 255], i * 4);
  for (const i of [2, 3]) lightmap[i * 4 + 3] = 255;
  return { width: 4, height: 1, lightmap, lightmapScale: 0.75 };
};
// The quad as a glTF asset with TEXCOORD_1, one buffer per accessor.
const quad = () => {
  const buffers = [
    new Float32Array(positions),
    new Float32Array(normals),
    new Float32Array(uv1),
    new Uint16Array(indices),
  ];
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_1: 2 }, indices: 3, material: 0 }] }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 1 } },
    ],
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
    bufferViews: buffers.map((b, i) => ({ buffer: i, byteLength: b.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  return new GLTFAsset(doc, buffers);
};
const imported = () => ({ width: 2, height: 1, data: new Uint8Array([200, 180, 160, 255, 40, 40, 40, 255]), scale: 2 });

export async function fixtures(load = (entry) => import(entry)) {
  const { ImportedLightmapInstallation } = await load('../dist/imported.js');
  const { applyLightmap } = await load('../dist/apply.js');
  const { GPULightmapBaker } = await load('../dist/gpu.js');
  const entries = [];
  for (const factory of [false, true])
    entries.push({
      name: 'ImportedLightmapInstallation' + (factory ? '.attach' : ''),
      create({ engine, scene, dependency }) {
        const model = dependency(() => new PBRModel(engine, quad()));
        const plugin = factory
          ? ImportedLightmapInstallation.attach(model, imported())
          : new ImportedLightmapInstallation(model, imported());
        if (!factory) scene.use(plugin);
        return { plugin, dispose: () => plugin.dispose(), cleanup: () => model.dispose() };
      },
    });
  // The model is the entry's plugin; the application's texture and the copied material records are its own.
  entries.push({
    name: 'applyLightmap PBRModel',
    create({ engine }) {
      const plugin = new PBRModel(engine, quad());
      const app = applyLightmap(plugin, baked());
      return {
        plugin,
        dispose: () => {
          app.dispose();
          plugin.dispose();
        },
      };
    },
  });
  // A materials mesh, and a core mesh drawn by a materials stand-in. Each is lit while the entry's plugin is attached.
  // Materials makes its 1x1 default textures once per device on first use and keeps them for the device's life.
  for (const target of ['materials mesh', 'core Mesh'])
    entries.push({
      name: `applyLightmap ${target}`,
      warmUp: "materials' 1x1 default textures, made once per device",
      create({ engine, scene }) {
        let mesh, app;
        const plugin = {
          name: `lightmap-${target}`,
          setup() {
            if (app) return;
            if (target === 'materials mesh') {
              mesh = createMesh(
                engine,
                { positions, normals, uvs1: uv1, indices },
                new PbrMaterial({ color: [0.5, 0.5, 0.5], roughness: 1, metalness: 0 }),
              );
              app = applyLightmap(mesh, baked());
            } else {
              mesh = scene.createMesh().setGeometry(new Geometry(positions, normals, indices));
              mesh.material = new CoreMaterial({ color: [0.5, 0.5, 0.5], roughness: 1, metalness: 0 });
              app = applyLightmap(mesh, baked(), { uv1 });
            }
          },
          dispose() {
            app?.dispose();
            if (target === 'materials mesh') mesh?.destroy();
            else mesh?.dispose();
            engine.sceneOf(this)?.removePlugin(this.name);
          },
        };
        scene.use(plugin);
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  // A live GPU bake drawn on a model: the baker owns its buffers and texture, the application borrows the texture.
  // The baker is the caller's; this caller ends it with the model, however the model goes.
  entries.push({
    name: 'GPULightmapBaker on PBRModel',
    async create({ engine }) {
      const baker = await GPULightmapBaker.create(
        engine.gpu,
        { positions: new Float32Array(positions), uv1: new Float32Array(uv1), indices: new Uint32Array(indices) },
        { width: 4, lights: [{ type: 'ambient', intensity: 1 }] },
      );
      const plugin = new PBRModel(engine, quad());
      const app = applyLightmap(plugin, baker);
      plugin.onDispose(() => baker[Symbol.dispose]());
      return {
        plugin,
        dispose: () => {
          app.dispose();
          plugin.dispose();
        },
      };
    },
  });
  return entries;
}
