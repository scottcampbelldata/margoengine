// @margoengine/sky/hurricane: the Holland wind, the eye and its stadium, the spiral bands, the rain and the weather a
// hurricane makes, and the clouds, settings and weather map that draw and follow it. Each bound is a published one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Hurricane,
  HURRICANE_LAYER,
  hollandMaxWind,
  hollandPressure,
  hollandWind,
  resolveHurricane,
} from '@margoengine/sky/hurricane';
import {
  VolumetricClouds,
  cloudLayerFor,
  layerOf,
  loadStormField,
  writeLayer,
  CLOUD_FLOATS,
} from '@margoengine/sky/volumetric-clouds';
import { applySkySettings, SKY_SETTINGS } from '@margoengine/sky/settings';
import { Sky } from '@margoengine/sky';
import { WeatherRegions } from '@margoengine/weather/regions';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

// The radius where a profile peaks, scanned at 10 m.
const peakOf = (wind, from, to) => {
  let best = -1,
    at = 0;
  for (let r = from; r <= to; r += 10) {
    const v = wind(r);
    if (v > best) [best, at] = [v, r];
  }
  return { speed: best, radius: at };
};

test('Holland 1980: the gradient wind peaks at the radius of maximum wind at sqrt(B dp / (rho e))', () => {
  for (const options of [
    {},
    { pressureDrop: 100, maxWindRadius: 15000, holland: 2.2 },
    { pressureDrop: 20, maxWindRadius: 80000, holland: 1 },
  ]) {
    // Without the Coriolis term (latitude 1 degree, f 2.5e-6) the peak is at R exactly and is the cyclostrophic maximum.
    const near = resolveHurricane({ ...options, latitude: 1 }),
      peak = peakOf((r) => hollandWind(r, near), 1000, 300000);
    assert.ok(Math.abs(peak.radius / near.rmax - 1) < 0.01, `peak at ${peak.radius} m, R ${near.rmax}`);
    assert.ok(
      Math.abs(peak.speed / hollandMaxWind(near) - 1) < 0.01,
      `peak ${peak.speed} against ${hollandMaxWind(near)}`,
    );
    // At 20 degrees the Coriolis term moves the peak just inside R and lowers it a little.
    const s = resolveHurricane(options),
      p20 = peakOf((r) => hollandWind(r, s), 1000, 300000);
    assert.ok(p20.radius <= s.rmax && p20.radius > 0.85 * s.rmax, `peak at ${p20.radius} m at 20 degrees`);
    assert.ok(p20.speed < peak.speed && p20.speed > 0.9 * peak.speed);
    // Pressure: pc at the centre, pc + dp / e at R, the ambient 1010 hPa far out.
    const dp = s.dp / 100;
    assert.ok(Math.abs(hollandPressure(0, s) - (1010 - dp)) < 1e-9);
    assert.ok(Math.abs(hollandPressure(s.rmax, s) - (1010 - dp + dp / Math.E)) < 1e-9);
    assert.ok(Math.abs(hollandPressure(1e10, s) - 1010) < 0.01);
  }
  // The default storm: 60 hPa, B 1.5, rho 1.15 gives a 53.7 m/s gradient peak, a strong category 3 at the surface.
  assert.ok(Math.abs(hollandMaxWind(resolveHurricane()) - 53.66) < 0.05);
  assert.equal(hollandWind(0), 0);
});

test('the bands are logarithmic spirals crossing a circle at the band pitch (Senn and Hiser: 10 to 25 degrees)', () => {
  assert.equal(resolveHurricane().pitch, (15 * Math.PI) / 180, 'the default pitch, 15 degrees, lies in 10 to 25');
  for (const [pitch, latitude] of [
    [15, 20],
    [22, 20],
    [10, -25],
  ]) {
    const storm = new Hurricane({ bandPitch: pitch, latitude, bands: 4, principalBand: 0 }),
      k = Math.tan((pitch * Math.PI) / 180),
      step = (2 * Math.PI * k) / 4,
      start = 75000 * Math.exp(Math.round(Math.log(2) / step) * step),
      points = [];
    // For each angle, the radius of the band's crest on one turn of it, from the crest near 150 km at angle 0.
    for (let theta = 0; theta < 1.2; theta += 0.05) {
      let best = 0,
        at = 0;
      const guess = start * Math.exp(-Math.sign(latitude) * k * theta);
      for (let r = guess * 0.9; r < guess * 1.1; r += 20) {
        const c = storm.coverAt(r * Math.cos(theta), -r * Math.sin(theta)).band;
        if (c > best) [best, at] = [c, r];
      }
      assert.ok(best > 0.6, `a band crest at angle ${theta}: ${best}`);
      points.push([theta, Math.log(at)]);
    }
    // ln r against the angle is a line of slope -tan(pitch) (north, inward anticlockwise) or +tan(pitch) (south).
    const n = points.length,
      mx = points.reduce((a, p) => a + p[0], 0) / n,
      my = points.reduce((a, p) => a + p[1], 0) / n,
      slope =
        points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / points.reduce((a, p) => a + (p[0] - mx) ** 2, 0),
      measured = (Math.atan(Math.abs(slope)) * 180) / Math.PI;
    assert.ok(Math.abs(measured - pitch) < 0.5, `pitch ${measured} against ${pitch}`);
    assert.equal(Math.sign(slope), -Math.sign(latitude), 'the bands turn the way the storm turns');
  }
});

