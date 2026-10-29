// Browser side of culled-meshes.mjs: engine A draws core meshes through @margoengine/culling's CulledMeshes (GPU frustum
// culling, rendered with culling:false so the CPU does not cull), engine B is plain core drawing every part (no culling at
// all). Same scene, same edits (an exploded layout, moved, hidden and added parts); engine.pick runs on both.
import { Engine } from '../../../packages/core/dist/index.js';
import { CulledMeshes } from '../../../packages/culling/dist/index.js';
import { buildAssembly } from './assembly.js';

const errors = [],
  camera = { fov: 45, near: 0.05, far: 50, position: [2.2, 1.6, 2.6], target: [0, 0, 0] };
let a,
  b,
  culled,
  sides = [];
async function setup() {
  // A starts at 64 slots so it grows while the assembly is built.
  a = await Engine.create(document.getElementById('a'), { capacity: 64, camera });
  b = await Engine.create(document.getElementById('b'), { capacity: 64, camera });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  culled = CulledMeshes.attach(a);
  sides = [a, b].map((e) => {
    const assembly = buildAssembly(e, 24);
    return { e, assembly, explode: exploded(assembly.parts) };
  });
  await draw();
  return { parts: sides[0].assembly.parts.length, capacity: a.store.capacity };
}
// Moves each part out from the centre by `amount` of its offset (an exploded layout in plain core transforms).
function exploded(parts) {
  const rows = parts.map((p) => ({
    p,
    base: [p.position.x, p.position.y, p.position.z],
    offset: [p.matrix[12] * 0.4, 0.06 + (p.name === 'bolt' ? 0.08 : 0), p.matrix[14] * 0.4],
  }));
  return {
    set amount(amount) {
      for (const { p, base, offset } of rows) p.setPosition(base.map((v, axis) => v + offset[axis] * amount));
    },
  };
}
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
const look = (position, target = [0, 0, 0]) => {
  for (const { e } of sides) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
const steps = [
  ['overview', () => {}],
  ['close view (most parts outside the frustum)', () => look([0.35, 0.25, 0.45], [0.1, 0, 0.1])],
  [
    'explode 0.6',
    () => {
      for (const s of sides) s.explode.amount = 0.6;
    },
  ],
  ['side view, exploded', () => look([3.2, 0.4, 0.2])],
  [
    'move every 7th part',
    () => {
      for (const s of sides)
        s.assembly.parts.forEach((p, i) => {
          if (i % 7 === 0) p.position.y += 0.03;
        });
    },
  ],
  [
    'hide a module',
    () => {
      for (const s of sides) s.assembly.groups.find((g) => g.name === 'module').visible = false;
    },
  ],
  [
    'collapse, look from below',
    () => {
      for (const s of sides) s.explode.amount = 0;
      look([0.6, -1.4, 1.2]);
    },
  ],
  [
    'add parts (store grows)',
    () => {
      for (const s of sides)
        for (let i = 0; i < 400; i++)
          s.e
            .createMesh(s.assembly.groups[0])
            .setGeometry(s.assembly.geometries.washer)
            .setMaterial(s.assembly.materials.washer)
            .setPosition([0.02 * (i % 20) - 0.2, 0.3, 0.02 * Math.floor(i / 20) - 0.1]);
      look([0.5, 0.6, 0.7]);
    },
  ],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  const counts = await culled.readCounts();
  let drawn = 0;
  for (const n of counts.values()) drawn += n;
  return { label, drawn, submitted: a.stats.visible, capacity: a.store.capacity };
}
// engine.pick on both engines over a grid; ids match because both scenes were created in the same order.
async function picks() {
  const out = [],
    canvas = document.getElementById('a');
  for (let y = 40; y < canvas.clientHeight; y += 60)
    for (let x = 40; x < canvas.clientWidth; x += 60) {
      const [p, q] = await Promise.all([a.pick(x, y), b.pick(x, y)]);
      out.push([p?.id ?? null, q?.id ?? null]);
    }
  await draw();
  return out;
}
window.check = { setup, step, steps: steps.length, picks, errors };
window.ready = true;
