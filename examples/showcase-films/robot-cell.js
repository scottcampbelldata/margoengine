import { Path, Shape, extrudeGeometry } from '@margoengine/geometry';
import { ConvexHullVolume } from '@margoengine/kinematics-constraints';
import { Material } from '@margoengine/materials';
import { Robot } from '@margoengine/robot-planning';
import { planPathSync } from '@margoengine/robot-planning/plan';
import { blend, finishTexture, ramp, rng, shotAt } from './film.js';

const base = [-1.72, 0.65, -0.31];
const firstLink = 1.12;
const secondLink = 1.04;
const guideX = -0.38;
const guideZ = 0.34;
const throatWidth = 0.388;
const housingWidth = 0.34;
const pick = [-1.18, 0.704, guideZ];
const entry = [-0.76, 1.05, guideZ];
const exit = [-0.015, 1.05, guideZ];
const seat = [0.19, 0.704, guideZ];
const wristHeight = 0.255;

const shift = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
function corners([x, y, z], [w, h, d]) {
  return [-1, 1].flatMap((a) =>
    [-1, 1].flatMap((b) => [-1, 1].flatMap((c) => [x + (a * w) / 2, y + (b * h) / 2, z + (c * d) / 2])),
  );
}
function poseFor([x, y, z]) {
  const reach = Math.hypot(x - base[0], z - base[2]);
  const dy = y + wristHeight - base[1];
  const angle = Math.acos((reach ** 2 + dy ** 2 - firstLink ** 2 - secondLink ** 2) / (2 * firstLink * secondLink));
  const shoulder =
    Math.atan2(dy, reach) + Math.atan2(secondLink * Math.sin(angle), firstLink + secondLink * Math.cos(angle));
  return [Math.atan2(base[2] - z, x - base[0]), shoulder, -angle, angle - shoulder];
}

const jawCenter = (sign) => [guideX, 0.942, guideZ + sign * (throatWidth * 0.5 + 0.096)];
const jawSize = [0.21, 0.405, 0.192];
function planTransfer() {
  const joint = (axis, origin) => ({ axis, origin: shift(origin), lower: -3, upper: 3 });
  const robot = new Robot({
    base: shift(base),
    joints: [
      joint([0, 1, 0], [0, 0, 0]),
      joint([0, 0, 1], [0, 0, 0]),
      joint([0, 0, 1], [firstLink, 0, 0]),
      joint([0, 0, 1], [secondLink, 0, 0]),
      { ...joint([0, 1, 0], [0, 0, 0]), mimic: { joint: 0, multiplier: -1 } },
    ],
    shapes: [
      { joint: 4, points: corners([0, -wristHeight, 0], [0.276, 0.147, housingWidth]) },
      { joint: 4, points: corners([0, -0.127, 0], [0.203, 0.235, 0.373]) },
      { joint: 2, start: [0.15, 0, 0], end: [0.88, 0, 0], radius: 0.079 },
    ],
  });
  const colliders = [-1, 1].map((sign) => new ConvexHullVolume({ points: corners(jawCenter(sign), jawSize) }));
  const waypoints = Array.from({ length: 17 }, (_, i) => poseFor(blend(entry, exit, i / 16)));
  const path = [waypoints[0]];
  for (let i = 1; i < waypoints.length; i++) {
    const leg = planPathSync(robot, waypoints[i - 1], waypoints[i], {
      colliders,
      minClearance: 0.006,
      maxSamples: 400,
    });
    if (leg.status !== 'found')
      throw new Error('Inspection-gate path has no clearance at waypoint ' + i + ' (' + leg.status + ')');
    path.push(...leg.path.slice(1));
  }
  return { robot, colliders, path };
}

function outline(points, holes, depth, bevel) {
  const shape = new Shape();
  shape.moveTo(...points[0]);
  for (const p of points.slice(1)) shape.lineTo(...p);
  shape.closePath();
  for (const [x, y, r] of holes) {
    const hole = new Path();
    hole.absarc(x, y, r, 0, Math.PI * 2, false);
    shape.holes.push(hole);
  }
  return extrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 26,
  });
}

