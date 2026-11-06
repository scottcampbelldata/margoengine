// Browser side of meshlets-check.mjs: one bumpy ball as a MeshletMesh (A) and as a core mesh (B). Their frames must match, and
// the clusters must drop triangles that face away or leave the view.
import { Engine, Geometry, PbrMaterial } from '../../../core/dist/index.js';
import { MeshletMesh } from '../../dist/meshlets.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 100, position: [0, 1, 7], target: [0, 0, 0] },
  bands = 96,
  around = 192;
// Latitude and longitude rings with a ripple, so triangles differ and none are coplanar.
function ball() {
  const positions = [],
    normals = [],
    indices = [];
  for (let y = 0; y <= bands; y++)
    for (let x = 0; x <= around; x++) {
      const a = (y / bands) * Math.PI,
        b = (x / around) * Math.PI * 2,
        r = 2 + 0.08 * Math.sin(a * 9) * Math.cos(b * 7),
        unit = [Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b)];
      positions.push(unit[0] * r, unit[1] * r, unit[2] * r);
      normals.push(...unit);
    }
  for (let y = 0; y < bands; y++)
    for (let x = 0; x < around; x++) {
      const p = y * (around + 1) + x,
        q = p + around + 1;
      indices.push(p, p + 1, q, q, p + 1, q + 1);
    }
  return new Geometry(positions, normals, indices);
}
let a, b, mesh, core, geometry;
const draw = async () => {
  for (const e of [a, b]) e.render({ culling: false });
  await Promise.all([a, b].map((e) => e.gpu.queue.onSubmittedWorkDone()));
};
const look = (position, target = [0, 0, 0]) => {
  for (const e of [a, b]) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
const place = (m) => {
  core.setPosition([m[12], m[13], m[14]]);
  core.setScale([m[0], m[5], m[10]]);
  b.render({ culling: false });
  mesh.setTransform(0, 0, core.matrix);
};
async function setup() {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  geometry = ball();
  const material = new PbrMaterial({ color: '#58a860', roughness: 0.5, doubleSided: false });
  core = b.createMesh().setGeometry(geometry).setMaterial(material);
  b.render({ culling: false });
  mesh = MeshletMesh.attach(a, [
    { geometry, material, transforms: new Float32Array(core.matrix) },
  ]);
}
const steps = [
  ['whole ball: the far side drops', () => {}],
  ['close: most of it leaves the view', () => look([0.5, 0.4, 2.6], [1.5, 0.6, 1])],
  ['to the side', () => look([7, 0, 0])],
  ['moved', () => place([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 1, -3, 1])],
  ['uneven scale', () => place([2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  await draw();
  return { label, kept: await mesh.readTriangles(), total: geometry.indices.length / 3, clusters: mesh.meshlets.count };
}
window.check = { setup, step, steps: steps.length, errors };
window.ready = true;
