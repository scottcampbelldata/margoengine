import { Engine, Geometry, PbrMaterial } from '../../../core/dist/index.js';
import { CulledMeshes } from '../../dist/index.js';
import { DynamicInstances } from '../../dist/dynamic.js';
import { CulledModels } from '../../dist/models.js';
import { createInstancedMesh, Material } from '../../../materials/dist/index.js';
import { InstanceSorter, FrontToBack, SortedInstances } from '../../dist/sort.js';
const kind = new URLSearchParams(location.search).get('kind') ?? 'core',
  count = 24;
const json = await (await fetch('../assets/box/Box.gltf')).json(),
  bin = await (await fetch('../assets/box/Box0.bin')).arrayBuffer();
const read = (n, Type, size) => {
  const a = json.accessors[n],
    v = json.bufferViews[a.bufferView];
  return new Type(bin, (v.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * size);
};
const positions = read(2, Float32Array, 3),
  normals = read(1, Float32Array, 3),
  indices = read(0, Uint16Array, 1),
  geometry = new Geometry(positions, normals, indices),
  data = { positions, normals, indices: new Uint32Array(indices) };
const camera = { fov: 50, near: 0.1, far: 100, position: [0, 2, 14], target: [0, 0, 0] };
const a = await Engine.create(document.querySelector('#a'), { camera, capacity: 128 }),
  b = await Engine.create(document.querySelector('#b'), { camera, capacity: 128 });
const at = (i) => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  ((i % 8) - 3.5) * 0.8,
  Math.floor(i / 8) * 0.6 - 0.5,
  ((i * 11) % 7) * 0.35,
  1,
];
let plugin, sort;
if (kind === 'models') {
  const meshes = [a, b].map((e) => {
    const m = createInstancedMesh(e, data, new Material({ color: '#5588bb' }), count);
    for (let i = 0; i < count; i++) m.instances.setMatrixAt(i, at(i));
    return m;
  });
  plugin = CulledModels.attach(a, [meshes[0]]);
  sort = FrontToBack.attach(a, { models: [meshes[0]] });
} else {
  const material = new PbrMaterial({ color: '#5588bb' });
  for (let i = 0; i < count; i++)
    b.createMesh().setGeometry(geometry).setMaterial(material).setPosition(at(i).slice(12, 15));
  if (kind === 'static') {
    sort = SortedInstances.attach(
      a,
      [{ geometry, material, transforms: new Float32Array(Array.from({ length: count }, (_, i) => at(i)).flat()) }],
      { culling: 'occlusion' },
    );
    plugin = sort;
  } else if (kind === 'dynamic') {
    plugin = DynamicInstances.attach(a, { geometry, material, capacity: count });
    for (let i = 0; i < count; i++) plugin.addInstance(at(i));
    sort = FrontToBack.attach(a);
  } else {
    for (let i = 0; i < count; i++)
      a.createMesh().setGeometry(geometry).setMaterial(material).setPosition(at(i).slice(12, 15));
    plugin = CulledMeshes.attach(a, { occlusion: true });
    sort = FrontToBack.attach(a);
  }
}
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
async function raw() {
  const sorter = new InstanceSorter(),
    device = a.gpu,
    results = [];
  for (const capacity of [0, 1, 3, 17, 65, 257]) {
    const start = 3,
      kept = capacity === 1 ? 1 : Math.max(0, capacity - 2),
      first = capacity >= 3 ? 2 : 0,
      records = new Float32Array((capacity + start) * 24);
    for (let i = 0; i < capacity; i++) {
      const row = [...I, ...Array.from({ length: 8 }, (_, k) => i * 10 + k)];
      row[12] = i % 5;
      row[14] = (i * 13) % 17;
      records.set(row, (start + i) * 24);
    }
    const input = device.createBuffer({ size: records.byteLength, usage: 128 | 8 }),
      args = device.createBuffer({ size: 40, usage: 128 | 8 | 4 });
    device.queue.writeBuffer(input, 0, records);
    device.queue.writeBuffer(args, 0, new Uint32Array([123, 456, 0, 0, 0, 36, kept, 3, 7, first]));
    const camera = { position: [0, 0, 20], target: [0, 0, 0] },
      node = [1, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 2, 1],
      encoder = device.createCommandEncoder();
    const sorted = sorter.encode(
      { backend: 'webgpu', device, encoder, camera },
      {},
      { instances: input, args, argsOffset: 20, capacity, start, center: [0, 0, 0], node },
    );
    const read = device.createBuffer({ size: Math.max(16, kept * 96) + 20, usage: 1 | 8 });
    if (kept) encoder.copyBufferToBuffer(sorted.instances, first * 96, read, 0, kept * 96);
    encoder.copyBufferToBuffer(sorted.args, 0, read, Math.max(16, kept * 96), 20);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(1);
    const bytes = read.getMappedRange(),
      actual = Array.from(new Float32Array(bytes, 0, kept * 24)),
      actualArgs = Array.from(new Uint32Array(bytes, Math.max(16, kept * 96), 5));
    const order = Array.from({ length: kept }, (_, i) => i).sort(
        (i, j) =>
          records[(start + first + j) * 24 + 12] * 0.5 +
            records[(start + first + j) * 24 + 14] * 2 -
            (records[(start + first + i) * 24 + 12] * 0.5 + records[(start + first + i) * 24 + 14] * 2) || i - j,
      ),
      expected = order.flatMap((i) =>
        Array.from(records.subarray((start + first + i) * 24, (start + first + i + 1) * 24)),
      );
    read.unmap();
    read.destroy();
    input.destroy();
    args.destroy();
    results.push({ capacity, actual, expected, actualArgs, expectedArgs: [36, kept, 3, 7, first] });
  }
  sorter.dispose();
  return results;
}
window.check = {
  raw,
  async step(i) {
    if (i === 1)
      for (const e of [a, b]) {
        e.camera.position = [7, 4, 9];
        e.camera.target = [0, 0, 0];
      }
    if (i === 2) {
      if (kind === 'static') sort.sortEnabled = false;
      else sort.enabled = false;
    }
    await draw();
    await draw();
    return { kind };
  },
};
window.ready = true;
