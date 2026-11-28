import { Material } from '@margoengine/materials';
import { WFCWorkerSolve } from '@margoengine/wfc/worker';
import { generateRockMesh } from '@margoengine/procedural';
import { rng, ramp, shotAt } from './film.js';
import { surface } from './environment-films.js';

const span = 7;
const cell = 2.3;
const middle = 3;
const seeds = [5241, 5574, 10743];
const variants = [
  { edges: [0, 0, 0, 0], weight: 5 },
  { edges: [0, 0, 0, 0], weight: 4 },
  { edges: [0, 0, 0, 0], weight: 3 },
  { edges: [0, 0, 0, 0], weight: 2 },
  ...Array.from({ length: 15 }, (_, n) => ({
    edges: Array.from({ length: 4 }, (_, k) => ((n + 1) >> k) & 1),
    weight: n === 14 ? 0.18 : 0.46,
  })),
];
const tileId = (bits) => bits + 3;
const rules = variants.map(({ edges, weight }) => ({
  weight,
  neighbors: [0, 1, -1, -1, 2, 3].map((face) =>
    variants.flatMap((other, id) => (face < 0 || edges[face] === other.edges[face ^ 1] ? [id] : [])),
  ),
}));
const pins = [
  { position: [middle, 0, 6], tile: tileId(8) },
  { position: [middle, 0, 5], tile: tileId(12) },
  { position: [middle, 0, 4], tile: tileId(12) },
  { position: [middle, 0, 3], tile: tileId(15) },
];

function makeBuilding(shop, parent, kind, place, palette, random) {
  const { box, ring, beam } = shop;
  const wall = palette.stucco[kind];
  const facing = shop.group('House facing the lane', parent, place);
  const room = 1.54 + random() * 0.16;
  const height = [1.25, 1.52, 1.79, 1.06][kind];
  box([room, 0.15, 1.62], palette.foundation, [0, 0.075, 0], undefined, facing, 0.045);
  // Side and back walls hold up the roof. The front is split around deep door and window reveals.
  box([room, height, 0.29], wall, [0, height / 2, -0.65], undefined, facing, 0.041);
  box([0.23, height, 1.48], wall, [-room / 2 + 0.1, height / 2, 0], undefined, facing, 0.036);
  box([0.23, height, 1.48], wall, [room / 2 - 0.1, height / 2, 0], undefined, facing, 0.036);
  for (const [x, width, top, bottom] of [
    [-0.59, 0.27, height, 0],
    [-0.06, 0.28, height, 0],
    [0.53, 0.36, height, 0],
    [-0.32, 0.31, height, 0.93],
    [0.24, 0.34, height, 0.9],
    [0.24, 0.34, 0.47, 0],
  ]) {
    box([width, top - bottom, 0.24], wall, [x, (top + bottom) / 2, 0.7], undefined, facing, 0.026);
  }
  box([0.34, 0.92, 0.04], palette.wood, [-0.32, 0.47, 0.634], undefined, facing, 0.014);
  for (const x of [-0.43, -0.32, -0.21]) box([0.012, 0.88, 0.025], palette.frame, [x, 0.47, 0.665], undefined, facing);
  box([0.37, 0.06, 0.32], palette.foundation, [-0.32, 0.03, 0.85], undefined, facing);
  box([0.36, 0.06, 0.2], palette.wood, [-0.32, 0.94, 0.825], undefined, facing, 0.016);
  box([0.29, 0.39, 0.031], palette.glass, [0.24, 0.68, 0.604], undefined, facing);
  for (const x of [0.08, 0.24, 0.4]) box([0.022, 0.41, 0.04], palette.wood, [x, 0.68, 0.658], undefined, facing);
  box([0.35, 0.062, 0.17], palette.frame, [0.24, 0.455, 0.786], undefined, facing, 0.014);
  box([room + 0.055, 0.13, 1.58], palette.roof, [0, height - 0.055, 0.005], undefined, facing);
  for (const z of [-0.72, 0.72]) box([room, 0.2, 0.16], wall, [0, height + 0.072, z], undefined, facing, 0.036);
  for (const x of [-room / 2 + 0.1, room / 2 - 0.1])
    box([0.2, 0.2, 1.43], wall, [x, height + 0.072, 0], undefined, facing, 0.036);
  for (const x of [-0.53, -0.23, 0.07, 0.37, 0.64])
    ring([0.052, 0.051, 1.72], palette.wood, [x, height - 0.17, 0.05], [Math.PI / 2, 0, 0], facing, 9);
  if (kind === 2) {
    box([0.68, 0.51, 0.71], wall, [-0.34, height + 0.2, -0.32], undefined, facing, 0.042);
    box([0.77, 0.085, 0.78], palette.roof, [-0.34, height + 0.48, -0.32], undefined, facing, 0.026);
    for (const x of [0.55, 0.78]) beam([x, 0.04, 0.9], [x, height + 0.08, 0.53], 0.042, palette.wood, facing, true);
    for (let i = 1; i < 10; i++)
      beam(
        [0.52, (height * i) / 10, 0.9 - 0.037 * i],
        [0.81, (height * i) / 10, 0.9 - 0.037 * i],
        0.027,
        palette.frame,
        facing,
        true,
      );
  }
  return facing;
}

