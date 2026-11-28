import { AreaLights } from '@margoengine/clustered/area';
import { DOF } from '@margoengine/dof';
import { Path, Shape, extrudeGeometry, latheGeometry } from '@margoengine/geometry';
import { Material, Texture } from '@margoengine/materials';
import { DepthTexture } from '@margoengine/post/depth';
import { HeatHaze } from '@margoengine/post/heat-haze';
import { VFX } from '@margoengine/vfx';
import { Flame } from '@margoengine/vfx/flame';
import { finishTexture, ramp, rng, shotAt } from './film.js';

const rightAngle = Math.PI / 2;
const hinge = [-0.758, 0, 0.592];
const archY = 1.37;
const radius = 0.594;
const floorY = 0.481;

export const kilnLook = {
  direction: [-0.41, 0.85, 0.36, 0.43],
  radiance: [0.71, 0.83, 1, 0.2],
  ambient: [0.69, 0.78, 0.96],
  environment: 0.41,
  exposure: 0.11,
  bloom: 0.17,
  shadows: { resolution: 2048, distance: 12, normalBias: 0.0031, lightSize: 0.35 },
};

function extrude(points, depth, bevel, holes = []) {
  const shape = new Shape();
  shape.moveTo(...points[0]);
  for (const p of points.slice(1)) shape.lineTo(...p);
  shape.closePath();
  for (const ring of holes) {
    const path = new Path();
    path.moveTo(...ring[0]);
    for (const p of ring.slice(1)) path.lineTo(...p);
    path.closePath();
    shape.holes.push(path);
  }
  return extrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 3,
  });
}

function arch(r, bottom, center = archY) {
  return [
    [-r, bottom],
    [r, bottom],
    ...Array.from({ length: 33 }, (_, i) => [
      r * Math.cos((i * Math.PI) / 32),
      center + r * Math.sin((i * Math.PI) / 32),
    ]),
  ];
}

function surface(seed, rgb, cracks = false) {
  const random = rng(seed);
  const side = 256;
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const v =
        8 * Math.cos(x * 0.063 + 0.72 * Math.sin(y * 0.072)) * Math.sin(y * 0.067) +
        7 * Math.sin(x * 0.21 + y * 0.18) +
        4.8 * Math.cos(x * 0.401 - y * 0.368);
      const pits = random() < 0.074 ? -33 * random() : 0;
      const seam = cracks && Math.abs(Math.sin((y - x * 0.39) * 0.052 + Math.sin(x * 0.035) * 0.38)) < 0.018 ? -19 : 0;
      const c = v + 13 * (random() - 0.53) + pits + seam;
      const p = (y * side + x) * 4;
      for (let i = 0; i < 3; i++) data[p + i] = Math.min(255, Math.max(10, rgb[i] + c));
      data[p + 3] = 255;
    }
  return new Texture(
    { width: side, height: side, data },
    { colorSpace: 'srgb', anisotropy: 8, wrapS: 'repeat', wrapT: 'repeat' },
  );
}