test('the eye is clear, and its edge leans out with height by eyeSlope (the stadium, Hazelton and Hart 2013)', () => {
  const storm = new Hurricane(),
    s = storm.resolved,
    edge = (height) => {
      for (let r = 0; r < 200000; r += 10) if (storm.coverAt(r, 0, height).eyewall >= 0.5) return r;
      return NaN;
    };
  assert.equal(s.eye, 21000, 'the eye is 0.7 of the radius of maximum wind');
  assert.equal(s.slope, 1.2, 'inverse slope 1.2, inside the 1 to 1.5 peak');
  const low = edge(0),
    high = edge(10000);
  assert.ok(Math.abs(low - s.eye) < 100, `edge at the base ${low}`);
  assert.ok(Math.abs(high - low - 12000) < 200, `the edge moved out ${high - low} m over 10 km`);
  // Clear above the eye's low floor cloud, at every height; the floor cloud is the eyeCloud cover near the base.
  for (const height of [3000, 8000, 14000]) assert.equal(storm.coverAt(0, 0, height).cover, 0, `eye at ${height} m`);
  assert.equal(storm.coverAt(0, 0, 300).cover, 0.25);
  assert.equal(new Hurricane({ eyeCloud: 0 }).coverAt(0, 0, 300).cover, 0);
  // The eyewall reaches the tops; the bands stop at bandTop of the layer; the canopy covers the core near the tops.
  const depth = HURRICANE_LAYER.top - HURRICANE_LAYER.bottom;
  assert.ok(storm.coverAt(30000 + 0.95 * depth * 1.2, 0, 0.95 * depth).eyewall > 0.9);
  assert.equal(storm.coverAt(150000, 0, 0.7 * depth).band, 0);
  assert.ok(storm.coverAt(60000, 0, 0.9 * depth).canopy > 0.5);
  assert.equal(new Hurricane({ eyeSlope: 0 }).coverAt(25000, 0, 10000).eyewall, storm.coverAt(25000, 0, 0).eyewall);
});

test('calm in the eye, gusts in the eyewall and bands, rain following the bands (R-CLIPER profile)', () => {
  const storm = new Hurricane(),
    eye = storm.weatherAt(0, 0),
    wall = storm.weatherAt(30000, 0);
  assert.equal(storm.regionAt(0, 0), 'eye');
  assert.equal(storm.regionAt(30000, 0), 'eyewall');
  assert.equal(storm.regionAt(50000, 0), 'moat');
  assert.equal(storm.regionAt(1e6, 0), 'outside');
  assert.ok(storm.windAt(0, 0).speed < 1 && eye.gust === 0 && eye.rain === 0, `eye ${JSON.stringify(eye)}`);
  assert.ok(storm.windAt(5000, 0).speed < 0.2 * storm.windAt(30000, 0).speed, 'the eye is calm against the eyewall');
  assert.equal(wall.gust, 1);
  assert.ok(Math.abs(storm.rainAt(30000, 0) - 50) < 0.5, 'the eyewall rains at rainMax');
  assert.ok(Math.abs(storm.windAt(30000, 0).gust / storm.windAt(30000, 0).speed - (1 + 0.23 * 1.5)) < 1e-9);
  // Along a circle outside the moat: the rain and the gusts rise in the bands and fall between them.
  const r = 140000;
  let inBand = { rain: 0, gust: 0 },
    between = { rain: Infinity, gust: Infinity };
  for (let a = 0; a < 2 * Math.PI; a += 0.005) {
    const x = r * Math.cos(a),
      z = -r * Math.sin(a),
      b = storm.coverAt(x, z).band,
      w = storm.weatherAt(x, z);
    if (b > 0.85) inBand = { rain: Math.max(inBand.rain, storm.rainAt(x, z)), gust: Math.max(inBand.gust, w.gust) };
    if (b < 0.01) between = { rain: Math.min(between.rain, storm.rainAt(x, z)), gust: Math.min(between.gust, w.gust) };
  }
  assert.ok(inBand.rain > 3 * between.rain && inBand.gust > between.gust + 0.3, JSON.stringify({ inBand, between }));
  // Outside the eyewall the rain envelope falls as exp(-(r - rm) / re).
  const s = storm.resolved,
    rm = s.eye + 0.5 * s.wall;
  assert.ok(Math.abs(storm.rainAt(rm, 0) - 50) < 1e-9);
  // The surface wind turns in toward the centre by the inflow angle, anticlockwise in the north and clockwise south.
  for (const [latitude, turn] of [
    [20, -1],
    [-20, 1],
  ]) {
    const w = new Hurricane({ latitude }).windAt(30000, 0),
      radial = w.velocity[0] / w.speed,
      tangential = w.velocity[1] / w.speed;
    assert.ok(Math.abs(Math.asin(-radial) - (22 * Math.PI) / 180) < 1e-9, 'inflow 22 degrees');
    assert.equal(Math.sign(tangential), turn, 'north: at +X the wind blows toward -Z (anticlockwise from above)');
  }
});

