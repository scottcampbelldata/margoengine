import { PbrMaterial, box as coreBox } from '@margoengine/core';
import { ColorBackground, Fog } from '@margoengine/environment';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { instancing } from '@margoengine/gltf/pbr-instancing';
import { Material } from '@margoengine/materials';
import { SSR } from '@margoengine/post/ssr';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { Weather } from '@margoengine/sky/weather';
import { WeatherMachine, skyWeather, windAt } from '@margoengine/weather';
import { GLTFWeather } from '@margoengine/weather/gltf';
import { Puddles } from '@margoengine/weather/puddles';
import { blend, finishTexture, ramp, shotAt } from './film.js';
import { asset as libraryAsset } from './assets.js';

const quarter = Math.PI / 2;
const trackRadius = 34;
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
  const { box, ring, beam, sign } = shop;
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
  const grit = finishTexture(2891, { r: 211, grain: 47, mottling: 30 });
  const brushed = finishTexture(21392, { r: 199, grain: 28, streak: true, mottling: 20 });
  const look = (color, roughness, metalness = 0, roughnessMap) =>
    new Material({ color, roughness, metalness, roughnessMap });
  const railSide = look('#423a33', 0.49, 0.72, brushed);
  const structure = look('#34424b', 0.61, 0.49, grit),
    steel = look('#646e71', 0.34, 0.74, brushed);
  const shelter = look('#6e7472', 0.7, 0.15, grit);
  const dark = look('#172127', 0.52, 0.24),
    offWhite = look('#bcb5a4', 0.35, 0.36, grit);
  const rubber = look('#17191c', 0.78, 0.09);
  const yellow = look('#ae8848', 0.59, 0.17, grit);
  const grayPanel = look('#535456', 0.42, 0.46, brushed);
  const emit = (color, intensity) =>
    new Material({ color, roughness: 0.43, emissive: color, emissiveIntensity: intensity });
  const warm = emit('#ffddb3', 2.8);
  const red = emit('#ef321c', 3.2),
    green = emit('#65db97', 3.6);
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
  // Wet ground: core and Material meshes through Puddles, the Blender models through GLTFWeather with the same water.
  // Small, rain-roughened puddles in the low spots, so lamps smear in them rather than mirror.
  const water = { wetness: 0.96, rain: 0.72, coverage: 0.22, size: 1.7, rippleStrength: 0.3 };
  const puddles = Puddles.attach(engine, { ...water });
  const modelWeather = GLTFWeather.attach(engine, { puddles: { ...water } });
  const fog = Fog.attach(engine, { color: '#3a3532', density: 0.013, heightFalloff: 0.055, height: 3 });
  // Through the gaps of the deck: a near black night.
  ColorBackground.attach(engine, { color: '#0e0f13', bottom: '#1d1a19' });
  // A low overcast deck lit orange from below by the city behind the yard, a far suburb and the yard's sodium lamps
  // (VolumetricClouds groundLights; Kyba et al. 2011, cloud cover amplifies skyglow). North is -z: the city lies the
  // way the tram comes in, so the approach shots look into its glow.
  const city = [1, 0.55, 0.3],
    sodium = [1, 0.5, 0.14];
  const clouds = VolumetricClouds.attach(engine, {
    sunDirection: [0, -1, 0],
    ambient: [
      [0.0004, 0.0005, 0.0008],
      [0.0025, 0.0018, 0.0012],
    ],
    coverage: 0.6,
    bottom: 650,
    top: 1300,
    density: 0.1,
    scale: 2600,
    erosion: 1.1,
    wind: [4, 1.5],
    evolution: 1.5,
    groundAlbedo: 0.12,
    temporal: false,
    // The city as districts of different size and lamp colour, so the deck's underside is mottled and the horizon
    // brightens over each one rather than in one even band.
    groundLights: [
      { color: city.map((c) => c * 0.26), x: 3600, z: -3600, radius: 2600 },
      { color: sodium.map((c) => c * 0.34), x: 600, z: -5200, radius: 1500 },
      { color: [0.55, 0.5, 0.45].map((c) => c * 0.16), x: 6200, z: -1200, radius: 1800 },
      { color: city.map((c) => c * 0.07), x: -4200, z: 4600, radius: 3000 },
      { color: sodium.map((c) => c * 0.5), x: 0, z: 0, radius: 140 },
    ],
    mist: { visibility: 30000 },
  });
  const ssr = new SSR({ maxRoughness: 0.5, thickness: 0.14, maxDistance: 42, steps: 44 });
  // Far ground under the Blender yard, below its plain ground (-0.125), so nothing beyond it is a void.
  const farGround = engine
    .createMesh()
    .setGeometry(coreBox(260, 0.16, 260))
    .setMaterial(new PbrMaterial({ color: '#2b2e30', roughness: 0.8 }))
    .setPosition([3, -0.26, -15]);
  farGround.name = 'Far wet ground';

  // The ground set, built in Blender from CC0 scans (north-yard/build_track.py, build_ground.py): ballasted track with
  // timber sleepers, rail seats and instanced stones; the two platforms with coping and tactile paving; the cess,
  // cable troughs, service road, kerbs and the clutter round them. All in film coordinates.
  const yard = await Promise.all(
    ['track', 'platforms', 'yard-ground'].map((name) =>
      loadGLTF(engine, libraryAsset('north-yard/' + name + '.glb'), { decoders: { instancing } }),
    ),
  );

  // Catenary span, track signals and depot building.
  for (let s = -66; s < 51; s += 13) {
    const { heading } = frame(s),
      p = along(s, 3.36);
    ring([0.122, 0.167, 5.32], structure, [p[0], 2.52, p[2]], undefined, undefined, 14);
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
    [along(-13, -9.2)[0], along(-13, -9.2)[2]],
    [-8.9, 2],
    [-8.9, 16],
    [-8.9, 29],
    [-4.7, 42],
    [-4.4, -29],
    [5.9, -23],
    [4.35, 46],
  ]) {
    box([0.27, 0.14, 0.28], shelter, [x, -0.03, z], undefined, undefined, 0.014);
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
  for (const z of [-37, -17, 40]) {
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
    // The yard's palisade and buildings (approach above) stand here.
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
      box([0.203, 0.065, 0.203], shelter, [x, 1.3095, z], undefined, undefined, 0.013);
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
  const platformDeck = 1.277;
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
  // The tram, built in Blender (north-yard/build_tram.py): three modules with baked livery, seams, rivets, grime, rain
  // streaks and beading, bogies under each, wheelsets that turn on the rail head (tread radius 0.33, axle at 0.52), the
  // articulation bellows and the two leaves of the cab's platform-side door.
  const load = (name) => loadGLTF(engine, libraryAsset('north-yard/' + name + '.glb'));
  const [cab, middle, tail, ...parts] = await Promise.all([
    load('tram-cab'),
    load('tram-middle'),
    load('tram-cab-tail'),
    ...Array.from({ length: 6 }, () => load('tram-wheelset')),
    load('tram-bellows'),
    load('tram-bellows'),
    load('tram-door-leaf'),
    load('tram-door-leaf'),
  ]);
  const modules = [cab, middle, tail];
  const wheelsets = parts.slice(0, 6);
  const bellows = parts.slice(6, 8);
  const leaves = parts.slice(8, 10);
  const wheels = [];
  for (const [i, module] of modules.entries())
    for (const [k, z] of [-0.9, 0.9].entries()) {
      const wheelset = wheelsets[i * 2 + k];
      wheelset.root.setParent(module.root).setPosition([0, wheelRadius + 0.19, z]);
      // The tail module is turned about Y, so its wheels turn the other way in its own frame.
      wheels.push({ node: wheelset.root, sign: i === 2 ? -1 : 1 });
    }
  // Closed positions in the cab's frame; each leaf plugs out 0.1 m, then slides 0.8 m along the body.
  const sliding = [
    [-0.46, -1],
    [0.4, 1],
  ].map(([z, direction], k) => {
    leaves[k].root.setParent(cab.root).setPosition([1.125, 2.02, z]);
    return { leaf: leaves[k].root, x: 1.125, z, direction };
  });
  const tram = [...modules, ...wheelsets, ...bellows, ...leaves];
  // GLTFWeather wets the imported models; the film's own Material meshes join Puddles by themselves.
  for (const model of [depot, ...approach, ...yard, ...tram]) modelWeather.add(model);

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
    for (const [i, module] of modules.entries()) {
      const bodyS = s - 3.95 - i * (length + 0.37);
      const { center, heading } = frame(bodyS);
      module.root.setPosition(center).setRotation([0, heading + (i === 2 ? Math.PI : 0), 0]);
      for (const k of [0, 1]) cabin[i * 2 + k].position = chase(bodyS, 0, 2.42, k ? 1.65 : -1.65);
      if (i < bellows.length) {
        const joint = frame(bodyS - (length + 0.37) / 2);
        bellows[i].root.setPosition(joint.center).setRotation([0, joint.heading, 0]);
      }
    }
    for (const { node, sign } of wheels) node.setRotation([(sign * (s + 52)) / wheelRadius, 0, 0]);
    const open = ramp(time, 70.78, 73.35);
    for (const { leaf, x, z, direction } of sliding)
      leaf.setPosition([x + 0.1 * ramp(time, 70.78, 71.33), 2.02, z + direction * 0.8 * open]);
    const cf = s - 3.95;
    for (const [i, h] of heads.entries()) {
      h.position = chase(cf, i === 0 ? -0.7 : 0.7, 1.19, 4.03);
      const { forward } = frame(cf);
      h.direction = [forward[0], -0.071, forward[2]];
    }
    cluster.setLights(lamps);
    weather.options.intensity = 0.73 - 0.17 * ramp(time, 68, 86);
    puddles.options.rain = weather.options.intensity;
    modelWeather.options.puddles.rain = weather.options.intensity;

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
    models: [depot, ...approach, ...yard, ...tram],
    effects: [ssr],
    receivers: [fog, ssr],
    dispose() {
      wet.dispose();
      grit.dispose();
      brushed.dispose();
      clouds.dispose();
      depot.dispose();
      for (const model of [...approach, ...yard, ...tram]) model.dispose();
    },
    inspection: { frontPosition },
  };
}