export function buildKiln(engine, shop, cluster) {
  const { group, box, part, beam, ring, sign } = shop;
  const random = rng(607771);
  const brushed = finishTexture(62, { r: 207, grain: 24, streak: true, mottling: 14 });
  const cast = finishTexture(73, { r: 205, grain: 37, mottling: 26 });
  const mortarMap = surface(710, [80, 74, 65], true),
    brickMap = surface(519, [148, 118, 91], true);
  const hearthMap = surface(714, [170, 134, 98], true),
    ashMap = surface(413, [97, 89, 76], true);
  const steelMap = surface(713, [123, 129, 127]);
  const paintMap = surface(791, [104, 128, 134], true);
  const textureBank = [brushed, cast, mortarMap, brickMap, hearthMap, ashMap, steelMap, paintMap];
  const mat = (color, roughness, metalness = 0, roughnessMap = cast) =>
    new Material({ color, roughness, metalness, roughnessMap });
  const plain = (map, roughness) => new Material({ color: '#ffffff', map, roughness, roughnessMap: cast });
  const paint = new Material({ color: '#b9d4ce', map: paintMap, roughness: 0.59, metalness: 0.06, roughnessMap: cast });
  const iron = mat('#364045', 0.45, 0.83, brushed),
    frame = mat('#33393c', 0.7, 0.32);
  const black = mat('#1b2224', 0.85, 0.08),
    steel = mat('#9aa5a3', 0.29, 0.86, brushed);
  const tile = plain(mortarMap, 0.94),
    table = plain(steelMap, 0.53),
    concrete = plain(ashMap, 0.93);
  const brick = plain(brickMap, 0.94),
    pipe = mat('#535954', 0.57, 0.69),
    leather = mat('#3b3735', 0.91);
  const hot = [0, 1, 2, 3].map(
    (i) =>
      new Material({
        color: ['#fff3db', '#ead3b8', '#f5e4cc', '#dfc4a1'][i],
        map: hearthMap,
        roughness: 0.96,
        emissive: ['#f2460b', '#ee4c19', '#c22606', '#ff6531'][i],
        emissiveIntensity: 0.05 + i * 0.018,
      }),
  );
  const terracotta = mat('#8d624a', 0.65, 0.025);
  const jade = mat('#5a766b', 0.34, 0.033, brushed),
    ecru = mat('#af9c7e', 0.61, 0.025),
    ink = mat('#506068', 0.38, 0.035);
  const lamp = (color, intensity) =>
    new Material({ color, roughness: 0.45, emissive: color, emissiveIntensity: intensity });
  const frosted = lamp('#e5ebec', 3),
    status = lamp('#ff993d', 1.8),
    pilot = lamp('#64bc90', 1.1);
  const gaugeGlow = lamp('#f59652', 0.03);

  // Workshop shell, scuffed floor, wall raceways and luminaires.
  box([12, 0.2, 9.9], concrete, [0, -0.111, 0.55]);
  for (let i = 0; i < 7; i++) box([0.009, 0.005, 9.9], black, [i - 3, 0.001, 0.55]);
  for (const z of [-2.3, -0.68, 1.91, 3.88]) box([11.95, 0.005, 0.009], black, [0, 0.001, z]);
  for (let i = 0; i < 390; i++) {
    const z = -0.25 + random() * 5.8;
    const x = -4 + 8 * random();
    const scale = 0.02 + random() ** 2 * 0.23;
    box([scale, 0.0029, 0.006 + scale * 0.12], i % 6 !== 0 ? tile : brick, [x, 0.0014, z], [0, random() * 2 - 0.7, 0]);
  }
  box([12, 4.25, 0.23], tile, [0, 2.01, -2.57]);
  box([0.25, 4.25, 10], tile, [-5.67, 2, 0.21]);
  const wallBricks = [
    brick,
    plain(surface(921, [113, 91, 72], true), 0.89),
    plain(surface(27, [135, 107, 87], true), 0.88),
  ];
  textureBank.push(wallBricks[1].map, wallBricks[2].map);
  for (let row = 0; row < 29; row++) {
    for (let col = 0; col < 35; col++) {
      const x = (col - 17) * 0.337 + (row % 2) * 0.168;
      box(
        [0.329, 0.116, 0.031],
        wallBricks[Math.floor(random() * 3)],
        [x, 0.065 + row * 0.128, -2.431],
        undefined,
        undefined,
        0.004,
      );
    }
  }
  for (const x of [-4.2, -1.94, 1.88, 4.22]) {
    box([0.164, 4.25, 0.153], frame, [x, 2.02, -2.337], undefined, undefined, 0.016);
    box([0.123, 0.16, 8.4], frame, [x, 3.71, 0.05]);
  }
  for (const y of [0.34, 2.74]) beam([-5.25, y, -2.321], [5.36, y, -2.321], 0.044, pipe, undefined, true);
  for (const x of [-3.92, 1.97, 3.48]) {
    beam([x, 0.43, -2.31], [x, 2.74, -2.31], 0.026, iron, undefined, true);
    box([0.135, 0.206, 0.087], black, [x, 1.34, -2.254], undefined, undefined, 0.013);
  }
  const keys = [
    [-2.19, 3.48, 0.251],
    [1.98, 3.48, -0.68],
    [0.94, 3.54, 2.63],
  ];
  const lights = [];
  for (const [i, p] of keys.entries()) {
    box([1.36, 0.14, 0.292], frame, p, undefined, undefined, 0.026);
    box([1.27, 0.019, 0.211], frosted, [p[0], p[1] - 0.079, p[2]], undefined, undefined, 0.009);
    lights.push({
      position: [p[0], p[1] - 0.102, p[2]],
      direction: i === 2 ? [-0.05, -0.9, -0.37] : [0, -1, 0.03],
      angle: 1.05,
      penumbra: 0.65,
      range: 7.6,
      intensity: [22, 24, 23][i],
      color: [0.67, 0.83, 1],
    });
  }
  cluster.setLights(lights);

  // Bench and cooling racks. Each vessel is hollow and its foot meets the shelf.
  const vesselProfiles = [
    [
      [0, 0],
      [0.082, 0],
      [0.092, 0.012],
      [0.094, 0.04],
      [0.113, 0.073],
      [0.123, 0.135],
      [0.107, 0.21],
      [0.072, 0.256],
      [0.062, 0.268],
      [0.062, 0.283],
      [0.054, 0.285],
      [0.049, 0.276],
      [0.05, 0.256],
      [0.06, 0.239],
      [0.09, 0.208],
      [0.105, 0.132],
      [0.096, 0.067],
      [0.078, 0.029],
      [0, 0.025],
    ],
    [
      [0, 0],
      [0.091, 0],
      [0.096, 0.013],
      [0.134, 0.032],
      [0.164, 0.071],
      [0.161, 0.127],
      [0.145, 0.161],
      [0.133, 0.167],
      [0.127, 0.162],
      [0.137, 0.148],
      [0.149, 0.123],
      [0.15, 0.074],
      [0.12, 0.037],
      [0.065, 0.021],
      [0, 0.021],
    ],
    [
      [0, 0],
      [0.084, 0],
      [0.096, 0.01],
      [0.13, 0.052],
      [0.148, 0.091],
      [0.144, 0.147],
      [0.124, 0.181],
      [0.113, 0.185],
      [0.112, 0.172],
      [0.127, 0.148],
      [0.135, 0.098],
      [0.125, 0.055],
      [0.087, 0.028],
      [0, 0.022],
    ],
  ];
  function vessel(type, material, pos, size = 1) {
    const profile = vesselProfiles[type].map(([r, y]) => [r * size, y * size]);
    part(latheGeometry(profile, 64), material, pos, [0, random() * Math.PI * 2, 0]);
  }
  box([2.41, 0.061, 0.943], table, [2.54, 0.91, -0.95], undefined, undefined, 0.018);
  for (const x of [1.41, 3.66])
    for (const z of [-1.36, -0.52]) {
      box([0.066, 0.89, 0.068], frame, [x, 0.445, z], undefined, undefined, 0.006);
      box([0.11, 0.03, 0.114], black, [x, 0.025, z]);
    }
  box([2.29, 0.026, 0.83], iron, [2.54, 0.31, -0.94]);
  for (const [i, [x, z, k]] of [
    [1.77, -0.99, 1.34],
    [2.12, -1.02, 0.96],
    [2.56, -1.09, 1.08],
    [2.99, -0.93, 0.8],
    [3.36, -0.72, 0.94],
    [3.39, -1.16, 1.16],
  ].entries())
    vessel(i % 3, [terracotta, jade, ecru, ink][i % 4], [x, 0.946, z], k);
  for (const x of [-3.96, -2.49]) {
    for (const z of [-1.57, -2.14]) box([0.055, 2.46, 0.055], frame, [x, 1.226, z], undefined, undefined, 0.008);
  }
  for (const y of [0.32, 0.81, 1.31, 1.81, 2.28]) {
    box([1.51, 0.045, 0.64], iron, [-3.225, y, -1.853]);
    for (let i = 0; i < 4; i++)
      vessel(
        (i + Math.floor(y * 5)) % 3,
        [terracotta, ecru, jade, ink][i],
        [-3.76 + i * 0.349, y + 0.024, -1.82],
        0.73 + random() * 0.33,
      );
  }
  sign(['GLAZE ROOM', 'COOLING RACK'], [0.685, 0.18], [-3.21, 2.56, -2.409], undefined, undefined, {
    background: '#30414a',
  });
  sign(['K-17', 'CERAMIC FIRING'], [0.48, 0.224], [1.52, 2.12, -2.412], undefined, undefined, {
    background: '#394349',
    foreground: '#e6d6b8',
  });

  // Fired chamber, base frame and flue.
  box([1.86, 0.226, 1.637], frame, [0, 0.23, -0.39], undefined, undefined, 0.045);
  for (const x of [-0.759, 0.759])
    for (const z of [-0.97, 0.289]) {
      box([0.175, 0.17, 0.169], iron, [x, 0.084, z], undefined, undefined, 0.022);
      ring([0.022, 0.027, 0.009], steel, [x, 0.17, z], undefined, undefined, 6);
    }
  box([1.81, 0.103, 1.64], black, [0, 0.373, -0.41], undefined, undefined, 0.033);
  for (const x of [-0.787, 0.787]) {
    box([0.293, 1.65, 1.499], paint, [x, 1.264, -0.428], undefined, undefined, 0.063);
    box([0.041, 1.48, 1.331], iron, [x * 1.192, 1.27, -0.424], undefined, undefined, 0.023);
    for (const y of [0.75, 1.91]) box([0.024, 0.032, 1.324], steel, [x * 1.226, y, -0.41], undefined, undefined, 0.004);
    for (let i = 0; i < 13; i++)
      box([0.027, 0.018, 0.302], black, [x * 1.225, 1.559 + i * 0.021, -0.523], undefined, undefined, 0.003);
  }
  box([1.86, 0.251, 1.62], paint, [0, 2.101, -0.466], undefined, undefined, 0.065);
  box([1.6, 0.055, 1.387], steel, [0, 2.252, -0.445], undefined, undefined, 0.043);
  ring([0.229, 0.241, 0.09], iron, [0, 2.296, -0.789]);
  ring([0.191, 0.191, 0.65], pipe, [0, 2.65, -0.789]);
  ring([0.201, 0.201, 0.069], steel, [0, 2.851, -0.789]);
  ring([0.201, 0.203, 0.65], pipe, [0, 3.222, -0.789]);
  box([0.57, 0.118, 0.6], frame, [0, 3.592, -0.789], undefined, undefined, 0.026);
  box([1.79, 1.64, 0.24], frame, [0, 1.262, -1.226], undefined, undefined, 0.032);
  const face = [
    [-0.906, 0.385],
    [0.906, 0.385],
    [0.921, 2.05],
    [0.849, 2.166],
    [-0.849, 2.166],
    [-0.921, 2.05],
  ];
  part(extrude(face, 0.101, 0.021, [arch(radius, floorY)]), iron, [0, 0, 0.331]);
  part(extrude(arch(radius + 0.103, floorY - 0.09), 0.103, 0.005, [arch(radius, floorY)]), brick, [0, 0, 0.42]);
  for (const x of [-0.828, 0.828])
    for (let i = 0; i < 5; i++) {
      ring([0.019, 0.023, 0.014], steel, [x, 0.547 + i * 0.333, 0.446], [rightAngle, 0, 0], undefined, 6);
    }
  for (let i = 0; i < 15; i++) {
    const a = (i * Math.PI) / 15 + 0.021,
      b = ((i + 1) * Math.PI) / 15 - 0.021;
    const polar = (r, t) => [r * Math.cos(t), archY + r * Math.sin(t)];
    const points = [
      polar(radius - 0.006, a),
      polar(radius + 0.091, a),
      polar(radius + 0.091, b),
      polar(radius - 0.006, b),
    ];
    part(extrude(points, 1.32, 0.0047), hot[i % 4], [0, 0, -0.955]);
  }
  for (let row = 0; row < 7; row++) {
    const y = 0.545 + row * 0.118;
    for (let k = 0; k < 7; k++) {
      const x = -0.51 + k * 0.169;
      box([0.164, 0.111, 0.046], hot[(row + k) % 4], [x, y, -1.106], undefined, undefined, 0.004);
    }
    for (const x of [-0.615, 0.615])
      for (let k = 0; k < 6; k++) {
        box([0.08, 0.111, 0.225], hot[(row + k + 1) % 4], [x, y, -0.861 + k * 0.224], undefined, undefined, 0.005);
      }
  }
  for (let row = 0; row < 6; row++) {
    const y = 1.371 + row * 0.097;
    const half = Math.sqrt(radius ** 2 - Math.min(radius - 0.001, y + 0.047 - archY) ** 2) - 0.006;
    const bricks = Math.ceil((2 * half) / 0.166);
    const width = (2 * half) / bricks;
    for (let i = 0; i < bricks; i++) {
      box(
        [width - 0.004, 0.094, 0.046],
        hot[(row + i + 2) % 4],
        [-half + (i + 0.5) * width, y, -1.106],
        undefined,
        undefined,
        0.004,
      );
    }
  }
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 6; j++) {
      box(
        [0.225, 0.049, 0.22],
        hot[(i + j) % 4],
        [-0.453 + i * 0.227, 0.454, -0.876 + j * 0.224],
        undefined,
        undefined,
        0.005,
      );
    }
  const kilnShelf = mat('#ab8a6f', 0.91, 0.02);
  box([0.901, 0.043, 0.724], kilnShelf, [0.012, 0.769, -0.561], undefined, undefined, 0.011);
  for (const x of [-0.414, 0.414])
    for (const z of [-0.312, -0.84]) box([0.079, 0.278, 0.079], hot[2], [x, 0.625, z], undefined, undefined, 0.008);
  vessel(0, ecru, [-0.24, 0.792, -0.515], 0.98);
  vessel(1, terracotta, [0.138, 0.792, -0.438], 1.37);
  vessel(2, ecru, [0.319, 0.792, -0.753], 0.81);
  vessel(0, terracotta, [0.072, 0.792, -0.857], 0.77);
  for (const x of [-0.427, 0.37]) {
    box([0.08, 0.098, 0.476], black, [x, 0.513, -0.635], undefined, undefined, 0.012);
    box([0.018, 0.018, 0.441], gaugeGlow, [x, 0.56, -0.635], undefined, undefined, 0.006);
  }

  // A rigid, insulated door rotates around the visible hinge pin. The latch has its own pivot.
  const door = group('Insulated firing door', null, hinge);
  const latch = group('Cam latch', door, [1.406, 1.112, 0.157]);
  box([1.498, 1.871, 0.156], paint, [0.758, 1.273, 0.065], undefined, door, 0.063);
  box([1.419, 1.769, 0.042], iron, [0.758, 1.273, 0.158], undefined, door, 0.051);
  part(extrude(arch(0.626, 0.443), 0.107, 0.015), brick, [0.758, 0, -0.131], undefined, door);
  for (let row = 0; row < 12; row++) {
    const y = 0.518 + row * 0.121;
    const rise = Math.max(0, y + 0.055 - archY);
    const half = Math.sqrt(0.607 ** 2 - rise ** 2);
    const count = Math.ceil((half * 2) / 0.204);
    for (let column = 0; column < count; column++) {
      const width = (half * 2) / count;
      box(
        [width - 0.006, 0.117, 0.022],
        wallBricks[(row + column) % 3],
        [0.758 - half + (column + 0.5) * width, y, -0.145],
        undefined,
        door,
        0.006,
      );
    }
  }
  for (const x of [0.164, 1.347])
    for (const y of [0.55, 0.92, 1.62, 1.98]) {
      ring([0.017, 0.021, 0.018], steel, [x, y, 0.192], [rightAngle, 0, 0], door, 6);
    }
  box([0.886, 0.238, 0.054], frame, [0.735, 1.442, 0.184], undefined, door, 0.017);
  sign(['K-17   FIRING CHAMBER', 'REFRACTORY DOOR'], [0.734, 0.171], [0.735, 1.444, 0.216], undefined, door, {
    background: '#23353b',
    foreground: '#ddd4bd',
  });
  for (const y of [0.713, 1.795]) {
    box([0.205, 0.126, 0.129], iron, [0.075, y, 0.008], undefined, door, 0.027);
    box([0.22, 0.127, 0.119], iron, [hinge[0] - 0.062, y, hinge[2] - 0.064], undefined, undefined, 0.026);
    ring([0.064, 0.064, 0.237], steel, [hinge[0], y, hinge[2]], undefined, undefined, 37);
    ring([0.082, 0.073, 0.025], iron, [hinge[0], y + 0.129, hinge[2]], undefined, undefined, 30);
  }
  ring([0.074, 0.078, 0.056], black, [0, 0, 0.056], [rightAngle, 0, 0], latch);
  beam([0, 0, 0.091], [-0.036, 0.289, 0.094], 0.057, steel, latch, true);
  ring([0.046, 0.05, 0.187], leather, [-0.039, 0.226, 0.104], undefined, latch);
  box([0.126, 0.085, 0.097], steel, [0.812, 1.116, 0.524], undefined, undefined, 0.017);
  box([0.45, 0.63, 0.22], paint, [1.174, 1.48, 0.095], undefined, undefined, 0.024);
  box([0.382, 0.56, 0.037], black, [1.174, 1.48, 0.226], undefined, undefined, 0.012);
  sign(['K-17', 'HOLD'], [0.27, 0.142], [1.174, 1.61, 0.249], undefined, undefined, {
    background: '#243129',
    foreground: '#d5d2a5',
    lit: 0.69,
  });
  for (const [i, x] of [1.069, 1.173, 1.272].entries())
    ring([0.025, 0.028, 0.018], i === 0 ? status : i === 1 ? pilot : steel, [x, 1.281, 0.256], [rightAngle, 0, 0]);
  beam([1.174, 1.19, 0.13], [1.174, 0.55, 0.13], 0.023, pipe, undefined, true);
  beam([1.174, 0.55, 0.13], [0.852, 0.55, -0.272], 0.023, pipe, undefined, true);

  const depth = DepthTexture.attach(engine);
  const flame = Flame.attach(engine, {
    position: [-0.098, 0.526, -0.657],
    length: 0.365,
    footprint: [0.69, 0.238],
    depth: () => depth.texture,
    peak: 2.9,
    core: 2060,
    edge: 1115,
    opacity: 0.86,
    flicker: 0.64,
    tongues: 0.82,
    glow: 0,
  });
  const sparks = VFX.attach(engine, {
    capacity: 2048,
    initialCount: 12,
    rate: 3,
    position: [0.046, 0.693, 0.432],
    emissionExtent: [0.374, 0.11, 0.074],
    velocity: [0.029, 0.68, 0.25],
    spread: 0.285,
    gravity: [0, 0.38, 0],
    turbulence: 0.36,
    frequency: 3.7,
    color: [1, 0.38, 0.072, 0.89],
    intensity: 8,
    size: 0.018,
    lifetime: [0.62, 1.83],
    softness: 0.024,
    depth: () => depth.texture,
    curves: {
      size: [0.6, 1, 0.29],
      alpha: [0.02, 0.84, 0.73, 0],
      color: [
        { at: 0, color: [1, 0.96, 0.62] },
        { at: 1, color: [0.92, 0.15, 0.011] },
      ],
    },
  });
  const hazeSource = { position: [0, 0.6, 0.56], footprint: [0.83, 0.54], length: 1.08, lean: [-0.06, 0.13], time: 0 };
  const haze = new HeatHaze({ sources: [hazeSource], strength: 5.9, turbulence: 0.52, steps: 20 });
  const panels = AreaLights.attach(engine, { lights: cluster, maxLights: 3 });
  const furnace = {
    position: [0, 1.114, 0.548],
    direction: [0, -0.42, 1],
    width: 1.148,
    height: 1.1,
    color: [1, 0.365, 0.087],
    intensity: 0.1,
  };
  const chamber = {
    position: [0.116, 0.568, -0.591],
    direction: [0, 0.63, 0.39],
    width: 0.69,
    height: 0.242,
    color: [1, 0.313, 0.071],
    intensity: 12,
  };
  const frontKey = {
    position: [1.38, 3.02, 1.85],
    direction: [-0.36, -0.7, -1],
    width: 1.27,
    height: 0.21,
    color: [0.83, 0.91, 1],
    intensity: 5,
  };
  box([1.42, 0.12, 0.269], frame, frontKey.position, undefined, undefined, 0.025);
  box([1.28, 0.019, 0.205], frosted, [1.38, 2.953, 1.85], undefined, undefined, 0.008);

  const shots = [
    [4.8, [1.17, 1.385, 1.73], [1.389, 1.36, 1.61], [0.19, 1.166, 0.57], [0.14, 1.175, 0.225], 39],
    [12.3, [3.7, 2.13, 4.44], [3.26, 2.02, 4.0], [0.12, 1.17, -0.55], [0.05, 1.2, -0.49], 47],
    [20.4, [1.695, 1.467, 1.965], [1.502, 1.393, 1.774], [0.617, 1.236, 0.75], [0.639, 1.212, 0.751], 37],
    [28.4, [-0.23, 1.54, 2.66], [0.098, 1.44, 2.52], [0.184, 1.255, 0.456], [0.207, 1.2, 0.456], 42],
    [39.8, [1.733, 0.47, 2.77], [1.476, 0.58, 2.42], [0.022, 0.971, 0.38], [0.077, 0.995, 0.29], 44],
    [49.8, [0.39, 1.271, 1.71], [0.243, 1.203, 1.406], [0.05, 0.991, -0.38], [0.01, 0.961, -0.52], 39],
    [59.2, [1.114, 1.726, 1.46], [1.024, 1.654, 1.421], [-0.071, 1.376, 0.21], [-0.088, 1.402, 0.08], 36],
    [67.5, [0.677, 1.729, 1.999], [1.02, 1.81, 2.053], [-0.052, 1.351, 0.238], [0.003, 1.31, 0.32], 37],
    [76.5, [2.2, 1.324, 3.04], [2.53, 1.53, 3.08], [0.12, 1.22, 0.23], [0.343, 1.23, 0.28], 42],
    [83, [0.924, 1.785, 2.49], [1.004, 1.77, 2.67], [0.784, 1.406, 0.19], [0.693, 1.39, 0.24], 40],
    [90, [3.24, 1.88, 4.04], [3.52, 2.01, 4.33], [0.164, 1.23, -0.43], [0.085, 1.29, -0.39], 44],
  ];
  const cues = [
    [0.17, 4.53, 'The Kiln Shift'],
    [6.05, 10.67, 'Earlier, at the end of the firing cycle'],
    [15.6, 19.8, 'The chamber holds heat behind the insulated door.'],
    [30.9, 37.4, 'As the door opens, the chamber lights the floor.'],
    [42.5, 48.5, 'The shelves and clay are still hot.'],
    [51.5, 57.2, 'Rising hot air bends the view.'],
    [62.1, 66.1, 'A few embers lift in the draft.'],
    [73.8, 78.9, 'The door settles against its seal.'],
  ];
  const lens = new DOF({ focalLength: 0.038, aperture: 6.3, maxRadius: 10, focalDistance: 1.45 });
  function apply(t) {
    const open = t < 4.8 ? 0.035 + 0.59 * ramp(t, 0.06, 4.7) : ramp(t, 27.62, 37.54) * (1 - ramp(t, 68.9, 73.82));
    const handle = t < 4.8 ? 0.96 : ramp(t, 17.48, 19.18) * (1 - ramp(t, 74.1, 75.36));
    door.setRotation([0, -1.983 * open, 0]);
    latch.setRotation([0, 0, -0.88 * handle]);
    const flicker = 1 + 0.044 * Math.sin(0.37 * t + 1.3 * Math.sin(t * 4.2)) + 0.021 * Math.sin(t * 8.2);
    flame.options.length = (0.242 + 0.128 * open) * flicker;
    flame.options.peak = 1.9 + 0.56 * open;
    sparks.options.rate = 16.4 * open * flicker + 6.9 * open * (1 - ramp(t, 43, 54));
    furnace.intensity = (0.06 + 22.8 * open ** 0.75) * flicker;
    chamber.intensity = (8.9 + 4.6 * open) * flicker;
    panels.setLights([furnace, chamber, frontKey]);
    hazeSource.length = 1.4 * open;
    hazeSource.time = t;
    haze.options.strength = (5.9 + 4.5 * ramp(t, 49.75, 51) * (1 - ramp(t, 57, 59.2))) * open;
    for (const [i, mat] of hot.entries()) mat.emissiveIntensity = (0.12 + 0.047 * i) * flicker;
    gaugeGlow.emissiveIntensity = 3.3 * flicker;
    status.emissiveIntensity = 1.7 - 0.74 * open;
    pilot.emissiveIntensity = 0.6 + 1.15 * handle;
    const view = shotAt(shots, t);
    lens.options.focalDistance = Math.hypot(...view.target.map((v, i) => v - view.position[i]));
    lens.options.aperture = t > 40 && t < 67.5 ? 5.6 : 7.2;
    return view;
  }
  return {
    apply,
    cues,
    effects: [haze, lens],
    receivers: [depth],
    dispose() {
      for (const texture of textureBank) texture.dispose();
    },
  };
}
