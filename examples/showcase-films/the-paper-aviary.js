import { PbrMaterial } from '@margoengine/core';
import { computeVertexNormals, toGeometry } from '@margoengine/geometry';
import { geometryData } from '@margoengine/geometry/utils';
import { Material } from '@margoengine/materials';
import { Toon } from '@margoengine/toon';
import { Hatching } from '@margoengine/toon/hatch';
import { blend, ramp, rng, shotAt } from './film.js';

const tau = Math.PI * 2;
const paperColors = [
  ['#bd5338', '#e6845a', '#a13f35', '#f4a77a'],
  ['#46838a', '#77a8a6', '#2e6973', '#b1cbc0'],
  ['#bb9452', '#dfbf7a', '#957343', '#eed8a0'],
  ['#788b69', '#a9b48a', '#566d59', '#c3c9a6'],
];
function faceData(faces) {
  const positions = [],
    indices = [];
  for (const face of faces) {
    const start = positions.length / 3;
    positions.push(...face.flat());
    for (let i = 1; i < face.length - 1; i++) indices.push(start, start + i, start + i + 1);
  }
  return computeVertexNormals(
    geometryData(
      new Float32Array(positions),
      new Float32Array(positions.length),
      new Float32Array((positions.length / 3) * 2),
      new Uint32Array(indices),
    ),
  );
}

function crane(engine, shadows, parent, colors, name) {
  const root = engine.createMesh(parent);
  root.name = name;
  const paper = colors.map((color) => new PbrMaterial({ color, roughness: 0.95, doubleSided: true }));
  const bones = [];
  function part(label, faces, color, target = root) {
    const mesh = engine
      .createMesh(target)
      .setGeometry(toGeometry(faceData(faces)))
      .setMaterial(paper[color]);
    mesh.name = label;
    shadows.add(mesh);
    return mesh;
  }
  const nose = [0, 0.02, 0.44],
    stern = [0, 0.012, -0.57],
    peak = [0, 0.24, -0.015],
    left = [-0.265, 0.014, -0.044],
    right = [0.265, 0.014, -0.044],
    underside = [0, -0.12, -0.032];
  part(
    'Body light facets',
    [
      [nose, peak, right],
      [peak, stern, left],
    ],
    1,
  );
  part(
    'Body folded facets',
    [
      [nose, left, peak],
      [stern, right, peak],
      [nose, right, underside],
      [stern, left, underside],
    ],
    0,
  );
  part(
    'Body lower paper',
    [
      [nose, underside, left],
      [stern, underside, right],
    ],
    2,
  );
  const neck = engine.createMesh(root).setPosition([0, 0.028, 0.28]);
  const throat = [0, 0.61, 0.46],
    collar = [0, 0.46, 0.18],
    beak = [0, 0.46, 0.76],
    n0 = [-0.13, 0, 0],
    n1 = [0.13, 0, 0];
  part(
    'Neck / mountain fold',
    [
      [n0, collar, throat],
      [n0, throat, [0, 0, 0.13]],
    ],
    0,
    neck,
  );
  part(
    'Neck reverse side',
    [
      [[0, 0, 0.13], throat, n1],
      [n1, throat, collar],
    ],
    1,
    neck,
  );
  part(
    'Beak / inside reverse fold',
    [
      [throat, [-0.065, 0.52, 0.45], beak],
      [throat, beak, [0.065, 0.52, 0.45]],
    ],
    3,
    neck,
  );
  const tail = engine.createMesh(root).setPosition([0, 0, -0.33]);
  part(
    'Tail ridge',
    [
      [
        [-0.16, 0, 0],
        [0, 0.2, -0.29],
        [0, 0.29, -0.83],
      ],
      [
        [0.16, 0, 0],
        [0, 0.29, -0.83],
        [0, 0.2, -0.29],
      ],
    ],
    1,
    tail,
  );
  part(
    'Tail upper flap',
    [
      [
        [-0.16, 0, 0],
        [0, 0.29, -0.83],
        [0, 0.03, 0],
      ],
      [
        [0.16, 0, 0],
        [0, 0.03, 0],
        [0, 0.29, -0.83],
      ],
    ],
    0,
    tail,
  );
  for (const side of [-1, 1]) {
    const hinge = engine.createMesh(root).setPosition([side * 0.17, 0.045, -0.056]);
    hinge.name = side < 0 ? 'Left wing root fold' : 'Right wing root fold';
    const leading = [side * 0.64, 0.053, 0.39],
      trailing = [side * 0.55, -0.03, -0.48],
      ridge = [side * 0.64, 0.14, -0.028];
    part(
      'Inner wing / lit face',
      [
        [[0, 0, 0.29], leading, ridge],
        [[0, 0, 0.29], ridge, [0, 0, -0.41]],
      ],
      1,
      hinge,
    );
    part('Inner wing / valley fold', [[[0, 0, -0.41], ridge, trailing]], 0, hinge);
    const tip = engine.createMesh(hinge).setPosition([side * 0.6, 0.03, 0]);
    const corner = [side * 0.87, -0.035, -0.35],
      mid = [side * 0.35, 0.08, -0.29],
      foldA = [side * 0.04, 0.023, 0.39],
      foldB = [-side * 0.05, -0.06, -0.48],
      foldR = [side * 0.04, 0.11, -0.028];
    part(
      'Outer wing / edge',
      [
        [foldA, corner, mid],
        [foldA, mid, foldR],
      ],
      0,
      tip,
    );
    part(
      'Outer wing / reverse facet',
      [
        [foldR, mid, foldB],
        [mid, corner, foldB],
      ],
      2,
      tip,
    );
    bones.push({ side, hinge, tip });
  }
  return {
    root,
    neck,
    tail,
    pose(fold, flap, t) {
      for (const { side, hinge, tip } of bones) {
        hinge.setRotation([0, side * 0.036 * flap, side * (0.045 + fold * 1.38 + flap)]);
        tip.setRotation([0, 0, side * (-0.08 + 0.54 * fold - flap * 0.46)]);
      }
      neck.setRotation([-0.035 + 0.5 * fold + 0.065 * Math.sin(t * 3), 0, 0]);
      tail.setRotation([-0.12 + 0.33 * fold + 0.19 * flap, 0, 0]);
    },
  };
}

