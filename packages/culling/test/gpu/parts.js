// Browser side of parts-check.mjs: engine A draws boxes as CulledParts parts, engine B the same boxes as core meshes,
// over one core floor each. Each batch holds one colour and spare slots. Positions sit on a grid of eighths, so the sum
// of a parent's translation and a child's stays exact and both engines hold the same floats.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { CulledParts } from '../../dist/parts.js';

const errors = [],
  camera = { fov: 50, near: 0.1, far: 200, position: [14, 10, 18], target: [0, 0, 0] },
  side = 20,
  count = side * side,
  colors = ['#e6331a', '#1a99e6', '#f2cc33', '#4dd966'],
  geometry = box(1, 1, 1),
  materials = colors.map((color) => new PbrMaterial({ color, roughness: 0.5, metalness: 0.1, doubleSided: false }));
let a, b, parts, casters, expected;
// One record per box: where it is on both engines.
const boxes = [];
const home = (n) => [(n % side) - side / 2, 1 + ((n % 5) * 2) / 8, Math.floor(n / side) - side / 2];
const translated = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const addMesh = (entry) => {
  const mesh = b.createMesh().setGeometry(geometry).setMaterial(materials[entry.batch]);
  mesh.setPosition(entry.position);
  casters?.add(mesh);
  entry.mesh = mesh;
};
const draw = async () => {
  a.render({ culling: false });
  b.render({ culling: false });
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
async function setup(withShadows, culling) {
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera, capacity: 2048 });
  for (const e of [a, b]) e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  const per = colors.map(() => []);
  for (let n = 0; n < count; n++) {
    const batch = n % 4,
      entry = { batch, index: per[batch].length / 16, position: home(n) };
    per[batch].push(...translated(entry.position));
    boxes.push(entry);
  }
  parts = CulledParts.attach(
    a,
    per.map((list, i) => ({
      geometry,
      material: materials[i],
      transforms: new Float32Array(list),
      capacity: list.length / 16 + 32,
    })),
    { culling },
  );
  const floors = [a, b].map((e) => {
    const floor = e.createMesh().setGeometry(box(40, 0.25, 40));
    floor.setMaterial(new PbrMaterial({ color: '#c8c8c8', roughness: 0.9, doubleSided: false }));
    floor.setPosition([0, -0.5, 0]);
    return floor;
  });
  if (withShadows) {
    const { Shadows } = await import('../../../shadows/dist/index.js');
    const sa = Shadows.attach(a, { resolution: 1024, filter: 'hard', distance: 60 }),
      sb = Shadows.attach(b, { resolution: 1024, filter: 'hard', distance: 60 });
    sa.add(parts);
    casters = sb;
  }
  for (const entry of boxes) addMesh(entry);
  void floors;
  expected = count;
  await draw();
}
const look = (position, target = [0, 0, 0]) => {
  for (const e of [a, b]) {
    e.camera.position = position;
    e.camera.target = target;
  }
};
const live = () => boxes.filter((entry) => entry.mesh);
const steps = [
  ['overview', () => {}],
  [
    'hide every 5th',
    () => {
      live().forEach((entry, n) => {
        if (n % 5) return;
        entry.mesh.visible = false;
        parts.setVisible(entry.batch, entry.index, false);
      });
    },
  ],
  [
    'show them again, hide one as a group node, hang every 7th on it, move the node',
    () => {
      live().forEach((entry, n) => {
        if (n % 5) return;
        entry.mesh.visible = true;
        parts.setVisible(entry.batch, entry.index, true);
      });
      const node = boxes[0];
      node.mesh.visible = false;
      parts.setVisible(node.batch, node.index, false);
      parts.setTransform(node.batch, node.index, translated([0, 0, 0]));
      for (let n = 7; n < count; n += 7) {
        parts.setParent(boxes[n].batch, boxes[n].index, node);
        boxes[n].position = [boxes[n].position[0], boxes[n].position[1] + 2, boxes[n].position[2]];
        boxes[n].mesh.setPosition(boxes[n].position);
      }
      parts.setTransform(node.batch, node.index, translated([0, 2, 0]));
    },
  ],
  [
    'detach half of them: they keep their world place',
    () => {
      for (let n = 7; n < count; n += 14) parts.setParent(boxes[n].batch, boxes[n].index, null);
    },
  ],
  [
    'remove a range of each batch',
    () => {
      for (let batch = 0; batch < 4; batch++) {
        const gone = boxes.filter((e) => e.batch === batch && e.mesh && e.index >= 20 && e.index < 40);
        for (const entry of gone) {
          if (entry !== boxes[0]) parts.setParent(batch, entry.index, null);
          entry.mesh.dispose();
          entry.mesh = null;
        }
        parts.removeParts(
          batch,
          gone.map((e) => e.index),
        );
        expected -= gone.length;
      }
    },
  ],
  [
    'add into the freed slots and the spare ones',
    () => {
      for (let batch = 0; batch < 4; batch++) {
        const positions = [],
          fresh = [];
        for (let k = 0; k < 40; k++) {
          const position = [k - 20, 4 + batch, -14 - batch];
          positions.push(...translated(position));
          fresh.push({ batch, position });
        }
        parts.addParts(batch, new Float32Array(positions)).forEach((index, k) => {
          fresh[k].index = index;
          addMesh(fresh[k]);
          boxes.push(fresh[k]);
        });
        expected += fresh.length;
      }
    },
  ],
  ['close view', () => look([2, 3, 6], [1, 1, 1])],
];
async function step(i) {
  const [label, edit] = steps[i];
  edit();
  await draw();
  const counts = await parts.readCounts();
  return { label, alive: parts.count, expected, drawn: counts.reduce((x, y) => x + y, 0) };
}
// Picks over a grid: B returns a core mesh, A a part; both must name the same box. The floor counts as no box.
async function picks() {
  look([14, 10, 18]);
  await draw();
  const out = [],
    canvas = document.getElementById('a'),
    live = boxes.filter((entry) => entry.mesh);
  for (let y = 20; y < canvas.clientHeight; y += 30)
    for (let x = 20; x < canvas.clientWidth; x += 30) {
      const [p, q] = await Promise.all([parts.pick(x, y), b.pick(x, y)]);
      out.push([
        p === null ? null : live.findIndex((e) => e.batch === p.batch && e.index === p.index),
        q ? live.findIndex((e) => e.mesh === q) : null,
      ]);
    }
  return out.map(([p, q]) => [p, q === -1 ? null : q]);
}
window.check = { setup, step, steps: steps.length, picks, errors };
window.ready = true;
