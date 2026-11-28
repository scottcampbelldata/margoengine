import { PbrMaterial, box as coreBox } from '@margoengine/core';
import { ColorBackground, Fog } from '@margoengine/environment';
import { Path, Shape, extrudeGeometry } from '@margoengine/geometry';
import { geometryData } from '@margoengine/geometry/utils';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { instancing } from '@margoengine/gltf/pbr-instancing';
import { Material } from '@margoengine/materials';
import { SSR } from '@margoengine/post/ssr';
import { Weather } from '@margoengine/sky/weather';
import { WeatherMachine, skyWeather, windAt } from '@margoengine/weather';
import { Puddles } from '@margoengine/weather/puddles';
import { blend, finishTexture, mix, ramp, rng, shotAt } from './film.js';
import { asset as libraryAsset } from './assets.js';

const quarter = Math.PI / 2;
const trackRadius = 34;
const gauge = 1.435;
const wheelRadius = 0.33;
const stop = 22;
const length = 6.92;

function route(s) {
  const arc = Math.min(0, Math.max(-45, s));
  const q = arc / trackRadius;
  const extra = s - arc;
  return [trackRadius * (1 - Math.cos(q)) + extra * Math.sin(q), 0, trackRadius * Math.sin(q) + extra * Math.cos(q)];
}
function frame(s) {
  const heading = Math.min(0, Math.max(-45, s)) / trackRadius;
  const forward = [Math.sin(heading), 0, Math.cos(heading)];
  const side = [forward[2], 0, -forward[0]];
  return { center: route(s), forward, side, heading };
}
function along(s, x = 0, y = 0) {
  const { center, side } = frame(s);
  return [center[0] + x * side[0], y, center[2] + x * side[2]];
}

function strip(x, y, width, height, start = -107, end = 60, step = 0.65) {
  const pos = [],
    normal = [],
    uv = [],
    index = [];
  const sections = Math.ceil((end - start) / step);
  const faces = [
    [
      [-1, 1],
      [1, 1],
      [0, 1],
    ],
    [
      [1, 1],
      [1, -1],
      [1, 0],
    ],
    [
      [1, -1],
      [-1, -1],
      [0, -1],
    ],
    [
      [-1, -1],
      [-1, 1],
      [-1, 0],
    ],
  ];
  for (const [a, b, n] of faces) {
    const from = pos.length / 3;
    for (let i = 0; i <= sections; i++) {
      const s = mix(start, end, i / sections);
      const { side } = frame(s);
      pos.push(
        ...along(s, x + (a[0] * width) / 2, y + (a[1] * height) / 2),
        ...along(s, x + (b[0] * width) / 2, y + (b[1] * height) / 2),
      );
      normal.push(side[0] * n[0], n[1], side[2] * n[0], side[0] * n[0], n[1], side[2] * n[0]);
      uv.push(0, s, 1, s);
      if (i < sections) {
        const v = from + i * 2;
        index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      }
    }
  }
  return geometryData(pos, normal, uv, index);
}

function prism(points, depth, bevel = 0.025, holes = []) {
  const shape = new Shape();
  shape.moveTo(...points[0]);
  for (const xy of points.slice(1)) shape.lineTo(...xy);
  shape.closePath();
  for (const polygon of holes) {
    const hole = new Path();
    hole.moveTo(...polygon[0]);
    for (const xy of polygon.slice(1)) hole.lineTo(...xy);
    hole.closePath();
    shape.holes.push(hole);
  }
  return extrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
  });
}

function frontPosition(t) {
  const start = -52,
    speed = 1.24,
    accel = 1 / 8,
    brake = 1 / 13;
  const brakeAt = stop - (0.5 * speed) / brake;
  const beforeBrake = 8 + (brakeAt - start - (0.5 * speed) / accel) / speed;
  if (t <= 8) return start + 0.5 * speed * accel * t * t;
  if (t < beforeBrake) return start + (0.5 * speed) / accel + speed * (t - 8);
  const a = Math.min(13, t - beforeBrake);
  return brakeAt + speed * a - 0.5 * speed * brake * a * a;
}

