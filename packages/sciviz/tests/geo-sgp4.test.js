import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SGP4, parseTLE, parseOMM, satelliteGeodetic } from '../dist/geo-time.js';
// Vallado et al. (2006), Appendix D/E. Published data, not companion implementation code.
const cases = [
  [
    'Molniya',
    '1 08195U 75081A   06176.33215444  .00000099  00000-0  11873-3 0   813',
    '2 08195  64.1586 279.0717 6877146 264.7651  20.2257  2.00491383225656',
    [
      [0, [2349.8948335, -14785.93811562, 0.02119378], [2.721488096, -3.256811655, 4.498416672]],
      [120, [15223.91713658, -17852.95881713, 25280.39558224], [1.079041732, 0.875187372, 2.485682813]],
      [2880, [3417.20931586, -16038.79510665, 1894.74934058], [2.585515864, -2.596818146, 4.456882556]],
    ],
  ],
  [
    'Molniya high e',
    '1 09880U 77021A   06176.56157475  .00000421  00000-0  10000-3 0  9814',
    '2 09880  64.5968 349.3786 7069051 270.0229  16.3320  2.00813614112380',
    [[2880, [15500.53445068, -1332.90981042, 3419.72315308], [2.960917974, 1.758331634, 4.813698638]]],
  ],
  [
    'synchronous',
    '1 24208U 96044A   06177.04061740 -.00000094  00000-0  10000-3 0  1600',
    '2 24208   3.8536  80.0121 0026640 311.0977  48.3000  1.00778054 36119',
    [
      [0, [7534.10987189, 41266.39266843, -0.10801028], [-3.027168008, 0.558848996, 0.207982755]],
      [1080, [41365.67576837, -6298.09965811, -2828.05254033], [0.459741276, 3.051680214, 0.006431872]],
    ],
  ],
  [
    'Vanguard',
    '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
    '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
    [
      [0, [7022.46529266, -1400.08296755, 0.03995155], [1.893841015, 6.405893759, 4.53480725]],
      [360, [-7154.03120202, -3783.17682504, -3536.19412294], [4.741887409, -4.151817765, -2.093935425]],
      [4320, [-9060.47373569, 4658.70952502, 813.68673153], [-2.232832783, -4.11045349, -3.157345433]],
    ],
  ],
  [
    'Lyddane',
    '1 04632U 70093B   04031.91070959 -.00000084  00000-0  10000-3 0  9955',
    '2 04632  11.4628 273.1101 1450506 207.6000 143.9350  1.20231981 44145',
    [
      [0, [2334.11450085, -41920.44035349, -0.03867437], [2.826321032, -0.065091664, 0.570936053]],
      [-5184, [-29020.02587128, 13819.84419063, -5713.33679183], [-1.76806839, -3.235371192, -0.395206135]],
    ],
  ],
  [
    'drag',
    '1 06251U 62025E   06176.82412014  .00008885  00000-0  12808-3 0  3985',
    '2 06251  58.0579  54.0425 0030035 139.1568 221.1854 15.56387291  6774',
    [
      [0, [3988.31022699, 5498.96657235, 0.90055879], [-3.290032738, 2.35765282, 6.496623475]],
      [2880, [1159.27802897, 5056.60175495, 4353.49418579], [-5.968060341, -2.314790406, 4.230722669]],
    ],
  ],
];
for (const [name, one, two, vectors] of cases)
  test(`SGP4 ${name} matches published TEME vectors`, () => {
    const orbit = new SGP4(parseTLE(one, two));
    for (const [time, position, velocity] of vectors) {
      const state = orbit.propagate(time);
      const dp = Math.hypot(...position.map((v, i) => state.position[i] - v));
      const dv = Math.hypot(...velocity.map((v, i) => state.velocity[i] - v));
      assert.ok(dp < 0.0001, `${name} ${time}: position ${dp} km, actual ${state.position}`);
      assert.ok(dv < 1e-7, `${name} ${time}: velocity ${dv} km/s`);
      assert.deepEqual(orbit.at(orbit.elements.epoch + time * 60000), state);
    }
  });
test('OMM preserves large catalog IDs and checks coordinate frame; TLE checks identity and checksum', () => {
  const record = {
    NORAD_CAT_ID: 100005,
    EPOCH: '2026-11-09T20:27:37.448064',
    INCLINATION: 51.6,
    RA_OF_ASC_NODE: 30,
    ECCENTRICITY: 0.0007,
    ARG_OF_PERICENTER: 10,
    MEAN_ANOMALY: 40,
    MEAN_MOTION: 15.5,
    BSTAR: 0.0001,
  };
  assert.equal(parseOMM(record).id, '100005');
  for (const value of [null, false, '', '   ']) assert.throws(() => parseOMM({ ...record, INCLINATION: value }));
  assert.throws(() =>
    parseTLE(cases[0][1], cases[0][2].slice(0, 8) + '        ' + cases[0][2].slice(16), { checksum: false }),
  );
  assert.throws(() => parseOMM({ ...record, REF_FRAME: 'GCRF' }));
  assert.throws(() => parseTLE(cases[0][1].slice(0, 68) + '1', cases[0][2]));
  const orbit = new SGP4(parseOMM(record));
  assert.throws(() => orbit.propagate(Infinity));
  assert.throws(() => orbit.propagate(1e20));
  const a = orbit.propagate(100);
  orbit.propagate(-100);
  assert.deepEqual(a, orbit.propagate(100));
  const geo = satelliteGeodetic(a);
  assert.ok(geo.every(Number.isFinite));
  assert.ok(geo[2] > 100000);
});
const published = JSON.parse(readFileSync(new URL('./fixtures/sgp4-vallado.json', import.meta.url)));
for (const item of published)
  test(`complete published SGP4 vectors, catalog ${item.id}`, () => {
    const orbit = new SGP4(parseTLE(item.one, item.two));
    for (const [time, ...expected] of item.vectors) {
      const state = orbit.propagate(time),
        actual = [...state.position, ...state.velocity];
      const dp = Math.hypot(...actual.slice(0, 3).map((v, i) => v - expected[i]));
      const dv = Math.hypot(...actual.slice(3).map((v, i) => v - expected[i + 3]));
      assert.ok(dp < 0.0001, `${item.id} at ${time}: ${dp} km; actual ${state.position}`);
      assert.ok(dv < 1e-7, `${item.id} at ${time}: ${dv} km/s`);
    }
  });
