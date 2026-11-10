import { Engine, Geometry, PbrMaterial, box } from '../../../core/dist/index.js';
import { WebGL2Culling } from '../../dist/webgl2.js';
const json = await (await fetch('../assets/box/Box.gltf')).json();
const bin = await (await fetch('../assets/box/Box0.bin')).arrayBuffer();
const read = (n, Type, size) => {
  const a = json.accessors[n],
    v = json.bufferViews[a.bufferView];
  return new Type(bin, (v.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * size);
};
const shape = new Geometry(read(2, Float32Array, 3), read(1, Float32Array, 3), read(0, Uint16Array, 1));
const a = await Engine.create(document.querySelector('#a'), {
  capacity: 256,
  camera: { position: [0, 1, 20], target: [0, 0, 0], near: 0.1, far: 200 },
});
const b = await Engine.create(document.querySelector('#b'), {
  capacity: 256,
  camera: { position: [0, 1, 20], target: [0, 0, 0], near: 0.1, far: 200 },
});
const walls = [],
  lists = [];
for (const e of [a, b]) {
  walls.push(
    e
      .createMesh()
      .setGeometry(box(18, 12, 0.5))
      .setMaterial(new PbrMaterial({ color: '#aabbcc', doubleSided: true }))
      .setPosition([0, 0, 5]),
  );
  const list = [];
  for (let i = 0; i < 80; i++)
    list.push(
      e
        .createMesh()
        .setGeometry(shape)
        .setMaterial(new PbrMaterial({ color: i % 2 ? '#ad2525' : '#2594bd' }))
        .setPosition([((i % 10) - 4.5) * 0.8, (Math.floor(i / 10) - 3.5) * 0.6, -Math.floor(i / 20)]),
    );
  lists.push(list);
}
const plugin = WebGL2Culling.attach(a, { resolution: 128 });
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
window.check = {
  async step(i) {
    if (i === 1) for (const wall of walls) wall.setPosition([30, 0, 5]);
    if (i === 2) for (const wall of walls) wall.setPosition([0, 0, 5]);
    if (i === 3)
      for (const e of [a, b]) {
        e.camera.position = [15, 3, 10];
        e.camera.target = [0, 0, -2];
      }
    if (i === 4)
      for (const e of [a, b]) {
        e.camera.position = [0, 0, 0];
        e.camera.target = [0, 0, -10];
      }
    if (i === 5) plugin.enabled = false;
    await draw();
    return { drawn: [...plugin.readCounts().values()].reduce((x, y) => x + y, 0), total: 81 };
  },
  async dispose() {
    plugin.dispose();
    await draw();
  },
  a,
  b,
};
window.ready = true;
