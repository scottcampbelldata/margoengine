import { PbrMaterial } from '@margoengine/core';
import { parametricGeometry, roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, torusGeometry, tubeGeometry } from '@margoengine/geometry/primitives';
import { CatmullRomCurve3 } from '@margoengine/geometry/shapes';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { capacity, feed, gateDrop, gatePivot, gateReach, gauge, marbleRadius, queues, railCenterDrop, railRadius,
  trayFloor, trayX } from './motion.js';

const turn = 2 * Math.PI;
const mix = (a, b, t) => a + (b - a) * t;
const order = { left: '#b54d35', right: '#286e76' };
const unit = (value) => {
  const length = Math.hypot(...value);
  return value.map((lane) => lane / length);
};

function railPoint(points, index, side) {
  const here = points[index];
  const before = points[Math.max(0, index - 1)];
  const after = points[Math.min(points.length - 1, index + 1)];
  const direction = unit(after.map((coordinate, i) => coordinate - before[i]));
  const up = unit(direction.map((coordinate, i) => (i === 1 ? 1 : 0) - coordinate * direction[1]));
  const across = unit([direction[2], 0, -direction[0]]);
  return here.map((coordinate, i) => coordinate + across[i] * gauge * side - up[i] * railCenterDrop);
}

function rail(points, side, samples = 100) {
  const lane = points.map((_, index) => railPoint(points, index, side));
  return tubeGeometry(new CatmullRomCurve3(lane), samples, railRadius, 12);
}

function swirlSections() {
  const separators = [0, .034, .089, .427, .462, .58, 1];
  const mesh = (from, to) => {
    const part = parametricGeometry((u, v) => {
      const latitude = Math.PI * u;
      const twist = .95 * Math.sin(latitude - .75) + .22 * Math.sin(2 * latitude + .27);
      const rag = .10 * Math.sin(5 * latitude + .4);
      const longitude = mix(from, to, v) * turn + twist + rag;
      return [marbleRadius * Math.cos(longitude) * Math.sin(latitude), marbleRadius * Math.cos(latitude),
        -marbleRadius * Math.sin(longitude) * Math.sin(latitude)];
    }, 36, Math.max(5, Math.round(64 * (to - from))));
    // All ribbons meet flush and share the same spherical normal through the material boundaries.
    for (let lane = 0; lane < part.positions.length; lane++) part.normals[lane] = part.positions[lane] / marbleRadius;
    return toGeometry(part);
  };
  return separators.slice(0, -1).map((current, i) => mesh(current, separators[i + 1]));
}

