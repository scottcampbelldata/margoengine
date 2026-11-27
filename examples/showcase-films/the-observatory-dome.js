import { Material } from '@margoengine/materials';
import { geometryData } from '@margoengine/geometry/utils';
import { Sky } from '@margoengine/sky';
import { AstroSky, fetchBrightStarCatalog, planetPositions } from '@margoengine/sky/astro';
import { MilkyWay } from '@margoengine/sky/milky-way';
import { degrees } from '@margoengine/sky/sun';
import { finishTexture, mix, ramp, shotAt } from './film.js';
import { brushTexture, surface, texturedGround } from './environment-films.js';

const deck = 4.2;
const radius = 5.28;
const slit = Math.asin(1.34 / radius);
const railStart = 0.22;
const railEnd = 1.72;
const shutterTravel = 1.405;
const site = { latitude: degrees(31.9583), longitude: degrees(-111.5967) };
const startDate = Date.parse('2026-12-09T08:30:00Z');
const rockHeight = (x, z) =>
  -0.09 +
  0.48 * Math.sin(x / 32) * Math.cos(z / 18) -
  1.7 * (1 - Math.exp(-(x * x + z * z) / 1700)) +
  18.1 * Math.exp(-((x + 111) ** 2 + (z + 98) ** 2) / 3500) +
  23.0 * Math.exp(-((x - 141) ** 2 + (z + 129) ** 2) / 2700) +
  0.24 * Math.sin(x / 10 + z / 13) * Math.min(1, Math.hypot(x, z) / 40);

const onShell = (latitude, arc, r) => [
  r * Math.sin(latitude),
  r * Math.cos(latitude) * Math.sin(arc),
  r * Math.cos(latitude) * Math.cos(arc),
];
function shellPanel(a, b, start, end, r, segments = 6) {
  const positions = [],
    normals = [],
    uv = [],
    indices = [];
  const rings = Math.max(2, Math.ceil((end - start) * 18));
  for (let j = 0; j <= rings; j++)
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const v = j / rings;
      const n = onShell(mix(a, b, u), mix(start, end, v), 1);
      positions.push(...n.map((c) => c * r));
      normals.push(...n);
      uv.push(u * 4, v * 12);
    }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segments; i++) {
      const p = j * (segments + 1) + i;
      const q = p + segments + 1;
      indices.push(p, p + 1, q, p + 1, q + 1, q);
    }
  return geometryData(positions, normals, uv, indices);
}