const stamps = [
  [0, [-0.08, 1.31, 0.05]],
  [35, [-0.08, 1.31, 0.05]],
  [40, [-0.45, 2.26, 0.13]],
  [47, [-1.27, 3.16, -1.04]],
  [58, [0.68, 3.72, -2.95]],
  [66, [2.55, 2.88, -1.5]],
  [74, [1.89, 2.23, 0.6]],
  [82, [2.99, 1.36, 1.12]],
  [90, [2.99, 1.36, 1.12]],
];
function flight(time) {
  let i = stamps.findIndex(([when]) => when > time);
  if (i < 1) i = stamps.length - 1;
  const [a, v] = stamps[i - 1],
    [b, w] = stamps[i];
  return blend(v, w, ramp(time, a, b));
}

export function buildAviary(engine, shop, _lights, shadows) {
  const mat = (color, roughness = 0.92) => new Material({ color, roughness });
  const floor = mat('#cfbfaa'),
    clay = mat('#dcceba'),
    walnut = mat('#6f4e40'),
    rail = mat('#8d6956'),
    warm = mat('#eadbc5'),
    fascia = mat('#a2745c');
  const wall = mat('#eadbc2'),
    chalk = mat('#f0e4ce'),
    frame = mat('#a47c60');
  shop.box([18, 0.14, 15], floor, [0, -0.07, -1], undefined, null, 0.04);
  shop.box([17, 5.8, 0.36], wall, [0, 2.9, -6.6], undefined, null, 0.08);
  shop.box([0.27, 5.8, 15], wall, [-8.45, 2.9, -1], undefined, null, 0.05);
  shop.box([0.27, 5.8, 15], wall, [8.45, 2.9, -1], undefined, null, 0.05);
  for (const [width, depth, x, z] of [
    [17, 3.85, 0, -6.54],
    [17, 2.6, 0, 5.2],
    [3.4, 8.65, -6.78, -0.28],
    [3.0, 8.65, 6.98, -0.28],
  ]) {
    shop.box([width, 0.14, depth], warm, [x, 5.83, z], undefined, null, 0.05);
  }
  for (const x of [-5.25, -2.7, -0.15, 2.4, 5.0])
    shop.box([0.095, 0.18, 9.0], rail, [x, 5.75, -0.27], undefined, null, 0.025);
  shop.box([17, 0.16, 0.16], walnut, [0, 0.14, -6.38], undefined, null, 0.025);
  shop.box([17, 0.22, 0.13], chalk, [0, 5.61, -6.37], undefined, null, 0.027);
  for (const x of [-5.25, 0, 5.25]) {
    shop.box([0.15, 0.1, 11], rail, [x, 5.68, -1], undefined, null, 0.022);
    for (const z of [-4.55, -1.26, 2.08]) {
      shop.ring([0.13, 0.16, 0.17], walnut, [x, 5.48, z], undefined, null, 24);
      shop.ring([0.12, 0.12, 0.016], chalk, [x, 5.39, z], undefined, null, 24);
    }
  }
  for (let i = 0; i < 8; i++) {
    const x = -7.9 + i * 2.18;
    shop.box([0.045, 4.75, 0.035], warm, [x, 2.55, -6.41], undefined, null);
  }
  const random = rng(485);
  for (let i = 0; i < 31; i++) {
    const z = -7.1 + i * 0.46;
    for (let j = 0; j < 6; j++) {
      const x = -9 + j * 3.2 + (i % 3) * 0.37;
      shop.box([3.14, 0.011, 0.006], rail, [x, 0.003, z], undefined, null);
      if (i % 2 === 0) shop.box([0.006, 0.012, 0.46], rail, [x + 1.5, 0.004, z + 0.22], undefined, null);
    }
  }
  for (const [x, y, z, width, height] of [
    [-4.8, 2.65, -6.33, 2.43, 1.7],
    [0.2, 2.65, -6.34, 2.43, 1.7],
    [4.63, 2.65, -6.33, 2.43, 1.7],
  ]) {
    shop.box([width + 0.09, height + 0.09, 0.087], frame, [x, y, z], undefined, null, 0.028);
    shop.sign(
      [
        ['FOLD STUDY', '01   /   WING'],
        ['PAPER STUDY', '02   /   FLIGHT'],
        ['CURATOR’S TABLE', '03   /   LANDING'],
      ][x < 0 ? 0 : x < 1 ? 1 : 2],
      [width - 0.12, height - 0.14],
      [x, y, z + 0.052],
      undefined,
      null,
      { background: '#ece1c8', foreground: '#594739' },
    );
  }
  const platforms = [
    [-0.08, 0, 0.05, 1.31],
    [2.99, 0, 1.12, 1.36],
    [-3.3, 0, -2.85, 1.29],
    [3.9, 0, -3.28, 1.25],
  ];
  for (const [x, , z, y] of platforms) {
    shop.box([1.75, y - 0.17, 1.55], clay, [x, (y - 0.17) / 2, z], undefined, null, 0.052);
    shop.box([1.86, 0.12, 1.66], chalk, [x, y - 0.1, z], undefined, null, 0.033);
    shop.box([1.79, 0.071, 1.62], walnut, [x, y - 0.035, z], undefined, null, 0.026);
    shop.box([1.56, 0.035, 1.35], fascia, [x, 0.025, z], undefined, null, 0.013);
  }
  const main = crane(engine, shadows, null, paperColors[0], 'Copper paper crane');
  const flock = Array.from({ length: 7 }, (_, i) => {
    const bird = crane(engine, shadows, null, paperColors[1 + (i % 3)], 'Hanging paper bird ' + (i + 1));
    const scale = 0.37 + random() * 0.24;
    bird.root.setScale([scale, scale, scale]);
    const x = -4.8 + i * 1.49,
      y = 3.38 + random() * 0.65,
      z = -3.4 - random() * 1.95;
    shop.beam([x, y + 0.14, z], [x, 5.2, z], 0.004, rail);
    return { bird, x, y, z, tilt: (random() - 0.5) * 1.3 };
  });
  for (const [x, z, index] of [
    [-3.3, -2.85, 2],
    [3.9, -3.28, 1],
  ]) {
    const bird = crane(engine, shadows, null, paperColors[index], 'Paper specimen');
    bird.root
      .setPosition([x, index === 2 ? 1.41 : 1.37, z])
      .setScale([0.5, 0.5, 0.5])
      .setRotation([0, index * 1.35, 0]);
    bird.pose(0.48, 0, 0);
  }
  const toon = Toon.attach(engine, { bands: 7, rim: 0.16, outline: 0.006, color: [0.154, 0.061, 0.042] });
  const hatching = Hatching.attach(engine, {
    style: 'hatch',
    spacing: 6.4,
    width: 0.62,
    layers: 2,
    angle: 37,
    ink: [0.23, 0.105, 0.074],
  });
  const views = [
    [5, [0.75, 2.1, 2.72], [0.55, 2.31, 2.2], [0.1, 1.57, 0.02], [0.1, 1.57, 0.04], 43],
    [15, [-1.18, 2.02, 2.98], [-2.14, 2.13, 1.95], [-0.05, 1.52, 0.03], [-0.06, 1.51, 0.05], 48],
    [25, [1.64, 2.0, 1.94], [1.75, 1.97, 1.44], [0, 1.55, 0.05], [0, 1.55, 0.05], 42],
    [37, [0.13, 2.93, 3.25], [0.21, 3.57, 3.59], [-0.05, 1.56, 0.05], [-0.1, 1.8, 0.12], 43],
    [48, [3.11, 3.32, 4.16], [1.22, 4.41, 3.3], [-0.05, 2.36, 0], [-1.21, 3.18, -1.09], 49],
    [60, [4.1, 3.45, 2.8], [5.08, 3.83, 1.96], [-1.25, 3.2, -1.03], [1.1, 3.67, -2.69], 47],
    [72, [5.66, 3.13, 1.92], [4.37, 3.65, 3.8], [2.05, 3.04, -1.56], [2, 2.18, 0.42], 46],
    [83, [5.3, 2.37, 4.15], [4.35, 2.12, 3.5], [1.9, 2.19, 0.65], [2.99, 1.58, 1.12], 46],
    [90, [5.27, 2.71, 4.25], [5.73, 2.86, 4.62], [2.45, 1.67, 0.55], [2.46, 1.71, 0.5], 49],
  ];
  return {
    apply(time) {
      const [x, y, z] = flight(time);
      const opening = 0.87 * (1 - ramp(time, 12.5, 31.8));
      const launch = ramp(time, 34, 37) * (1 - ramp(time, 76, 82));
      const flutter = Math.sin(time * tau * 1.28) * 0.48;
      const teaser = (1 - ramp(time, 3.6, 4.9)) * ramp(time, 0, 0.9);
      const flap = launch * flutter + teaser * flutter * 0.57;
      const fold = time < 5 ? 0.18 * (1 - teaser) : opening + 0.26 * ramp(time, 77, 83);
      main.root.setPosition([x, y + 0.11 + 0.09 * Math.sin(time * 6.9) * launch, z]);
      main.root.setRotation([
        launch * (0.06 + 0.1 * Math.sin(time * 3)),
        0.65 + launch * (0.7 * Math.sin(time * 0.22) - 0.1),
        launch * 0.13 * Math.sin(time * 1.72),
      ]);
      main.pose(fold, flap, time);
      flock.forEach(({ bird, x, y, z, tilt }, i) => {
        bird.root
          .setPosition([x, y + 0.018 * Math.sin(time * 0.8 + i), z])
          .setRotation([0.05, tilt + 0.19 * Math.sin(time * 0.49 + i), 0.035 * Math.sin(time * 0.6)]);
        bird.pose(0.15 + 0.09 * Math.sin(time * 0.53 + i), 0.045 * Math.sin(time * 0.97 + i), time);
      });
      return shotAt(views, time);
    },
    cues: [
      [5.4, 11.9, 'One sheet, folded into a crane.'],
      [15.6, 22, 'The wings open along their creases.'],
      [28, 34, 'The folds hold their shape as the paper flexes.'],
      [38, 43, 'The crane lifts from the table.'],
      [52, 57, 'Ink hatching follows the changing light.'],
      [65, 70, 'The flock hangs over the print gallery.'],
      [76, 82, 'The copper crane settles onto the second stand.'],
    ],
    inspection: { main, flock },
    dispose() {
      hatching.dispose();
      toon.dispose();
    },
  };
}
