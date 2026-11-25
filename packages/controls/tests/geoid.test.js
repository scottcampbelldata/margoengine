// @margoengine/controls/geoid: the bilinear grid lookup, int16 packing, the loader and the EGM96 check values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EGM96_COLUMNS, EGM96_FILE, EGM96_ROWS, Geoid, loadEGM96, packGeoid } from '../dist/geoid.js';

const rad = (d) => (d * Math.PI) / 180;
// A synthetic world grid at 90 degree spacing: 3 rows (90, 0, -90) x 5 columns (0..360), height = row * 10 + column.
const synthetic = () =>
  new Geoid({
    data: Float64Array.from({ length: 15 }, (_, i) => Math.floor(i / 5) * 10 + (i % 5)),
    rows: 3,
    columns: 5,
    step: 90,
    scale: 1,
  });

test('grid nodes are exact, between them bilinear, longitude wraps and latitude clamps', () => {
  const g = synthetic();
  assert.equal(g.undulation(rad(90), rad(0)), 11);
  assert.equal(g.undulation(rad(45), rad(45)), 5.5); // the four nodes 0, 1, 10, 11
  assert.equal(g.undulation(rad(-90), rad(0)), 13, 'west of 0 wraps to 270 E');
  assert.equal(g.undulation(rad(360), rad(0)), g.undulation(0, 0));
  assert.equal(g.undulation(0, rad(100)), g.undulation(0, rad(90)), 'past the pole clamps');
  assert.ok(Number.isNaN(g.undulation(Number.NaN, 0)));
  assert.throws(() => new Geoid({ data: new Int16Array(3), rows: 2, columns: 2 }), RangeError);
});

test('packGeoid rounds to centimetres and refuses what int16 cannot hold', () => {
  assert.deepEqual([...packGeoid([-107.004, 0.004, 85.4449])], [-10700, 0, 8544]);
  assert.throws(() => packGeoid([400]), RangeError);
  assert.throws(() => packGeoid([1], 0), RangeError);
  const g = new Geoid({
    data: packGeoid([1.25, 1.25, -2.5, -2.5]),
    rows: 2,
    columns: 2,
    step: 180,
    north: 90,
    west: -180,
  });
  assert.ok(Math.abs(g.undulation(0, 0) + 0.625) < 1e-12);
});

// The packed grid lives at packages/controls/data/egm96-15.bin (copied into dist by the build); it is made from NGA's
// WW15MGH.GRD by scripts/geoid/pack-egm96.mjs. Check values: NGA's EGM96 test points (INTPT.DAT / OUTINTPT.DAT).
const grid = fileURLToPath(new URL(`../data/${EGM96_FILE}`, import.meta.url));
test(`EGM96: NGA check values from ${EGM96_FILE}, or a coded error naming how to make it`, async () => {
  if (!existsSync(grid)) {
    await assert.rejects(
      loadEGM96({ url: pathToFileURL(grid) }),
      (e) => e.code === 'failed' && /pack-egm96/.test(e.message),
    );
    return;
  }
  const g = await loadEGM96({ url: pathToFileURL(grid) });
  assert.equal(EGM96_ROWS * EGM96_COLUMNS, 1038961);
  // NGA interpolates with a bicubic spline; bilinear on the 15' grid stays within a few centimetres of it.
  for (const [lat, lon, n] of [
    [38.628155, 269.779155, -31.629],
    [-14.621217, 305.021114, -2.966],
    [46.874319, 102.448729, -43.572],
    [-23.617446, 133.874712, 15.868],
    [38.625473, 359.9995, 50.065],
    [-0.466744, 0.0023, 17.33],
  ])
    assert.ok(
      Math.abs(g.undulation(rad(lon), rad(lat)) - n) < 0.1,
      `${lat}, ${lon}: ${g.undulation(rad(lon), rad(lat))} vs ${n}`,
    );
});

test('GeospatialControls loads EGM96 on the first sea-level read: a geoid event, or one geoid-error when it is not installed', async () => {
  const { GeospatialControls } = await import('../dist/geospatial.js'),
    { FakeElement, camera } = await import('./control-fakes.js'),
    make = (options) => new GeospatialControls(camera(), new FakeElement(), { clipPlanes: false, ...options }),
    installed = existsSync(fileURLToPath(new URL(`../dist/${EGM96_FILE}`, import.meta.url))),
    c = make({ view: { longitude: rad(-84.5), latitude: rad(45.8), range: 3000 } }),
    events = [];
  c.addEventListener('geoid', (e) => events.push(e.type));
  c.addEventListener('geoid-error', (e) => events.push(`${e.type}: ${e.error.message}`));
  assert.equal(c.heights.seaLevel, null, 'null until the grid is in');
  c.heights;
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(events.length, 1, events.join('; '));
  if (installed) assert.ok(typeof c.heights.seaLevel === 'number');
  else assert.match(events[0], /^geoid-error: .*pack-egm96/);
  // geoid: null never loads; your own query is used as it is.
  const none = make({ geoid: null });
  none.addEventListener('geoid-error', () => assert.fail('no load expected'));
  assert.equal(none.heights.seaLevel, null);
  assert.ok(
    Math.abs(make({ geoid: () => 10 }).heights.seaLevel - (make({ geoid: null }).heights.ellipsoid - 10)) < 1e-6,
  );
  c.dispose();
  none.dispose();
});
