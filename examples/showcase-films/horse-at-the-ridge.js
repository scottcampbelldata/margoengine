import { PbrMaterial } from '@margoengine/core';
import { Animation } from '@margoengine/animation';
import { dualQuaternionSkinning } from '@margoengine/animation/dqs';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { computeVertexNormals, toGeometry } from '@margoengine/geometry';
import { geometryData } from '@margoengine/geometry/utils';
import { createMesh } from '@margoengine/materials';
import { generateRockMesh } from '@margoengine/procedural';
import { road } from '@margoengine/road';
import { GrassScatter } from '@margoengine/scatter/grass';
import { Sky } from '@margoengine/sky';
import { Spline } from '@margoengine/splines';
import { TerrainHeightmap } from '@margoengine/terrain';
import { RockSurface } from '@margoengine/terrain/rock-surface';
import { exampleAsset } from '../live/asset-base.js';
import { mix, rng, shotAt } from './film.js';
import { surface, texturedGround } from './environment-films.js';

const sun = [0.56, 0.42, -0.71];
const horseAsset = exampleAsset('horse-at-the-ridge/ridge-bay-performance.glb');
const horseMotion = exampleAsset('horse-at-the-ridge/ridge-bay-performance.json');
const trail = (z) => 0.47 * Math.sin(z / 18) + 0.23 * Math.cos(z / 13);
const grade = (z) => 0.93 * Math.sin(z / 26) + 0.48 * Math.sin(z / 11) + 0.11 * Math.sin(z / 3.2);
const ground = (x, z) => {
  const verge = 1 - Math.exp(-((x - trail(z)) ** 2) / 32);
  return (
    grade(z) +
    verge * (1.32 * Math.sin(x / 12 + z / 32) + 0.68 * Math.cos(x / 8 - z / 19)) -
    12.1 * (1 - Math.exp(-(x ** 2) / 5200))
  );
};