export function createMachine(engine, shadows) {
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const enameledBase = finish('#294745', .49);
  const edgeCoat = finish('#52625d', .49);
  const darkSteel = finish('#5b6561', .41, .54);
  const brass = finish('#ad8146', .29, .68);
  const brassEdge = finish('#d8aa68', .24, .68);
  const satinBrass = finish('#9f8055', .44, .58);
  const brightMetal = finish('#aeb3a6', .30, .61);
  const graphite = finish('#434643', .7);
  const paper = finish('#c5c1b1', .88);
  const ivory = finish('#ddd1ad', .6);
  const sideFinish = Object.fromEntries(Object.entries(order).map(([side, color]) => [side, finish(color, .44)]));
  let meshes = 0;

  function mount(data, material, position, options = {}) {
    const shape = 'uvs' in data ? toGeometry(data) : data;
    const mesh = engine.createMesh(options.parent).setGeometry(shape).setMaterial(material).setPosition(position);
    if (options.rotation) mesh.setQuaternion(options.rotation);
    if (options.caster) shadows.add(mesh, { static: options.caster === 'static' });
    meshes++;
    return mesh;
  }
  const block = (x, y, z, bevel) => toGeometry(roundedBoxGeometry(x, y, z, 3, bevel));
  const box = (size, bevel, material, at, options) => mount(block(...size, bevel), material, at, options);
  const cylinder = (width, height, material, at, options) => mount(
    cylinderGeometry(width, width, height, 25, 1), material, at, options);
  const staticCaster = { caster: 'static' };
  const zero = [0, 0, 0];
  const horizontalRing = { rotation: axisAngleToQuaternion([1, 0, 0], -Math.PI / 2) };

  box([1.48, .074, 1.35], .032, enameledBase, [0, -.02, .005], staticCaster);
  box([1.39, .013, 1.263], .006, brightMetal, [0, .019, .005]);
  box([1.368, .018, 1.239], .008, enameledBase, [0, .028, .005]);
  box([100, .12, 100], .015, paper, [0, -.131, 0]);
  const foot = toGeometry(cylinderGeometry(.053, .057, .036, 28, 2));
  for (const x of [-.58, .58]) for (const z of [-.48, .49]) mount(foot, graphite, [x, -.0525, z], staticCaster);

  // Independent feet and a central service plate support the rail assembly.
  box([.32, .020, .31], .012, edgeCoat, [0, .043, .088], staticCaster);
  const screwHead = toGeometry(cylinderGeometry(.0086, .0086, .006, 16, 1));
  const screwSlot = block(.011, .0012, .0022, .0005);
  function screw(x, y, z, yaw) {
    mount(screwHead, brightMetal, [x, y, z]);
    mount(screwSlot, graphite, [x, y + .0031, z], { rotation: axisAngleToQuaternion([0, 1, 0], yaw) });
  }
  for (const x of [-.133, .133]) for (const z of [-.042, .215]) screw(x, .056, z, 4 * (x - z));
  box([.104, .009, .017], .003, satinBrass, [0, .059, .208]);

  const boltBase = toGeometry(cylinderGeometry(.048, .051, .015, 32, 1));
  const boltRing = toGeometry(cylinderGeometry(.027, .027, .019, 23, 1));
  const mountingBar = block(.081, .013, .018, .005);
  function post(point, withCollar = true) {
    const [x, y, z] = point;
    const cap = y - railCenterDrop - railRadius;
    cylinder(.0122, cap - .053, darkSteel, [x, (cap + .053) * .5, z], staticCaster);
    mount(boltBase, edgeCoat, [x, .043, z], staticCaster);
    mount(boltRing, satinBrass, [x, .055, z]);
    mount(mountingBar, brass, [x, cap - .002, z]);
    if (withCollar) mount(boltRing, brass, [x, cap - .031, z]);
  }
  for (const index of [2, 37, 67, 104]) post(feed.steps[index]);
  for (const { path } of Object.values(queues)) for (const index of [33, 67]) post(path.steps[index]);
  for (const face of [-1, 1]) {
    mount(rail(feed.steps, face, 156), brassEdge, zero, staticCaster);
    for (const { path } of Object.values(queues)) mount(rail(path.steps, face, 96), brass, zero, staticCaster);
  }

  const [px, py, pz] = gatePivot;
  post(gatePivot, false);
  cylinder(.052, .028, satinBrass, [px, py - .082, pz], staticCaster);
  cylinder(.039, .043, darkSteel, [px, py - .054, pz], staticCaster);
  cylinder(.033, .013, brassEdge, [px, py - .030, pz], staticCaster);
  const washer = toGeometry(torusGeometry(.048, .004, 10, 54));
  mount(washer, brightMetal, [px, py - .069, pz], horizontalRing);
  for (const sign of [-1, 1]) {
    const center = queues[sign < 0 ? 'left' : 'right'].tip;
    box([.077, .020, .044], .007, sideFinish[sign < 0 ? 'left' : 'right'],
      [center[0], center[1] - .057, center[2] + .012], staticCaster);
  }

  const gate = engine.createMesh().setPosition(gatePivot);
  const bridge = [[0, 0, 0], [0, -gateDrop, gateReach]];
  for (const face of [-1, 1]) mount(rail(bridge, face, 18), brightMetal, zero, { parent: gate });
  box([.066, .018, .032], .008, darkSteel, [0, -.040, .037], { parent: gate });
  box([.070, .014, .027], .006, brass, [0, -.063, .111], { parent: gate });
  const lever = toGeometry(cylinderGeometry(.009, .009, .13, 20, 1));
  mount(lever, brassEdge, [.083, -.055, .004], { parent: gate, rotation: axisAngleToQuaternion([0, 0, 1], Math.PI / 2) });
  box([.045, .035, .034], .011, graphite, [.155, -.055, .004], { parent: gate });
  box([.026, .004, .019], .002, ivory, [.155, -.035, .004], { parent: gate });
  shadows.add(gate);

  for (const side of ['left', 'right']) {
    const x = trayX * (side === 'left' ? -1 : 1);
    box([.278, .020, .285], .0095, satinBrass, [x, .044, .469], staticCaster);
    box([.252, .015, .246], .007, graphite, [x, trayFloor - .0075, .469]);
    box([.270, .040, .017], .007, sideFinish[side], [x, .073, .602], staticCaster);
    for (const sign of [-1, 1]) {
      box([.017, .035, .251], .006, brass, [x + .128 * sign, .069, .470], staticCaster);
      screw(x + .104 * sign, .095, .601, .51 * sign);
    }
    for (const offset of [-.065, 0, .065]) for (const z of [.481, .554]) {
      mount(toGeometry(torusGeometry(.022, .0015, 8, 24)), edgeCoat,
        [x + offset, trayFloor + .001, z], horizontalRing);
    }
  }

  // A feed latch and spare ball rack make the function of the upper assembly visible.
  const [sx, sy, sz] = feed.steps[0];
  cylinder(.059, .028, graphite, [sx, sy - .043, sz], staticCaster);
  mount(washer, brass, [sx, sy - .031, sz], horizontalRing);
  box([.088, .014, .067], .008, brightMetal, [sx, sy - .064, sz + .020], staticCaster);
  const pin = engine.createMesh().setPosition([sx, sy - .003, sz + .032]);
  mount(toGeometry(cylinderGeometry(.006, .006, .086, 20, 1)), satinBrass, zero,
    { parent: pin, rotation: axisAngleToQuaternion([0, 0, 1], Math.PI / 2) });
  mount(toGeometry(cylinderGeometry(.019, .019, .022, 25, 1)), sideFinish.left, [-.042, 0, 0],
    { parent: pin, rotation: axisAngleToQuaternion([0, 0, 1], Math.PI / 2) });
  shadows.add(pin);
  box([.270, .024, .083], .010, darkSteel, [-.330, .484, -.158], staticCaster);
  box([.277, .013, .089], .006, brass, [-.330, .499, -.158]);
  for (const x of [-.426, -.237]) {
    cylinder(.0122, .431, darkSteel, [x, .262, -.158], staticCaster);
    mount(boltRing, satinBrass, [x, .055, -.158]);
    mount(boltBase, edgeCoat, [x, .043, -.158], staticCaster);
  }
  const cradle = toGeometry(torusGeometry(.022, .004, 8, 36));
  for (const x of [-.407, -.331, -.254]) mount(cradle, satinBrass, [x, .507, -.158], horizontalRing);

  const glasses = [
    ['#b94c36', '#f1d2a5', '#8f3124', '#e7b078', '#dd794c', '#bd5637'],
    ['#23667b', '#a4d7c0', '#2b6173', '#dfddae', '#56a194', '#27667d'],
    ['#a6752e', '#f7e4ad', '#926227', '#edda9c', '#d4863e', '#bc8c38'],
    ['#367957', '#e4d688', '#315c47', '#dde2af', '#6e9a68', '#367f64'],
  ].map((shell) => shell.map((color) => finish(color, .165)));
  const sections = swirlSections();
  const makeBall = (index) => {
    const root = engine.createMesh();
    const children = sections.map((section, i) => mount(section, glasses[index % glasses.length][i], zero, { parent: root }));
    shadows.add(root);
    let visible = true;
    return { pose(show, position, rotation) {
      if (visible !== show) {
        visible = show;
        for (const child of children) child.visible = show;
      }
      if (show) root.setPosition(position).setQuaternion(rotation);
    }};
  };
  const marbles = Array.from({ length: capacity * 2 }, (_, index) => makeBall(index));
  for (let i = 0; i < 3; i++) makeBall(i + 1).pose(true, [-.407 + i * .076, .531, -.158],
    axisAngleToQuaternion([0, 1, 0], i * .74 - .65));
  const initial = feed.steps[0];
  return {
    get meshCount() { return meshes; },
    apply(state) {
      gate.setRotation([0, state.angle, 0]);
      const retract = state.marble?.stage === 'feed' && state.marble.distance < .07 ? .045 : 0;
      pin.setPosition([sx - retract, sy - .003, sz + .032]);
      const moving = state.marble;
      for (let i = 0; i < marbles.length; i++) {
        const item = i === moving?.index ? moving : state.settled[i];
        if (item) marbles[i].pose(true, item.position, item.rotation);
        else marbles[i].pose(i === state.next && state.canDrop, initial, axisAngleToQuaternion([0, 1, 0], i * 1.21));
      }
    },
  };
}