export async function buildObservatory(engine, shop, cluster) {
  const [stone, concrete, catalog] = await Promise.all([
    surface('rocky_terrain_02', { color: '#968588', normalScale: 0.85 }),
    surface('concrete_floor_02', { color: '#a4a5a4', normalScale: 0.58 }),
    fetchBrightStarCatalog(new URL('../../packages/sky/test/fixtures/bsc5/catalog.gz', import.meta.url).href),
  ]);
  const rock = texturedGround(engine, rockHeight, stone.material, { size: [610, 620], resolution: 179 }, 8);
  const sky = Sky.attach(engine, {
    model: 'bruneton',
    timeScale: 0,
    sunDirection: [0, -1, 0],
    night: {
      zenithColor: [0.0013, 0.0027, 0.0092],
      horizonColor: [0.029, 0.037, 0.078],
      starIntensity: 0,
      moonIntensity: 0.6,
    },
    clouds: { coverage: 0.49, speed: 0.08, height: 650 },
  });
  const astronomy = AstroSky.attach(engine, {
    ...site,
    date: new Date(startDate),
    catalog,
    sky,
    timeScale: 0,
    brightness: 82,
    pointSize: 1.63,
    limitingMagnitude: 7.0,
    extinction: 0.13,
  });
  MilkyWay.attach(engine, { astro: astronomy, clouds: 0.46 });
  const { group, part, box, ring, beam, sign } = shop;
  const finish = finishTexture(451279, { r: 185, grain: 22, mottling: 13, streak: true });
  const get = (color, roughness = 0.54, metalness = 0, extra = {}) =>
    new Material({ color, roughness, metalness, roughnessMap: finish, ...extra });
  const shell = get('#ced4ce', 0.43, 0.24, { doubleSided: true });
  const rail = get('#7f8a97', 0.36, 0.68);
  const trim = get('#58636a', 0.58, 0.48);
  const dark = get('#292d35', 0.61, 0.62);
  const pale = get('#d3d0c2', 0.39, 0.26);
  const hardware = get('#a0a7a6', 0.47, 0.64);
  const tubePaint = get('#c0c6c5', 0.34, 0.48);
  const gold = get('#b19c65', 0.48, 0.51);
  const lens = get('#1b3745', 0.17, 0.48, { emissive: '#142439', emissiveIntensity: 0.08 });
  const red = get('#92201f', 0.45, 0, { emissive: '#ff3124', emissiveIntensity: 2.3 });
  const white = get('#ded2a6', 0.55, 0, { emissive: '#ffbb6d', emissiveIntensity: 1.3 });
  const tar = get('#252728', 0.75, 0.18);
  const base = group('Service deck');
  ring([5.34, 5.44, 0.65], concrete.material, [0, deck - 0.34, 0], undefined, base, 88);
  ring([5.26, 5.25, 1.85], concrete.material, [0, 0.88, 0], undefined, base, 88);
  ring([5.45, 5.47, 0.19], trim, [0, deck - 0.65, 0], undefined, base, 88);
  ring([5.29, 5.29, 0.15], hardware, [0, deck - 0.08, 0], undefined, base, 88);
  ring([5.13, 5.13, 0.085], dark, [0, deck + 0.014, 0], undefined, base, 88);

  for (let i = 0; i < 56; i++) {
    const az = (i * Math.PI * 2) / 56;
    const x = Math.sin(az),
      z = Math.cos(az);
    const doorHere = Math.abs(az - Math.PI * 1.27) < 0.27;
    if (!doorHere) box([0.59, 2.13, 0.2], concrete.material, [5.06 * x, 2.74, 5.06 * z], [0, az, 0], base);
    const bolt = [5.37 * x, deck - 0.18, 5.37 * z];
    ring([0.049, 0.049, 0.027], rail, bolt, [0, az, Math.PI / 2], base, 6);
    if (i % 2 === 0) {
      const next = az + (Math.PI * 4) / 56;
      for (const h of [1.11, 0.63])
        beam(
          [6.02 * x, deck - 0.39 + h, 6.02 * z],
          [6.02 * Math.sin(next), deck - 0.39 + h, 6.02 * Math.cos(next)],
          0.064,
          rail,
          base,
          true,
        );
      box([0.065, 1.18, 0.065], trim, [6.02 * x, deck + 0.18, 6.02 * z], undefined, base, 0.008);
    }
    const innerAz = az + Math.PI / 56;
    box(
      [0.81, 0.62, 0.06],
      i % 2 ? trim : dark,
      [4.86 * Math.sin(innerAz), deck + 0.32, 4.86 * Math.cos(innerAz)],
      [0, innerAz, 0],
      base,
      0.009,
    );
  }
  ring([6.06, 6.06, 0.13], trim, [0, deck - 0.405, 0], undefined, base, 88);
  for (let i = 0; i < 15; i++) {
    const x = -5.53 - 0.26 * i,
      h = deck - 0.43 - 0.24 * i;
    box([0.25, 0.1, 1.08], trim, [x, h, -1.35], undefined, base, 0.009);
    for (const z of [-1.91, -0.79]) if (i % 3 === 0) box([0.052, 0.99, 0.052], rail, [x, h + 0.49, z], undefined, base);
  }
  for (const z of [-1.91, -0.79]) beam([-5.53, deck + 0.51, z], [-9.17, deck - 2.85, z], 0.058, hardware, base, true);
  box([0.21, 2.17, 1.12], pale, [-4.77, 2.71, -2.26], undefined, base, 0.013);
  box([0.045, 0.28, 0.51], white, [-4.91, 3.45, -2.23], undefined, base, 0.025);

  const rotating = group('Azimuth ring', null, [0, deck, 0]);
  const shutter = group('Rolling upper shutter', rotating);
  const arcRail = (latitude, start, end, r, width, material, parent) => {
    const segments = Math.ceil((end - start) * 17);
    for (let j = 0; j < segments; j++) {
      const p = onShell(latitude, mix(start, end, j / segments), r);
      const q = onShell(latitude, mix(start, end, (j + 1) / segments), r);
      beam(p, q, width, material, parent, true);
    }
  };
  for (const [start, end] of [
    [-1.5707, -slit],
    [slit, 1.5707],
  ]) {
    const panels = 8;
    for (let j = 0; j < panels; j++) {
      const a = mix(start, end, j / panels);
      const b = mix(start, end, (j + 1) / panels);
      part(shellPanel(a, b, 0, Math.PI, radius), shell, undefined, undefined, rotating);
      if (j) arcRail(a, 0, Math.PI, radius + 0.022, 0.033, rail, rotating);
    }
  }
  for (const [start, end] of [
    [0, railStart],
    [railEnd, Math.PI],
  ])
    part(shellPanel(-slit, slit, start, end, radius, 18), shell, undefined, undefined, rotating);
  for (const side of [-slit, slit]) {
    arcRail(side, railStart - 0.08, Math.PI - 0.006, radius + 0.074, 0.103, rail, rotating);
    arcRail(side, railStart, railEnd, radius - 0.055, 0.085, trim, rotating);
    arcRail(side, railStart, railEnd, radius + 0.143, 0.064, trim, shutter);
    for (const arc of [railStart + 0.11, railEnd - 0.13]) {
      ring([0.073, 0.073, 0.068], hardware, onShell(side, arc, radius + 0.087), [0, 0, Math.PI / 2], shutter, 20);
    }
  }
  const lid = get('#cfcec2', 0.38, 0.31, { doubleSided: true });
  part(
    shellPanel(-slit, slit, railStart - 0.018, railEnd + 0.02, radius + 0.151, 21),
    lid,
    undefined,
    undefined,
    shutter,
  );
  for (const [arc, r, parent] of [
    [railStart, radius - 0.025, rotating],
    [railEnd, radius - 0.025, rotating],
    [railStart, radius + 0.171, shutter],
    [railEnd, radius + 0.171, shutter],
  ]) {
    for (let j = 0; j < 14; j++)
      beam(
        onShell(mix(-slit, slit, j / 14), arc, r),
        onShell(mix(-slit, slit, (j + 1) / 14), arc, r),
        0.076,
        trim,
        parent,
        true,
      );
  }

  const tower = group('Telescope pier', null, [0, deck + 0.05, 0]);
  ring([1.17, 1.4, 0.22], concrete.material, [0, 0.11, 0], undefined, tower, 56);
  ring([0.66, 0.91, 0.99], concrete.material, [0, 0.63, 0], undefined, tower, 48);
  ring([0.85, 0.85, 0.23], hardware, [0, 1.14, 0], undefined, tower, 48);
  const mount = group('Motorized telescope fork', tower, [0, 1.26, 0]);
  ring([0.73, 0.82, 0.56], dark, [0, 0.28, 0], undefined, mount, 48);
  for (const x of [-0.85, 0.85]) {
    box([0.28, 1.46, 0.74], pale, [x, 0.85, 0], undefined, mount, 0.105);
    box([0.32, 0.32, 0.67], trim, [x, 0.26, 0], undefined, mount, 0.036);
    ring([0.38, 0.38, 0.16], dark, [x * 1.2, 1.51, 0], [0, 0, Math.PI / 2], mount, 42);
    ring([0.25, 0.25, 0.19], gold, [x * 1.23, 1.51, 0], [0, 0, Math.PI / 2], mount, 36);
    for (let j = 0; j < 10; j++)
      ring(
        [0.033, 0.033, 0.045],
        rail,
        [x * 1.34, 1.51 + 0.29 * Math.sin(j * 0.628), 0.29 * Math.cos(j * 0.628)],
        [0, 0, Math.PI / 2],
        mount,
        8,
      );
  }
  const optical = group('Reflector tube', mount, [0, 1.51, 0]);
  const along = [Math.PI / 2, 0, 0];
  ring([0.62, 0.61, 2.57], tubePaint, [0, 0, 0.21], along, optical, 80);
  ring([0.73, 0.63, 0.17], dark, [0, 0, 1.43], along, optical, 80);
  ring([0.678, 0.676, 0.09], rail, [0, 0, 1.54], along, optical, 80);
  ring([0.587, 0.587, 0.06], lens, [0, 0, 1.585], along, optical, 80);
  for (const z of [-0.79, -0.31, 0.85]) ring([0.66, 0.66, 0.078], hardware, [0, 0, z], along, optical, 72);
  ring([0.38, 0.43, 0.21], trim, [0, 0, -1.14], along, optical, 60);
  ring([0.23, 0.26, 0.31], dark, [0, 0, -1.35], along, optical, 40);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.5;
    const x = Math.sin(a),
      y = Math.cos(a);
    beam([0.64 * x, 0.64 * y, -0.95], [0.64 * x, 0.64 * y, 1.26], 0.046, rail, optical, true);
    beam([0.07 * x, 0.07 * y, 1.68], [0.56 * x, 0.56 * y, 1.62], 0.026, dark, optical);
  }
  ring([0.063, 0.063, 0.17], hardware, [0, 0, 1.68], along, optical, 24);
  ring([0.12, 0.12, 0.83], dark, [0.0, 0.7, 0.37], along, optical, 30);
  ring([0.098, 0.098, 0.015], lens, [0.0, 0.7, 0.81], along, optical, 30);

  const consolePanel = group('Red light control desk', null, [-3.78, deck + 0.19, -1.87]);
  box([1.7, 0.92, 0.65], dark, [0, 0.46, 0], undefined, consolePanel, 0.06);
  box([1.66, 0.1, 0.71], trim, [0, 0.96, 0], undefined, consolePanel, 0.047);
  sign(
    ['OBSERVING STATION', 'DOME READY   /   TARGET ACQUIRED'],
    [0.91, 0.31],
    [0.17, 1.26, 0.27],
    [-0.14, 0, 0],
    consolePanel,
    { foreground: '#ff8061', background: '#351b20', lit: 0.72 },
  );
  for (let i = 0; i < 7; i++)
    ring([0.036, 0.036, 0.025], i === 3 ? white : red, [0.29 + i * 0.061, 1.023, 0.12], undefined, consolePanel, 16);
  for (const az of [0.2, 1.8, 3.3, 4.7]) {
    const x = 4.78 * Math.sin(az),
      z = 4.78 * Math.cos(az);
    box([0.35, 0.23, 0.15], trim, [x, deck + 0.71, z], [0, az, 0], base, 0.023);
    box(
      [0.24, 0.075, 0.055],
      red,
      [x - 0.088 * Math.sin(az), deck + 0.67, z - 0.088 * Math.cos(az)],
      [0, az, 0],
      base,
      0.018,
    );
  }
  const illuminated = brushTexture(384, 96, (ctx, w, h) => {
    ctx.fillStyle = '#211d27';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#bf705c';
    ctx.font = '700 37px Segoe UI';
    ctx.fillText('OBSERVATORY', 11, 61);
  });
  box(
    [1.29, 0.19, 0.018],
    new Material({
      map: illuminated,
      color: '#ffffff',
      emissiveMap: illuminated,
      emissive: '#e09066',
      emissiveIntensity: 0.36,
    }),
    [2.08, 1.53, 4.87],
    [0, 0.43, 0],
  );
  box([30, 0.055, 4.55], tar, [0, -0.025, 11.6], undefined, null, 0.015);

  const scopeCamera = [-2.62, 5.93, 3.55];
  const scopeTarget = [0, 6.6, 0.08];
  const shots = [
    [5.7, [11.7, 5.12, 13.76], [10.55, 5.58, 12.9], [0, 5.8, 0], [0, 5.96, 0], 47],
    [18.1, [-3.55, 5.48, 2.91], [-2.86, 5.54, 2.03], [-0.08, 6.48, 0], [0.35, 6.66, 0.37], 54],
    [33.6, [9.33, 7.65, 8.2], [13.0, 8.99, 6.62], [0, 6.67, 0], [0, 7.24, 0], 47],
    [48.9, scopeCamera, scopeCamera, scopeTarget, scopeTarget, 51],
    [62.9, [0.54, 5.31, -2.46], [1.95, 6.03, -1.77], [3.51, 7.86, 0.25], [8.48, 12.95, 0.81], 57],
    [77.9, [5.35, 7.38, 0.6], [7.58, 8.48, 0.62], [15.5, 14.2, 1.43], [22, 19.6, 2.2], 39],
    [90, [16.34, 5.26, 14.9], [18.86, 5.91, 15.85], [0, 7.38, 0], [0, 8.22, 0], 52],
  ];
  const cues = [
    [0.18, 5.5, 'The shutter slides up and over the dome.'],
    [7.3, 15.8, 'Dim red lamps preserve the observer’s night vision.'],
    [20.1, 29.7, 'The dome lines up its viewing slit.'],
    [35.4, 45.9, 'The telescope turns and tilts toward Jupiter.'],
    [51.1, 60.4, 'Light enters through the open slit.'],
    [63.9, 69.8, 'Kitt Peak sky • December 9, 2026 • 01:30 MST'],
    [70.3, 76.7, 'Jupiter is the brightest point in this view.'],
    [78.1, 82.1, 'Stars from the Yale Bright Star Catalogue and CDS.'],
  ];
  let cachedTime = NaN;
  let planet;
  function apply(time) {
    const date = new Date(startDate + time * 9000);
    astronomy.options.date = date;
    if (time !== cachedTime) {
      cachedTime = time;
      planet = planetPositions(date, site).find((position) => position.name === 'jupiter');
    }
    const [x, , z] = planet.direction;
    const yaw = Math.atan2(x, z);
    const orient = ramp(time, 9.2, 32.4);
    const aligned = mix(0.7, yaw, orient);
    rotating.setRotation([0, aligned, 0]);
    const telescopeYaw = mix(0.22, yaw, ramp(time, 35.15, 45.8));
    const telescopePitch = mix(-0.053, -planet.elevation.radians, ramp(time, 35.65, 46.5));
    mount.setRotation([0, telescopeYaw, 0]);
    optical.setRotation([telescopePitch, 0, 0]);
    const travel = shutterTravel * (0.36 * ramp(time, 0.2, 4.65) + 0.64 * ramp(time, 5.3, 31.7));
    shutter.setRotation([-travel, 0, 0]);
    sky.options.clouds.coverage = mix(0.51, 0.05, ramp(time, 41, 70));
    cluster.setLights([
      { position: [-3.55, 6.03, -1.67], color: [1, 0.16, 0.085], intensity: 8.6, range: 9 },
      { position: [2.55, 5.26, 2.6], color: [1, 0.093, 0.038], intensity: 7.4, range: 7.5 },
      { position: [0.3, 5.3, -3.85], color: [1, 0.18, 0.065], intensity: 7.2, range: 9 },
      { position: [-5.53, 3.75, -1.25], color: [1, 0.67, 0.34], intensity: 12.5, range: 9 },
    ]);
    return shotAt(shots, time);
  }
  return {
    apply,
    cues,
    models: [rock],
    dispose() {
      stone.dispose();
      concrete.dispose();
      finish.dispose();
      illuminated.dispose();
    },
    inspection: { stars: catalog.count ?? catalog.magnitude?.length },
  };
}
