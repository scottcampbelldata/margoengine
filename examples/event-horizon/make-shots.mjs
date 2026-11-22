// Writes the Event Horizon shot files, tools/shot/shots/eh-*.json: twelve long shots (1920 x 1080 footage for the
// long video) and three vertical shorts. `node examples/event-horizon/make-shots.mjs [folder]` writes into the folder
// given, default tools/shot/shots; tests/shot-file.test.js checks the files in the repository match its output.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const out = process.argv[2] ?? resolve(import.meta.dirname, '../../tools/shot/shots');
const R = (v) => +v.toFixed(3);
const sph = (r, latDeg, azDeg) => {
  const la = (latDeg * Math.PI) / 180,
    az = (azDeg * Math.PI) / 180;
  return [R(r * Math.cos(la) * Math.sin(az)), R(r * Math.sin(la)), R(r * Math.cos(la) * Math.cos(az))];
};
const cam = (keys) => ({
  type: 'camera',
  id: 'camera',
  path: 'catmull-rom',
  keys: keys.map(([time, position, target = [0, 0, 0], fov = 38], i) => ({
    time,
    position,
    target,
    fov,
    ...(i ? { ease: 'smoothstep' } : {}),
  })),
});
const prop = (property, keys) => ({
  type: 'property',
  id: property,
  target: 'hole',
  property,
  keys: keys.map(([time, value]) => ({ time, value })),
});
// A value that switches at each time (a 0.01 s ramp), held to the end.
const step = (property, times, values, end) =>
  prop(
    property,
    times
      .flatMap((t, i) =>
        i
          ? [
              [t - 0.01, values[i - 1]],
              [t, values[i]],
            ]
          : [[t, values[i]]],
      )
      .concat([[end, values.at(-1)]]),
  );
const PAGE = {
  path: 'examples/event-horizon/index.html',
  query: { ui: 0 },
  css: 'h1,#panel,#status,#error,#telemetry{display:none!important}#viewport{position:fixed!important;inset:0!important}',
  engine: 'eventHorizon.engine',
  apply: 'eventHorizon.apply',
  canvas: '#viewport canvas',
  ready: '#viewport[data-ready="true"]',
};
let seed = 70;
function shot(id, kind, seconds, tracks, probes) {
  const file = {
    format: 'margo-cutscene',
    version: 1,
    duration: seconds,
    tracks,
    shot: {
      format: 'margo-shot',
      version: 1,
      id,
      kind,
      seed: seed++,
      seconds,
      tier: 'high',
      msaa: 1,
      supersample: kind === 'long' ? 1.5 : 1,
      subframes: 4,
      shutter: 180,
      warmup: 30,
      probes,
      page: PAGE,
    },
  };
  writeFileSync(join(out, `${id}.json`), JSON.stringify(file, null, 2) + '\n');
  return seconds;
}
const p3 = (s) => ({ open: 0, mid: R(s / 2), end: R(s - 0.1) });
const p4 = (s) => ({ open: 0, third: R(s / 3), 'two-thirds': R((2 * s) / 3), end: R(s - 0.1) });
let total = 0;
const near = [-0.55, 0.95, 11.8],
  nearT = [0, -0.05, 0];
