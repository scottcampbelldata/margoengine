import {
  CatmullRomCurve3,
  cylinderGeometry,
  latheGeometry,
  sphereGeometry,
  torusGeometry,
  tubeGeometry,
} from '@margoengine/geometry';
import { parametricGeometry, roundedBoxGeometry } from '@margoengine/geometry/extras';

const tau = Math.PI * 2;
const sphere = sphereGeometry(1, 28, 18);
const rounded = roundedBoxGeometry(1, 1, 1, 4, 0.11);
const cylinder = cylinderGeometry(1, 1, 1, 36);
const torus = torusGeometry(1, 0.12, 12, 48);
const quarterX = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const tube = (points, radius) => tubeGeometry(new CatmullRomCurve3(points), 36, radius, 10);

function garment(rings, aspect = 1, folds = 0.028) {
  return parametricGeometry(
    (u, v) => {
      const along = v * (rings.length - 1);
      const i = Math.min(rings.length - 2, Math.floor(along));
      const t = along - i;
      const [a, b] = [rings[i], rings[i + 1]];
      const y = a[0] + (b[0] - a[0]) * t;
      const r = a[1] + (b[1] - a[1]) * t;
      const theta = -tau * u;
      const wrinkle = 1 + folds * Math.sin(57 * v + 3.3 * Math.sin(2 * theta)) * Math.cos(theta);
      return [aspect * r * Math.cos(theta) * wrinkle, y, r * Math.sin(theta) * wrinkle];
    },
    36,
    (rings.length - 1) * 5,
  );
}

const chest = garment(
  [
    [-0.17, 0.064],
    [-0.12, 0.136],
    [-0.015, 0.154],
    [0.08, 0.137],
    [0.19, 0.14],
    [0.3, 0.168],
    [0.4, 0.164],
    [0.455, 0.142],
    [0.5, 0.087],
    [0.52, 0.067],
  ],
  1.27,
  0.012,
);
const arms = [
  garment(
    [
      [-0.315, 0.048],
      [-0.29, 0.056],
      [-0.265, 0.06],
      [-0.21, 0.059],
      [-0.14, 0.063],
      [-0.08, 0.072],
      [0.028, 0.069],
    ],
    1.05,
  ),
  garment(
    [
      [-0.27, 0.043],
      [-0.246, 0.046],
      [-0.217, 0.049],
      [-0.155, 0.055],
      [-0.096, 0.063],
      [-0.04, 0.07],
      [0.015, 0.054],
    ],
    0.95,
  ),
];
const legs = [
  garment([
    [-0.434, 0.063],
    [-0.414, 0.067],
    [-0.379, 0.074],
    [-0.303, 0.082],
    [-0.19, 0.092],
    [-0.07, 0.102],
    [0.045, 0.086],
  ]),
  garment([
    [-0.413, 0.042],
    [-0.378, 0.048],
    [-0.333, 0.051],
    [-0.235, 0.058],
    [-0.149, 0.07],
    [-0.073, 0.072],
    [0.015, 0.063],
  ]),
];
const tank = latheGeometry(
  [
    [0, -0.28],
    [0.061, -0.28],
    [0.08, -0.253],
    [0.085, -0.224],
    [0.085, 0.193],
    [0.079, 0.225],
    [0.066, 0.242],
    [0.046, 0.252],
    [0.021, 0.265],
    [0, 0.273],
  ],
  52,
);
const hood = parametricGeometry(
  (u, v) => {
    const latitude = Math.PI * (v - 0.5);
    const angle = 0.81 + (tau - 1.62) * u;
    const section = Math.cos(latitude);
    return [
      0.092 * Math.sin(angle) * section,
      0.132 * Math.sin(latitude) + 0.023,
      0.005 + 0.112 * Math.cos(angle) * section,
    ];
  },
  64,
  32,
);
// Cross-sections run from the ankle cuff through the heel, instep, ball and toe.
const bootSections = [
  [0.044, -0.007, 0.038, 0.022, 0.024],
  [0.003, -0.008, 0.044, 0.03, 0.026],
  [-0.04, 0.019, 0.046, 0.038, 0.024],
  [-0.098, 0.052, 0.045, 0.034, 0.02],
  [-0.158, 0.091, 0.054, 0.023, 0.017],
  [-0.202, 0.115, 0.051, 0.016, 0.013],
  [-0.229, 0.129, 0.027, 0.008, 0.008],
  [-0.235, 0.131, 0.001, 0.001, 0.001],
];
const footPocket = parametricGeometry(
  (u, v) => {
    const along = v * (bootSections.length - 1);
    const i = Math.min(bootSections.length - 2, Math.floor(along));
    const f = along - i;
    const [y, z, width, upper, sole] = bootSections[i].map((value, k) => value + f * (bootSections[i + 1][k] - value));
    const angle = tau * u;
    const vertical = Math.sin(angle);
    return [Math.cos(angle) * width, y, z + vertical * (vertical > 0 ? upper : sole)];
  },
  32,
  35,
);
const kneePanel = parametricGeometry(
  (u, v) => {
    const angle = (u - 0.5) * 1.65;
    const taper = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
    const radius = 0.064 + v * 0.009 + 0.004 * taper;
    return [radius * Math.sin(angle), -0.065 + 0.091 * v, radius * Math.cos(angle)];
  },
  20,
  16,
);
const fin = parametricGeometry(
  (u, v) => {
    const angle = tau * u;
    const across = Math.cos(angle);
    const width = 0.046 + 0.067 * Math.sin(Math.PI * v * 0.68);
    const thickness = 0.008 * (1 - 0.6 * v) * Math.sin(Math.PI * v) ** 0.22;
    return [
      across * width,
      -0.18 - 0.344 * v + v ** 7 * (0.024 - 0.035 * across ** 2),
      0.116 + 0.062 * v + 0.054 * v ** 3 - 0.012 * across ** 2 * v + Math.sin(angle) * thickness,
    ];
  },
  56,
  36,
);

