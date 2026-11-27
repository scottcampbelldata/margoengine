import { addDiver } from './diver.js';
import {
  CatmullRomCurve3,
  cylinderGeometry,
  latheGeometry,
  planeGeometry,
  sphereGeometry,
  torusGeometry,
  tubeGeometry,
} from '@margoengine/geometry';
import { parametricGeometry, roundedBoxGeometry } from '@margoengine/geometry/extras';
import { SetModel } from './materials.js';

const tau = Math.PI * 2;
export const seafloor = -11.5;
const turn = (axis, angle) => {
  const q = [0, 0, 0, Math.cos(angle * 0.5)];
  q[axis] = Math.sin(angle * 0.5);
  return q;
};
const alongX = turn(2, -Math.PI / 2);

const soft = roundedBoxGeometry(1, 1, 1, 3, 0.12);
const cylinder = cylinderGeometry(1, 1, 1, 32);
const bolt = cylinderGeometry(1, 1, 1, 6);
const sphere = sphereGeometry(1, 20, 12);
const line = (points, radius, steps = 36) => tubeGeometry(new CatmullRomCurve3(points), steps, radius, 9);

export function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function bed(x, z) {
  const contact = 1 - Math.exp(-(Math.hypot(x * 0.29, z * 0.49) ** 2));
  const ridge = Math.exp(-(((x - 4) / 14) ** 2 + ((z + 13) / 6) ** 2));
  const relief =
    Math.sin(x * 0.44 + z * 0.31) * 0.18 +
    Math.sin(z * 3.22 + x * 0.19) * 0.052 +
    Math.cos(x * 0.9 - 0.24 * z) * 0.07 +
    Math.sin((x + z) * 0.11) * 0.29;
  return seafloor + contact * relief + 1.05 * ridge;
}

function addTerrain(model, random, offshore) {
  // Keep the original sampling density at the joint and carry the seabed beyond the vessel's route.
  const coordinate = (u) => (u - 0.5) * 160 + (offshore ? 220 * (2 * u - 1) ** 5 : 0);
  const sand = parametricGeometry(
    (u, v) => {
      const x = coordinate(u);
      const z = coordinate(1 - v);
      const offshoreDistance = Math.max(0, Math.hypot(x, z) - 51) / 73;
      const shelf = offshore ? 84 * (1 - Math.exp(-(offshoreDistance ** 2))) : 0;
      return [x, bed(x, z) - shelf, z];
    },
    272,
    272,
  );
  for (let i = 0; i < sand.uvs.length; i++) {
    sand.uvs[i] = (coordinate(sand.uvs[i]) / 160 + 0.5) * 39;
  }
  model.part('Coarse rippled sand', sand, 'sand');
  const rocks = Array.from({ length: 7 }, (_, style) =>
    parametricGeometry(
      (u, v) => {
        const azimuth = -tau * u;
        const latitude = (v - 0.5) * Math.PI;
        const cosine = Math.cos(latitude);
        const x = Math.cos(azimuth) * cosine;
        const y = Math.sin(latitude);
        const z = Math.sin(azimuth) * cosine;
        const fractures =
          0.87 +
          0.09 * Math.sin(7.1 * x + 5.4 * z - style) +
          0.1 * Math.cos(5.1 * y + 8.2 * z + style) +
          0.06 * Math.sin(13 * y - 16 * x + style);
        return [x * fractures, y * fractures, z * fractures];
      },
      32,
      20,
    ),
  );
  for (let i = 0; i < 104; i++) {
    const x = (random() - 0.5) * 57;
    const z = (random() - 0.55) * 38;
    if (Math.abs(z - cableZ(x)) < 0.6 || Math.hypot(x * 0.54, z) < 2.1) continue;
    const boulder = z < -7 && i % 4 === 0;
    const width = boulder ? 0.52 + random() * 1.12 : 0.045 + random() ** 2.5 * 0.44;
    model.part('Limestone fragment', rocks[i % rocks.length], 'rock', [x, bed(x, z) - width * 0.12, z], {
      scale: [width * 1.4, width * (0.36 + random() * 0.47), width],
      rotation: turn(1, random() * tau),
    });
  }
}