// 1. The approach, the strong opener: from 140 r_s in to the inclined close view.
total += shot(
  'eh-long-approach',
  'long',
  90,
  [
    cam([
      [0, [-6.5, 5.2, 95]],
      [25, [-3.8, 3.5, 50]],
      [55, [-1.9, 2.05, 25]],
      [78, [-0.95, 1.28, 15]],
      [90, near, nearT],
    ]),
  ],
  { open: 0, wide: 25, closing: 55, near: 78, end: 89.9 },
);
// 2. Inclinations: from edge on up towards the pole and round.
total += shot(
  'eh-long-inclinations',
  'long',
  100,
  [
    cam([
      [0, sph(12.5, 0.55, 0)],
      [20, sph(12.5, 12, 15)],
      [45, sph(12.5, 35, 35)],
      [70, sph(12.5, 62, 55)],
      [90, sph(12.5, 80, 70)],
      [100, sph(12.5, 84, 80)],
    ]),
  ],
  p4(100),
);
// 3. Spin from Schwarzschild to the spin limit and back to 0.5: the shadow shifts and the ISCO moves in.
total += shot(
  'eh-long-spin',
  'long',
  60,
  [
    cam([
      [0, near, nearT],
      [60, [-0.35, 0.9, 11.2], nearT],
    ]),
    prop('spin', [
      [0, 0],
      [6, 0],
      [28, 0.998],
      [38, 0.998],
      [56, 0.5],
      [60, 0.5],
    ]),
  ],
  p4(60),
);
// 4. Accretion and turbulence rise, two hot spots spiral in.
total += shot(
  'eh-long-accretion',
  'long',
  50,
  [
    cam([
      [0, [-0.7, 1.2, 12.6], nearT],
      [50, [0.4, 1.05, 11.6], nearT],
    ]),
    prop('accretion', [
      [0, 0.35],
      [30, 1.5],
      [50, 1.5],
    ]),
    prop('turbulence', [
      [0, 0],
      [30, 1],
      [50, 1],
    ]),
    prop('flareAge', [
      [0, -12],
      [26, 14],
      [26.01, -2],
      [50, 22],
    ]),
  ],
  { open: 0, flare: 15, late: 35, end: 49.9 },
);
// 5. Light paths seen from the side: the fan builds, then the camera swings round it.
total += shot(
  'eh-long-geodesics',
  'long',
  70,
  [
    cam([
      [0, [26, 3, 0]],
      [35, [24, 5, 9]],
      [70, [20, 8, 16]],
    ]),
    prop('paths', [
      [0, 0],
      [4, 0],
      [24, 24],
      [70, 24],
    ]),
    prop('accretion', [
      [0, 0.8],
      [70, 0.8],
    ]),
    prop('jet', [
      [0, 0.2],
      [70, 0.2],
    ]),
  ],
  p4(70),
);
// 6. The redshift map, orbiting.
total += shot(
  'eh-long-redshift',
  'long',
  45,
  [
    cam([
      [0, sph(12.2, 5, -10)],
      [45, sph(12.2, 9, 40)],
    ]),
    step('view', [0, 3], [0, 1], 45),
  ],
  p3(45),
);
// 7. Beaming, then the observed temperature.
total += shot(
  'eh-long-beaming',
  'long',
  45,
  [
    cam([
      [0, sph(12.4, 6, 30)],
      [45, sph(12.4, 10, 70)],
    ]),
    step('view', [0, 2, 23], [0, 2, 3], 45),
  ],
  { open: 0, beaming: 12, temperature: 34, end: 44.9 },
);
// 8. Image orders, edge on.
total += shot(
  'eh-long-orders',
  'long',
  40,
  [
    cam([
      [0, [0, 0.12, 12.5]],
      [40, [1.6, 0.3, 12.4]],
    ]),
    step('view', [0, 2], [0, 4], 40),
  ],
  p3(40),
);
// 9. Before and after the footprint filter: point sampled and filtered every 10 s.
total += shot(
  'eh-long-before-after',
  'long',
  40,
  [
    cam([
      [0, [-0.6, 1.0, 11.6], nearT],
      [40, [-0.3, 0.85, 10.6], nearT],
    ]),
    prop('turbulence', [
      [0, 1],
      [40, 1],
    ]),
    step('prefilter', [0, 10, 20, 30], [0, 1, 0, 1], 40),
  ],
  { before: 5, after: 15, 'before-again': 25, end: 39.9 },
);
// 10. Down the jet from above the pole.
total += shot(
  'eh-long-jet',
  'long',
  45,
  [
    cam([
      [0, [0.3, 9.5, 6.2]],
      [45, [0.2, 13.5, 2.6]],
    ]),
    prop('jet', [
      [0, 0.4],
      [20, 1],
      [45, 1],
    ]),
  ],
  p3(45),
);
// 11. Skimming the inner rim.
total += shot(
  'eh-long-rim',
  'long',
  50,
  [
    cam([
      [0, [-2.1, 0.52, 6.4], [-0.35, 0, 0]],
      [25, [-4.2, 0.42, 5.2], [-0.3, 0, 0.1]],
      [50, [-6.0, 0.36, 2.6], [-0.2, 0, 0.2]],
    ]),
  ],
  p3(50),
);
// 12. The plunge from 12 to 1.6 r_s.
total += shot(
  'eh-long-plunge',
  'long',
  40,
  [
    cam([
      [0, [-0.55, 0.95, 11.8]],
      [20, [-0.33, 0.57, 6.8]],
      [34, [-0.15, 0.25, 3.0]],
      [40, [-0.08, 0.13, 1.6]],
    ]),
  ],
  { open: 0, half: 20, close: 34, end: 39.9 },
);
// Shorts, 1080 x 1920 at 60 fps; a wider vertical field so the disk fits the narrow frame.
const tall = 62;
shot(
  'eh-short-approach',
  'short',
  30,
  [
    cam([
      [0, [-6, 5, 110], [0, 0, 0], tall],
      [18, [-2.2, 2.4, 34], [0, 0, 0], tall],
      [30, [-0.9, 1.4, 16], nearT, tall],
    ]),
  ],
  p3(30),
);
shot(
  'eh-short-fix',
  'short',
  24,
  [
    cam([
      [0, [-0.6, 1.0, 13.5], nearT, tall],
      [24, [-0.4, 0.9, 12.5], nearT, tall],
    ]),
    prop('turbulence', [
      [0, 1],
      [24, 1],
    ]),
    step('prefilter', [0, 6, 12, 18], [0, 1, 0, 1], 24),
  ],
  { before: 3, after: 9, 'before-again': 15, end: 23.9 },
);
shot(
  'eh-short-maps',
  'short',
  24,
  [
    cam([
      [0, [-0.6, 1.0, 13.5], nearT, tall],
      [24, [0.5, 1.1, 13.2], nearT, tall],
    ]),
    step('view', [0, 6, 12, 18], [0, 1, 2, 3], 24),
  ],
  { beauty: 3, redshift: 9, beaming: 15, temperature: 21 },
);
console.log(`long footage ${total} s`);
