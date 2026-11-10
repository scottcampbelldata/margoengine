import { Engine, Geometry, PbrMaterial, box } from '../../../core/dist/index.js';
import { Material, createInstancedMesh, createMesh } from '../../../materials/dist/index.js';
import { BoxCulledMeshes, BoxCulledModels, BoxDynamicInstances } from '../../dist/bounds.js';
const kind = new URLSearchParams(location.search).get('kind'),
  count = 24;
const json = await (await fetch('../assets/box/Box.gltf')).json(),
  bin = await (await fetch('../assets/box/Box0.bin')).arrayBuffer();
const read = (n, Type, size) => {
  const a = json.accessors[n],
    v = json.bufferViews[a.bufferView];
  return new Type(bin, (v.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * size);
};
const positions = Float32Array.from(read(2, Float32Array, 3), (v, i) => v * (i % 3 === 1 ? 8 : 0.05)),
  normals = read(1, Float32Array, 3),
  indices = read(0, Uint16Array, 1);
const shape = new Geometry(positions, normals, indices),
  data = { positions, normals, indices: new Uint32Array(indices) };
const camera = { fov: 50, near: 0.1, far: 100, position: [0, 0, 10], target: [0, 0, 0] };
const a = await Engine.create(document.querySelector('#a'), { capacity: 128, camera }),
  b = await Engine.create(document.querySelector('#b'), { capacity: 128, camera });
const walls = [a, b].map((e) =>
  e
    .createMesh()
    .setGeometry(box(18, 14, 0.2))
    .setMaterial(new PbrMaterial({ color: '#8899aa', doubleSided: true }))
    .setPosition([8, 0, 2]),
);
for (const wall of walls) wall.visible = false;
const at = (i) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 8 + ((i % 6) - 2.5) * 0.05, 0, -Math.floor(i / 6) * 0.05, 1];
let plugin,
  first,
  others = [];
if (kind === 'models') {
  for (const e of [a, b]) {
    const mesh = createInstancedMesh(e, data, new Material({ color: '#5588aa' }), count);
    for (let i = 0; i < count; i++) mesh.instances.setMatrixAt(i, at(i));
    const plain = createMesh(e, data, new Material({ color: '#aa8844' }));
    plain.root.setPosition([8.2, 0, 0]);
    if (e === a) {
      first = mesh;
      others.push(plain);
    } else others.push(mesh, plain);
  }
  plugin = BoxCulledModels.attach(a, [first, others[0]], { occlusion: true });
  plugin.addOccluder(walls[0]);
} else {
  const material = new PbrMaterial({ color: '#5588aa' });
  if (kind === 'dynamic') plugin = BoxDynamicInstances.attach(a, { geometry: shape, material, capacity: count });
  for (const e of [a, b])
    for (let i = 0; i < count; i++) {
      if (e === a && kind === 'dynamic') {
        plugin.addInstance(at(i));
        continue;
      }
      const mesh = e.createMesh().setGeometry(shape).setMaterial(material);
      mesh.setPosition(at(i).slice(12, 15));
    }
  if (kind === 'meshes') plugin = BoxCulledMeshes.attach(a, { occlusion: true });
}
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
window.check = {
  async step(i) {
    if (i === 1)
      for (const e of [a, b]) {
        e.camera.position = [8, 0, 10];
        e.camera.target = [8, 0, 0];
      }
    if (i === 2) for (const wall of walls) wall.visible = true;
    if (i === 3) for (const wall of walls) wall.visible = false;
    await draw();
    await draw();
    const result =
      kind === 'dynamic'
        ? await plugin.readCount()
        : [...(await plugin.readCounts()).values()].reduce((x, y) => x + y, 0);
    return { drawn: result, kind, compat: !!globalThis.__margoCompat };
  },
};
window.ready = true;
