import { ResampledVoxelPathTracer } from '@margoengine/voxel-pathtracer/resampled';
import { rng, shotAt } from './film.js';

const dimensions = [114, 62, 89],
  unit = 0.076;
const [nx, ny, nz] = dimensions;
const rgba = [
  null,
  [0.15, 0.17, 0.18],
  [0.23, 0.24, 0.23],
  [0.32, 0.23, 0.17],
  [0.39, 0.26, 0.17],
  [0.15, 0.2, 0.21],
  [0.08, 0.11, 0.125],
  [0.11, 0.3, 0.29],
  [0.29, 0.51, 0.42],
  [0.46, 0.12, 0.071],
  [0.23, 0.37, 0.45],
  [0.62, 0.44, 0.25],
  [0.66, 0.73, 0.61],
  [0.9, 0.52, 0.18],
  [0.23, 0.64, 0.59],
  [0.82, 0.93, 0.96],
  [0.47, 0.57, 0.62],
  [0.089, 0.21, 0.22],
  [0.115, 0.111, 0.104],
  [0.52, 0.49, 0.42],
  [0.32, 0.46, 0.62],
  [0.31, 0.27, 0.25],
  [0.38, 0.31, 0.24],
  [0.43, 0.33, 0.24],
  [0.21, 0.27, 0.27],
];
const glyphs = {
  R: ['110', '101', '110', '101', '101'],
  E: ['111', '100', '110', '100', '111'],
  P: ['110', '101', '110', '100', '100'],
  A: ['010', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
};
const matrix = (scale, x, y, z) => [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1];

function workshopShell() {
  const voxels = new Uint8Array(nx * ny * nz),
    r = rng(43019);
  function block(x, y, z, w, h, d, id) {
    for (let k = z; k < z + d; k++)
      for (let j = y; j < y + h; j++) {
        const index = x + nx * (k + nz * j);
        voxels.fill(id, index, index + w);
      }
  }
  // The west wall is an existing cutaway so the work area stays visible from the approach.
  block(0, 0, 0, 114, 3, 89, 6);
  for (let z = 0; z < nz; z += 5)
    for (let x = 0; x < nx; x += 5) block(x, 3, z, Math.min(4, nx - x), 1, Math.min(4, nz - z), r() < 0.33 ? 1 : 2);
  block(11, 4, 8, 94, 3, 66, 21);
  for (let z = 8; z < 74; z += 4)
    for (let x = 11; x < 105; x += 11) block(x, 7, z, Math.min(10, 105 - x), 1, 3, r() > 0.35 ? 22 : 23);
  block(12, 8, 9, 91, 42, 4, 21);
  block(99, 8, 13, 4, 43, 51, 21);
  for (let y = 8; y < 50; y += 3) {
    for (let offset = (((y / 3) | 0) % 2) * 4, x = 12 + offset; x < 102; x += 8)
      block(x, y, 13, Math.min(7, 102 - x), 2, 1, [21, 22, 23, 3][Math.floor(r() * 4)]);
    for (let offset = (((y / 3) | 0) % 2) * 4, z = 15 + offset; z < 64; z += 8)
      block(98, y, z, 1, 2, Math.min(7, 64 - z), [21, 22, 23, 24][Math.floor(r() * 4)]);
  }
  for (const x of [12, 49, 98]) block(x, 8, 14, 3, 44, 3, 6);
  for (const z of [14, 35, 60]) block(96, 48, z, 7, 4, 3, 5);
  block(17, 50, 9, 86, 3, 15, 5);
  block(16, 53, 8, 88, 2, 18, 6);
  block(99, 49, 18, 4, 4, 46, 5);
  // Front return piers and fluted projecting shop fascia.
  for (const x of [12, 95]) {
    block(x, 8, 63, 6, 31, 8, 7);
    block(x + 1, 9, 70, 1, 29, 2, 8);
    block(x + 4, 9, 70, 1, 29, 2, 8);
    block(x - 1, 35, 62, 8, 4, 10, 5);
  }
  block(12, 39, 62, 90, 9, 8, 7);
  block(10, 48, 61, 95, 2, 12, 6);
  block(11, 39, 70, 93, 1, 1, 8);
  const letters = 'REPAIR';
  for (let i = 0; i < letters.length; i++)
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++) {
        if (glyphs[letters[i]][y][x] === '1') block(40 + i * 6 + x, 46 - y, 70, 1, 1, 1, 14);
      }
  for (const x of [19, 87]) {
    block(x, 40, 69, 7, 6, 2, 17);
    block(x + 1, 41, 71, 5, 4, 1, 14);
  }
  // Low side window, with thick frame, divider and real glass in the path tracer.
  block(96, 20, 33, 9, 17, 22, 0);
  for (const z of [31, 42, 54]) block(97, 19, z, 5, 20, 2, 7);
  block(97, 19, 31, 5, 2, 25, 8);
  block(97, 36, 31, 5, 2, 25, 8);
  block(100, 21, 33, 1, 15, 9, 15);
  block(100, 21, 44, 1, 15, 10, 15);
  // Hardwood bench and drawer bank against the pegboard.
  for (const x of [24, 81]) for (const z of [17, 33]) block(x, 8, z, 3, 12, 3, 5);
  block(22, 19, 15, 66, 3, 24, 3);
  block(22, 21, 37, 66, 1, 2, 11);
  block(71, 8, 20, 15, 11, 16, 7);
  for (let y = 9; y <= 16; y += 3) {
    block(72, y, 36, 13, 2, 1, 8);
    block(77, y + 1, 37, 4, 1, 1, 16);
  }
  block(24, 23, 14, 53, 16, 3, 4);
  for (let y = 25; y < 38; y += 2) for (let x = 26; x < 76; x += 3) block(x, y, 17, 1, 1, 1, 18);
  for (const [x, y, h, id] of [
    [29, 26, 10, 16],
    [36, 26, 9, 12],
    [42, 25, 7, 16],
    [51, 25, 12, 16],
    [63, 25, 7, 11],
    [69, 24, 10, 16],
  ]) {
    block(x, y, 17, 1, h, 1, id);
    block(x - 1, y + h - 2, 17, 3, 2, 1, id);
  }
  block(54, 22, 26, 14, 10, 10, 6);
  block(55, 23, 36, 12, 8, 1, 8);
  block(56, 24, 37, 7, 6, 1, 17);
  block(57, 25, 38, 5, 4, 1, 14);
  for (const x of [64, 66]) block(x, 25, 37, 1, 2, 1, 12);
  block(57, 32, 30, 1, 8, 1, 16);
  block(57, 40, 30, 6, 1, 1, 16);
  for (const [x, z, h, color] of [
    [32, 27, 4, 9],
    [39, 22, 6, 10],
    [76, 24, 5, 9],
    [81, 27, 3, 11],
    [84, 32, 3, 10],
  ]) {
    block(x, 22, z, 4, h, 4, color);
    block(x + 1, 22 + h, z + 1, 2, 1, 2, 16);
  }
  // Bench task lamp. Its illuminated underside is the practical source for the interior lighting.
  block(40, 22, 24, 9, 2, 8, 6);
  block(44, 24, 27, 2, 15, 2, 5);
  block(45, 37, 26, 13, 2, 2, 5);
  block(53, 34, 24, 13, 4, 7, 7);
  block(54, 33, 25, 11, 1, 5, 13);
  // Shelves, parts bins, steel cabinet, stool, plant and pavement detail.
  for (const y of [18, 30, 42]) {
    block(17, y, 19, 15, 2, 7, 3);
    for (let i = 0; i < 4; i++) block(18 + i * 3, y + 2, 21, 2, 3 + Math.floor(r() * 3), 4, [7, 9, 10, 11][i]);
  }
  for (const [x, z, width, depth, color] of [
    [28, 50, 15, 12, 7],
    [74, 52, 10, 8, 9],
    [87, 54, 7, 7, 10],
  ]) {
    block(x, 8, z, width, 2, depth, color);
    for (const offset of [1, width - 2]) for (const side of [1, depth - 2]) block(x + offset, 8, z + side, 1, 7, 1, 6);
    block(x, 15, z, width, 2, depth, color);
  }
  block(18, 8, 61, 6, 5, 6, 9);
  block(19, 13, 62, 4, 5, 4, 17);
  for (let i = 0; i < 19; i++)
    block(16 + Math.floor(r() * 10), 14 + Math.floor(r() * 7), 59 + Math.floor(r() * 10), 1, 2, 1, r() < 0.5 ? 8 : 17);
  block(4, 4, 72, 105, 1, 2, 10);
  for (let i = 0; i < 95; i++) {
    const x = 1 + Math.floor(r() * 110),
      z = 73 + Math.floor(r() * 14);
    block(x, 4, z, 1 + Math.floor(r() * 2), 1, 1, i % 4 ? 2 : 19);
  }
  return voxels;
}
const shots = [
  [5, [5.5, 2.4, 4.8], [4.45, 2.1, 3.72], [0.7, 3.28, 1.89], [0.55, 3.17, 1.89], 43],
  [16, [-6.7, 3.53, 8.45], [-5.04, 3.7, 7.03], [0.03, 1.75, 0.41], [0.0, 1.85, 0.44], 48],
  [27, [-4.25, 2.25, 3.9], [-3.46, 2.31, 3.57], [-0.4, 1.61, -1.72], [-0.13, 1.63, -1.72], 44],
  [39, [2.53, 2.15, 1.77], [1.7, 2.07, 1.19], [0.12, 1.89, -0.84], [0.0, 1.83, -0.94], 40],
  [52, [-1.45, 2.44, 0.92], [-1.53, 2.37, 0.61], [0.25, 2.0, -0.94], [0.4, 2.03, -1.14], 38],
  [65, [5.25, 2.77, 3.08], [5.12, 2.79, 2.55], [3.07, 2.37, -0.02], [3.13, 2.32, -0.35], 40],
  [81, [-4.45, 3.41, 4.43], [-3.39, 3.56, 3.97], [0.09, 1.98, -0.4], [0.1, 1.97, -0.4], 54],
  [90, [-6.8, 3.3, 7.4], [-7.38, 3.49, 8.05], [0.22, 1.92, 0.15], [0.22, 1.92, 0.15], 44],
];
export async function buildNightShop(engine) {
  const model = { id: 'shop', revision: 1, size: dimensions, voxels: workshopShell() };
  const sceneFor = (mode) => ({
    revision: mode + 1,
    models: [model],
    instances: [{ id: 'shop', modelId: 'shop', matrix: matrix(unit, -4.32, 0, -3.39) }],
    materials: rgba.flatMap((color, id) =>
      !color
        ? []
        : [
            id === 15
              ? { id, color, type: 'glass', ior: 1.47, roughness: 0.04 }
              : id === 13 || id === 14
                ? { id, color, type: 'emit', emission: id === 13 ? (mode >= 2 ? 6.3 : 0.06) : mode >= 1 ? 4.8 : 0.14 }
                : { id, color, type: 'diffuse', roughness: 0.68 },
          ],
    ),
    environment: {
      skyColor: [0.13, 0.19, 0.35],
      backgroundColor: [0.022, 0.035, 0.062],
      sunIntensity: 0.46,
      sunColor: [0.63, 0.75, 1],
      sunDirection: [-0.69, 0.44, 0.54],
      sunAngularSize: 0.1,
      sunVisible: false,
      groundColor: [0.075, 0.09, 0.13],
      groundFade: 9,
      groundFadeStart: 12,
    },
  });
  let mode = 1;
  const trace = ResampledVoxelPathTracer.attach(engine, {
    scene: sceneFor(mode),
    maxSamples: 20,
    samplesPerFrame: 8,
    resolutionScale: 0.46,
    denoise: true,
    candidates: 5,
  });
  await trace.ready;
  return {
    apply(time) {
      const next = time < 5 ? 1 : time < 11.6 ? 0 : time < 28.5 ? 1 : 2;
      if (next !== mode) {
        trace.setScene(sceneFor(next));
        mode = next;
      }
      return shotAt(shots, time);
    },
    cues: [
      [6, 10, 'A small repair shop after dark.'],
      [13, 18, 'The sign throws green light onto the fascia.'],
      [23, 27, 'A cutaway reveals the workbench.'],
      [29.4, 35, 'One warm task lamp lights the bench.'],
      [45, 50, 'Light bounces between the tools and the wall.'],
      [57, 63, 'A view through the glazed side window.'],
      [73, 79, 'Every visible surface is built from voxels.'],
    ],
    inspection: { trace },
    dispose: () => trace.dispose(),
  };
}