export async function buildDepot(engine, shop, cluster) {
  const { group, box, ring, beam, part, sign } = shop;
  const depot = await loadGLTF(engine, libraryAsset('north-yard/industrial-buildings.glb'), {
    decoders: { instancing },
  });
  // Approach side of the yard: four original buildings (north-yard/build_approach_buildings.py, Blender, CC0 maps),
  // each front facing the track, set back behind the fence.
  const approach = await Promise.all(
    [
      ['approach-substation', -27, 7.4],
      ['approach-warehouse-b', -41, 8.6],
      ['approach-warehouse-a', -61.5, 8.4],
      ['approach-shed', -85, 8.2],
    ].map(async ([name, s, setback]) => {
      const model = await loadGLTF(engine, libraryAsset('north-yard/' + name + '.glb'));
      const { heading } = frame(s);
      model.root.setPosition(along(s, setback, -0.1)).setRotation([0, heading - quarter, 0]);
      return model;
    }),
  );
  // A steel palisade between the track and the approach buildings, 13 m panels end to end, and the yard's clutter
  // (a parked flat wagon, sleepers, rails, cable drums, drums, a relay cabinet) on the open ground across the track.
  const placed = async (name, s, offset, turn) => {
    const model = await loadGLTF(engine, libraryAsset('north-yard/' + name + '.glb'));
    const { heading } = frame(s);
    model.root.setPosition(along(s, offset, -0.1)).setRotation([0, heading + turn, 0]);
    return model;
  };
  approach.push(
    ...(await Promise.all([
      ...[-89.5, -76.5, -63.5, -50.5, -37.5, -24.5].map((s) => placed('yard-fence', s, 4.95, 0)),
      placed('yard-props', -60, -6.9, 0),
    ])),
  );
  const random = rng(72291);
  const grit = finishTexture(2891, { r: 211, grain: 47, mottling: 30 });
  const brushed = finishTexture(21392, { r: 199, grain: 28, streak: true, mottling: 20 });
  const look = (color, roughness, metalness = 0, roughnessMap) =>
    new Material({ color, roughness, metalness, roughnessMap });
  const roadbed = look('#3c3e3d', 0.74, 0.11, grit),
    coal = look('#212729', 0.82, 0.14, grit);
  const ballast = ['#4a4944', '#373d40', '#554f46', '#2a3130'].map((c) => look(c, 0.88, 0.05, grit));
  const railTop = look('#9b9790', 0.19, 0.92, brushed),
    railSide = look('#423a33', 0.49, 0.72, brushed);
  const structure = look('#34424b', 0.61, 0.49, grit),
    steel = look('#646e71', 0.34, 0.74, brushed);
  const shelter = look('#6e7472', 0.7, 0.15, grit),
    mortar = look('#35393b', 0.91, 0.06, grit);
  const platform = look('#5e666b', 0.39, 0.15, grit),
    asphalt = look('#272e34', 0.44, 0.02, grit);
  const dark = look('#172127', 0.52, 0.24),
    offWhite = look('#bcb5a4', 0.35, 0.36, grit);
  const rubber = look('#17191c', 0.78, 0.09),
    mica = look('#283c47', 0.24, 0.32, brushed);
  const orange = look('#c57547', 0.44, 0.22, grit),
    livery = look('#354d60', 0.34, 0.27, grit);
  const ivory = look('#d5cab4', 0.37, 0.22, grit),
    yellow = look('#ae8848', 0.59, 0.17, grit);
  const electric = look('#34403e', 0.46, 0.46),
    grayPanel = look('#535456', 0.42, 0.46, brushed);
  const screenGlass = new Material({
    color: '#4b5d58',
    metalness: 0.13,
    roughness: 0.19,
    opacity: 0.32,
    transparent: true,
    doubleSided: true,
  });
  const seat = look('#536970', 0.75, 0.08, grit);
  const emit = (color, intensity) =>
    new Material({ color, roughness: 0.43, emissive: color, emissiveIntensity: intensity });
  const warm = emit('#ffddb3', 2.8),
    head = emit('#e3f0ff', 8.1);
  const red = emit('#ef321c', 3.2),
    green = emit('#65db97', 3.6),
    stepLamp = emit('#ffdb9f', 2.2);
  const wet = new WeatherMachine('rain', { seed: 41 });
  wet.update(140);
  const weather = Weather.attach(engine, {
    ...skyWeather(wet.state, windAt(wet.wind, 0, 3, 0, 0)),
    radius: 24,
    height: 8,
    particles: 26000,
    fadeSeconds: 0,
    opacity: 0.31,
    brightness: 0.63,
    color: [0.53, 0.68, 0.91],
    wind: [1.4, 0.32],
  });
  const puddles = Puddles.attach(engine, {
    wetness: 0.98,
    rain: 0.72,
    coverage: 0.39,
    size: 2.6,
    rippleStrength: 0.22,
  });
  const fog = Fog.attach(engine, { color: '#26394a', density: 0.013, heightFalloff: 0.055, height: 3 });
  ColorBackground.attach(engine, { color: '#121e2d', bottom: '#26394a' });
  const ssr = new SSR({ maxRoughness: 0.64, thickness: 0.14, maxDistance: 42, steps: 44 });
  const wetGround = engine
    .createMesh()
    .setGeometry(coreBox(210, 0.16, 205))
    .setMaterial(new PbrMaterial({ color: '#30363b', roughness: 0.72 }))
    .setPosition([3, -0.2, -15]);
  wetGround.name = 'Rain-darkened concrete and pooling water';

  part(strip(0, -0.087, 2.77, 0.067), roadbed);
  part(strip(2.67, -0.105, 2.47, 0.027, -96, -4), asphalt);
  part(strip(-2.67, -0.105, 2.47, 0.027, -96, -4), asphalt);
  for (const x of [-gauge / 2, gauge / 2]) {
    part(strip(x, 0.016, 0.148, 0.034), railSide);
    part(strip(x, 0.054, 0.062, 0.078), railSide);
    part(strip(x, 0.107, 0.084, 0.029), railTop);
  }
  for (let s = -88; s < 53; s += 0.67) {
    const { heading } = frame(s);
    box([2.44, 0.084, 0.23], s > -7 && s < 34 ? structure : coal, along(s, 0, -0.023), [0, heading, 0]);
    for (const x of [-gauge / 2, gauge / 2]) {
      box([0.196, 0.016, 0.129], electric, along(s, x, 0.026), [0, heading, 0]);
      box([0.039, 0.02, 0.083], steel, along(s, x + 0.091, 0.039), [0, heading, 0], undefined, 0.004);
      box([0.041, 0.02, 0.083], steel, along(s, x - 0.091, 0.039), [0, heading, 0], undefined, 0.004);
    }
  }
  for (let i = 0; i < 660; i++) {
    const s = -77 + random() * 131;
    const x = (random() < 0.5 ? -1 : 1) * (1.04 + random() * 0.34);
    const d = 0.044 + random() * 0.09;
    box([d, 0.016 + random() * 0.039, d * 0.68], ballast[i % 4], along(s, x, -0.062 + random() * 0.014), [
      random() * 0.23,
      random() * 6,
      random() * 0.24,
    ]);
  }
  for (const [lo, hi, x] of [
    [-4, 36, -2.7],
    [-2, 38, 2.98],
  ]) {
    box([2.07, 1.38, hi - lo], platform, [x, 0.587, (lo + hi) / 2], undefined, undefined, 0.025);
    const edgeX = x < 0 ? x + 0.924 : x - 0.924;
    for (let s = lo + 0.46; s < hi - 0.37; s += 0.93) {
      box([0.192, 0.069, 0.913], shelter, [edgeX, 1.257, s], undefined, undefined, 0.009);
      box([0.202, 0.019, 0.898], yellow, [edgeX + (x < 0 ? -0.11 : 0.11), 1.288, s], undefined, undefined, 0.008);
      for (let k = 0; k < 6; k++)
        box([0.112, 0.006, 0.021], mortar, [edgeX + (x < 0 ? -0.11 : 0.11), 1.299, s + (k - 2.5) * 0.122]);
      box([1.85, 0.008, 0.008], mortar, [x, 1.277, s + 0.448]);
    }
    for (let i = 0; i < 9; i++) {
      const height = (i + 1) * 0.153;
      box(
        [1.74, height, 0.29],
        platform,
        [x, -0.101 + height / 2, lo - (8 - i) * 0.284 - 0.146],
        undefined,
        undefined,
        0.009,
      );
      box([1.72, 0.021, 0.043], yellow, [x, height - 0.091, lo - (8 - i) * 0.284 - 0.272], undefined, undefined, 0.004);
    }
    for (const side of [-1, 1]) {
      const xx = x + side * 0.81;
      beam([xx, 0.92, lo - 2.63], [xx, 2.19, lo], 0.036, steel, undefined, true);
      for (let i = 0; i < 4; i++) {
        const u = i / 3;
        beam(
          [xx, 0.95 * u, lo - 2.51 + u * 2.4],
          [xx, 0.93 + 1.21 * u, lo - 2.51 + u * 2.4],
          0.035,
          steel,
          undefined,
          true,
        );
      }
    }
  }
  // Crosswalk and a continuous, wet service aisle.
  box([4.4, 0.015, 40], asphalt, [-6.4, -0.099, 15]);
  for (let i = 0; i < 13; i++)
    box([0.205, 0.011, 1.22], ivory, [-3.07 + i * 0.52, -0.092, -4.34], undefined, undefined, 0.007);
  for (let i = 0; i < 20; i++) box([0.035, 0.01, 1.01], yellow, [-4.05, -0.089, -5.6 + i * 2.14]);
  for (let i = 0; i < 70; i++) {
    const z = random() * 47 - 9,
      x = (random() - 0.5) * 10;
    if (Math.abs(x) > 1.74)
      box([0.035 + random() * 0.27, 0.006, 0.01 + random() * 0.034], structure, [x, -0.092, z], [0, random() * 0.5, 0]);
  }

  // Catenary span, track signals and depot building.
  for (let s = -66; s < 51; s += 13) {
    const { heading } = frame(s),
      p = along(s, 3.36);
    ring([0.122, 0.167, 5.32], structure, [p[0], 2.52, p[2]], undefined, undefined, 14);
    box([0.39, 0.14, 0.36], shelter, [p[0], -0.02, p[2]], undefined, undefined, 0.025);
    beam(along(s, 3.36, 4.65), along(s, -0.35, 4.65), 0.065, steel, undefined, true);
    beam(along(s, 3.36, 5.07), along(s, 0.33, 4.65), 0.028, steel, undefined, true);
    ring([0.058, 0.058, 0.117], offWhite, along(s, 2.65, 4.65), [0, 0, quarter], undefined, 16);
    for (const offset of [0, 2.8, 5.6, 8.4, 11.2]) {
      beam(along(s + offset, 0.05, 4.37), along(s + offset, 0.05, 4.61), 0.008, steel, undefined, true);
    }
    box([0.12, 0.155, 0.07], yellow, [p[0], 1.36, p[2] - 0.181], [0, heading, 0], undefined, 0.008);
  }
  for (let s = -79; s < 58; s += 1.4)
    for (const height of [4.38, 4.62]) {
      beam(
        along(s, 0.05, height),
        along(s + 1.4, 0.05, height),
        height < 4.5 ? 0.011 : 0.009,
        railSide,
        undefined,
        true,
      );
    }
  const lights = [];
  for (const [x, z] of [
    [-4.8, -13],
    [-5.3, 2],
    [-5.2, 16],
    [-4.5, 29],
    [-4.7, 42],
    [-4.4, -29],
    [5.9, -23],
    [4.35, 46],
  ]) {
    box([0.27, 0.14, 0.28], shelter, [x, -0.014, z], undefined, undefined, 0.014);
    ring([0.055, 0.09, 5.76], structure, [x, 2.75, z], undefined, undefined, 17);
    beam([x, 5.47, z], [x + 0.56, 5.71, z], 0.063, structure, undefined, true);
    box([0.62, 0.113, 0.255], steel, [x + 0.64, 5.72, z], undefined, undefined, 0.043);
    box([0.51, 0.018, 0.213], warm, [x + 0.665, 5.656, z], undefined, undefined, 0.006);
    lights.push({
      position: [x + 0.65, 5.64, z],
      direction: [0.17, -1, 0],
      range: 17,
      angle: 1.15,
      penumbra: 0.55,
      color: [1, 0.68, 0.38],
      intensity: 136,
    });
  }
  for (const z of [-37, -17, 34]) {
    const [x] = along(z, -1.96);
    const p = along(z, -1.96);
    ring([0.043, 0.062, 2.11], steel, [x, 0.94, p[2]], undefined, undefined, 17);
    box([0.177, 0.274, 0.132], dark, [x, 1.98, p[2]], undefined, undefined, 0.023);
    box([0.158, 0.064, 0.118], rubber, [x, 2.106, p[2] - 0.05], [0.15, 0, 0], undefined, 0.018);
    ring([0.034, 0.037, 0.021], z < 0 ? green : red, [x, 2.029, p[2] - 0.076], [quarter, 0, 0]);
    ring([0.034, 0.037, 0.021], z < 0 ? green : red, [x, 2.029, p[2] + 0.077], [quarter, 0, 0]);
  }
  const roomGlow = emit('#ffcc95', 0.95);
  for (const z of [3.5, 18.5, 36.5, 39.5])
    box([0.035, 1.68, 2.23], roomGlow, [9.205, 4.337, z], undefined, undefined, 0.008);
  sign(['NORTH YARD', 'SERVICE DEPOT'], [3.35, 0.54], [8.73, 5.7, 15.8], [0, -quarter, 0], undefined, {
    background: '#2c424f',
    lit: 0.37,
  });
  // Approach is bounded by the working yard, with an open view along the curve.
  for (let s = -96; s < -22; s += 6.4) {
    const { heading } = frame(s);
    // The yard's palisade (yardFence below) and buildings (approach above) stand here; the draws keep the scatter's
    // sequence.
    for (let j = 0; j < 6; j++) random();
    if (s < -42 && Math.round(s) % 2 === 0) {
      box([1.3, 0.17, 0.37], structure, along(s, 6.8, 3.66), [0, heading, 0], undefined, 0.041);
      ring([0.079, 0.094, 3.63], structure, along(s, 7.32, 1.65), undefined, undefined, 16);
      box([1.11, 0.021, 0.218], warm, along(s, 6.8, 3.564), [0, heading, 0], undefined, 0.008);
      lights.push({
        position: along(s, 6.73, 3.547),
        direction: [-0.35, -1, 0],
        range: 11,
        angle: 1.09,
        penumbra: 0.6,
        color: [1, 0.68, 0.41],
        intensity: 68,
      });
    }
  }
  // Platform shelter and tactile stopping marker.
  for (const z of [8.7, 15.5, 22.3, 29.1]) {
    for (const x of [2.17, 3.69]) {
      box([0.116, 2.11, 0.141], structure, [x, 2.344, z], undefined, undefined, 0.011);
      box([0.203, 0.065, 0.203], shelter, [x, 1.32, z], undefined, undefined, 0.013);
    }
    box([2.15, 0.1, 0.16], structure, [2.97, 3.39, z]);
    box([1.44, 0.041, 0.111], warm, [2.9, 3.326, z], undefined, undefined, 0.008);
    lights.push({
      position: [2.9, 3.3, z],
      direction: [-0.2, -1, 0],
      range: 6.54,
      angle: 0.99,
      penumbra: 0.7,
      color: [1, 0.76, 0.47],
      intensity: 36,
    });
  }
  box([2.528, 0.156, 24.3], structure, [2.94, 3.54, 18.8], undefined, undefined, 0.041);
  for (let i = 0; i < 32; i++) box([2.56, 0.027, 0.025], grayPanel, [2.935, 3.628, 6.9 + i * 0.759]);
  const platformDeck = 0.587 + 1.38 / 2;
  for (const z of [13.1, 22.6, 27.6]) {
    box([0.47, 0.054, 1.38], grayPanel, [3.57, 1.77, z], undefined, undefined, 0.022);
    box([0.044, 0.333, 1.38], structure, [3.765, 1.955, z], undefined, undefined, 0.016);
    for (const dz of [-0.51, 0.51]) {
      for (const x of [3.412, 3.728]) {
        box([0.102, 0.015, 0.108], structure, [x, platformDeck + 0.007, z + dz], undefined, undefined, 0.009);
        beam([x, platformDeck + 0.014, z + dz], [x, 1.754, z + dz], 0.061, steel);
      }
      box([0.354, 0.045, 0.064], steel, [3.57, 1.728, z + dz], undefined, undefined, 0.009);
      beam([3.728, 1.738, z + dz], [3.758, 2.108, z + dz], 0.042, steel);
    }
  }
  sign(['03   NORTH YARD', 'TERMINAL'], [1.58, 0.45], [2.098, 2.96, 21.8], [0, -quarter, 0], undefined, {
    background: '#1c2934',
    foreground: '#eaddc5',
    lit: 0.45,
  });
  const train = [];
  const wheels = [];
  const sliding = [];
  const interiorDeck = 1.327 + 0.109 / 2;
  for (let i = 0; i < 3; i++) {
    const car = group('Low-floor module ' + (i + 1));
    train.push(car);
    const nose = i === 0,
      tail = i === 2;
    box([2.12, 0.3, 6.61], dark, [0, 0.55, 0], undefined, car, 0.088);
    box([2.276, 0.17, 6.75], orange, [0, 0.747, 0], undefined, car, 0.052);
    box([2.31, 0.545, 6.78], livery, [0, 1.036, 0], undefined, car, 0.128);
    box([2.258, 0.093, 6.72], ivory, [0, 1.324, 0], undefined, car, 0.025);
    box([2.288, 0.28, 6.78], livery, [0, 2.814, 0], undefined, car, 0.101);
    box([2.163, 0.24, 6.67], grayPanel, [0, 2.993, 0], undefined, car, 0.101);
    box([1.9, 0.13, 6.29], offWhite, [0, 2.745, 0], undefined, car, 0.041);
    box([1.907, 0.109, 6.65], steel, [0, 1.327, 0], undefined, car, 0.027);
    box([1.694, 0.093, 1.22], grayPanel, [0, 3.139, -0.13], undefined, car, 0.03);
    for (let r = 0; r < 11; r++) box([1.555, 0.019, 0.031], rubber, [0, 3.193, -0.6 + r * 0.097]);
    for (const x of [-1, 1]) {
      for (const z of [-2.87, -1.08, 0.88, 2.76]) {
        box([0.171, 1.52, 0.158], livery, [x * 1.075, 2.055, z], undefined, car, 0.037);
        box([0.032, 1.29, 0.07], steel, [x * 1.154, 2.06, z + 0.064], undefined, car, 0.009);
      }
      // Seats, handrails and warm luminaires are behind translucent glazing.
      for (const z of [-2.39, -1.84, 1.31, 1.86, 2.281]) {
        const sx = x * 0.777;
        box([0.425, 0.078, 0.388], seat, [sx, 1.777, z], undefined, car, 0.034);
        box([0.418, 0.409, 0.074], seat, [sx, 1.981, z - 0.156], [-0.045, 0, 0], car, 0.031);
        box([0.337, 0.036, 0.307], structure, [sx, 1.728, z], undefined, car, 0.012);
        for (const dx of [-1, 1])
          for (const dz of [-1, 1]) {
            const footX = sx + dx * 0.139;
            const footZ = z + dz * 0.137;
            box([0.054, 0.014, 0.054], structure, [footX, interiorDeck + 0.006, footZ], undefined, car, 0.008);
            beam(
              [footX, interiorDeck + 0.012, footZ],
              [sx + dx * 0.117, 1.735, z + dz * 0.111],
              0.032,
              steel,
              car,
              true,
            );
          }
      }
      box([0.048, 0.024, 6.25], warm, [x * 0.643, 2.664, 0.02], undefined, car, 0.009);
      for (const z of [-2.5, -0.98, 0.91, 2.62])
        beam([x * 0.514, 1.379, z], [x * 0.564, 2.665, z], 0.029, yellow, car, true);
      box([0.194, 0.105, 1.53], grayPanel, [x * 1.02, 2.692, 0.02], undefined, car, 0.015);
      for (const [z, width] of [
        [-1.975, 1.652],
        [1.825, 1.735],
      ]) {
        for (const delta of [-0.643, 0.643])
          box([0.063, 0.046, width], rubber, [x * 1.122, 2.022 + delta, z], undefined, car, 0.013);
        for (const delta of [-width / 2 + 0.03, width / 2 - 0.03])
          box([0.061, 1.29, 0.062], rubber, [x * 1.121, 2.022, z + delta], undefined, car, 0.012);
        box([0.072, 1.263, width - 0.103], screenGlass, [x * 1.127, 2.023, z], undefined, car, 0.025);
        box([0.046, 0.023, width - 0.065], steel, [x * 1.154, 1.405, z], undefined, car, 0.006);
      }
      for (const [z, direction] of [
        [-0.48, -1],
        [0.43, 1],
      ]) {
        const leaf = group('Sliding door', car, [x * 1.14, 1.97, z]);
        box([0.115, 0.37, 0.89], livery, [0, -0.465, 0], undefined, leaf, 0.04);
        box([0.114, 0.149, 0.89], livery, [0, 0.663, 0], undefined, leaf, 0.025);
        for (const edge of [-0.418, 0.418]) box([0.102, 1.15, 0.065], steel, [0, 0.103, edge], undefined, leaf, 0.017);
        box([0.081, 1.11, 0.763], screenGlass, [0, 0.089, 0], undefined, leaf, 0.017);
        box([0.13, 0.035, 0.905], orange, [0, -0.537, 0], undefined, leaf, 0.009);
        box([0.108, 0.325, 0.051], rubber, [0, -0.252, -direction * 0.4], undefined, leaf, 0.01);
        if (x > 0 && i === 0) sliding.push({ leaf, x: x * 1.14, z, direction });
      }
      box([0.046, 0.049, 1.882], stepLamp, [x * 1.174, 1.344, -0.021], undefined, car, 0.008);
      box([0.065, 0.062, 1.801], rubber, [x * 1.175, 1.304, -0.022], undefined, car, 0.007);
      sign(['NR  03', 'YARD SERVICE'], [0.66, 0.172], [x * 1.176, 1.092, 2.288], [0, x * quarter, 0], car, {
        background: '#2a4353',
        foreground: '#c8cabe',
      });
    }
    for (const zWheel of [-1.06, 1.06]) {
      box([1.805, 0.23, 0.53], structure, [0, 0.507, zWheel], undefined, car, 0.038);
      for (const x of [-1, 1]) {
        const wheel = group('Wheelset', car, [(x * gauge) / 2, wheelRadius + 0.119, zWheel]);
        wheels.push(wheel);
        ring([wheelRadius - 0.024, wheelRadius - 0.024, 0.111], steel, [0, 0, 0], [0, 0, quarter], wheel, 48);
        ring(
          [wheelRadius + 0.011, wheelRadius + 0.011, 0.024],
          railTop,
          [-x * 0.043, 0, 0],
          [0, 0, quarter],
          wheel,
          48,
        );
        ring([0.213, 0.215, 0.103], grayPanel, [x * 0.072, 0, 0], [0, 0, quarter], wheel);
        ring([0.112, 0.115, 0.075], steel, [x * 0.129, 0, 0], [0, 0, quarter], wheel);
        for (let j = 0; j < 7; j++) {
          const a = (j * 2 * Math.PI) / 7;
          ring(
            [0.024, 0.027, 0.012],
            rubber,
            [x * 0.126, Math.cos(a) * 0.17, Math.sin(a) * 0.17],
            [0, 0, quarter],
            wheel,
            6,
          );
        }
        ring([0.098, 0.1, 0.145], electric, [x * 0.363, 0.56, zWheel], [0, 0, quarter], car);
        for (let j = 0; j < 6; j++)
          ring([0.085, 0.085, 0.019], rubber, [x * 0.819, 0.414 + j * 0.032, zWheel + 0.232], undefined, car, 18);
      }
    }
    for (const z of [-1.85, 1.85]) box([1.33, 0.25, 0.84], grayPanel, [0, 0.553, z], undefined, car, 0.041);
    if (nose || tail) {
      const end = group('Streamlined cab', car, [0, 0, nose ? 3.402 : -3.402]);
      end.setRotation([0, nose ? 0 : Math.PI, 0]);
      const outside = [
        [-1.123, 0.776],
        [-1.157, 1.374],
        [-1.125, 2.536],
        [-0.959, 2.849],
        [-0.71, 2.995],
        [0.71, 2.995],
        [0.959, 2.849],
        [1.125, 2.536],
        [1.157, 1.374],
        [1.123, 0.776],
        [0.884, 0.631],
        [-0.884, 0.631],
      ];
      const windshield = [
        [-0.887, 1.435],
        [-0.89, 2.441],
        [-0.778, 2.622],
        [0.778, 2.622],
        [0.89, 2.441],
        [0.887, 1.435],
      ];
      const cabDepth = 0.52;
      const cabBevel = 0.079;
      const cabOriginZ = -0.037;
      part(prism(outside, cabDepth, cabBevel, [windshield]), livery, [0, 0, cabOriginZ], undefined, end);
      part(prism(windshield, 0.031, 0.027), mica, [0, -0.003, 0.552], [-0.149, 0, 0], end);
      // The front windshield cutout is closed by the rake of the glass and the matte black seals.
      part(prism(windshield, 0.027, 0.021), screenGlass, [0, 0, 0.477], undefined, end);
      for (let j = 0; j < windshield.length; j++) {
        const [ax, ay] = windshield[j],
          [bx, by] = windshield[(j + 1) % windshield.length];
        beam([ax, ay, 0.51], [bx, by, 0.51], 0.046, rubber, end, true);
      }
      box([1.91, 0.11, 0.128], orange, [0, 0.934, 0.549], undefined, end, 0.049);
      box([0.91, 0.09, 0.14], rubber, [0, 0.794, 0.537], undefined, end, 0.031);
      box([0.61, 0.084, 0.22], dark, [0, 0.71, 0.558], undefined, end, 0.015);
      for (const x of [-0.738, 0.738]) {
        box([0.304, 0.197, 0.127], rubber, [x, 1.173, 0.547], undefined, end, 0.05);
        box([0.235, 0.092, 0.042], nose ? head : red, [x, 1.188, 0.621], undefined, end, 0.031);
        box([0.235, 0.031, 0.035], offWhite, [x, 1.111, 0.621], undefined, end, 0.012);
      }
      beam([-0.252, 1.521, 0.544], [-0.625, 2.411, 0.584], 0.025, rubber, end);
      beam([0.282, 1.519, 0.544], [0.678, 2.266, 0.584], 0.025, rubber, end);
      for (const x of [-0.252, 0.282])
        ring([0.027, 0.027, 0.021], grayPanel, [x, 1.52, 0.557], [quarter, 0, 0], end, 24);
      sign([nose ? 'NR-031' : 'NR-033'], [0.363, 0.095], [0, 1.171, 0.597], undefined, end, {
        background: '#2f414a',
        foreground: '#d2d6cb',
      });
      for (const x of [-0.602, 0.602]) box([0.104, 0.053, 0.052], steel, [x, 0.833, 0.574], undefined, end, 0.015);
      // Seat the bezel into the body and keep its lens clear of the frontmost cab bevel.
      const cabFace = cabOriginZ + cabDepth + cabBevel;
      const bezelFace = cabFace + 0.035;
      const bezelDepth = 0.083;
      box([0.819, 0.227, bezelDepth], rubber, [0, 2.721, bezelFace - bezelDepth / 2], undefined, end, 0.018);
      sign(
        [nose ? '03   NORTH YARD' : '03   OUT OF SERVICE'],
        [0.759, 0.163],
        [0, 2.721, bezelFace + 0.006],
        undefined,
        end,
        {
          background: '#1a2425',
          foreground: '#e6b974',
          lit: 1.9,
        },
      );
    }
    if (i === 1) {
      box([1.81, 0.141, 1.37], electric, [0, 3.156, 0.57], undefined, car, 0.033);
      for (const x of [-0.354, 0.354]) {
        ring([0.067, 0.067, 0.171], offWhite, [x, 3.25, 0.58], undefined, car, 19);
        beam([x, 3.286, 1.012], [x, 3.899, 0.177], 0.079, structure, car, true);
        beam([x, 3.899, 0.177], [x, 4.348, 0.745], 0.054, steel, car, true);
        beam([x, 3.29, 0.282], [x, 3.808, 0.218], 0.043, steel, car, true);
      }
      beam([-0.55, 4.35, 0.742], [0.55, 4.35, 0.742], 0.062, steel, car);
      box([1.31, 0.032, 0.157], rubber, [0.035, 4.369, 0.742], undefined, car, 0.013);
    }
  }
  const bellows = [group('Articulation 1'), group('Articulation 2')];
  for (const b of bellows) {
    box([1.847, 2.117, 1.03], rubber, [0, 1.81, 0], undefined, b, 0.159);
    for (let j = 0; j < 10; j++) {
      box([1.959, 2.19, 0.034], dark, [0, 1.81, -0.451 + j * 0.1], undefined, b, 0.016);
    }
  }
  const heads = [-0.738, 0.738].map(() => ({
    position: [0, 1.188, 0],
    direction: [0, -0.062, 1],
    range: 41,
    color: [0.7, 0.83, 1],
    intensity: 305,
    angle: 0.31,
    penumbra: 0.74,
  }));
  // The saloon lights: two ceiling lamps per module, so the cabins glow through the windows and light their seats.
  const cabin = Array.from({ length: 6 }, () => ({
    position: [0, 2.4, 0],
    direction: [0, -1, 0],
    range: 4.6,
    color: [1, 0.92, 0.8],
    intensity: 26,
    angle: 1.35,
    penumbra: 0.85,
  }));
  const lamps = [...lights, ...heads, ...cabin];
  const chase = (s, x, y, z) => {
    const p = along(s, x, y);
    const { forward } = frame(s);
    return [p[0] + forward[0] * z, p[1], p[2] + forward[2] * z];
  };
  const follow = (s, t, a, b, p, q, fov) => {
    const f = ramp(t, a, b);
    const [x, y, z] = blend(p[0], q[0], f);
    const [tx, ty, tz] = blend(p[1], q[1], f);
    return { position: chase(s, x, y, z), target: chase(s, tx, ty, tz), fov };
  };
  const fixedShots = [
    [5, along(-42.4, -2.43, 0.48), along(-41.8, -2.23, 0.64), along(-51, 0.16, 1.6), along(-49.4, 0.12, 1.54), 38],
    [13, along(-40.5, -5.7, 3.63), along(-37.73, -5.14, 3.12), along(-54.4, 0.35, 1.42), along(-48.22, 0.22, 1.58), 45],
    [
      19,
      along(-31.1, -4.22, 1.62),
      along(-30.4, -4.03, 1.53),
      along(-38.9, -0.68, 1.73),
      along(-36.1, -0.74, 1.78),
      47,
    ],
    [44, [-6.35, 3.48, 1.58], [-5.51, 2.81, 1.72], [-0.54, 1.65, -17], [-0.77, 1.62, -10.69], 49],
    [69, [-4.78, 1.81, 27.88], [-4.44, 1.68, 27.08], [0.13, 1.63, 18.77], [0.05, 1.65, 20.45], 46],
    [76, [3.59, 1.91, 18.64], [3.43, 1.83, 19.23], [0.14, 1.93, 17.81], [0.16, 1.87, 17.91], 40],
    [83, [-3.21, 1.59, 25.91], [-3.68, 1.74, 25.71], [0.07, 1.35, 21.94], [0.19, 1.37, 21.68], 41],
    [90, [-5.66, 2.68, 29.65], [-6.1, 2.91, 29.99], [0.51, 1.65, 17.04], [0.32, 1.73, 17.18], 48],
  ];
  const cues = [
    [0.16, 4.62, 'Last service into North Yard'],
    [13.2, 17.7, 'One tram is still out in the rain.'],
    [27.5, 31.7, 'The wheel flanges follow the curve.'],
    [47.1, 52.6, 'The pantograph stays in contact with the wire.'],
    [62.0, 67.3, 'Braking into the terminal'],
    [70.85, 75.75, 'The doors release at the stop.'],
  ];
  function apply(time) {
    const s = frontPosition(time);
    for (const [i, car] of train.entries()) {
      const bodyS = s - 3.95 - i * (length + 0.37);
      const { center, heading } = frame(bodyS);
      car.setPosition(center).setRotation([0, heading, 0]);
      for (const k of [0, 1]) cabin[i * 2 + k].position = chase(bodyS, 0, 2.42, k ? 1.65 : -1.65);
      if (i < bellows.length) {
        const joint = frame(bodyS - (length + 0.37) / 2);
        bellows[i].setPosition(joint.center).setRotation([0, joint.heading, 0]);
      }
    }
    for (const wheel of wheels) wheel.setRotation([(s + 52) / wheelRadius, 0, 0]);
    const open = ramp(time, 70.78, 73.35);
    for (const { leaf, x, z, direction } of sliding)
      leaf.setPosition([x + 0.105 * ramp(time, 70.78, 71.33), 1.97, z + direction * 0.8 * open]);
    const cf = s - 3.95;
    for (const [i, h] of heads.entries()) {
      h.position = chase(cf, i === 0 ? -0.738 : 0.738, 1.19, 4.005);
      const { forward } = frame(cf);
      h.direction = [forward[0], -0.071, forward[2]];
    }
    cluster.setLights(lamps);
    weather.options.intensity = 0.73 - 0.17 * ramp(time, 68, 86);
    puddles.options.rain = weather.options.intensity;
    if (time >= 19 && time < 27)
      return follow(
        s,
        time,
        19,
        27,
        [
          [-3.25, 1.55, 4.1],
          [0.05, 1.42, -1.1],
        ],
        [
          [-2.92, 1.41, 2.9],
          [0.09, 1.45, -0.95],
        ],
        39,
      );
    if (time >= 27 && time < 35)
      return follow(
        s,
        time,
        27,
        35,
        [
          [-2.35, 0.3, -3.6],
          [-0.62, 0.36, -4.95],
        ],
        [
          [-2.45, 0.34, -4.1],
          [-0.6, 0.38, -5.15],
        ],
        36,
      );
    if (time >= 44 && time < 52)
      return follow(
        s,
        time,
        44,
        52,
        [
          [-3.93, 5.16, -9.71],
          [0, 3.88, -10.59],
        ],
        [
          [-3.49, 4.98, -9.43],
          [0.14, 3.9, -10.68],
        ],
        42,
      );
    if (time >= 52 && time < 61)
      return follow(
        s,
        time,
        52,
        61,
        [
          [1.88, 1.89, -2.1],
          [0.38, 1.94, -4.14],
        ],
        [
          [1.84, 1.85, -1.85],
          [0.12, 1.86, -3.94],
        ],
        46,
      );
    if (time >= 61 && time < 69)
      return follow(
        s,
        time,
        61,
        69,
        [
          [-4.78, 1.95, 8.3],
          [0.13, 1.63, -0.5],
        ],
        [
          [-4.44, 1.83, 5.08],
          [0.05, 1.65, -1.55],
        ],
        46,
      );
    if (time >= 35 && time < 44) {
      const [, , to, target, targetEnd, fov] = fixedShots[3];
      const fraction = ramp(time, 35, 44);
      return { position: blend(fixedShots[3][1], to, fraction), target: blend(target, targetEnd, fraction), fov };
    }
    return shotAt(fixedShots, time);
  }
  return {
    apply,
    cues,
    models: [depot, ...approach],
    effects: [ssr],
    receivers: [fog, ssr],
    dispose() {
      wet.dispose();
      grit.dispose();
      brushed.dispose();
      depot.dispose();
      for (const model of approach) model.dispose();
    },
    inspection: { frontPosition },
  };
}
