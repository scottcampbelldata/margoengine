import { PbrMaterial } from '@margoengine/core';
import { parametricGeometry, roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry, tubeGeometry } from '@margoengine/geometry/primitives';
import { CatmullRomCurve3 } from '@margoengine/geometry/shapes';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { radians, reflectedColor } from './optics.js';

const center = [0, .315, -.022];
const axis = (theta) => axisAngleToQuaternion([0, 0, 1], theta);
const horizontal = { rotation: axisAngleToQuaternion([1, 0, 0], Math.PI / 2) };
const side = { rotation: axisAngleToQuaternion([0, 0, 1], Math.PI / 2) };
const mix = (a, b, t) => a + (b - a) * t;

function surface(u, v, height = 0) {
  const taper = .83 + .17 * Math.cos(Math.PI * v / 2);
  const bend = 1 - u * u;
  return [
    .269 * u * taper + .042 * Math.sin(Math.PI * v) * bend,
    .038 * bend + .019 * (1 - v * v) + height,
    -.210 * v + .048 * bend * Math.sin(Math.PI * v / 2),
  ];
}

function profileNormal(u, v) {
  const h = .0001;
  const [a, b, c] = surface(u + h, v).map((value, i) => value - surface(u - h, v)[i]);
  const [p, q, r] = surface(u, v + h).map((value, i) => value - surface(u, v - h)[i]);
  const normal = [b * r - c * q, c * p - a * r, a * q - b * p];
  const length = Math.hypot(...normal);
  return normal.map((coordinate) => coordinate / length);
}

function strip(from, to, count, offset = 0) {
  return parametricGeometry((u, v) => surface(mix(from, to, u), mix(-1, 1, v), offset), count, 23);
}

function annulus(inside, outside, depth) {
  const half = depth / 2;
  const r = .0018;
  return latheGeometry([
    [inside + r, -half], [outside - r, -half], [outside, -half + r], [outside, half - r],
    [outside - r, half], [inside + r, half], [inside, half - r], [inside, -half + r], [inside + r, -half],
  ], 64);
}