export function cableZ(x) {
  const distance = Math.max(0, Math.abs(x) - 2.5);
  return Math.min(distance / 5, 1) * (1.6 * Math.sin(x * 0.21) + 1.0 * Math.sin(x * 0.063));
}

function addCable(model) {
  for (const side of [-1, 1]) {
    const route = Array.from({ length: 88 }, (_, i) => {
      const x = side * (2.36 + i * 0.93);
      const z = cableZ(x);
      const settling = Math.exp(-i * 0.23);
      return [x, bed(x, z) + 0.072 + 0.41 * settling, z];
    });
    model.part('Armoured cable', line(route, 0.076, 320), 'rubber');
    for (let rib = 0; rib < 21; rib++) {
      const f = rib / 20;
      const x = side * (1.84 + f * 0.58);
      const collar = model.part(
        'Strain relief rib',
        cylinder,
        rib % 7 === 0 ? 'anodized' : 'rubber',
        [x, bed(x, 0) + 0.5, 0],
        {
          scale: [0.16 - f * 0.073, 0.024, 0.16 - f * 0.073],
          rotation: alongX,
        },
      );
      if (rib === 0) model.nodes[collar].name = 'Cable gland seat';
    }
  }

  const body = latheGeometry(
    [
      [0, -1.76],
      [0.23, -1.76],
      [0.31, -1.63],
      [0.42, -1.43],
      [0.422, -1.37],
      [0.42, 1.37],
      [0.405, 1.47],
      [0.28, 1.66],
      [0.215, 1.76],
      [0, 1.76],
    ],
    72,
  );
  const y = seafloor + 0.52;
  for (let i = 0; i < body.uvs.length / 2; i++) {
    body.uvs[i * 2] *= 1.22;
    body.uvs[i * 2 + 1] = (body.positions[i * 3 + 1] + 1.76) / 1.62;
  }
  model.part('Corroded cable-joint shell', body, 'steel', [0, y, 0], { rotation: alongX });
  const seam = torusGeometry(0.417, 0.018, 11, 72);
  for (const side of [-1, 1]) {
    model.part('Machined end flange', cylinder, 'anodized', [side * 1.4, y, 0], {
      rotation: alongX,
      scale: [0.459, 0.154, 0.459],
    });
    model.part('Gland shoulder', cylinder, 'silver', [side * 1.73, y, 0], {
      rotation: alongX,
      scale: [0.254, 0.12, 0.254],
    });
    model.part('Gland hex locknut', bolt, 'brass', [side * 1.813, y, 0], {
      rotation: alongX,
      scale: [0.203, 0.079, 0.203],
    });
    model.part('Longitudinal weld', seam, 'silver', [side * 1.253, y, 0], { rotation: turn(1, Math.PI / 2) });
    for (let i = 0; i < 12; i++) {
      const angle = (i * tau) / 12;
      const pin = [side * 1.487, y + 0.392 * Math.cos(angle), 0.392 * Math.sin(angle)];
      model.part('Flange washer', cylinder, 'silver', pin, { rotation: alongX, scale: [0.048, 0.015, 0.048] });
      model.part('Flange bolt', bolt, 'silver', [pin[0] + side * 0.028, pin[1], pin[2]], {
        rotation: alongX,
        scale: [0.032, 0.041, 0.032],
      });
    }
  }
  for (const x of [-0.92, 0.92]) {
    model.part('Lifting collar', cylinder, 'amber', [x, y, 0], { rotation: alongX, scale: [0.443, 0.105, 0.443] });
    model.part('Isolation saddle', soft, 'zinc', [x, seafloor + 0.045, 0], { scale: [0.44, 0.23, 1.16] });
    model.part('Lifting eye', torusGeometry(0.101, 0.025, 10, 36), 'amber', [x, y + 0.48, 0]);
    for (const z of [-0.49, 0.49]) {
      model.part('Saddle mounting stud', bolt, 'silver', [x, seafloor + 0.17, z], { scale: [0.045, 0.045, 0.045] });
    }
  }
  model.part('Inspection plate bracket', soft, 'anodized', [0, y + 0.11, 0.399], { scale: [0.78, 0.38, 0.094] });
  const face = planeGeometry(0.739, 0.349);
  for (let u = 1; u < face.uvs.length; u += 2) face.uvs[u] = 1 - face.uvs[u];
  model.part('Circuit identification plate', face, 'plate', [0, y + 0.11, 0.452]);
  for (const x of [-0.341, 0.341]) {
    for (const dy of [-0.142, 0.142]) {
      model.part('Plate rivet', sphere, 'silver', [x, y + 0.11 + dy, 0.455], { scale: [0.013, 0.013, 0.009] });
    }
  }

  // Passive acoustic marker beside the joint and its short, ground-following lead.
  const z = -1.5;
  model.part('Marker anchor', soft, 'steel', [1.15, seafloor + 0.1, z], { scale: [0.61, 0.27, 0.61] });
  model.part('Acoustic marker', cylinder, 'amber', [1.15, seafloor + 0.43, z], { scale: [0.142, 0.56, 0.142] });
  model.part('Marker status cap', sphere, 'beacon', [1.15, seafloor + 0.72, z], { scale: [0.09, 0.038, 0.09] });
  model.part(
    'Marker lead',
    line(
      [
        [1.15, seafloor + 0.26, z],
        [0.91, seafloor + 0.052, -1.1],
        [0.6, seafloor + 0.052, -0.53],
        [0.63, y - 0.19, -0.33],
      ],
      0.028,
    ),
    'rubber',
  );
}