export function buildCell(engine, shop, cluster) {
  const { robot, colliders, path } = planTransfer();
  const { group, box, part, ring, beam, sign } = shop;
  const cast = finishTexture(149, { r: 220, grain: 25, mottling: 10 });
  const brushed = finishTexture(271, { r: 207, grain: 17, streak: true, mottling: 12 });
  const mat = (color, roughness, metalness = 0, roughnessMap) =>
    new Material({ color, roughness, metalness, roughnessMap });
  const orange = mat('#c26832', 0.48, 0.19, cast),
    rust = mat('#6a3423', 0.63, 0.31, cast);
  const frame = mat('#364651', 0.53, 0.55, brushed),
    black = mat('#151e24', 0.79, 0.12);
  const alloy = mat('#aab7b7', 0.34, 0.84, brushed),
    edge = mat('#c8d1cc', 0.23, 0.89, brushed);
  const floor = mat('#545b5e', 0.85, 0.09, cast),
    concrete = mat('#626c70', 0.83, 0.08, cast);
  const wall = mat('#343d43', 0.72, 0.16, cast),
    rubber = mat('#1b2022', 0.85);
  const amber = mat('#d9a642', 0.62, 0.09),
    shadowYellow = mat('#49381c', 0.69);
  const screen = new Material({ color: '#2a7568', emissive: '#64d6a3', emissiveIntensity: 0.95, roughness: 0.36 });
  const passLight = new Material({ color: '#487255', emissive: '#43ed7c', emissiveIntensity: 0, roughness: 0.39 });
  const pilot = new Material({ color: '#e2b274', emissive: '#ff9d45', emissiveIntensity: 1.8, roughness: 0.42 });
  const diffuser = new Material({ color: '#e3ebe7', emissive: '#e2efff', emissiveIntensity: 2.25, roughness: 0.58 });
  const quarter = Math.PI / 2;
  const rnd = rng(6034);

  box([20, 0.19, 15], floor, [0, -0.1, 0]);
  for (const x of [-5.5, -2.75, 0, 2.75, 5.5]) box([0.012, 0.004, 15], black, [x, 0.001, 0]);
  for (const z of [-3.4, -1.5, 2.55, 4.8]) box([19, 0.004, 0.014], black, [0, 0.001, z]);
  for (const x of [-3.71, 2.85]) box([0.065, 0.006, 5.2], amber, [x, 0.004, -0.25]);
  box([6.62, 0.006, 0.065], amber, [-0.43, 0.004, 2.36]);
  for (let i = 0; i < 74; i++)
    box(
      [0.03 + rnd() * 0.19, 0.003, 0.003 + rnd() * 0.012],
      concrete,
      [rnd() * 9 - 4.5, 0.003, rnd() * 5 - 2],
      [0, rnd() * 0.25, 0],
    );
  box([18, 6, 0.34], wall, [0, 2.9, -3.75]);
  box([0.4, 6, 12], wall, [-6.7, 2.9, -0.7]);
  for (const x of [-5.2, -2.65, 0.25, 3.1, 5.9]) {
    box([0.23, 6, 0.37], frame, [x, 2.85, -3.45], undefined, undefined, 0.017);
    box([0.32, 0.24, 8], frame, [x, 4.65, -0.5]);
    for (const y of [0.69, 1.06, 4.12]) box([2.64, 0.021, 0.035], black, [x + 1.3, y, -3.54]);
  }
  for (const x of [-3.3, -0.85, 1.6, 4.1]) {
    box([1.64, 0.12, 0.34], frame, [x, 3.97, -0.21], undefined, undefined, 0.025);
    box([1.49, 0.014, 0.262], diffuser, [x, 3.9, -0.21], undefined, undefined, 0.004);
  }
  const lamps = [-3.3, -0.85, 1.6, 4.1].map((x, i) => ({
    position: [x, 3.88, -0.21],
    direction: [0.03, -1, 0.04],
    range: 7.2,
    color: i % 2 ? [1, 0.86, 0.69] : [0.72, 0.85, 1],
    intensity: 24,
    angle: 1.07,
    penumbra: 0.68,
  }));
  lamps.push({
    position: [-0.3, 3.2, 2.45],
    direction: [0, -0.72, -1],
    angle: 0.76,
    penumbra: 0.5,
    range: 6.2,
    intensity: 21,
    color: [0.73, 0.88, 1],
  });
  box([1.24, 0.11, 0.3], frame, [-0.3, 3.22, 2.45]);
  box([1.12, 0.017, 0.26], diffuser, [-0.3, 3.154, 2.45]);
  cluster.setLights(lamps);

  // Guard bay, electrical cabinet and interlock stations.
  for (const z of [-1.55, -0.36, 0.83, 2.01]) {
    box([0.075, 2.49, 0.082], amber, [-3.14, 1.25, z], undefined, undefined, 0.011);
    box([0.08, 2.49, 0.082], amber, [2.47, 1.25, z], undefined, undefined, 0.011);
    box([0.105, 2.49, 0.081], amber, [z - 0.6, 1.25, -1.82], undefined, undefined, 0.011);
  }
  for (const y of [0.24, 2.42]) {
    box([0.052, 0.05, 3.57], frame, [-3.14, y, 0.23]);
    box([0.052, 0.05, 3.57], frame, [2.47, y, 0.23]);
    box([5.59, 0.052, 0.055], frame, [-0.325, y, -1.82]);
  }
  for (let j = 0; j < 32; j++) {
    const z = -1.5 + j * 0.11;
    for (const x of [-3.14, 2.47]) box([0.007, 2.17, 0.006], black, [x, 1.327, z]);
  }
  for (let i = 0; i < 51; i++) box([0.006, 2.16, 0.008], black, [-3.08 + i * 0.108, 1.33, -1.83]);
  for (let i = 0; i < 22; i++) {
    const y = 0.28 + i * 0.1;
    box([5.5, 0.007, 0.008], black, [-0.32, y, -1.834]);
    for (const x of [-3.14, 2.47]) box([0.007, 0.007, 3.51], black, [x, y, 0.25]);
  }
  box([0.73, 1.74, 0.47], frame, [1.78, 0.91, -1.04], undefined, undefined, 0.029);
  box([0.68, 1.62, 0.038], concrete, [1.78, 0.93, -0.794], undefined, undefined, 0.014);
  box([0.32, 0.27, 0.061], black, [1.78, 1.43, -0.747], undefined, undefined, 0.017);
  sign(['CELL 07', 'TRANSFER CONTROL'], [0.276, 0.193], [1.78, 1.43, -0.71], undefined, undefined, {
    background: '#173738',
    foreground: '#9de0bf',
    lit: 0.75,
  });
  sign(['INTERLOCK', 'KEEP CLEAR'], [0.29, 0.21], [2.47, 1.57, 0.816], [0, -quarter, 0], undefined, {
    background: '#e1ac42',
    foreground: '#201c12',
  });
  for (let i = 0; i < 14; i++) box([0.27, 0.009, 0.007], black, [1.78, 0.6 + i * 0.024, -0.766]);
  box([0.67, 0.072, 0.37], black, [1.78, 0.07, -1.04]);
  ring([0.02, 0.022, 0.028], pilot, [1.65, 1.22, -0.72], [quarter, 0, 0]);
  ring([0.02, 0.022, 0.028], screen, [1.78, 1.22, -0.72], [quarter, 0, 0]);
  sign(['ROBOTICS  /  CELL 07', 'GAUGE TRANSFER'], [1.35, 0.36], [-1.16, 2.78, -1.806], undefined, undefined, {
    background: '#20313b',
    foreground: '#d8ddd7',
  });

  // Pedestal, servo collars and custom cast housings.
  box([0.84, 0.108, 0.87], frame, [base[0], 0.06, base[2]], undefined, undefined, 0.026);
  ring([0.3, 0.35, 0.39], frame, [base[0], 0.283, base[2]]);
  ring([0.316, 0.325, 0.092], black, [base[0], 0.455, base[2]]);
  ring([0.265, 0.3, 0.064], alloy, [base[0], 0.51, base[2]]);
  const turret = group('Slew axis', null, base);
  ring([0.276, 0.299, 0.1], orange, [0, -0.093, 0], undefined, turret);
  box([0.488, 0.216, 0.458], orange, [-0.029, -0.008, 0], undefined, turret, 0.089);
  const upper = group('Shoulder', turret);
  const fore = group('Elbow', upper, [firstLink, 0, 0]);
  const wrist = group('Wrist pitch', fore, [secondLink, 0, 0]);
  const tool = group('Vertical spindle', wrist);
  const left = group('Clamp jaw left', tool),
    right = group('Clamp jaw right', tool);
  for (const [parent, radius, length] of [
    [upper, 0.208, firstLink],
    [fore, 0.159, secondLink],
  ]) {
    ring([radius, radius, 0.29], orange, [0, 0, 0], [quarter, 0, 0], parent);
    for (const sign of [-1, 1]) {
      ring([radius * 0.96, radius * 0.99, 0.029], rust, [0, 0, sign * 0.153], [quarter, 0, 0], parent);
      ring([radius * 0.76, radius * 0.81, 0.031], alloy, [0, 0, sign * 0.177], [quarter, 0, 0], parent);
      ring([radius * 0.405, radius * 0.44, 0.045], frame, [0, 0, sign * 0.196], [quarter, 0, 0], parent);
      for (let i = 0; i < 8; i++) {
        const q = (i * Math.PI) / 4;
        ring(
          [0.011, 0.012, 0.011],
          black,
          [Math.cos(q) * radius * 0.64, Math.sin(q) * radius * 0.64, sign * 0.199],
          [quarter, 0, 0],
          parent,
          6,
        );
      }
    }
    const depth = radius * 1.2;
    const p = [
      [-0.013, -radius * 0.82],
      [length * 0.27, -radius * 0.68],
      [length * 0.77, -radius * 0.53],
      [length, -radius * 0.56],
      [length + 0.07, -radius * 0.27],
      [length + 0.076, radius * 0.29],
      [length * 0.94, radius * 0.58],
      [length * 0.33, radius * 0.86],
      [0.014, radius * 0.87],
    ];
    part(outline(p, [], depth, 0.027), orange, [0, 0, -depth / 2], undefined, parent);
    for (const side of [-1, 1]) {
      part(
        outline(
          [
            [0.21, -0.055],
            [length * 0.76, -0.039],
            [length * 0.86, 0.014],
            [length * 0.69, 0.073],
            [0.27, 0.093],
          ],
          [],
          0.013,
          0.011,
        ),
        rust,
        [0, 0, side * 0.109],
        undefined,
        parent,
      );
      beam([0.2, 0.07, side * 0.119], [length * 0.71, 0.054, side * 0.119], 0.016, orange, parent);
    }
    for (let i = 0; i < 12; i++) {
      const x = 0.14 + (i * (length - 0.31)) / 12;
      ring([0.056, 0.056, 0.018], black, [x, radius * 0.59, -0.112], [0, 0, quarter], parent, 16);
    }
    beam([0.09, radius * 0.58, -0.112], [length - 0.099, radius * 0.58, -0.112], 0.085, rubber, parent, true);
  }
  sign(['AXIAL', 'R-07'], [0.29, 0.112], [0.575, 0.013, 0.147], undefined, upper, {
    background: '#553827',
    foreground: '#f1cc9a',
  });
  ring([0.115, 0.117, 0.205], orange, [0, 0, 0], [quarter, 0, 0], wrist);
  ring([0.088, 0.089, 0.031], edge, [0, 0, 0.123], [quarter, 0, 0], wrist);
  ring([0.086, 0.088, 0.07], black, [0, -0.075, 0], undefined, tool);
  ring([0.088, 0.093, 0.042], alloy, [0, -0.115, 0], undefined, tool);
  box([0.183, 0.068, 0.252], frame, [0, -0.143, 0], undefined, tool, 0.018);
  ring([0.024, 0.024, 0.018], pilot, [0.077, -0.152, 0.08], [0, 0, quarter], tool);
  for (const gripper of [left, right]) {
    box([0.179, 0.037, 0.043], alloy, [0, -0.168, 0], undefined, gripper, 0.008);
    box([0.13, 0.067, 0.024], edge, [0, -0.205, 0], undefined, gripper, 0.006);
    box([0.134, 0.02, 0.026], black, [0, -0.227, 0], undefined, gripper, 0.003);
  }

  // The housing has a through bore, machined flange and a line-bored hub.
  const cargo = group('Machined aluminum housing');
  const face = [
    [-0.125, -0.151],
    [0.086, -0.151],
    [0.131, -0.109],
    [0.131, 0.101],
    [0.088, 0.151],
    [-0.088, 0.151],
    [-0.131, 0.091],
    [-0.131, -0.104],
  ];
  const holes = [
    [0, 0, 0.072],
    [-0.093, -0.108, 0.01],
    [0.093, -0.108, 0.01],
    [-0.093, 0.108, 0.01],
    [0.093, 0.108, 0.01],
  ];
  part(outline(face, holes, 0.099, 0.008), alloy, [0, -0.046, 0], [-quarter, 0, 0], cargo);
  part(outline(face, holes, 0.023, 0.005), edge, [0, 0.053, 0], [-quarter, 0, 0], cargo);
  const hub = new Shape(),
    bore = new Path();
  hub.absarc(0, 0, 0.104, 0, 2 * Math.PI, false);
  bore.absarc(0, 0, 0.072, 0, 2 * Math.PI, true);
  hub.holes.push(bore);
  part(
    extrudeGeometry(hub, {
      depth: 0.026,
      bevelThickness: 0.004,
      bevelSize: 0.004,
      bevelSegments: 2,
      curveSegments: 46,
    }),
    edge,
    [0, 0.069, 0],
    [-quarter, 0, 0],
    cargo,
  );
  for (const x of [-0.114, 0.114])
    for (let i = 0; i < 5; i++)
      box([0.012, 0.055, 0.014], edge, [x, -0.003, -0.081 + i * 0.041], undefined, cargo, 0.0026);
  for (const z of [-0.1655, 0.1655]) box([0.126, 0.026, 0.009], edge, [0, 0.032, z], undefined, cargo, 0.003);

  // Transfer gauge and pickup cradle. Collision volumes use these same jaw bounds.
  box([1.88, 0.086, 0.84], frame, [-0.36, 0.56, 0.34], undefined, undefined, 0.022);
  box([1.84, 0.022, 0.795], alloy, [-0.36, 0.613, 0.34], undefined, undefined, 0.008);
  for (const x of [-1.15, 0.37])
    for (const z of [-0.005, 0.676]) {
      box([0.112, 0.554, 0.115], frame, [x, 0.281, z], undefined, undefined, 0.013);
      box([0.171, 0.036, 0.172], black, [x, 0.024, z], undefined, undefined, 0.008);
    }
  box([1.79, 0.059, 0.092], frame, [-0.36, 0.3, 0.679]);
  for (const signZ of [-1, 1]) {
    const [x, y, z] = jawCenter(signZ);
    box(jawSize, alloy, [x, y, z], undefined, undefined, 0.013);
    box([0.226, 0.055, 0.244], frame, [x, 0.744, z + signZ * 0.02], undefined, undefined, 0.011);
    const inner = guideZ + signZ * (throatWidth / 2 + 0.007);
    box([0.202, 0.021, 0.024], amber, [x, 1.139, inner], undefined, undefined, 0.004);
    for (const xShift of [-0.064, 0.066]) {
      ring([0.015, 0.015, 0.004], black, [x + xShift, 1.146, z + signZ * 0.04], undefined, undefined, 6);
      box([0.006, 0.087, 0.005], shadowYellow, [x + xShift, 1.07, inner], [0, 0, 0.4]);
    }
    for (const yLine of [0.835, 0.854, 0.873, 0.892, 0.911, 0.93])
      box([0.002, 0.005, 0.151], frame, [x + 0.106, yLine, z]);
    ring([0.037, 0.037, 0.007], frame, [x + 0.107, 1.035, z], [0, 0, quarter], undefined, 40);
    ring([0.024, 0.024, 0.009], edge, [x + 0.112, 1.035, z], [0, 0, quarter], undefined, 8);
    for (const xDock of [pick[0], seat[0]]) {
      box([0.34, 0.044, 0.057], frame, [xDock, 0.646, guideZ + signZ * 0.116], undefined, undefined, 0.008);
      ring([0.014, 0.011, 0.031], edge, [xDock + 0.118, 0.629, guideZ + signZ * 0.117]);
      box([0.18, 0.019, 0.02], rubber, [xDock - 0.01, 0.654, guideZ + signZ * 0.109], undefined, undefined, 0.004);
    }
  }
  box([0.405, 0.083, 0.079], black, [seat[0], 0.669, 0.623], undefined, undefined, 0.008);
  sign(['FINAL  /  SEAT'], [0.362, 0.054], [seat[0], 0.675, 0.664], undefined, undefined, { background: '#242e33' });
  box([0.158, 0.232, 0.096], frame, [0.59, 0.765, 0.54], undefined, undefined, 0.01);
  sign(['GAP', 'OK'], [0.125, 0.081], [0.59, 0.802, 0.591], undefined, undefined, {
    background: '#193c34',
    foreground: '#7fde9e',
    lit: 0.3,
  });
  ring([0.03, 0.032, 0.021], passLight, [0.59, 0.883, 0.541]);
  for (const z of [0.024, 0.68])
    for (let i = 0; i < 9; i++) {
      ring([0.012, 0.013, 0.004], black, [-1.235 + i * 0.208, 0.626, z], undefined, undefined, 6);
    }

  const highPick = [...pick];
  highPick[1] = 1.05;
  const highSeat = [...seat];
  highSeat[1] = 1.05;
  const openPick = [...pick];
  openPick[1] += 0.25;
  const home = [-0.35, 1.47, -0.21];
  const transfer = (u) => {
    const i = Math.min(path.length - 2, Math.floor(u * (path.length - 1)));
    return blend(path[i], path[i + 1], u * (path.length - 1) - i);
  };
  const zones = [
    [0, 4.8, 0.35, 0.9],
    [42, 53, 0, 1],
  ];
  const shots = [
    [4.8, [0.307, 1.53, 0.79], [0.196, 1.445, 0.823], [-0.407, 1.06, 0.346], [-0.38, 1.052, 0.34], 37],
    [12, [2.05, 2.53, 3.51], [1.15, 2.13, 2.96], [-0.63, 1.07, 0.03], [-0.66, 1.03, 0.06], 44],
    [21, [-0.51, 1.38, 1.36], [-0.65, 1.235, 1.149], [-1.15, 0.82, 0.34], [-1.17, 0.755, 0.34], 43],
    [29, [-2.18, 1.28, 1.5], [-1.96, 1.55, 1.37], [-1.13, 0.82, 0.33], [-1.16, 1.12, 0.34], 43],
    [36, [0.4, 1.91, 2.4], [0.22, 1.82, 2.13], [-0.75, 1.19, 0.24], [-0.68, 1.18, 0.26], 43],
    [42, [0.13, 2.26, 0.95], [0.05, 2.04, 0.86], [-0.477, 1.017, 0.35], [-0.475, 1.006, 0.344], 40],
    [47.8, [0.067, 1.47, 1.05], [-0.02, 1.42, 0.96], [-0.52, 1.045, 0.34], [-0.43, 1.043, 0.34], 37],
    [53, [0.504, 1.337, 0.541], [0.572, 1.31, 0.58], [-0.35, 1.054, 0.35], [-0.1, 1.068, 0.34], 39],
    [59, [0.482, 1.77, 1.21], [0.685, 1.67, 1.12], [-0.08, 1.084, 0.34], [0.165, 1.057, 0.34], 42],
    [66, [0.718, 1.251, 1.019], [0.618, 1.168, 0.887], [0.159, 0.991, 0.34], [0.19, 0.772, 0.34], 36],
    [75, [0.907, 1.1, 1.139], [0.982, 1.134, 1.186], [0.214, 0.829, 0.35], [0.21, 0.806, 0.35], 34],
    [83, [-0.74, 1.97, 2.61], [-0.59, 1.9, 2.53], [-0.42, 1.15, 0.24], [-0.4, 1.14, 0.24], 44],
    [90, [1.44, 2.12, 2.97], [1.12, 2.18, 2.79], [-0.51, 1.1, 0.22], [-0.46, 1.12, 0.21], 44],
  ];
  const cues = [
    [0.18, 4.5, 'A machined housing. A 24 mm side gap.'],
    [6.0, 10.6, 'Earlier in the cycle'],
    [15.6, 20.1, 'The jaws grip the housing.'],
    [31, 35.7, 'The path is checked through the gauge.'],
    [45.7, 51.8, '24 mm of nominal clearance on each side'],
    [62.0, 66.2, 'The housing seats on the locating rails.'],
    [68.8, 74.3, 'Seated. The gauge confirms the transfer.'],
  ];
  function apply(time) {
    let q;
    const zone = zones.find(([a, b]) => time >= a && time < b);
    if (zone) {
      const [a, b, u, v] = zone;
      q = transfer(u + (v - u) * ramp(time, a, b));
    } else if (time < 12) q = poseFor(blend(home, openPick, ramp(time, 5, 12)));
    else if (time < 19) q = poseFor(blend(openPick, pick, ramp(time, 12, 17.8)));
    else if (time < 29) q = poseFor(blend(pick, highPick, ramp(time, 20.6, 29)));
    else if (time < 42) q = poseFor(blend(highPick, entry, ramp(time, 29.2, 39.9)));
    else if (time < 59) q = poseFor(blend(exit, highSeat, ramp(time, 53, 59)));
    else if (time < 70) q = poseFor(blend(highSeat, seat, ramp(time, 59.2, 65.6)));
    else q = poseFor(blend(seat, home, ramp(time, 70.1, 81.8)));
    turret.setRotation([0, q[0], 0]);
    upper.setRotation([0, 0, q[1]]);
    fore.setRotation([0, 0, q[2]]);
    wrist.setRotation([0, 0, q[3]]);
    tool.setRotation([0, -q[0], 0]);
    const clamped = time < 4.8 ? 1 : ramp(time, 18.2, 20.0) * (1 - ramp(time, 67.5, 69.55));
    for (const [i, jaw] of [left, right].entries())
      jaw.setPosition([0, 0, (i * 2 - 1) * (0.165 + 0.029 * (1 - clamped))]);
    let payload = time < 21 ? pick : seat;
    if (time < 4.8 || (time >= 21 && time < 67.5)) {
      robot.forward(q);
      const frame = robot.frameMatrix(4);
      payload = [frame[12], frame[13] - wristHeight, frame[14]];
    }
    cargo.setPosition(payload);
    passLight.emissiveIntensity = 4.1 * ramp(time, 67.4, 67.83);
    return shotAt(shots, time);
  }

  return {
    apply,
    cues,
    dispose() {
      cast.dispose();
      brushed.dispose();
    },
    inspection: {
      clearanceAt: (progress) => robot.clearance(transfer(progress), colliders),
      transferNodes: path.length,
    },
  };
}
