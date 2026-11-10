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
let a, b, lod, meshes, eye, compat;
const draw = async () => {
  for (const e of [a, b]) e.render({ culling: false });
  await Promise.all([a, b].map((e) => e.gpu.queue.onSubmittedWorkDone()));
};
// The level of an instance by its depth along the view, as the kernel does; -1 draws nothing. The WebGL2 layer (compat)
// has no compute and draws every shown instance at the first level.
function level(n) {
  if (compat) return 0;
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
async function setup(onCompat = false) {
  compat = onCompat;
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
// The same frame again with nothing changed: each level's instances must come out in the same order.
const redraw = () => draw();
// Each level's drawn list as instance numbers, read back from the GPU (column 3 of each record's matrix is its spot).
async function order() {
  const counts = await lod.readCounts(),
    d = a.gpu,
    out = [];
  for (const [l, level] of lod['levels'].entries()) {
    const size = Math.max(counts[l] * 96, 4),
      staging = d.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      encoder = d.createCommandEncoder();
    encoder.copyBufferToBuffer(level.drawn, 0, staging, 0, size);
    d.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    out.push(
      Array.from({ length: counts[l] }, (_, k) =>
        spots.findIndex((s) => s[0] === f[k * 24 + 12] && s[2] === f[k * 24 + 14]),
      ),
    );
  }
  return out;
}
window.check = { setup, step, steps: steps.length, errors, redraw, order };
window.ready = true;
