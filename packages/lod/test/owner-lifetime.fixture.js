import { Geometry } from '../../core/dist/index.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';

const geometry = () => new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]);
const msftModel = (engine) => new PBRModel(engine, new GLTFAsset({
  asset: { version: '2.0' },
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }],
  materials: [{ extensions: { MSFT_lod: { ids: [1] } } }, {}],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  nodes: [{ mesh: 0 }],
  scenes: [{ nodes: [0] }],
  scene: 0,
}, [new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])]));

export async function fixtures(load = (entry) => import(entry)) {
  const { LODSystem } = await load('../dist/index.js');
  const { LODFade } = await load('../dist/fade.js');
  const { LevelStream } = await load('../dist/stream.js');
  const { MSFTMaterialLOD } = await load('../dist/msft.js');
  const { ClusterLOD } = await load('../dist/clusters.js');
  const entries = [];
  const populate = (engine, system) => {
    const anchor = engine.createMesh(), fine = engine.createMesh(), coarse = engine.createMesh();
    system.add(anchor, [{ object: fine }, { object: coarse, distance: 10 }], { radius: 1 });
  };
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    entries.push({ name: 'LODSystem' + suffix, create({ engine }) {
      const plugin = factory ? LODSystem.attach(engine) : new LODSystem();
      if (!factory) engine.use(plugin);
      populate(engine, plugin);
      return { plugin, dispose: () => plugin.dispose?.() };
    } });
    entries.push({ name: 'LODFade' + suffix, create({ engine, scene, dependency }) {
      const system = new LODSystem();
      dependency(() => scene.use(system));
      populate(engine, system);
      const plugin = factory ? LODFade.attach(engine, system) : new LODFade(system);
      return { plugin, dependencies: [system], dispose: () => plugin.dispose(), cleanup: () => system.dispose?.() };
    } });
    entries.push({ name: 'LevelStream' + suffix, create({ engine }) {
      const plugin = factory ? LevelStream.attach(engine) : new LevelStream();
      return { plugin, dispose: () => plugin.dispose?.() };
    } });
    entries.push({ name: 'MSFTMaterialLOD' + suffix, create({ engine }) {
      const model = msftModel(engine);
      const plugin = factory ? MSFTMaterialLOD.attach(engine, model) : new MSFTMaterialLOD(model);
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => model.dispose() };
    } });
    entries.push({ name: 'ClusterLOD' + suffix, create({ engine }) {
      const node = { id: 0, children: [], meshlets: [geometry()], bounds: [0.5, 0.5, 0, 1], error: 0 };
      const hierarchy = { root: node, nodes: [node], triangles: 1 }, anchor = engine.createMesh();
      const plugin = factory ? ClusterLOD.attach(engine, hierarchy, anchor) : new ClusterLOD(hierarchy, anchor);
      return { plugin, dispose: () => plugin.dispose() };
    } });
  }
  return entries;
}
