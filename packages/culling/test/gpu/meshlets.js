// Browser side of meshlets-check.mjs: one bumpy ball as a MeshletMesh (A) and as a core mesh (B). Their frames must match, and
// the clusters must drop triangles that face away or leave the view. A and B draw without MSAA (`exactSize`): on the M6
// core's own 4x MSAA frame changes with the primitive stream (see meshlets-check.mjs). R is A again with MSAA, drawn only
// so the frame-repeat check still sees every MSAA edge.
import { box, Engine, Geometry, PbrMaterial } from '../../../core/dist/index.js';
import { MeshletMesh } from '../../dist/meshlets.js';
import { Shadows } from '../../../shadows/dist/index.js';

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
let a, b, r, mesh, again, core, geometry;
// A and B single-sampled at the canvas's CSS size (the page runs at device pixel ratio 1); R keeps the default MSAA.
const exact = { camera, exactSize: [480, 320] },
  create = async () => {
    a = await Engine.create(document.getElementById('a'), exact);
    b = await Engine.create(document.getElementById('b'), exact);
    r = await Engine.create(document.getElementById('r'), { camera });
    for (const e of [a, b, r]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  };
const draw = async () => {
  for (const e of [a, b, r]) e.render({ culling: false });
  await Promise.all([a, b, r].map((e) => e.gpu.queue.onSubmittedWorkDone()));
};
const look = (position, target = [0, 0, 0]) => {
  for (const e of [a, b, r]) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
const place = (m) => {
  core.setPosition([m[12], m[13], m[14]]);
  core.setScale([m[0], m[5], m[10]]);
  b.render({ culling: false });
  mesh.setTransform(0, 0, core.matrix);
  again.setTransform(0, 0, core.matrix);
};
async function setup() {
  await create();
  geometry = ball();
  const material = new PbrMaterial({ color: '#58a860', roughness: 0.5, doubleSided: false });
  core = b.createMesh().setGeometry(geometry).setMaterial(material);
  b.render({ culling: false });
  mesh = MeshletMesh.attach(a, [{ geometry, material, transforms: new Float32Array(core.matrix) }]);
  again = MeshletMesh.attach(r, [{ geometry, material, transforms: new Float32Array(core.matrix) }]);
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
  return {
    label,
    kept: await mesh.readTriangles(),
    total: geometry.indices.length / 3,
    clusters: mesh.meshlets.count,
    part: geometry.indices.length / 3,
  };
}
// Three balls as parts of one MeshletMesh, one of them mirrored, against three core meshes.
const spot = (x, z, flip = 1) => [flip, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];
const fresh = async () => {
  for (const e of [a, b, r]) e.dispose();
  for (const id of ['a', 'b', 'r']) {
    const old = document.getElementById(id),
      next = document.createElement('canvas');
    next.id = id;
    next.width = old.width;
    next.height = old.height;
    old.replaceWith(next);
  }
  await create();
};
async function instances() {
  await fresh();
  const material = new PbrMaterial({ color: '#58a860', roughness: 0.5, doubleSided: false }),
    places = [spot(-4, 0), spot(0, -2), spot(4, 0)],
    transforms = new Float32Array(places.flat());
  mesh = MeshletMesh.attach(a, [{ geometry, material, transforms }]);
  again = MeshletMesh.attach(r, [{ geometry, material, transforms }]);
  for (const m of places) b.createMesh().setGeometry(geometry).setMaterial(material).setPosition([m[12], m[13], m[14]]);
  look([0, 2, 11]);
  await draw();
  await draw();
  return {
    label: 'three parts',
    kept: await mesh.readTriangles(),
    total: (geometry.indices.length / 3) * 3,
    clusters: mesh.meshlets.count,
    part: geometry.indices.length / 3,
  };
}
// A ball with a wall hiding its left half, Hi-Z against none, and the same picture as core.
async function occlusion() {
  await fresh();
  const material = new PbrMaterial({ color: '#58a860', roughness: 0.5, doubleSided: true }),
    transforms = new Float32Array(spot(0, 0)),
    wall = (e) =>
      e
        .createMesh()
        .setGeometry(box(4, 8, 0.2))
        .setMaterial(new PbrMaterial({ color: '#c04030' }))
        .setPosition([-2, 0, 3]);
  const plain = MeshletMesh.attach(a, [{ geometry, material, transforms }]),
    first = wall(a);
  b.createMesh().setGeometry(geometry).setMaterial(material);
  wall(b);
  again = MeshletMesh.attach(r, [{ geometry, material, transforms }], { culling: 'occlusion' });
  again.addOccluder(wall(r));
  look([0, 0, 7]);
  await draw();
  await draw();
  const frustum = await plain.readTriangles();
  a.removePlugin(plain.name);
  plain.dispose?.();
  mesh = MeshletMesh.attach(a, [{ geometry, material, transforms }], { culling: 'occlusion' });
  mesh.addOccluder(first);
  await draw();
  await draw();
  await draw();
  return {
    label: 'behind a wall',
    occlusion: true,
    kept: await mesh.readTriangles(),
    total: frustum,
    clusters: mesh.meshlets.count,
    part: geometry.indices.length / 3,
  };
}
// A ball casting on a floor: the shadow frame keeps only clusters in each cascade, and the picture is core's.
async function shadowed() {
  await fresh();
  const material = new PbrMaterial({ color: '#58a860', roughness: 0.5, doubleSided: false }),
    floor = (e) =>
      e
        .createMesh()
        .setGeometry(box(40, 0.25, 40))
        .setMaterial(new PbrMaterial({ color: '#c8c8c8' }))
        .setPosition([0, -3, 0]),
    near = spot(0, 0),
    far = spot(30, 0);
  mesh = MeshletMesh.attach(a, [{ geometry, material, transforms: new Float32Array([...near, ...far]) }]);
  again = MeshletMesh.attach(r, [{ geometry, material, transforms: new Float32Array([...near, ...far]) }]);
  const ball = b.createMesh().setGeometry(geometry).setMaterial(material),
    other = b.createMesh().setGeometry(geometry).setMaterial(material).setPosition([30, 0, 0]);
  floor(a);
  floor(b);
  floor(r);
  const sa = Shadows.attach(a, { resolution: 1024, filter: 'hard', distance: 20, cascades: 1 }),
    sb = Shadows.attach(b, { resolution: 1024, filter: 'hard', distance: 20, cascades: 1 });
  Shadows.attach(r, { resolution: 1024, filter: 'hard', distance: 20, cascades: 1 }).add(again);
  sa.add(mesh);
  sb.add(ball);
  sb.add(other);
  look([0, 4, 12]);
  await draw();
  await draw();
  return {
    label: 'shadow pass',
    kept: await mesh.readShadowTriangles(0),
    total: (geometry.indices.length / 3) * 2,
    clusters: mesh.meshlets.count,
    part: geometry.indices.length / 3,
  };
}
// A square plate facing +z, 16 x 16 quads from -0.5 to 0.5, in a few clusters.
function plate(side = 16) {
  const positions = [],
    normals = [],
    indices = [];
  for (let y = 0; y <= side; y++)
    for (let x = 0; x <= side; x++) {
      positions.push(x / side - 0.5, y / side - 0.5, 0);
      normals.push(0, 0, 1);
    }
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const p = y * (side + 1) + x,
        q = p + side + 1;
      indices.push(p, p + 1, q, q, p + 1, q + 1);
    }
  return new Geometry(positions, normals, indices);
}
// Two-pass occlusion: a wall of 1,536 small tiles (each about 6 pixels in radius, under occluderSize, so no tile was ever
// drawn as a whole-part occluder) in front of a second wall of 640 tiles that it hides. The clusters the front tiles
// drew last frame are this frame's Hi-Z occluders, so the hidden tiles drop; the old cull kept them all.
async function twoPass() {
  await fresh();
  const tile = plate(),
    material = new PbrMaterial({ color: '#b07040', roughness: 0.6, doubleSided: false }),
    matrices = [];
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 48; x++)
      matrices.push([0.25, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, -5.875 + x * 0.25, -3.875 + y * 0.25, 0, 1]);
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 32; x++)
      matrices.push([0.25, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, -3.875 + x * 0.25, -2.375 + y * 0.25, -2, 1]);
  const transforms = new Float32Array(matrices.flat()),
    frustum = MeshletMesh.attach(a, [{ geometry: tile, material, transforms }]);
  for (const m of matrices)
    b.createMesh()
      .setGeometry(tile)
      .setMaterial(material)
      .setPosition([m[12], m[13], m[14]])
      .setScale([m[0], m[5], m[10]]);
  again = MeshletMesh.attach(r, [{ geometry: tile, material, transforms }], { culling: 'occlusion' });
  look([0, 0, 10]);
  await draw();
  await draw();
  const plain = await frustum.readTriangles();
  a.removePlugin(frustum.name);
  frustum.dispose?.();
  mesh = MeshletMesh.attach(a, [{ geometry: tile, material, transforms }], { culling: 'occlusion' });
  await draw();
  await draw();
  await draw();
  return {
    label: 'two-pass behind small tiles',
    occlusion: true,
    front: 1536 * (tile.indices.length / 3),
    kept: await mesh.readTriangles(),
    total: plain,
    clusters: mesh.meshlets.count,
    part: tile.indices.length / 3,
  };
}
// Three balls sharing a pool that holds about one ball's kept clusters: the parts past it draw their whole mesh, and
// the picture is still core's.
async function overflow() {
  await fresh();
  const material = new PbrMaterial({ color: '#58a860', roughness: 0.5, doubleSided: false }),
    places = [spot(-4, 0), spot(0, -2), spot(4, 0)],
    transforms = new Float32Array(places.flat()),
    full = MeshletMesh.attach(a, [{ geometry, material, transforms }]);
  for (const m of places) b.createMesh().setGeometry(geometry).setMaterial(material).setPosition([m[12], m[13], m[14]]);
  again = MeshletMesh.attach(r, [{ geometry, material, transforms }], { maxKeptTriangles: 30000 });
  look([0, 2, 11]);
  await draw();
  await draw();
  const unlimited = await full.readTriangles();
  a.removePlugin(full.name);
  full.dispose?.();
  mesh = MeshletMesh.attach(a, [{ geometry, material, transforms }], { maxKeptTriangles: 30000 });
  await draw();
  await draw();
  return {
    label: 'a pool too small for every part',
    kept: await mesh.readTriangles(),
    unlimited,
    total: (geometry.indices.length / 3) * 3,
    clusters: mesh.meshlets.count,
    part: geometry.indices.length / 3,
  };
}
// The same frame again with nothing changed: the kept clusters must come out in the same order, so the pixels repeat.
const redraw = () => draw();
window.check = { setup, step, steps: steps.length, errors, instances, occlusion, shadowed, twoPass, overflow, redraw };
window.ready = true;