export function createBench(engine, shadows) {
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const table = finish('#516067', .82);
  const graphite = finish('#353d42', .60);
  const dark = finish('#262c30', .64);
  const enamel = finish('#46545d', .33);
  const ceramic = finish('#b2bec0', .52);
  const steel = finish('#bac5c3', .29, 1);
  const machined = finish('#99a9ab', .40, 1);
  const brass = finish('#bc8d58', .33, 1);
  const offWhite = finish('#e1ddd0', .5);
  const carbide = finish('#354449', .42);
  const teal = finish('#426269', .51);
  const meshGeometry = new WeakMap();
  let count = 0;
  function mount(shape, material, at, { parent, rotation, cast } = {}) {
    if (!meshGeometry.has(shape)) meshGeometry.set(shape, toGeometry(shape));
    const mesh = engine.createMesh(parent).setGeometry(meshGeometry.get(shape)).setMaterial(material).setPosition(at);
    if (rotation) mesh.setQuaternion(rotation);
    if (cast) shadows.add(mesh, { static: true });
    count++;
    return mesh;
  }
  const block = (w, h, d, bevel) => roundedBoxGeometry(w, h, d, 3, bevel);
  const box = (dimensions, bevel, material, at, options) => mount(block(...dimensions, bevel), material, at, options);
  const cylinder = (radius, thick, material, at, options) => mount(cylinderGeometry(radius, radius, thick, 56, 1), material, at, options);
  const fixed = { cast: true };

  box([52, .12, 52], .014, table, [0, -.11, 0]);
  box([.790, .060, .622], .028, graphite, [0, -.001, .008], fixed);
  box([.756, .009, .591], .004, steel, [0, .028, .008]);
  box([.731, .025, .565], .011, enamel, [0, .041, .008]);
  for (const x of [-.305, .305]) for (const z of [-.22, .239]) cylinder(.033, .028, dark, [x, -.037, z], fixed);
  for (const x of [-.166, .166]) box([.021, .008, .467], .003, machined, [x, .057, .006]);
  const screw = cylinderGeometry(.0082, .0082, .004, 18, 1);
  const screwSlot = block(.011, .001, .002, .0003);
  for (const x of [-.330, .330]) for (const z of [-.215, .214]) {
    box([.045, .005, .043], .002, carbide, [x, .057, z]);
    mount(screw, steel, [x, .062, z]);
    mount(screwSlot, dark, [x, .0644, z], { rotation: axisAngleToQuaternion([0, 1, 0], x * 5 - z * 2) });
  }

  // Two opposed bearing pedestals leave clearance beneath the tilting coated specimen.
  const pedestal = cylinderGeometry(.028, .042, .212, 52, 1);
  const bearing = annulus(.013, .044, .022);
  for (const z of [-.267, .220]) {
    box([.140, .028, .074], .011, teal, [0, .072, z], fixed);
    mount(pedestal, ceramic, [0, .188, z], fixed);
    cylinder(.038, .028, enamel, [0, .290, z], fixed);
    mount(bearing, machined, [0, center[1], z], { ...horizontal, cast: true });
    cylinder(.014, .055, steel, [0, center[1], z], horizontal);
  }
  const pivot = engine.createMesh().setPosition(center);
  const zero = [0, 0, 0];
  cylinder(.010, .524, machined, zero, { ...horizontal, parent: pivot });
  for (const z of [-.213, .213]) {
    box([.070, .033, .026], .006, carbide, [0, .003, z], { parent: pivot });
    cylinder(.009, .011, steel, [0, .026, z], { parent: pivot });
  }
  // A dark back and a closed bead give the glass real thickness and a protective edge.
  const back = mount(strip(-1, 1, 56, -.010), carbide, zero, { parent: pivot });
  shadows.add(back);
  const along = Array.from({ length: 23 }, (_, i) => mix(-1, 1, i / 22));
  const rimPoints = [
    ...along.map((u) => surface(u, -1, -.004)),
    ...along.slice(1).map((v) => surface(1, v, -.004)),
    ...along.slice(1).map((u) => surface(-u, 1, -.004)),
    ...along.slice(1).map((v) => surface(-1, -v, -.004)),
  ];
  mount(tubeGeometry(new CatmullRomCurve3(rimPoints), 116, .0071, 12), steel, zero, { parent: pivot });

  const film = [];
  const stripCount = 69;
  for (let i = 0; i < stripCount; i++) {
    const low = -1 + 2 * i / stripCount, high = -1 + 2 * (i + 1) / stripCount;
    const u = (low + high) / 2;
    const material = finish('#5b6262', .37);
    mount(strip(low, high, 2), material, zero, { parent: pivot });
    film.push({ normal: profileNormal(u, 0), thicknessOffset: 61 * u + 29 * Math.sin(Math.PI * u), material });
  }

  // A small protractor on the front bearing makes the mechanical tilt visible.
  cylinder(.059, .020, dark, [0, center[1] - .008, .251], { ...horizontal, cast: true });
  mount(annulus(.049, .058, .006), brass, [0, center[1] - .008, .264], horizontal);
  cylinder(.047, .003, teal, [0, center[1] - .008, .267], horizontal);
  const tick = block(.0021, .0080, .0019, .0005);
  for (let i = 0; i < 19; i++) {
    const angle = i * 5 * radians;
    mount(tick, i % 3 ? ceramic : offWhite,
      [.040 * Math.sin(angle), center[1] - .008 + .040 * Math.cos(angle), .270],
      { rotation: axis(-angle) });
  }
  const indicator = engine.createMesh().setPosition([0, center[1] - .008, .273]);
  box([.0033, .037, .0032], .001, offWhite, [0, .018, 0], { parent: indicator });
  cylinder(.014, .010, brass, [0, center[1] - .008, .278], horizontal);

  // Badging and a knurled adjustment wheel on the right break up the support's symmetry.
  box([.195, .004, .043], .002, carbide, [-.172, .057, .249]);
  box([.120, .0013, .0019], .0005, offWhite, [-.179, .060, .241]);
  box([.070, .0013, .0016], .0004, machined, [-.199, .060, .254]);
  box([.055, .012, .060], .005, carbide, [.268, .059, .193]);
  box([.022, .054, .045], .009, teal, [.266, .085, .193], fixed);
  cylinder(.023, .021, machined, [.276, .103, .193], side);
  cylinder(.011, .037, steel, [.282, .103, .193], side);
  const wheel = engine.createMesh().setPosition([.296, .103, .193]);
  cylinder(.043, .018, brass, [0, 0, 0], { parent: wheel, ...side });
  cylinder(.034, .007, graphite, [.011, 0, 0], { parent: wheel, ...side });
  const fluting = block(.014, .0038, .0065, .0015);
  for (let i = 0; i < 28; i++) {
    const angle = i * Math.PI / 14;
    mount(fluting, machined, [0, .041 * Math.cos(angle), .041 * Math.sin(angle)],
      { rotation: axisAngleToQuaternion([1, 0, 0], angle), parent: wheel });
  }
  box([.010, .019, .003], .0015, offWhite, [.015, .018, 0], { parent: wheel });

  return {
    count,
    update(thickness, degrees) {
      const tilt = degrees * radians;
      pivot.setQuaternion(axis(-tilt));
      indicator.setQuaternion(axis(-tilt));
      wheel.setQuaternion(axisAngleToQuaternion([1, 0, 0], 4 * tilt));
      const sin = Math.sin(tilt), cos = Math.cos(tilt);
      for (const { normal, thicknessOffset, material } of film) {
        const cosine = Math.max(0, Math.min(1, normal[1] * cos - normal[0] * sin));
        material.set({ color: reflectedColor(thickness + thicknessOffset, Math.acos(cosine)) });
      }
    },
  };
}