test('the storm moves, has an outer eyewall, and publishes the full mean wind', () => {
  const storm = new Hurricane({ velocity: [5, 0], outerEyewall: 120000, pressureDrop: 150 });
  assert.deepEqual(storm.centerAt(3600), [18000, 0]);
  assert.equal(storm.regionAt(18000, 0, 3600), 'eye');
  assert.equal(storm.regionAt(120000, 0), 'outerEyewall');
  // A secondary wind maximum under the outer eyewall (Willoughby, Clos and Shoreibah 1982).
  assert.ok(storm.windAt(120000, 0).speed > storm.windAt(95000, 0).speed);
  const intense = storm.windAt(30000, 0).speed;
  assert.ok(intense > 60);
  assert.equal(storm.weatherAt(30000, 0).wind, intense);
  assert.equal(storm.weatherAt(1e6, 0).weight, 0);
  assert.equal(storm.weatherAt(100000, 0).weight, 1);
  for (const bad of [
    { bands: 2.5 },
    { latitude: 0 },
    { bandPitch: 50 },
    { pressureDrop: 200 },
    { center: [0] },
    { bandStart: 1000 },
    { extent: 30000 },
  ])
    assert.throws(() => new Hurricane(bad), Error, JSON.stringify(bad));
});

// The clouds' uniform written by a frame (VolumetricClouds through the traced GPU).
function frames(options) {
  const h = tracedGPU(),
    clouds = new VolumetricClouds(options),
    uniforms = [],
    write = h.engine.gpu.queue.writeBuffer.bind(h.engine.gpu.queue);
  h.engine.gpu.queue.writeBuffer = (b, offset, v, ...rest) => {
    if (v instanceof Float32Array && v.length === CLOUD_FLOATS) uniforms.push(v.slice());
    return write(b, offset, v, ...rest);
  };
  h.engine.use(clouds);
  return {
    h,
    clouds,
    frame(delta = 1) {
      clouds.onPreUpdate(delta);
      h.context.bindings = [];
      h.engine.frameGraph.execute(h.context);
      return uniforms.at(-1);
    },
  };
}