export async function buildVillage(engine, shop) {
  const solved = await Promise.all(
    seeds.map(
      (seed) =>
        new WFCWorkerSolve([span, 1, span], rules, {
          seed,
          pins,
          attempts: 12,
          timeout: 16_000,
        }).result,
    ),
  );
  if (new Set(solved.map((layout) => layout.join(','))).size !== 3)
    throw Error('Village seeds must produce three distinct layouts.');
  const landscape = await surface('gravelly_sand', { color: '#bda681', normalScale: 0.4 });
  const plaster = ['#cd946f', '#dda27b', '#be795b', '#a9795e'].map((color) => new Material({ color, roughness: 0.94 }));
  const mat = (color, roughness = 0.86) => new Material({ color, roughness });
  const palette = {
    stucco: plaster,
    foundation: mat('#a58a6b'),
    wood: mat('#66483b'),
    roof: mat('#916b53'),
    frame: mat('#805647'),
    glass: mat('#374d54', 0.31),
  };
  const stone = mat('#b6a08a'),
    mesa = mat('#815b4d'),
    grass = mat('#697456'),
    path = mat('#af9476'),
    stage = mat('#704d3e');
  shop.box([16.65, 0.72, 16.65], stage, [0, -0.49, 0], undefined, null, 0.13);
  shop.box([16.43, 0.16, 16.43], landscape.material, [0, -0.08, 0], undefined, null, 0.11);
  shop.box([125, 0.4, 125], landscape.material, [0, -1.28, 1], undefined, null);
  const random = rng(715);
  const rocks = ['block', 'slab', 'wedge', 'shard'].map((form, i) => generateRockMesh(27 + i, form));
  const outer = shop.group('Talus and arid foothills', null);
  for (let i = 0; i < 48; i++) {
    const a = random() * Math.PI * 2,
      d = 12 + random() * 38;
    const model = shop.group('Weathered stone', outer, [Math.cos(a) * d, -1.17, Math.sin(a) * d]);
    const s = 0.2 + random() ** 2 * 1.45;
    model.setScale([s, s, s]);
    shop.part(rocks[i % 4], i % 5 ? stone : mesa, undefined, [0, a, 0], model);
  }
  for (let i = 0; i < 13; i++) {
    const x = (i - 6) * 5.5,
      z = -36 - random() * 9;
    const ridge = shop.group('Mesa silhouette', outer, [x, -0.43, z]);
    ridge.setScale([2.8 + random() * 2.2, 2.3 + random() * 3.2, 3 + random() * 3]);
    shop.part(rocks[i % 4], mesa, undefined, [0, random(), 0], ridge);
  }

  const plaza = shop.group('Pinned plaza', null, [0, 0, 0]);
  shop.box([2.05, 0.06, 2.05], path, [0, 0.029, 0], undefined, plaza, 0.06);
  shop.ring([0.42, 0.49, 0.15], stone, [0, 0.13, 0], undefined, plaza, 12);
  shop.ring([0.28, 0.28, 0.17], palette.roof, [0, 0.27, 0], undefined, plaza, 12);
  shop.ring([0.17, 0.17, 0.009], palette.glass, [0, 0.362, 0], undefined, plaza, 24);
  for (const x of [-0.74, 0.74])
    for (const z of [-0.76, 0.76]) {
      shop.ring([0.1, 0.08, 0.15], palette.roof, [x, 0.12, z], undefined, plaza, 12);
      shop.ring([0.12, 0.04, 0.15], grass, [x, 0.24, z], undefined, plaza, 9);
    }
  const gate = shop.group('Pinned south gate', null, [0, 0, 6.9]);
  for (const x of [-0.73, 0.73]) {
    shop.box([0.37, 1.32, 0.53], palette.stucco[1], [x, 0.66, 0], undefined, gate, 0.048);
    shop.box([0.47, 0.14, 0.62], stone, [x, 1.32, 0], undefined, gate, 0.032);
  }
  shop.box([1.72, 0.16, 0.28], palette.wood, [0, 1.415, 0], undefined, gate, 0.036);
  const groups = solved.map((layout, design) => {
    const root = shop.group('Layout ' + (design + 1), null);
    const lots = [];
    for (let z = 0; z < span; z++)
      for (let x = 0; x < span; x++) {
        const id = layout[x + z * span],
          px = (x - middle) * cell,
          pz = (z - middle) * cell;
        const lot = shop.group('Lot ' + x + ', ' + z, root, [px, 0, pz]);
        const balance = Math.max(Math.abs(x - middle), Math.abs(z - middle));
        if (id < 4) {
          const house = makeBuilding(shop, lot, id, [0, 0, 0], palette, random);
          const front = [
            [0, 1],
            [1, 0],
            [0, -1],
            [-1, 0],
          ].find(
            ([dx, dz]) =>
              x + dx >= 0 && x + dx < span && z + dz >= 0 && z + dz < span && layout[x + dx + (z + dz) * span] >= 4,
          );
          house.setRotation([0, front ? Math.atan2(front[0], front[1]) : Math.atan2(-px, -pz), 0]);
          for (let i = 0; i < 5; i++) {
            const b = random() * 6.28,
              r = 0.82 + random() * 0.2;
            shop.ring([0.071, 0.024, 0.13], grass, [Math.cos(b) * r, 0.055, Math.sin(b) * r], undefined, lot, 6);
          }
        } else if (x !== middle || z !== middle) {
          shop.box([0.72, 0.032, 0.72], path, [0, 0.018, 0], undefined, lot, 0.03);
          variants[id].edges.forEach((yes, side) => {
            if (!yes) return;
            const alongX = side < 2,
              sign = side % 2 ? -1 : 1;
            shop.box(
              alongX ? [1.04, 0.031, 0.72] : [0.72, 0.031, 1.04],
              path,
              alongX ? [sign * 0.79, 0.018, 0] : [0, 0.018, sign * 0.79],
              undefined,
              lot,
            );
          });
          for (let i = 0; i < 11; i++) {
            const p = [(random() - 0.5) * 1.87, 0.036, (random() - 0.5) * 1.87];
            if (Math.abs(p[0]) < 0.33 || Math.abs(p[2]) < 0.33) continue;
            shop.box([0.07, 0.027, 0.105], stone, p, [0, random() * 3, 0], lot, 0.012);
          }
        }
        lots.push({ lot, px, pz, order: balance + 0.6 * random() });
      }
    return { root, lots };
  });

  const shots = [
    [5, [9, 11, 13], [7.2, 9.6, 10.8], [0, 0.32, 0], [0, 0.32, 0], 44],
    [16, [0.7, 2.41, 9.6], [-0.4, 2.55, 6.5], [0, 0.8, 5], [0, 0.83, 2.35], 44],
    [30, [4.9, 6.8, 9.4], [7.4, 7.5, 6.8], [0, 0.73, 0], [0, 0.73, 0], 46],
    [42, [0.2, 15, 6.3], [-3.4, 13.3, 5.9], [0, 0, 0], [0, 0, 0], 53],
    [55, [-10, 7.1, 5.2], [-8.1, 7.1, 8.4], [0, 0.6, 0], [0, 0.6, 0], 47],
    [68, [4.3, 10.2, -11.1], [5.3, 12.9, -11.8], [0, 0.6, 0], [0, 0.55, 0], 46],
    [81, [5.4, 3.2, 5.45], [3.6, 2.7, 3.7], [0, 0.9, 0], [0, 0.72, 0], 52],
    [90, [8.7, 9.4, 10.3], [11.1, 11.8, 13.8], [0, 0.7, 0], [0, 0.5, 0], 47],
  ];
  return {
    apply(time) {
      const design = time < 30 ? 0 : time < 55 ? 1 : 2;
      const start = [0, 30, 55][design],
        elapsed = time - start;
      groups.forEach(({ root, lots }, i) => {
        root.visible = i === design;
        if (i !== design) return;
        for (const { lot, px, pz, order } of lots) {
          const progress =
            time < 1.3
              ? ramp(time, 0.1 * order, 0.62 + 0.13 * order)
              : design === 0
                ? 1
                : ramp(elapsed, 0.64 * order, 1.15 + 0.72 * order);
          lot.setPosition([px, -1.15 * (1 - progress), pz]).setScale([1, Math.max(0.001, progress), 1]);
        }
      });
      return shotAt(shots, time);
    },
    cues: [
      [5.4, 13, 'The gate and plaza are fixed.'],
      [18, 27, 'Road tiles match an open edge with an open edge.'],
      [31, 39, 'A second seed builds a different street plan.'],
      [43, 51, 'The gate still leads to the same square.'],
      [56, 64, 'A third seed rearranges the lanes and homes.'],
      [72, 79, 'Three layouts. The same entrance and plaza.'],
    ],
    inspection: { seeds, layouts: solved.map((value) => [...value]) },
    dispose: () => landscape.dispose(),
  };
}
