// Browser side of dynamic-check.mjs: engine A draws boxes through @margoengine/culling's DynamicInstances (GPU matrices,
// frustum culling and indirect draws through core's batch redirect), engine B draws the same boxes as plain core meshes
// with no culling. Same edits on both (moves, hides, deletes, adds, camera moves, shadows); picks are compared too.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { DynamicInstances } from '../../dist/dynamic.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 200, position: [14, 10, 18], target: [0, 0, 0] },
  side = 24,
  count = side * side,
  palette = [
    [0.9, 0.2, 0.1],
    [0.1, 0.6, 0.9],
    [0.95, 0.8, 0.2],
    [0.3, 0.85, 0.4],
  ];
let a, b, crowd, casters;
const meshes = [],
  ids = [];
const geometry = box(1, 1, 1);
// Core meshes take one material per colour; DynamicInstances one white material tinted per instance, so both shade
// with the same colour floats (1 times the tint).
const materials = palette.map((rgb) => {
  const m = new PbrMaterial({ color: '#ffffff', roughness: 0.5, metalness: 0.1, doubleSided: false });
  m.data.set(rgb, 0);
  return m;
});
const white = new PbrMaterial({ color: '#ffffff', roughness: 0.5, metalness: 0.1, doubleSided: false });
function place(mesh, i, t = 0) {
  const k = 0.4 + 0.2 * ((i * 7) % 3);
  mesh.setPosition([(i % side) - side / 2, 0.5 + 0.3 * Math.sin(i + t), Math.floor(i / side) - side / 2]);
  mesh.setRotation([0, i * 0.37 + t, 0]);
  mesh.setScale([k, k, k]);
}
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
// Each instance's matrix is read back from the core mesh after B's kernel computed it, so both draw the same floats.
const settle = () => b.render({ culling: false });
const add = (i, material, t) => {
  const mesh = b.createMesh().setGeometry(geometry).setMaterial(materials[material]);
  place(mesh, i, t);
  casters?.add(mesh);
  return mesh;
};
async function setup(withShadows) {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera, capacity: 2048 });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  crowd = DynamicInstances.attach(a, { geometry, material: white, capacity: count + 64 });
  for (let i = 0; i < count; i++) meshes.push(add(i, i % 4, 0));
  settle();
  for (let i = 0; i < count; i++) {
    ids.push(crowd.addInstance(meshes[i].matrix));
    crowd.setColorAt(ids[i], palette[i % 4]);
  }
  if (withShadows) {
    const { Shadows } = await import('../../../shadows/dist/index.js');
    const sa = Shadows.attach(a, { resolution: 1024, filter: 'hard', distance: 60 }),
      sb = Shadows.attach(b, { resolution: 1024, filter: 'hard', distance: 60 });
    sa.add(crowd);
    for (const mesh of meshes) sb.add(mesh);
    casters = sb;
  }
  await draw();
  return { count };
}
const look = (position, target = [0, 0, 0]) => {
  for (const e of [a, b]) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
const steps = [
  ['overview', () => {}],
  ['close view (most boxes outside the frustum)', () => look([2, 1.5, 3], [1, 0.5, 1])],
  [
    'move every 3rd box',
    () => {
      for (let i = 0; i < count; i += 3) place(meshes[i], i, 0.8);
      settle();
      for (let i = 0; i < count; i += 3) crowd.setMatrixAt(ids[i], meshes[i].matrix);
    },
  ],
  ['overview after moves', () => look([14, 10, 18])],
  [
    'hide every 5th box',
    () => {
      for (let i = 0; i < count; i += 5) {
        meshes[i].visible = false;
        crowd.setVisibleAt(ids[i], false);
      }
    },
  ],
  [
    'delete every 11th, show the hidden again',
    () => {
      for (let i = 0; i < count; i += 5) {
        meshes[i].visible = true;
        crowd.setVisibleAt(ids[i], true);
      }
      for (let i = 0; i < count; i += 11) {
        meshes[i].dispose();
        crowd.deleteInstance(ids[i]);
        meshes[i] = null;
      }
    },
  ],
  [
    'add boxes into deleted slots and past the end',
    () => {
      const added = [];
      for (let n = 0; n < 100; n++) {
        const i = n * 11 < count ? n * 11 : count + n;
        meshes[i] = add(i, (i + 1) % 4, 1.3);
        added.push(i);
      }
      settle();
      for (const i of added) {
        ids[i] = crowd.addInstance(meshes[i].matrix);
        crowd.setColorAt(ids[i], palette[(i + 1) % 4]);
      }
    },
  ],
  ['view from below', () => look([3, -6, 9])],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  return { label, drawn: await crowd.readCount(), alive: crowd.count };
}
// Picks over a grid: B returns a core mesh, A an instance index; both must name the same box.
async function picks() {
  look([14, 10, 18]);
  await draw();
  const out = [],
    canvas = document.getElementById('a');
  for (let y = 20; y < canvas.clientHeight; y += 40)
    for (let x = 20; x < canvas.clientWidth; x += 40) {
      const [p, q] = await Promise.all([crowd.pick(x, y), b.pick(x, y)]);
      out.push([p === null ? null : ids.indexOf(p), q ? meshes.indexOf(q) : null]);
    }
  return out;
}
// Bulk compaction on a third engine: 200,000 rows (782 blocks of 256) in a partial view, with hidden, deleted and
// non-finite rows. One list publishes block counts as usual; the other (wait 0) never reads them and counts every
// earlier block itself, the look-back fallback. Both must keep the same rows in row order, byte for byte.
// `drawn` has no COPY_SRC usage: a small compute pass copies its first `size` bytes into a buffer that can be mapped.
async function readBack(device, buffer, size) {
  if (!size) return new Uint8Array(0);
  const words = size / 4,
    out = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    module = device.createShaderModule({
      code: '@group(0) @binding(0) var<storage,read> a:array<u32>;@group(0) @binding(1) var<storage,read_write> o:array<u32>;@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g:vec3u){if(g.x<arrayLength(&o)){o[g.x]=a[g.x];}}',
    }),
    pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
    group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: { buffer: out } },
      ],
    }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(words / 256));
  pass.end();
  encoder.copyBufferToBuffer(out, 0, read, 0, size);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(read.getMappedRange().slice(0));
  read.unmap();
  read.destroy();
  out.destroy();
  return bytes;
}
async function bulk() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:256px;height:256px';
  document.body.append(canvas);
  const c = await Engine.create(canvas, { camera: { fov: 50, near: 0.1, far: 400, position: [0, 30, 60], target: [0, 0, 0] } });
  c.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  const n = 200_000,
    lists = [0, 1].map(() => DynamicInstances.attach(c, { geometry, material: white, capacity: n }));
  lists[1].wait = 0;
  // The WebGL2 layer draws these lists through the CPU route (compat.js, README "Moving objects"), which loads by import()
  // after attach; until it has, a frame runs the kernel on the layer's CPU tier, where the fallback alone (wait 0) counts
  // every earlier block again, 782 x 781 / 2 blocks, past the tier's work budget, so nothing it wrote lands. The case
  // starts once both routes are in, as an application's frames run after the first.
  if (globalThis.__margoCompat)
    for (let tries = 0; !lists.every((list) => list['route']); tries++) {
      if (tries === 300) throw new Error('the WebGL2 route of DynamicInstances did not load');
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  for (const list of lists) {
    for (let r = 0; r < n; r++) list.addInstance([0.2, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0.2, 0, (r % 500) * 0.5 - 125, 0, Math.floor(r / 500) * 0.5 - 100, 1]);
    for (let r = 0; r < n; r += 7) list.setVisibleAt(r, false);
    for (let r = 3; r < n; r += 17) list.deleteInstance(r);
    for (let r = 5; r < n; r += 13) list.matrices[r * 12 + 9] = Number.NaN;
    list.update();
  }
  c.render();
  await c.gpu.queue.onSubmittedWorkDone();
  const out = [];
  for (const list of lists) {
    const count = await list.readCount();
    out.push({ count, records: Array.from(await readBack(c.gpu, list.buffers.drawn, count * 96)) });
  }
  // Rows kept in increasing row order, each shown, alive and finite.
  const f = new Float32Array(new Uint8Array(out[0].records).buffer),
    kept = [];
  for (let k = 0; k < out[0].count; k++) kept.push(Math.round((f[k * 24 + 14] + 100) / 0.5) * 500 + Math.round((f[k * 24 + 12] + 125) / 0.5));
  const ordered = kept.every((r, k) => k === 0 || r > kept[k - 1]),
    shown = kept.every((r) => r % 7 !== 0 && (r - 3) % 17 !== 0 && (r - 5) % 13 !== 0);
  for (const list of lists) list.dispose();
  c.dispose();
  canvas.remove();
  return {
    alive: n - Math.ceil((n - 3) / 17),
    counts: out.map((o) => o.count),
    same: out[0].records.length === out[1].records.length && out[0].records.every((v, k) => v === out[1].records[k]),
    ordered,
    shown,
  };
}
// The check's control: hide the instance under the canvas centre in A only (true), or show it again (false). Returns
// the box's index, or null when no instance is there.
let hidden = null;
async function drop(on) {
  if (on) {
    const p = await crowd.pick(240, 160);
    hidden = p === null ? null : ids.indexOf(p);
    if (hidden !== null) crowd.setVisibleAt(ids[hidden], false);
  } else if (hidden !== null) crowd.setVisibleAt(ids[hidden], true);
  await draw();
  return hidden;
}
window.check = { setup, step, steps: steps.length, picks, drop, bulk, errors };
window.ready = true;
