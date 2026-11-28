// @margoengine/sky/milky-way: the galactic frame against the Hipparcos definition (ESA 1997, Vol. 1, 1.5.3), the band's
// shape, the options and the draw. That the band lands where this maths puts it on screen, with the radiance it should
// have, is proved on a real GPU by night-check.mjs (stars).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MargoError } from '@margoengine/math/errors';
import { AstroSky, skyMatrix } from '@margoengine/sky/astro';
import { degrees } from '@margoengine/sky/sun';
import {
  MilkyWay,
  galacticCoordinates,
  galacticDirection,
  galacticOfDirection,
  milkyWayBrightness,
  nearInfraredColor,
  parsePointSources,
  pointSourceLook,
} from '../dist/milky-way.js';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const near = (actual, expected, bound, what) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${what}: ${actual} against ${expected}, bound ${bound}`);
const observer = { latitude: degrees(-30), longitude: degrees(20) },
  date = new Date('2026-06-20T22:00:00Z'),
  rad = Math.PI / 180;
// The world direction of a J2000 right ascension and declination: the sky matrix times its unit vector.
const world = (ra, dec) => {
  const m = skyMatrix(date, observer, { deltaT: 69 }),
    p = [Math.cos(dec * rad) * Math.cos(ra * rad), Math.cos(dec * rad) * Math.sin(ra * rad), Math.sin(dec * rad)];
  return [0, 1, 2].map((r) => m[r * 3] * p[0] + m[r * 3 + 1] * p[1] + m[r * 3 + 2] * p[2]);
};

test('galactic coordinates follow the Hipparcos definition', () => {
  // The galactic centre (l 0, b 0) at J2000 RA 266.40499, Dec -28.93617 and the north galactic pole at RA 192.85948,
  // Dec 27.12825 (ESA 1997, Vol. 1, 1.5.3).
  const centre = galacticCoordinates(world(266.40499, -28.93617), date, observer, { deltaT: 69 });
  near(Math.min(centre.l, 360 - centre.l), 0, 1e-4, 'centre l');
  near(centre.b, 0, 1e-4, 'centre b');
  near(galacticCoordinates(world(192.85948, 27.12825), date, observer, { deltaT: 69 }).b, 90, 1e-3, 'pole b');
  // Deneb (RA 310.358, Dec 45.280) lies in the plane at l about 84.3, b about 2.0.
  const deneb = galacticCoordinates(world(310.35798, 45.28034), date, observer, { deltaT: 69 });
  near(deneb.l, 84.28, 0.05, 'Deneb l');
  near(deneb.b, 2.0, 0.05, 'Deneb b');
  assert.throws(() => galacticCoordinates([0, 0, 0], date, observer), TypeError);
  assert.throws(() => galacticCoordinates([0, 1, 0], date, { latitude: 30, longitude: 0 }), TypeError);
});

test('the band: bright about the centre, darkened by the rift, thin at the poles', () => {
  near(milkyWayBrightness(0, -4), 0.66, 0.01, 'Sagittarius cloud');
  // The rift dims the plane itself toward the centre, so the cloud just south of it outshines it.
  assert.ok(milkyWayBrightness(0, 0) < 0.6 * milkyWayBrightness(0, -4));
  assert.ok(milkyWayBrightness(30, 1) < milkyWayBrightness(30, -5), 'Aquila rift');
  // Away from the rift the plane is brightest on it, falling with latitude and away from the centre.
  assert.ok(milkyWayBrightness(-60, 0) > milkyWayBrightness(-60, 10));
  assert.ok(milkyWayBrightness(-60, 0) > milkyWayBrightness(180, 0));
  assert.ok(milkyWayBrightness(180, 0) > 0.15, 'the anticentre still shows');
  assert.ok(milkyWayBrightness(0, 90) < 1e-4 && milkyWayBrightness(0, -90) < 1e-4, 'poles');
  // Longitude wraps.
  near(milkyWayBrightness(-60, 3), milkyWayBrightness(300, 3), 1e-12, 'wrap');
  let peak = 0;
  for (let l = -180; l < 180; l += 1)
    for (let b = -90; b <= 90; b += 0.5) peak = Math.max(peak, milkyWayBrightness(l, b));
  // The brightest place is the plane where the rift ends (l -12), 0.75 of the undimmed centre.
  near(peak, milkyWayBrightness(-12, 0), 1e-12, 'peak');
  near(peak, 0.746, 0.001, 'peak');
});

test('invalid options throw', () => {
  assert.throws(() => new MilkyWay({}), /astro \(AstroSky\) or a latitude and longitude/);
  assert.throws(() => new MilkyWay({ ...observer, surfaceBrightness: 10 }), RangeError);
  assert.throws(() => new MilkyWay({ ...observer, clouds: 2 }), RangeError);
  assert.throws(() => new MilkyWay({ ...observer, seed: 1.5 }), RangeError);
  assert.throws(() => new MilkyWay({ ...observer, date: new Date(NaN) }), TypeError);
  assert.throws(() => new MilkyWay({ astro: {} }), /must be an AstroSky/);
  const band = new MilkyWay({ ...observer });
  band.options.brightness = -1;
  assert.throws(() => band.onPreUpdate(), RangeError);
  // WebGL: unsupported; after dispose: disposed.
  assert.throws(
    () => new MilkyWay({ ...observer }).setup({}),
    (e) => e instanceof MargoError && e.code === 'unsupported',
  );
  const gone = new MilkyWay({ ...observer });
  gone.dispose();
  assert.throws(
    () => gone.setup({ gpu: {} }),
    (e) => e instanceof MargoError && e.code === 'disposed',
  );
});

test('the band follows its AstroSky and fades in with the night', () => {
  const sky = { options: { night: {} }, nightFactor: 1 },
    astro = new AstroSky({ ...observer, date, timeScale: 60, sky, extinction: 0.3, brightness: 7 }),
    band = new MilkyWay({ astro });
  astro.onPreUpdate(10);
  assert.equal(band.date.getTime(), astro.date.getTime());
  sky.nightFactor = 0.25;
  assert.equal(band.night(), 0.25);
  // Without a sky: the sun's depression, 1 well after dusk and 0 by day.
  assert.equal(new MilkyWay({ ...observer, date }).night(), 1);
  assert.equal(new MilkyWay({ ...observer, date: new Date('2026-06-20T10:00:00Z') }).night(), 0);

  const h = tracedGPU();
  h.engine.use(band);
  const draws = () => h.commands().filter((c) => c.startsWith('draw 6 '));
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  assert.deepEqual(draws(), ['draw 6 1']);
  // By day nothing is drawn.
  sky.nightFactor = 0;
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  assert.deepEqual(draws(), ['draw 6 1']);
  band.dispose();
  assert.equal(h.engine.plugins?.has?.('sky:milky-way') ?? false, false);
});

test('MilkyWay horizon false shows the band by day and below the horizon, as from space', () => {
  const day = new Date('2026-06-20T10:00:00Z'),
    band = new MilkyWay({ ...observer, date: day, horizon: false });
  assert.equal(band.night(), 1);
  assert.equal(new MilkyWay({ ...observer, date: day }).night(), 0);
  const h = tracedGPU();
  h.engine.use(band);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  assert.deepEqual(
    h.commands().filter((c) => c.startsWith('draw 6 ')),
    ['draw 6 1'],
  );
  assert.equal(band.values[36], 1);
  assert.throws(() => new MilkyWay({ ...observer, horizon: 1 }), /horizon/);
  band.dispose();
});

test('galacticDirection puts the galactic centre at -z, the north galactic pole up and l 90 to the left', () => {
  const pole = galacticDirection(192.85948, 27.12825),
    centre = galacticOfDirection(galacticDirection(266.41683, -29.00781)),
    l90 = galacticDirection(318.0044, 48.3299);
  near(pole[1], 1, 1e-6, 'pole y');
  near(l90[0], -1, 1e-4, 'l 90 is -x');
  // Sagittarius A* lies at l 359.944, b -0.046 (Reid and Brunthaler, ApJ 616, 2004).
  near(((centre.l + 180) % 360) - 180, -0.056, 0.01, 'Sgr A* l');
  near(centre.b, -0.046, 0.01, 'Sgr A* b');
  for (const [ra, dec] of [
    [10, 20],
    [200, -60],
    [359, 89],
  ]) {
    const back = galacticOfDirection(galacticDirection(ra, dec));
    const d = galacticDirection(ra, dec),
      sky = galacticOfDirection([d[0] * 3, d[1] * 3, d[2] * 3]);
    near(back.l, sky.l, 1e-9, 'scale free l');
    assert.ok(back.l >= 0 && back.l < 360 && Math.abs(back.b) <= 90);
  }
  const out = new Float32Array(6);
  assert.equal(galacticDirection(192.85948, 27.12825, out, 3), out);
  near(out[4], 1, 1e-6, 'written at the offset');
  assert.throws(() => galacticDirection(NaN, 0), TypeError);
  assert.throws(() => galacticOfDirection([0, 0, 0]), TypeError);
  // KB1867b: galacticDirection's Float32Array output goes straight back in (the README's example failed its type check).
  const single = galacticOfDirection(galacticDirection(266.41683, -29.00781, new Float32Array(3))),
    double = galacticOfDirection(galacticDirection(266.41683, -29.00781));
  assert.ok(Math.abs(((single.l - double.l + 540) % 360) - 180) < 1e-4 && Math.abs(single.b - double.b) < 1e-4);
  assert.throws(() => galacticOfDirection(new Float32Array(2)), TypeError);
});

test('nearInfraredColor reddens along the dwarf sequence and behind dust past M5', () => {
  const ratio = (jk) => nearInfraredColor(jk)[0] / nearInfraredColor(jk)[2];
  let last = 0;
  for (const jk of [-0.3, -0.1, 0, 0.16, 0.31, 0.5, 0.72, 0.9, 1.1, 1.2]) {
    const r = ratio(jk);
    assert.ok(r > last, `J-Ks ${jk} is redder than the one before`);
    last = r;
    near(Math.max(...nearInfraredColor(jk)), 1, 1e-12, 'peak 1');
  }
  // A0 (J-K 0, B-V 0) is bluish white, as starColor(0) gives.
  assert.ok(nearInfraredColor(0)[2] >= nearInfraredColor(0)[0]);
  // Two magnitudes of J-K excess is A_V 11.8: green falls to a fifth of red and blue below a fiftieth.
  const hidden = nearInfraredColor(2.9);
  assert.ok(hidden[0] === 1 && hidden[1] < 0.3 && hidden[2] < 0.02, `dust-hidden source ${hidden}`);
  assert.ok(
    nearInfraredColor(0.6, 2)[0] - nearInfraredColor(0.6, 2)[2] > nearInfraredColor(0.6)[0] - nearInfraredColor(0.6)[2],
  );
  assert.throws(() => nearInfraredColor(0, 3.5), RangeError);
  assert.deepEqual(nearInfraredColor(NaN), [1, 1, 1]);
});

test('parsePointSources reads 12-byte records onto the sphere and refuses partial or off-sky ones', () => {
  const bytes = new ArrayBuffer(24),
    view = new DataView(bytes);
  view.setFloat32(0, 192.85948, true);
  view.setFloat32(4, 27.12825, true);
  view.setInt16(8, 850, true);
  view.setInt16(10, 6420, true);
  view.setFloat32(12, 266.405, true);
  view.setFloat32(16, -28.936, true);
  view.setInt16(20, -120, true);
  view.setInt16(22, 14999, true);
  const s = parsePointSources(bytes, { radius: 40 });
  assert.equal(s.count, 2);
  near(s.positions[1], 40, 1e-4, 'pole at the radius');
  near(s.positions[5], -40, 1e-2, 'centre at -z');
  near(s.colorIndex[0], 0.85, 1e-6, 'J-Ks');
  near(s.magnitude[1], 14.999, 1e-6, 'Ks');
  assert.equal(parsePointSources(new Uint8Array(bytes, 12, 12)).count, 1, 'a view reads from its offset');
  assert.throws(
    () => parsePointSources(new ArrayBuffer(13)),
    (e) => e instanceof MargoError && e.code === 'failed',
  );
  view.setFloat32(4, 91, true);
  assert.throws(() => parsePointSources(bytes), /off the sky/);
  assert.throws(() => parsePointSources(new ArrayBuffer(0), { radius: 0 }), RangeError);
});

test('pointSourceLook brightens and grows the brighter sources and caps the brightest', () => {
  const sources = { count: 3, colorIndex: new Float32Array([0.3, 0.3, 0.3]), magnitude: new Float32Array([2, 6, 11]) };
  const { colors, sizes } = pointSourceLook(sources, { brightness: 4, compression: 0.5 });
  const light = (i) => Math.max(colors[i * 4], colors[i * 4 + 1], colors[i * 4 + 2]);
  near(light(1), 4, 1e-5, 'reference magnitude');
  near(light(0), 4 * Math.min(4, 10 ** 0.8), 1e-4, 'capped at four times');
  near(light(2), 4 * 10 ** -1, 1e-5, 'five magnitudes fainter at compression 0.5');
  assert.ok(sizes[0] === 3 && sizes[1] === 3 && sizes[2] < sizes[1] && sizes[2] > 1);
  assert.equal(colors[3], 1);
  assert.throws(() => pointSourceLook(sources, { compression: 0.1 }), RangeError);
});

test('pointSourceLook saturation keeps luminance while no channel clips, and spreads the channels', () => {
  const sources = { count: 1, colorIndex: new Float32Array([0.6]), magnitude: new Float32Array([6]) };
  const plain = pointSourceLook(sources).colors,
    rich = pointSourceLook(sources, { saturation: 1.5 }).colors,
    grey = pointSourceLook(sources, { saturation: 0 }).colors;
  const y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(rich[2] > 0, 'no channel clips');
  near(y(rich), y(plain), 1e-5, 'luminance kept');
  assert.ok(rich[0] - rich[2] > plain[0] - plain[2], 'redder');
  near(grey[0], grey[2], 1e-6, 'grey at 0');
  assert.throws(() => pointSourceLook(sources, { saturation: 4 }), RangeError);
});
