import { PbrMaterial } from '@margoengine/core';
import { CulledParts } from '@margoengine/culling/parts';
import { applyMatrix4, boxGeometry, mergeGeometries, toGeometry } from '@margoengine/geometry';
import { Material } from '@margoengine/materials';
import { Sky } from '@margoengine/sky';
import { sunPosition } from '@margoengine/sky/astro';
import { degrees } from '@margoengine/sky/sun';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { ease, finishTexture, mix, ramp, rng, shotAt } from './film.js';
import { at, brushTexture } from './environment-films.js';
import { loadSolarLandscape } from './solar-landscape.js';

const site = { latitude: degrees(34.7805), longitude: degrees(-118.423) };
const day = Date.parse('2026-10-04T16:05:00Z');

function cells() {
  return brushTexture(512, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#b9bac0';
    ctx.fillRect(0, 0, w, h);
    const random = rng(82341);
    for (let j = 0; j < 12; j++) {
      for (let i = 0; i < 6; i++) {
        const x = 12 + i * 82,
          y = 11 + j * 84;
        ctx.fillStyle = '#142034';
        ctx.fillRect(x - 1, y - 1, 78, 78);
        const g = ctx.createLinearGradient(x, y, x + 57, y + 100);
        const v = Math.round(29 + random() * 6);
        g.addColorStop(0, 'rgb(' + v + ',45,75)');
        g.addColorStop(0.5, 'rgb(' + (v + 3) + ',53,93)');
        g.addColorStop(1, '#192943');
        ctx.fillStyle = g;
        ctx.fillRect(x + 2, y + 2, 73, 73);
        ctx.strokeStyle = '#6d85a34d';
        ctx.lineWidth = 1;
        for (let k = 4; k < 75; k += 4) {
          ctx.beginPath();
          ctx.moveTo(x + 2, y + k);
          ctx.lineTo(x + 75, y + k);
          ctx.stroke();
        }
        ctx.fillStyle = '#b1bbcf8a';
        for (let k = 21; k < 73; k += 19) ctx.fillRect(x + k, y + 2, 1, 73);
      }
    }
  });
}