function addVegetation(model, random) {
  const moving = [];
  const leaves = [
    [0.41, 0.062],
    [0.75, 0.09],
    [1.13, 0.13],
  ].map(([length, width]) =>
    parametricGeometry(
      (u, v) => {
        const twist = (v - 0.15) * 2.4;
        const edge = (u - 0.5) * width * Math.sin(Math.PI * (v * 0.95 + 0.045)) ** 0.69;
        return [
          0.25 * length * v ** 2 + edge * Math.cos(twist),
          length * (v - 0.14 * v ** 3),
          0.36 * v ** 2 + edge * Math.sin(twist) + 0.019 * Math.sin(v * 22 + u * 4) * v,
        ];
      },
      6,
      20,
    ),
  );
  const tufts = [
    [-3.2, 2.25],
    [2.9, 3.1],
    [-4.5, -3.4],
    [5, -2.25],
    [8, 0.8],
  ];
  for (let i = 0; i < 45; i++) {
    const x = (random() - 0.5) * 36;
    const z = (random() - 0.65) * 28;
    if (Math.abs(z - cableZ(x)) > 1.4 && Math.hypot(x, z) > 3.8) tufts.push([x, z]);
  }
  for (let i = 0; i < tufts.length; i++) {
    const [x, z] = tufts[i];
    const root = model.node('Current-driven grass tuft', [x, bed(x, z) - 0.04, z]);
    moving.push(root);
    for (let n = 0; n < 6; n++) {
      const size = 0.42 + random() * 0.9;
      model.part(
        'Ribbon blade',
        leaves[(n + i) % leaves.length],
        n % 3 === 0 ? 'kelp' : 'eelgrass',
        [(random() - 0.5) * 0.29, 0, (random() - 0.5) * 0.29],
        {
          parent: root,
          scale: [size, size, size],
          rotation: turn(1, random() * tau),
        },
      );
    }
  }
  return moving;
}

export function makeSet(engine, images, { offshore = false } = {}) {
  const model = new SetModel();
  const random = seededRandom(48874);
  addTerrain(model, random, offshore);
  addCable(model);
  const grassRoots = addVegetation(model, random);
  const diver = addDiver(model);
  const buddy = addDiver(model, true);
  const scene = model.load(engine, images);
  return { scene, diver, buddy, grasses: grassRoots.map((i) => scene.nodes[i]) };
}