test('the clouds draw the storm: the hurricane layer, its fields in the uniform, moving with the storm', async () => {
  const field = await loadStormField();
  assert.deepEqual(cloudLayerFor({ cloud: 0.2 }, undefined, 'hurricane'), {
    coverage: 1,
    bottom: 500,
    top: 15000,
    density: 0.1,
  });
  assert.deepEqual(layerOf({ hurricane: {} }), { coverage: 1, bottom: 500, top: 15000, density: 0.1 });
  assert.equal(layerOf({ hurricane: {}, type: 'stratus' }).top, 900, 'a type set still wins');
  assert.ok(field.of({ type: 'hurricane' }) && !field.of({}), "'hurricane' alone draws the default storm");
  const { h, frame, clouds } = frames({
    hurricane: new Hurricane({ velocity: [4, -2], bands: 5, outerEyewall: 90000 }),
  });
  await clouds.ready;
  let v = frame(10);
  assert.deepEqual([v[28], v[29], v[30], v[31]], [500, 15000, 1, Math.fround(0.1)]);
  assert.deepEqual([v[64], v[65]], [40, -20], 'the centre after 10 s');
  assert.deepEqual([v[72], v[77], v[80]], [5, 1, 90000], 'bands, spin, outer eyewall');
  assert.equal(v[86], 30000);
  assert.ok(Math.abs(v[71] - Math.tan((15 * Math.PI) / 180)) < 1e-6);
  v = frame(890);
  assert.deepEqual([v[64], v[65]], [3600, -1800]);
  assert.ok(Math.abs(v[78] - 0) < 1e-6, 'the flow phase wraps every flowPeriod (900 s)');
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /fn cloudStormDensity\(/);
  assert.match(code, /if\(c\.storm\[3\]\.y!=0\.0\)\{return cloudStormDensity/);
  h.cleanup();
  // Without a storm the fields are 0 and the storm is off (storm[3].y).
  const plain = new Float32Array(CLOUD_FLOATS).fill(7);
  writeLayer(plain, {}, [0, 0, 0]);
  assert.ok(plain.subarray(64).every((x) => x === 0));
  // The storm's options are checked when its code has loaded: `ready` rejects, and a draw would throw the same.
  await assert.rejects(new VolumetricClouds({ hurricane: { bands: 12 } }).ready, RangeError);
  assert.throws(() => new VolumetricClouds({ hurricane: 3 }), TypeError);
  await assert.doesNotReject(new VolumetricClouds({}).ready, 'no storm, nothing to load');
});

test('the sun shines into the eye: the deck passes what the cloud over the camera passes', async () => {
  const h = tracedGPU(),
    sky = new Sky({ hours: 12, timeScale: 0, lighting: {} }),
    clouds = new VolumetricClouds({ sky, hurricane: {} });
  await clouds.ready;
  h.engine.use(sky);
  h.engine.use(clouds);
  h.engine.camera.position = [0, 2, 0];
  const eye = sky.deck(1);
  h.engine.camera.position = [32000, 2, 0];
  const wall = sky.deck(1);
  // The eye's floor cloud (eyeCloud 0.25) is all that dims the sun there; without it the eye passes the whole sun.
  assert.ok(eye > 0.7 && wall < 0.1, `eye ${eye}, eyewall ${wall}`);
  clouds.options.hurricane = { eyeCloud: 0 };
  h.engine.camera.position = [0, 2, 0];
  assert.ok(sky.deck(1) > 0.999, 'a clear eye passes the sun');
  h.cleanup();
});

test('the hurricane rows write the storm while the type is hurricane, and take it back after', () => {
  const rows = SKY_SETTINGS.filter((s) => s.group === 'hurricane');
  assert.equal(rows.length, 34);
  assert.ok(
    rows.every((s) => s.live),
    'every hurricane row is live',
  );
  const sky = new Sky({ timeScale: 0 }),
    clouds = { options: {} };
  applySkySettings({ sky, clouds }, { 'volumetric.type': 'hurricane' });
  assert.deepEqual(clouds.options.hurricane, {}, 'defaults write nothing but the storm');
  assert.equal(clouds.options.type, 'hurricane');
  applySkySettings(
    { sky, clouds },
    {
      'volumetric.type': 'hurricane',
      'hurricane.bands': 4.6,
      'hurricane.hemisphere': 'south',
      'hurricane.speed': 5,
      'hurricane.heading': 90,
      'hurricane.bandRotation': 180,
      'hurricane.eyeRadius': 15000,
    },
  );
  const o = clouds.options.hurricane;
  assert.equal(o.bands, 5);
  assert.equal(o.latitude, -20);
  assert.equal(o.eyeRadius, 15000);
  assert.ok(Math.abs(o.velocity[0] - 5) < 1e-12 && Math.abs(o.velocity[1]) < 1e-12);
  assert.ok(Math.abs(o.bandRotation - Math.PI) < 1e-12);
  new Hurricane(o);
  // A Hurricane given by hand takes the rows into its own options.
  const storm = new Hurricane({ pressureDrop: 80 }),
    own = { options: { hurricane: storm } };
  applySkySettings({ sky, clouds: own }, { 'volumetric.type': 'hurricane', 'hurricane.moat': 0.3 });
  assert.equal(own.options.hurricane, storm);
  assert.equal(storm.options.moat, 0.3);
  applySkySettings({ sky, clouds }, {});
  assert.equal(clouds.options.hurricane, undefined, 'the rows take back their own storm');
  assert.equal(own.options.hurricane, storm);
});

test('the weather map follows the storm: calm eye, eyewall gusts and rain, bands, blended over the base', () => {
  const storm = new Hurricane(),
    map = new WeatherRegions({ base: 'partlyCloudy', storms: [storm] }),
    eye = map.stateAt(0, 0),
    wall = map.stateAt(30000, 0),
    far = map.stateAt(2e6, 0);
  assert.equal(eye.wind, 0);
  assert.equal(eye.rain, 0);
  assert.ok(wall.wind > 45 && wall.gust === 1 && wall.rain > 0.8, JSON.stringify(wall));
  assert.ok(Math.abs(wall.windDirection - storm.windAt(30000, 0).direction) < 1e-12);
  assert.equal(far.wind, map.base.wind, 'past the extent the base weather');
  // The storm moves with the map's clock.
  const moving = new WeatherRegions({ storms: [new Hurricane({ velocity: [10, 0] })] });
  moving.time = 3000;
  assert.equal(moving.stateAt(30000, 0).wind, 0, 'the eye has arrived');
});
