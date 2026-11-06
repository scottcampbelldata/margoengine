// Browser side of lod-check.mjs: rows of instances down a street, each level a smaller box. Engine A picks levels on the GPU;
// B holds the same scene as core meshes with the level worked out here. Rows sit on a 4-unit lattice, so no row is near a limit.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { LodInstances } from '../../dist/lod.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 400, position: [0, 3, 30], target: [0, 3, 0] },
  sizes = [1, 0.8, 0.6],
  limits = [20, 8, 3],
  geometries = sizes.map((s) => box(s, s, s)),
  color = new PbrMaterial({ color: '#3a8fd8', roughness: 0.6, doubleSided: false }),
  columns = 11,
  rows = 29,
  count = columns * rows,
  place = (n) => [((n % columns) - 5) * 3, 0.5, 24 - Math.floor(n / columns) * 4],
  matrix = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const spots = Array.from({ length: count }, (_, n) => place(n)),
  shown = new Array(count).fill(true);
let a, b, lod, meshes, eye;
const draw = async () => {
  for (const e of [a, b]) e.render({ culling: false });
  await Promise.all([a, b].map((e) => e.gpu.queue.onSubmittedWorkDone()));
};
// The level of an instance by its depth along the view, as the kernel does; -1 draws nothing.
function level(n) {
  const w = eye - spots[n][2];
  if (w <= 0) return -2;
  const radius = (geometries[0].bounds[3] * (b.canvas.clientHeight / 2 / Math.tan((25 * Math.PI) / 180))) / w;
  return limits.findIndex((limit) => radius >= limit);
}
function sync() {
  const drawn = [0, 0, 0];
  meshes.forEach((mesh, n) => {
    const l = level(n);
    mesh.visible = shown[n] && l >= 0;
    if (l >= 0) mesh.setGeometry(geometries[l]);
    if (mesh.visible) drawn[l]++;
    mesh.setPosition(spots[n]);
  });
  return drawn;
}
const move = (z) => {
  eye = z;
  for (const e of [a, b]) {
    e.camera.position = [0, 3, z];
    e.camera.target = [0, 3, z - 30];
  }
};
async function setup() {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera, capacity: 2048 });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  const transforms = new Float32Array(count * 16);
  spots.forEach((spot, n) => transforms.set(matrix(spot), n * 16));
  lod = LodInstances.attach(a, {
    levels: geometries.map((geometry, l) => ({ geometry, minRadius: limits[l] })),
    material: color,
    transforms,
  });
  meshes = spots.map(() => b.createMesh().setGeometry(geometries[0]).setMaterial(color));
  eye = 30;
}
const steps = [
  ['start', () => {}],
  ['closer', () => move(22)],
  ['back', () => move(46)],
  [
    'hide every 4th',
    () => {
      for (let n = 0; n < count; n += 4) {
        shown[n] = false;
        lod.setVisible(n, false);
      }
    },
  ],
  [
    'moved to the far end',
    () => {
      spots[1][2] = spots[count - 1][2];
      lod.setTransform(1, matrix(spots[1]));
    },
  ],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  const expected = sync();
  await draw();
  await draw();
  return { label, counts: await lod.readCounts(), expected };
}
window.check = { setup, step, steps: steps.length, errors };
window.ready = true;