export async function buildSolarField(engine, shop, _cluster, shadows) {
  const landscape = await loadSolarLandscape();
  const ground = landscape.sample;
  const terrain = landscape.attach(engine);
  shadows.add(terrain, { static: true });
  const sky = Sky.attach(engine, {
    model: 'bruneton',
    timeScale: 0,
    fog: { density: 0.000118, start: 145, color: [0.47, 0.53, 0.6] },
  });
  const clouds = VolumetricClouds.attach(engine, {
    sky,
    type: 'cumulus',
    bottom: 1580,
    top: 2690,
    coverage: 0.28,
    steps: 38,
    lightSteps: 4,
    temporal: false,
    wind: [7, 2],
    dimLight: false,
  });
  const textured = cells();
  const finish = finishTexture(187402, { r: 159, grain: 18, mottling: 24, streak: true });
  const pane = new Material({
    color: '#e9f3ff',
    map: textured,
    metalness: 0.08,
    roughness: 0.225,
    clearcoat: 0.74,
    clearcoatRoughness: 0.13,
  });
  const metal = new Material({ color: '#bec4c3', roughness: 0.62, metalness: 0.51, roughnessMap: finish });
  const motor = new Material({ color: '#668085', roughness: 0.56, metalness: 0.37, roughnessMap: finish });
  const zinc = new PbrMaterial({ color: '#858c83', metalness: 0.57, roughness: 0.62 });
  const dark = new PbrMaterial({ color: '#324b67', metalness: 0.21, roughness: 0.25 });
  const alloy = new PbrMaterial({ color: '#656d73', metalness: 0.52, roughness: 0.48 });
  const base = new Material({ color: '#b2a18f', roughness: 0.86 });
  const wiring = new Material({ color: '#24272a', roughness: 0.53 });
  const backsheet = new Material({ color: '#aeb6b7', roughness: 0.78, roughnessMap: finish });
  const orange = new Material({ color: '#ac6444', roughness: 0.56 });
  const white = new Material({ color: '#d0cc98', roughness: 0.6, emissive: '#f1b673', emissiveIntensity: 0.35 });
  const { group, part, box, ring, beam, sign } = shop;

  const rows = [];
  const fixed = [];
  const tubes = [];
  const panels = [];
  const transforms = [];
  const moduleCount = 12;
  const segment = 14.3;
  const half = segment * 0.48;
  const width = 2.24;
  for (let j = 0; j < moduleCount; j++) {
    const z = (j - (moduleCount - 1) / 2) * 1.153;
    panels.push(applyMatrix4(boxGeometry(width, 0.04, 1.118), at(0, 0.11, z)));
  }
  const railGeometry = mergeGeometries([
    applyMatrix4(boxGeometry(0.14, 0.14, segment - 0.43), at(0, 0, 0)),
    applyMatrix4(boxGeometry(0.03, 0.065, segment - 0.43), at(-width / 2, 0.088, 0)),
    applyMatrix4(boxGeometry(0.03, 0.065, segment - 0.43), at(width / 2, 0.088, 0)),
  ]);

  for (let row = -33; row <= 37; row++) {
    const x = row * 6.92 + 1.13;
    for (let col = -15; col <= 15; col++) {
      const z = col * segment + (row % 3) * 0.22;
      if ((col > 8 && row > 21) || (col < -5 && row < -24) || col === 3 || col === -8 || row === -17 || row === 18)
        continue;
      const y = ground(x, z) + 1.98;
      if (row >= -1 && row <= 1 && col >= -2 && col <= 1) {
        const pivot = group('Tracker torque tube', null, [x, y, z]);
        const support = group('Driven support', null, [x, y, z]);
        rows.push(pivot);
        part(railGeometry, metal, undefined, undefined, pivot);
        for (let p = 0; p < moduleCount; p++) {
          const a = (p - (moduleCount - 1) / 2) * 1.153;
          box([2.224, 0.05, 1.124], metal, [0, 0.086, a], undefined, pivot, 0.009);
          box([2.17, 0.018, 1.077], pane, [0, 0.115, a], undefined, pivot);
          box([2.176, 0.008, 1.081], backsheet, [0, 0.057, a], undefined, pivot);
          box([2.07, 0.055, 0.08], metal, [0, -0.02, a - 0.34], undefined, pivot, 0.009);
          box([0.23, 0.053, 0.24], wiring, [0.38, 0.043, a + 0.22], undefined, pivot, 0.01);
          beam([0.43, 0.041, a + 0.25], [0.21, -0.08, a + 0.41], 0.013, wiring, pivot, true);
        }
        for (const v of [-4.78, 0, 4.78]) {
          const localGround = ground(x, z + v) - y;
          box([0.33, -localGround - 0.12, 0.23], metal, [0, localGround / 2 - 0.06, v], undefined, support, 0.025);
          box([0.58, 0.18, 0.53], base, [0, localGround + 0.04, v], undefined, support, 0.05);
          ring([0.185, 0.185, 0.24], motor, [0, 0, v], [Math.PI / 2, 0, 0], support, 24);
          if (v !== 0) continue;
          box([0.46, 0.45, 0.33], motor, [-0.09, -0.29, 0.08], undefined, support, 0.035);
          ring([0.18, 0.18, 0.34], metal, [-0.22, -0.3, 0.1], [0, 0, Math.PI / 2], support, 28);
          for (let k = -3; k <= 3; k++)
            ring([0.189, 0.189, 0.012], motor, [-0.26 + k * 0.026, -0.3, 0.1], [0, 0, Math.PI / 2], support, 20);
          ring([0.194, 0.194, 0.048], metal, [-0.409, -0.3, 0.1], [0, 0, Math.PI / 2], support, 40);
          for (let bolt = 0; bolt < 8; bolt++) {
            const angle = (bolt * Math.PI) / 4;
            ring(
              [0.02, 0.02, 0.024],
              metal,
              [-0.446, -0.3 + 0.15 * Math.cos(angle), 0.1 + 0.15 * Math.sin(angle)],
              [0, 0, Math.PI / 2],
              support,
              6,
            );
          }
          box([0.056, 0.18, 0.45], metal, [-0.155, 0.077, 0.12], undefined, support, 0.011);
          box([0.062, 0.037, 0.266], orange, [0.14, 0.09, 0.04], undefined, pivot, 0.008);
          box([0.2, 0.17, 0.14], orange, [0.214, -0.43, 0.145], undefined, support, 0.018);
          box([0.02, 0.025, 0.048], white, [0.32, -0.42, 0.151], undefined, support, 0.004);
          beam([0.22, -0.54, 0.14], [0.18, -1.59, 0.17], 0.022, wiring, support, true);
        }
        continue;
      }
      transforms.push(...at(x, y, z));
      tubes.push([x, y, z, row]);
      for (const v of [-half * 0.72, 0, half * 0.72]) fixed.push(...at(x, ground(x, z + v) + 0.9, z + v));
    }
  }
  const banks = CulledParts.attach(engine, [
    { geometry: toGeometry(mergeGeometries(panels)), material: dark, transforms: new Float32Array(transforms) },
    { geometry: toGeometry(railGeometry), material: alloy, transforms: new Float32Array(transforms) },
    { geometry: toGeometry(boxGeometry(0.23, 1.94, 0.24)), material: zinc, transforms: new Float32Array(fixed) },
  ]);
  shadows.add(banks);

  const random = rng(77162);
  const dry = new PbrMaterial({ color: '#5b6350', roughness: 0.91 });
  const bush = mergeGeometries(
    Array.from({ length: 8 }, (_, i) => {
      const angle = i * 2.4;
      return applyMatrix4(
        boxGeometry(0.04, 0.38 + random() * 0.31, 0.048),
        at(Math.cos(angle) * 0.21, 0.18, Math.sin(angle) * 0.22, 0.63 * Math.cos(angle)),
      );
    }),
  );
  const scrub = [];
  for (let i = 0; i < 5200; i++) {
    const x = mix(-460, 525, random()),
      z = mix(-490, 530, random());
    if (Math.abs(x) < 190 && Math.abs(z) < 165 && random() > 0.06) continue;
    const size = mix(0.48, 1.42, random());
    const matrix = at(x, ground(x, z) + 0.06, z);
    matrix[0] = matrix[5] = matrix[10] = size;
    scrub.push(...matrix);
  }
  const scatter = CulledParts.attach(engine, [
    { geometry: toGeometry(bush), material: dry, transforms: new Float32Array(scrub) },
  ]);

  const stationPaint = new Material({ color: '#bbbcad', roughness: 0.58, roughnessMap: finish, metalness: 0.26 });
  const vent = new Material({ color: '#434846', roughness: 0.65, metalness: 0.23 });
  for (const [x, z] of [
    [36, 44],
    [-55, -114],
    [132, 44],
    [-145, 44],
  ]) {
    const pad = group('Field inverter station', null, [x, ground(x, z) + 0.06, z]);
    box([4.82, 0.15, 2.07], base, [0, 0.03, 0], undefined, pad, 0.028);
    box([2.87, 1.41, 0.89], stationPaint, [0, 0.87, -0.19], undefined, pad, 0.06);
    box([2.92, 0.055, 0.92], metal, [0, 1.58, -0.2], undefined, pad, 0.02);
    for (const door of [-0.95, 0, 0.95]) {
      box([0.9, 1.25, 0.04], stationPaint, [door, 0.89, 0.279], undefined, pad, 0.022);
      box([0.43, 0.47, 0.017], vent, [door - 0.062, 0.94, 0.305], undefined, pad, 0.013);
      for (let rung = 0; rung < 10; rung++)
        box([0.43, 0.02, 0.02], metal, [door - 0.062, 0.73 + 0.045 * rung, 0.325], undefined, pad, 0.006);
      box([0.029, 0.176, 0.034], vent, [door + 0.354, 0.92, 0.326], undefined, pad, 0.006);
    }
    sign(['PV INVERTER', 'HIGH VOLTAGE'], [0.263, 0.116], [0, 1.33, 0.308], undefined, pad, {
      foreground: '#2e281d',
      background: '#dfb76c',
    });
    for (const post of [-1.53, 1.55]) ring([0.048, 0.049, 0.78], orange, [post, 0.46, 0.82], undefined, pad, 18);
  }

  for (const x of [17.6, 18.5]) {
    box([0.07, 1.21, 0.07], metal, [x, ground(x, 2.9) + 0.61, 2.9], undefined, null, 0.01);
  }
  sign(['SOLAR TRACKER FIELD', 'ARRAY 04'], [1.29, 0.43], [18.05, ground(18.05, 2.9) + 1.09, 2.96], [0, -0.1, 0]);
  for (const x of [-0.58, 0.61]) {
    box([0.13, 1.41, 0.12], metal, [x, ground(x, 9.22) + 0.74, 9.22]);
  }
  const rowCamera = [4.55, 3.38 + ground(4.55, -30.3), -30.3];
  const rowTarget = [1.85, 1.9 + ground(1.85, -11), -11];
  const shots = [
    [5.8, [3.81, 2.97, 10.46], [2.82, 2.34, 5.46], [1.08, 1.9, 4.6], [0.9, 1.9, 0.2], 44],
    [19, [-1.62, 1.18, 1.44], [-0.92, 1.27, -0.94], [0.81, 1.59, 0.13], [0.96, 1.62, 0.12], 40],
    [31.9, rowCamera, rowCamera, rowTarget, rowTarget, 46],
    [55, [36, 18, -47], [180, 137, -215], [25, 0, 23], [18, -5, 96], 52],
    [68, [-183, 31, -85], [-195, 47, -24], [47, 1, 88], [51, 4, 92], 43],
    [90, [172, 76, -249], [205, 82, -187], [1, 4, 71], [4, 4, 78], 49],
  ];
  const cues = [
    [0.2, 5.6, 'Hundreds of trackers. One moving target.'],
    [7.2, 15.8, 'A motor drives the north-south torque tube.'],
    [20.5, 30.7, 'Time-lapse • The panels tilt from east to west.'],
    [34.3, 42.7, 'The rows keep tilting into the afternoon.'],
    [44.8, 53.5, 'Each foundation follows the surveyed ground.'],
    [57.6, 65.9, 'From the west, the panels catch the afternoon light.'],
    [72.3, 80.2, 'One mechanism, repeated across the valley floor.'],
  ];
  const working = new Float32Array(16);
  for (let j = 0; j < 16; j++) working[j] = j % 5 === 0 ? 1 : 0;
  let stamp = -1;
  function apply(time) {
    // Compress late morning through early afternoon into the fixed-camera shot.
    const progressed = 0.135 * ease(time / 20) + 0.5 * ramp(time, 20, 30.6) + 0.365 * ramp(time, 30, 77);
    const sun = sunPosition(new Date(day + 7.45 * 3600000 * progressed), site);
    sky.options.sunDirection = [...sun.direction];
    const position = sun.direction;
    const dayFactor = Math.max(0.56, Math.min(1, position[1] * 1.63));
    engine.lighting.direction.set([...position, 2.18 * dayFactor]);
    engine.lighting.radiance.set([1.05, mix(0.79, 0.96, dayFactor), mix(0.63, 0.9, dayFactor), 0.6]);
    const tilt = 0.45 * ease(time / 5.8) - 0.45 + Math.atan2(-position[0], Math.max(position[1], 0.22));
    const slope = Math.max(-0.94, Math.min(0.94, tilt));
    for (const pivot of rows) pivot.setRotation([0, 0, slope]);
    if (stamp !== time) {
      stamp = time;
      const c = Math.cos(slope);
      const s = Math.sin(slope);
      working[0] = working[5] = c;
      working[1] = s;
      working[4] = -s;
      for (const [i, [x, y, z]] of tubes.entries()) {
        working[12] = x;
        working[13] = y;
        working[14] = z;
        banks.setTransform(0, i, working);
        banks.setTransform(1, i, working);
      }
    }
    const view = shotAt(shots, time);
    if (time < 19) {
      view.position[1] += ground(view.position[0], view.position[2]);
      view.target[1] += ground(view.target[0], view.target[2]);
    }
    return view;
  }
  return {
    apply,
    cues,
    dispose() {
      terrain.dispose();
      clouds.dispose();
      textured.dispose();
      finish.dispose();
      banks.dispose();
      scatter.dispose();
    },
    inspection: { racks: tubes.length + rows.length, modules: (tubes.length + rows.length) * moduleCount },
  };
}