export function addDiver(model, buddy = false) {
  const root = model.node(buddy ? 'Safety diver buoyancy rig' : 'Diver buoyancy rig', [-6, -1, 2]);
  const add = (parent, name, shape, material, translation, scale, rotation) =>
    model.part(name, shape, material, translation, { parent, scale, rotation });
  add(root, 'Neoprene drysuit', chest, 'suit', [0, 0, 0]);
  add(root, 'BCD backplate', rounded, 'gear', [0, 0.23, -0.13], [0.302, 0.54, 0.095]);
  for (const side of [-1, 1]) {
    add(root, 'BCD air cell', sphere, 'gear', [side * 0.14, 0.19, -0.128], [0.098, 0.288, 0.1]);
    add(root, 'Aluminium gas cylinder', tank, 'tank', [side * 0.101, 0.256, -0.237]);
    for (const y of [0.071, 0.316]) {
      add(root, 'Cylinder band', cylinder, 'gear', [side * 0.101, y, -0.237], [0.088, 0.038, 0.088]);
      add(root, 'Cylinder band latch', rounded, 'stainless', [side * 0.184, y, -0.252], [0.016, 0.025, 0.045]);
    }
    add(root, 'First stage', cylinder, 'stainless', [side * 0.101, 0.537, -0.237], [0.035, 0.054, 0.036]);
    add(root, 'Valve handwheel', rounded, 'gear', [side * 0.137, 0.561, -0.237], [0.033, 0.043, 0.042]);
    add(
      root,
      'Shoulder webbing',
      tube(
        [
          [side * 0.108, 0.062, 0.116],
          [side * 0.121, 0.24, 0.164],
          [side * 0.146, 0.408, 0.139],
          [side * 0.13, 0.476, 0.035],
          [side * 0.11, 0.435, -0.112],
        ],
        0.023,
      ),
      'gear',
      [0, 0, 0],
    );
    add(root, 'Harness buckle', rounded, 'stainless', [side * 0.117, 0.142, 0.155], [0.049, 0.036, 0.017]);
    add(root, 'Drysuit cargo pocket', rounded, 'gear', [side * 0.171, -0.081, 0.023], [0.093, 0.151, 0.129]);
  }
  add(root, 'Waist webbing', torus, 'gear', [0, 0.051, 0.01], [0.18, 0.14, 0.035], quarterX);
  add(root, 'Quick-release buckle', rounded, 'stainless', [0.014, 0.062, 0.155], [0.093, 0.044, 0.028]);

  const neck = model.node('Neck joint', [0.004, 0.516, 0.037], { parent: root });
  const head = model.node('Head joint', [0, 0.112, 0], { parent: neck });
  add(neck, 'Drysuit neck seal', sphere, 'gear', [0, 0.015, 0.019], [0.079, 0.049, 0.081]);
  add(head, 'Open-face neoprene hood', hood, 'hood', [0, 0, 0]);
  add(head, 'Diving mask strap', sphere, 'gear', [0, 0.043, -0.012], [0.094, 0.013, 0.101]);
  add(head, 'Mask silicone rim', torus, 'gear', [0, 0.036, 0.114], [0.075, 0.034, 0.049]);
  add(head, 'Mask glass', sphere, 'visor', [0, 0.038, 0.113], [0.074, 0.033, 0.01]);
  add(head, 'Mask nose skirt', sphere, 'gear', [0, 0.007, 0.103], [0.032, 0.03, 0.027]);
  add(head, 'Demand-valve second stage', cylinder, 'gear', [0, -0.042, 0.121], [0.04, 0.039, 0.038], quarterX);
  add(head, 'Purge disc', cylinder, 'stainless', [0, -0.042, 0.145], [0.024, 0.007, 0.024], quarterX);
  add(head, 'Regulator exhaust tee', sphere, 'gear', [0, -0.066, 0.118], [0.056, 0.016, 0.021]);
  add(
    head,
    'Low-pressure regulator hose',
    tube(
      [
        [0.04, -0.042, 0.125],
        [0.123, -0.054, 0.104],
        [0.152, -0.064, 0.012],
        [0.119, -0.073, -0.147],
        [0.102, -0.068, -0.263],
      ],
      0.014,
    ),
    'hose',
    [0, 0, 0],
  );

  const limbs = [-1, 1].map((side) => {
    const shoulder = model.node('Shoulder joint', [side * 0.198, 0.406, 0.007], { parent: root });
    add(shoulder, 'Upper sleeve', arms[0], side > 0 && !buddy ? 'redSuit' : 'suit', [0, 0, 0]);
    const elbow = model.node('Elbow joint', [0.016 * side, -0.286, 0.009], { parent: shoulder });
    add(elbow, 'Elbow gusset', sphere, 'suit', [0, 0, 0], [0.065, 0.066, 0.066]);
    add(elbow, 'Forearm sleeve', arms[1], 'suit', [0, 0, 0]);
    add(elbow, 'Wrist seal', cylinder, 'gear', [0, -0.244, 0.001], [0.047, 0.035, 0.047]);
    const wrist = model.node('Wrist joint', [0, -0.258, 0.001], { parent: elbow });
    add(wrist, 'Glove palm', sphere, 'glove', [0, -0.048, 0.011], [0.045, 0.067, 0.025]);
    for (let finger = 0; finger < 4; finger++) {
      const x = (finger - 1.5) * 0.018;
      add(
        wrist,
        'Flexed glove finger',
        tube(
          [
            [x, -0.073, 0.01],
            [x, -0.116 - 0.008 * Math.sin(finger), 0.02],
            [x, -0.112, 0.043],
            [x, -0.093, 0.052],
          ],
          0.01,
        ),
        'glove',
        [0, 0, 0],
      );
    }
    add(wrist, 'Glove thumb', sphere, 'glove', [side * 0.042, -0.06, 0.027], [0.013, 0.035, 0.016]);
    if (side < 0) {
      add(wrist, 'Dive computer casing', rounded, 'gear', [0, -0.003, -0.015], [0.082, 0.051, 0.035]);
      add(wrist, 'Dive computer display', rounded, 'sensor', [0, -0.003, -0.034], [0.046, 0.041, 0.008]);
    }
    const hip = model.node('Hip joint', [side * 0.098, -0.106, 0], { parent: root });
    add(hip, 'Drysuit thigh', legs[0], 'suit', [0, 0, 0]);
    const knee = model.node('Knee joint', [0, -0.417, -0.007], { parent: hip });
    add(knee, 'Abrasion-resistant knee panel', kneePanel, 'gear', [0, 0, 0]);
    add(knee, 'Drysuit calf', legs[1], 'suit', [0, 0, 0]);
    const ankle = model.node('Ankle joint', [0, -0.393, 0.009], { parent: knee });
    add(ankle, 'Moulded fin foot pocket', footPocket, 'gear', [0, 0, 0]);
    add(ankle, 'Flexible paddle fin', fin, 'fin', [0, 0, 0]);
    for (const edge of [-1, 1]) {
      add(
        ankle,
        'Fin stiffening rail',
        tube(
          [
            [edge * 0.043, -0.206, 0.121],
            [edge * 0.083, -0.329, 0.142],
            [edge * 0.103, -0.471, 0.188],
          ],
          0.004,
        ),
        'gear',
        [0, 0, 0],
      );
    }
    return { shoulder, elbow, wrist, hip, knee, ankle };
  });
  return { root, head, neck, limbs };
}

