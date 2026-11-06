// Browser side of occluders-check.mjs: engine A culls parts in occlusion mode with a core wall, a materials wall and a
// terrain hill as occluders; engine B has the same scene with the parts as core meshes. Frames must match.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { boxGeometry } from '../../../geometry/dist/index.js';
import { Terrain } from '../../../terrain/dist/index.js';
import { CulledParts } from '../../dist/parts.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 300, position: [0, 4, 36], target: [0, 2, 0] },
  side = 24,
  count = side * side,
  small = box(0.8, 0.8, 0.8),
  paint = new PbrMaterial({ color: '#e6331a', roughness: 0.5, doubleSided: false });
let a, b, parts, walls, mover;
const place = (n) => [(n % side) - side / 2, 1 + (n % 3), -Math.floor(n / side)];
const hills = (device) => {
  // A ridge between the two walls, in front of the crowd: 120 units over 64 texels, around z = 12 and |x| < 7.
  const size = 64,
    heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const wx = -60 + (x * 120) / (size - 1),
        wz = -60 + (y * 120) / (size - 1);
      heights[y * size + x] = Math.abs(wx) < 7 && Math.abs(wz - 12) < 3 ? 1 : 0;
    }
  // 6 = TEXTURE_BINDING | COPY_DST.
  const heightmap = device.createTexture({ size: [size, size], format: 'r32float', usage: 6 });
  device.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: size * 4 }, [size, size]);
  const layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
  device.queue.writeTexture(
    { texture: layers },
    new Uint8Array([60, 120, 40, 255, 110, 110, 100, 255, 120, 90, 60, 255, 240, 245, 255, 255]),
    { bytesPerRow: 4, rowsPerImage: 1 },
    [1, 1, 4],
  );
  return { heightmap, layers };
};
const scenery = (e) => {
  const core = e.createMesh().setGeometry(box(30, 16, 1)).setMaterial(new PbrMaterial({ color: '#8d99a6', doubleSided: false }));
  core.setPosition([-16, 6, 12]);
  const model = createMesh(e, boxGeometry(30, 16, 1), new Material({ color: '#6d8fa0' }));
  model.root.setPosition([16, 6, 12]);
  const terrain = Terrain.attach(e, {
    resolution: 32,
    levels: 4,
    cellSize: 2,
    origin: [-60, -60],
    size: [120, 120],
    heightScale: 6,
    layers: [
      { height: [-20, 100], slope: [0, 0.3], scale: 0.3 },
      { height: [-20, 100], slope: [0.2, 1], scale: 0.2 },
      { height: [-20, 2], slope: [0, 0.4], scale: 0.4 },
      { height: [10, 100], slope: [0, 0.5], scale: 0.2 },
    ],
    textures: hills,
  });
  return { core, model, terrain };
};
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
const look = (position, target = [0, 2, 0]) => {
  for (const e of [a, b]) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
async function setup() {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera, capacity: 2048 });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  const transforms = new Float32Array(count * 16);
  for (let n = 0; n < count; n++) {
    transforms.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...place(n), 1], n * 16);
    b.createMesh().setGeometry(small).setMaterial(paint).setPosition(place(n));
  }
  parts = CulledParts.attach(a, [{ geometry: small, material: paint, transforms }], { culling: 'occlusion' });
  walls = [scenery(a), scenery(b)];
  parts.addOccluder(walls[0].core).addOccluder(walls[0].model).addOccluder(walls[0].terrain);
  mover = walls;
  await draw();
  await draw();
}
const steps = [
  ['behind the walls', () => {}],
  ['still', () => {}],
  ['high up, over the walls', () => look([0, 34, 30], [0, 0, -10])],
  ['behind them again', () => look([0, 4, 36])],
  [
    'the core wall hidden',
    () => {
      for (const w of mover) w.core.visible = false;
    },
  ],
  [
    'it comes back and the materials wall moves away',
    () => {
      for (const w of mover) {
        w.core.visible = true;
        w.model.root.setPosition([60, 6, 12]);
      }
    },
  ],
  ['from behind the crowd, walls edge-on to nothing', () => look([0, 6, -40], [0, 2, 0])],
  ['removed occluders: the image still matches', () => {
    parts.removeOccluder(walls[0].core);
    look([0, 4, 36]);
  }],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  await draw();
  const counts = await parts.readCounts();
  return { label, drawn: counts[0], total: count };
}
window.check = { setup, step, steps: steps.length, errors };
window.ready = true;