export async function buildHorseAtTheRidge(engine, shop, _lights, shadows) {
  const [lichen, earth, coat, motion] = await Promise.all([
    surface('rocky_terrain_02', { color: '#939883', normalScale: 0.61 }),
    surface('gravelly_sand', { color: '#98846a', normalScale: 0.68 }),
    loadGLTF(engine, horseAsset, { signal: AbortSignal.timeout(30_000) }),
    fetch(horseMotion, { signal: AbortSignal.timeout(10_000) }).then((response) => {
      if (!response.ok) throw Error('Prepare the ridge horse performance before rendering.');
      return response.json();
    }),
  ]);
  const meadow = texturedGround(
    engine,
    ground,
    lichen.material,
    {
      origin: [-135, -92],
      size: [270, 307],
      resolution: 224,
    },
    3.8,
  );
  const route = new Spline(
    Array.from({ length: 139 }, (_, i) => {
      const z = -85 + i * 2;
      return [trail(z), ground(trail(z), z) + 0.028, z];
    }),
  );
  const tread = road(route, {
    crossSection: [
      [-1.15, -0.037],
      [-0.83, 0],
      [0, 0.008],
      [0.84, 0],
      [1.23, -0.038],
    ],
    segments: 384,
    uvMeters: 2.2,
  });
  const { vertices, indices: treadIndices } = tread.geometry;
  const positions = new Float32Array(vertices.length / 2);
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = vertices.subarray(i * 2, i * 2 + 3);
    const edge = Math.min(1, Math.abs(x - trail(z)));
    positions[i] = x + edge ** 4 * (0.09 * Math.sin(z * 0.31) + 0.05 * Math.cos(z));
    positions[i + 1] = y + ground(x, z) - ground(trail(z), z);
    positions[i + 2] = z;
  }
  const path = createMesh(
    engine,
    computeVertexNormals(geometryData(positions, new Float32Array(positions.length), tread.uvs, treadIndices)),
    earth.material,
  );
  const distance = texturedGround(
    engine,
    (x, z) =>
      -26 +
      100 * Math.exp(-((x + 103) ** 2 + (z + 279) ** 2) / 20800) +
      126 * Math.exp(-((x - 270) ** 2 + (z - 441) ** 2) / 25800) +
      36 * Math.sin(x / 140) * Math.cos(z / 90) +
      (1 - Math.exp(-(x * x + z * z) / 110000)) *
        (8 * Math.sin(x * 0.029 + z * 0.009) * Math.cos(z * 0.025) + 3.8 * Math.sin(x * 0.071 - z * 0.053)),
    lichen.material,
    { origin: [-620, -640], size: [1240, 1280], resolution: 128 },
    95,
  );
  const sky = Sky.attach(engine, {
    model: 'bruneton',
    sunDirection: sun,
    timeScale: 0.15,
    fog: { density: 0.0011, start: 75, color: [0.49, 0.6, 0.68] },
    clouds: { coverage: 0.36, height: 760, speed: 0.03 },
  });
  const sample = TerrainHeightmap.attach(engine, ground, { origin: [-44, -74], size: [88, 244], resolution: 256 });
  const grass = [];
  for (const side of [-1, 1]) {
    grass.push(
      GrassScatter.attach(engine, {
        center: [side * 13.8, 0, 37],
        area: [24, 204],
        count: 18500,
        seed: side < 0 ? 779 : 1946,
        heightmap: () => sample.texture,
        bounds: [-44, -74, 44, 170],
        lod: [10, 24, 65],
        lodFade: 4,
        edgeShrink: 2,
        sink: 0.04,
        scale: [0.37, 1.2],
        wind: [0.62, -0.38, 0.26, 8],
        maxSlope: 32,
        material: new PbrMaterial({ color: '#81774e', roughness: 0.91, doubleSided: true }),
        blades: { rootShade: 0.61, translucency: 0.48, widen: 0.65 },
        variation: { hue: 0.06, value: 0.31 },
        grass: { height: 0.44, width: 0.016, radius: 0.12, blades: 7, lean: 0.35, segments: [5, 3, 1] },
      }),
    );
  }
  const random = rng(5814);
  const stoneFaces = [17, 35, 81, 160, 223, 459, 617, 730].map((seed) => toGeometry(generateRockMesh(seed)));
  const stoneMaterial = new PbrMaterial({ color: '#675f54', roughness: 0.9 });
  const stone = RockSurface.attach(engine, { scale: 0.62, bump: 1.05, variation: 0.65, tideHeight: 0, moss: 0.46 });
  const rocks = [];
  for (let i = 0; i < 690; i++) {
    const side = random() > 0.5 ? 1 : -1;
    const x = side * mix(1.4, 56, random() ** 2);
    const z = mix(-65, 168, random());
    const size = 0.06 + 0.78 * random() ** 5;
    const yaw = random() * Math.PI * 2;
    const geometry = stoneFaces[i % stoneFaces.length];
    const rock = engine
      .createMesh()
      .setGeometry(geometry)
      .setMaterial(stoneMaterial)
      .setPosition([x, ground(x, z) + size * 0.17, z])
      .setRotation([0.14 * Math.sin(i * 2.4), yaw, 0.12 * Math.cos(i * 2.4)])
      .setScale([size, size, size]);
    stone.add(rock, { type: 'granite', seed: i + 1 });
    shadows.add(rock, { static: true });
    rocks.push(rock);
  }

  const skin = new Animation(coat, { skinning: dualQuaternionSkinning, loop: false });
  engine.use(skin);
  skin.play('Ridge performance');
  skin.playing = false;
  let travelled = 0;
  let gait = 'walk';
  const shots = [
    [4.9, [2.5, 0.47, 2.4], [2.33, 0.55, 2.15], [0.05, 0.53, 0.5], [0, 0.71, 0.56], 41],
    [16.4, [5.5, 2.05, 2.95], [5.04, 1.83, 1.15], [0, 1.07, 0.5], [0, 1.11, 0.45], 36],
    [25.7, [8.3, 3.7, -8.4], [10.1, 3.52, -10.75], [0, 1.05, 1.6], [0, 1.1, 1.2], 42],
    [38, [2.9, 1.82, 2.52], [2.64, 1.95, 1.93], [0, 1.52, 0.76], [0, 1.53, 0.75], 35],
    [48.6, [5.95, 2.04, 4.11], [5.83, 1.9, 3.4], [0, 1.12, 0.63], [0, 1.14, 0.62], 37],
    [60, [3.7, 0.72, -1.4], [3.8, 0.83, -2.31], [0, 0.79, 0.25], [0, 0.86, 0.39], 44],
    [72.1, [8.9, 4.07, -9.3], [9, 4.68, -13], [0, 1.14, 2.3], [0, 1, 2.4], 40],
    [82.6, [3.62, 1.67, 4.38], [4.09, 1.76, 3.92], [0, 1.22, 0.4], [0, 1.24, 0.4], 41],
    [90, [13.5, 3.7, 14.5], [17.5, 4.93, 16.4], [0, 1.7, -0.1], [0, 2, -0.1], 44],
  ];
  return {
    apply(time) {
      skin.seek(time);
      const frame = Math.max(0, Math.min(motion.body.length - 1, motion.fps * time));
      const i = Math.floor(frame);
      const a = motion.body[i];
      const b = motion.body[Math.min(i + 1, motion.body.length - 1)];
      travelled = mix(a[0], b[0], frame - i);
      gait = b[0] === a[0] ? 'stand' : a[1] > 0.5 ? 'trot' : 'walk';
      const zWorld = motion.fromZ + travelled;
      const position = [0, grade(zWorld) + 0.029, zWorld];
      const [x, y, z] = position;
      coat.root.setPosition(position);
      const view = shotAt(shots, time);
      const eye = view.position;
      eye[1] = Math.max(y + eye[1], ground(x + eye[0], z + eye[2]) + 0.32) - y;
      view.position = eye.map((v, i) => v + [x, y, z][i]);
      view.target = view.target.map((v, i) => v + [x, y, z][i]);
      return view;
    },
    cues: [
      [0.2, 4.62, 'Four hooves. A different rhythm for every gait.'],
      [6.3, 13.5, 'At a walk, the hooves land one at a time.'],
      [18.1, 23.1, 'Each planted hoof bears weight as the body moves over it.'],
      [27.2, 32, 'The horse pauses on the ridge.'],
      [40.7, 46.9, 'As speed builds, the walk gives way to a trot.'],
      [50.2, 57.9, 'At a trot, diagonal pairs of hooves land together.'],
      [65.8, 71.3, 'Back to a walk. The four-beat rhythm returns.'],
    ],
    musicCredit: 'Music: Wandering • Daniel William Lawrence • CC0',
    models: [meadow, path, distance, coat],
    dispose() {
      skin.dispose();
      coat.dispose();
      for (const patch of grass) patch.dispose();
      sample.dispose();
      stone.dispose();
      for (const rock of rocks) rock.dispose();
      sky.dispose();
      lichen.dispose();
      earth.dispose();
    },
    inspection: {
      gait: () => gait,
      distance: () => travelled,
      hoofbeats: () => motion.contacts,
    },
  };
}
