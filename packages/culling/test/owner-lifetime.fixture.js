import { box, PbrMaterial } from '../../core/dist/index.js';

const translate = (x, y, z, s = 1) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1];
const batches = () => [{
  geometry: box(),
  material: new PbrMaterial({ color: '#ff0000' }),
  transforms: new Float32Array([...translate(0, 0, 0), ...translate(4, 0, 0, 2)]),
}];
const vertices = (...points) => {
  const out = new Float32Array(points.length * 20);
  points.forEach((p, i) => out.set(p, i * 20));
  return out;
};
// A caller-owned instanced model: like gltf-pro's PBRInstances it makes its row buffer on each device it is drawn on, and
// its owner (the caller, not the culler) destroys it.
const instancedModel = (dependency) => {
  const buffers = [];
  let device, rows;
  const model = { primitives: [{
    node: { matrix: new Float32Array(translate(5, 6, 7, 2)) },
    vertices: vertices([-1, 0, 0], [3, 0, 0]),
    indices: new Uint32Array(6),
    instances: { count: 300, capacity: 512, upload(gpu) {
      if (gpu !== device) {
        device = gpu;
        rows = dependency(() => gpu.createBuffer({ size: 96 * 512,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE }));
        buffers.push(rows);
      }
      return rows;
    } },
  }] };
  return { model, cleanup: () => { for (const buffer of buffers) buffer.destroy(); } };
};

export async function fixtures(load = (entry) => import(entry)) {
  const { CulledInstances, CulledMeshes } = await load('../dist/index.js');
  const { CulledParts } = await load('../dist/parts.js');
  const { DynamicInstances } = await load('../dist/dynamic.js');
  const { LodInstances } = await load('../dist/lod.js');
  const { CulledModels } = await load('../dist/models.js');
  const { CascadeParts, CascadeInstances } = await load('../dist/shadows.js');
  const { MeshletMesh } = await load('../dist/meshlets.js');
  const { WebGL2Culling } = await load('../dist/webgl2.js');
  const { BoxCulledMeshes, BoxCulledModels, BoxDynamicInstances } = await load('../dist/bounds.js');
  const { FrontToBack, SortedInstances } = await load('../dist/sort.js');
  const dynamic = () => ({ geometry: box(), material: new PbrMaterial({ color: '#00ff00' }), capacity: 8 });
  const lod = () => ({ levels: [{ geometry: box(), minRadius: 4 }, { geometry: box(0.5) }],
    material: new PbrMaterial({ color: '#0000ff' }), transforms: new Float32Array(translate(0, 0, 0)) });
  const make = {
    CulledInstances: [CulledInstances, (e, C, f) => f ? C.attach(e, batches()) : new C(batches())],
    SortedInstances: [SortedInstances, (e, C, f) => f ? C.attach(e, batches()) : new C(batches())],
    CulledParts: [CulledParts, (e, C, f) => f ? C.attach(e, batches()) : new C(batches())],
    CascadeParts: [CascadeParts, (e, C, f) => f ? C.attach(e, batches()) : new C(batches())],
    MeshletMesh: [MeshletMesh, (e, C, f) => f ? C.attach(e, batches()) : new C(batches())],
    DynamicInstances: [DynamicInstances, (e, C, f) => f ? C.attach(e, dynamic()) : new C(dynamic())],
    CascadeInstances: [CascadeInstances, (e, C, f) => f ? C.attach(e, dynamic()) : new C(dynamic())],
    BoxDynamicInstances: [BoxDynamicInstances, (e, C, f) => f ? C.attach(e, dynamic()) : new C(dynamic())],
    LodInstances: [LodInstances, (e, C, f) => f ? C.attach(e, lod()) : new C(lod())],
    CulledMeshes: [CulledMeshes, (e, C, f) => f ? C.attach(e) : new C()],
    BoxCulledMeshes: [BoxCulledMeshes, (e, C, f) => f ? C.attach(e) : new C()],
    CulledModels: [CulledModels, (e, C, f, m) => f ? C.attach(e, [m]) : new C()],
    BoxCulledModels: [BoxCulledModels, (e, C, f, m) => f ? C.attach(e, [m]) : new C()],
    FrontToBack: [FrontToBack, (e, C, f) => f ? C.attach(e) : new C()],
    WebGL2Culling: [WebGL2Culling, (e, C, f) => f ? C.attach(e) : new C()],
  };
  const entries = [];
  for (const factory of [false, true]) for (const [name, [Plugin, build]] of Object.entries(make))
    entries.push({ name: name + (factory ? '.attach' : ''), create({ engine, dependency }) {
      const { model, cleanup } = instancedModel(dependency);
      const plugin = build(engine, Plugin, factory, model);
      return { plugin, dispose: () => plugin.dispose(), cleanup };
    } });
  return entries;
}
