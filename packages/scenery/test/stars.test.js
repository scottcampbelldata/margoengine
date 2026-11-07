// @margoengine/scenery/stars: the galactic frame against the Hipparcos definition (ESA 1997, Vol. 1, 1.5.3), the band's
// shape, the options and the draw. That the band lands where this maths puts it on screen, with the radiance it should
// have, is proved on a real GPU by scenery-check.mjs (stars).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MargoError } from '@margoengine/math/errors';
import { AstroSky, skyMatrix } from '@margoengine/sky/astro';
import { degrees } from '@margoengine/sky/sun';
import { MilkyWay, galacticCoordinates, milkyWayBrightness } from '../dist/stars.js';
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
  assert.equal(h.engine.plugins?.has?.('scenery:milky-way') ?? false, false);
});