const eased = (x) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

export function bindDiver(model, rig, face, { offset = [0, 0, 0], heading = 0 } = {}) {
  const nodes = model.nodes;
  face.root.setParent(nodes[rig.head]).setPosition([0, -0.105, 0.014]);
  const joint = (id, x = 0, y = 0, z = 0) => nodes[id].rotation.set(x, y, z);
  return (seconds, travel) => {
    const descent = eased((travel - 7.8) / 7.2);
    const inspection = eased((travel - 14.3) / 5.8);
    const breath = 0.025 * Math.sin(seconds * 2.2) + 0.012 * Math.sin(seconds * 4.2);
    const position = [
      -6.15 + descent * 2.75 + inspection * 1.15 + offset[0],
      -0.96 - 8.85 * descent - 0.13 * inspection + breath + offset[1],
      1.95 - descent * 2.62 + offset[2],
    ];
    const yaw = 1.19 + heading - inspection * 0.14 + Math.sin(seconds * 0.61) * 0.075;
    const trim = 1.18 + 0.36 * descent + 0.035 * Math.sin(seconds * 1.95);
    const sinY = Math.sin(yaw / 2);
    const cosY = Math.cos(yaw / 2);
    const sinX = Math.sin(trim / 2);
    const cosX = Math.cos(trim / 2);
    nodes[rig.root].setPosition(position).setQuaternion([cosY * sinX, sinY * cosX, -sinY * sinX, cosY * cosX]);
    joint(rig.neck, -0.31 + 0.06 * Math.sin(seconds * 1.1), 0.2 * Math.sin(seconds * 0.71), 0.04);
    joint(rig.head, -0.13 + 0.032 * Math.sin(seconds * 1.95), 0.09 * Math.sin(seconds * 0.87), 0.03);
    for (const [i, limb] of rig.limbs.entries()) {
      const sign = 2 * i - 1;
      const kick = Math.sin(seconds * 2.65 + i * Math.PI) * (0.2 - 0.12 * inspection);
      joint(limb.shoulder, -1.69 - 0.18 * sign - 0.19 * inspection, 0.13 * sign, 0.15 * sign);
      joint(limb.elbow, -0.83 + 0.19 * sign + 0.09 * Math.sin(seconds * 1.38 + i), sign * 0.1);
      // The +Z side of the glove is the palm. Pronate along the forearm so that side faces the cable.
      joint(limb.wrist, -0.12 + 0.08 * inspection * sign, Math.PI + 0.09 * sign, -0.05 * sign);
      joint(limb.hip, 0.065 + kick * 0.53, 0.069 * sign, 0.089 * sign);
      joint(limb.knee, 0.39 + kick + 0.07 * inspection);
      joint(limb.ankle, -0.13 - kick * 0.32, -0.12 + 0.09 * sign, 0.075 * sign);
    }
    // Regulator is just ahead of and a little under the neck in swimming trim.
    return [position[0] + 0.62 * Math.sin(yaw), position[1] - 0.15, position[2] + 0.62 * Math.cos(yaw)];
  };
}
