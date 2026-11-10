import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  openCF,
  inspectCFField,
  readCFField,
  readCFVertical,
  cfTimeCodec,
  convertCFUnits,
  cfSampler,
  regridCF,
  conservativeCF,
  cfGridProjection,
} from '@margoengine/sciviz/cf';
import { climateProjection, wrapLongitude } from '@margoengine/sciviz/projections';
const near = (a, b, e = 1e-10) => assert.ok(Math.abs(a - b) <= e, `${a} differs from ${b} by ${Math.abs(a - b)}`);
const root = new URL('../../../examples/assets/sciviz/climate/', import.meta.url);
const attrs = (a) =>
  Object.fromEntries(
    Object.entries(a).map(([k, v]) => [k, typeof v === 'string' ? v : Float64Array.from(Array.isArray(v) ? v : [v])]),
  );
// Test metadata adapters deliberately implement ordinary NetCDF hyperslabs, not the CF algorithms under test.
function file(dimensions, description) {
  const variables = {},
    reads = [];
  for (const [name, [dims, data, attributes = {}]] of Object.entries(description))
    variables[name] = {
      name,
      type: 'double',
      dimensions: dims,
      shape: dims.map((d) => dimensions[d]),
      attributes: attrs(attributes),
      async read(s = {}) {
        s.signal?.throwIfAborted();
        reads.push({ name, ...s });
        const shape = this.shape,
          count = s.count ?? shape,
          start = s.start ?? shape.map(() => 0),
          out = new Float64Array(count.reduce((a, b) => a * b, 1));
        for (let i = 0; i < out.length; i++) {
          let q = i,
            at = 0;
          const pos = [];
          for (let d = count.length - 1; d >= 0; d--) {
            pos[d] = (q % count[d]) + start[d];
            q = Math.floor(q / count[d]);
          }
          for (let d = 0; d < shape.length; d++) at = at * shape[d] + pos[d];
          out[i] = data[at];
        }
        return out;
      },
    };
  return { variables, dimensions, attributes: {}, reads };
}
const grid = (values = [0, 10, 20, 30], extra = {}) => ({
  nx: 2,
  ny: 2,
  longitude: Float64Array.of(0, 10),
  latitude: Float64Array.of(0, 10),
  values: Float64Array.from(values),
  curvilinear: false,
  units: 'K',
  ...extra,
});

test('real ERA5 and CMIP6 CDF2 data are pinned with truthful producer terms, selected and transposed', async () => {
  const source = JSON.parse(readFileSync(new URL('source.json', root)));
  for (const record of source.files) {
    const b = readFileSync(new URL(record.file, root));
    assert.equal(b.length, record.bytes);
    assert.equal(createHash('sha256').update(b).digest('hex'), record.sha256);
  }
  using era = await openCF(readFileSync(new URL('era5.nc', root)));
  using cmip = await openCF(readFileSync(new URL('cmip6.nc', root)));
  const info = era.field('2m_temperature');
  assert.equal(info.units, 'K');
  assert.equal(info.coordinates.find((c) => c.kind === 'time').name, 'time');
  await assert.rejects(era.read('2m_temperature'), /select non-horizontal dimension time/);
  const a = await era.read('2m_temperature', { indices: { time: 0 }, units: 'degC' });
  assert.deepEqual([a.nx, a.ny, a.values.length], [64, 32, 2048]);
  const original = await era.file.variables['2m_temperature'].read({ start: [0, 0, 0], count: [1, 64, 32] });
  for (const [i, j] of [
    [0, 0],
    [10, 15],
    [63, 31],
  ])
    near(a.values[j * 64 + i], original[i * 32 + j] - 273.15);
  const time = era.file.variables.time,
    codec = cfTimeCodec(time.attributes.units, { calendar: time.attributes.calendar });
  assert.equal(codec.decode((await time.read())[0]).year, 2020);
  const b = await cmip.read('tas', { indices: { time: 0 } });
  assert.deepEqual([b.nx, b.ny], [144, 143]);
  assert.ok(b.values.every(Number.isFinite));
  const ct = cmip.file.variables.time,
    cdate = cfTimeCodec(ct.attributes.units, { calendar: ct.attributes.calendar }).decode((await ct.read())[0]);
  assert.deepEqual([cdate.year, cdate.month], [1850, 1]);
  const mapped = regridCF(a, {
    projection: climateProjection('mollweide', { radius: 1 }),
    extent: [-2.83, -1.415, 2.83, 1.415],
    width: 80,
    height: 40,
  });
  assert.ok(mapped.values.filter(Number.isFinite).length > 2000);
  assert.ok(mapped.values.filter(Number.isNaN).length > 300);
  const selected = await era.read('2m_temperature', { indices: { time: 1 } });
  assert.ok(selected.values.some((v, i) => v !== a.values[i] + 273.15));
  era.dispose();
  await assert.rejects(era.read('2m_temperature', { indices: { time: 0 } }));
});

test('CF coordinate metadata is lazy, explicit, scalar-aware and rejects ambiguity and dangling references', async () => {
  const f = file(
    { x: 2, y: 2, time: 2 },
    {
      x: [['x'], [0, 10], { units: 'degrees_east' }],
      y: [['y'], [10, 0], { units: 'degrees_north' }],
      time: [['time'], [0, 1], { units: 'days since 2001-01-01', calendar: 'noleap' }],
      height: [[], [2], { standard_name: 'height', units: 'm', positive: 'up' }],
      tas: [['time', 'x', 'y'], [1, 2, 3, 4, 5, 6, 7, 8], { coordinates: 'height', units: 'K' }],
    },
  );
  const metadata = inspectCFField(f, 'tas');
  assert.equal(f.reads.length, 0);
  assert.equal(metadata.coordinates.find((c) => c.name === 'height').kind, 'vertical');
  const data = await readCFField(f, 'tas', { indices: { time: 1 } });
  assert.deepEqual([...data.values], [5, 7, 6, 8]);
  assert.deepEqual(f.reads.find((r) => r.name === 'tas').count, [1, 2, 2]);
  await assert.rejects(readCFField(f, 'tas', { indices: { not_a_dimension: 0 } }), /invalid index/);
  f.variables.tas.attributes.coordinates = 'absent';
  assert.throws(() => inspectCFField(f, 'tas'), /missing coordinate/);
  f.variables.tas.attributes.coordinates = 'height';
  f.variables.x.attributes.bounds = 'absent';
  assert.throws(() => inspectCFField(f, 'tas'), /missing bounds/);
});

test('CF auxiliary curvilinear and projected CF coordinates map the same physical locations', async () => {
  const f = file(
    { t: 2, j: 2, i: 2 },
    {
      navlon: [
        ['t', 'j', 'i'],
        [170, 180, 172, 182, 171, 181, 173, 183],
        { standard_name: 'longitude', units: 'degrees_east' },
      ],
      navlat: [['j', 'i'], [0, 0, 10, 10], { standard_name: 'latitude', units: 'degrees_north' }],
      v: [['t', 'j', 'i'], [1, 2, 3, 4, 5, 6, 7, 8], { coordinates: 'navlon navlat', units: 'K' }],
    },
  );
  const g = await readCFField(f, 'v', { indices: { t: 1 } });
  assert.equal(g.curvilinear, true);
  near(cfSampler(g)(177, 5), 6.5);
  const mapping = file(
    {},
    {
      crs: [
        [],
        [0],
        {
          grid_mapping_name: 'lambert_conformal_conic',
          standard_parallel: [30, 60],
          longitude_of_central_meridian: 10,
          latitude_of_projection_origin: 40,
          earth_radius: 6371000,
          false_easting: 2000,
          false_northing: 3000,
        },
      ],
    },
  ).variables.crs;
  const projection = cfGridProjection(mapping),
    p = projection.forward(10, 40);
  assert.deepEqual(p, [2000, 3000]);
  const projected = file(
    { x: 2, y: 2 },
    {
      x: [['x'], [2, 3], { standard_name: 'projection_x_coordinate', units: 'km' }],
      y: [['y'], [3, 4], { standard_name: 'projection_y_coordinate', units: 'km' }],
      v: [['y', 'x'], [1, 2, 3, 4], { grid_mapping: 'crs', units: 'K' }],
    },
  );
  projected.variables.crs = mapping;
  // CF false easting/northing use the coordinate axes' units, not an assumed metre.
  mapping.attributes.false_easting = Float64Array.of(2);
  mapping.attributes.false_northing = Float64Array.of(3);
  const g2 = await readCFField(projected, 'v');
  near(g2.longitude[0], 10);
  near(g2.latitude[0], 40);
  assert.equal(g2.curvilinear, true);
});

test('CF units preserve dimensional algebra, temperature differences and masks, rejecting incompatible units', () => {
  near(convertCFUnits([273.15], 'K', 'degC')[0], 0);
  near(convertCFUnits([32], 'degF', 'K')[0], 273.15);
  near(convertCFUnits([10], 'degC', 'K', { temperatureDifference: true })[0], 10);
  near(convertCFUnits([1000], 'hPa', 'Pa')[0], 100000);
  near(convertCFUnits([1], 'kg m-2 s-1', 'g cm-2 s-1')[0], 0.1);
  near(convertCFUnits([1], 'W m**-2', 'kg s-3')[0], 1);
  assert.ok(Number.isNaN(convertCFUnits([NaN], 'K', 'degC')[0]));
  assert.throws(() => convertCFUnits([1], 'kg', 'm'), /incompatible/);
  assert.throws(() => convertCFUnits([1], 'm / s / s', 'm s-2'), /multiple division/);
  assert.throws(() => convertCFUnits([1], 'unknown', 'm'), /unknown unit/);
  assert.throws(() => convertCFUnits([1], 'degC m-1', 'K m-1'), /on-scale/);
});

test('CF model calendars roundtrip impossible Gregorian dates, negative offsets and fixed UDUNITS durations', () => {
  const a = cfTimeCodec('days since 2000-01-01', { calendar: '360_day' }),
    b = cfTimeCodec('days since 2000-01-01', { calendar: 'noleap' });
  assert.deepEqual([a.decode(59).month, a.decode(59).day], [2, 30]);
  assert.deepEqual([b.decode(59).month, b.decode(59).day], [3, 1]);
  assert.equal(a.decode(360).year, 2001);
  assert.equal(b.decode(365).year, 2001);
  for (const calendar of [
    'standard',
    'proleptic_gregorian',
    'julian',
    'noleap',
    '365_day',
    'all_leap',
    '366_day',
    '360_day',
  ]) {
    const c = cfTimeCodec('hours since 1850-01-01 12:30:00.25 -5:30', { calendar });
    for (const v of [-700000, -1.25, 0, 0.001, 24, 37000, 100000]) near(c.encode(c.decode(v)), v, 1e-9);
  }
  const greg = cfTimeCodec('days since 1582-10-04');
  assert.equal(greg.decode(1).day, 15);
  assert.throws(() => cfTimeCodec('days since 1582-10-10'), /do not exist/);
  assert.throws(() => cfTimeCodec('days since 2001-02-29', { calendar: 'noleap' }), /invalid datetime/);
  assert.throws(() => cfTimeCodec('days since 2000-01-01', { calendar: 'utc' }), /unsupported calendar/);
  assert.throws(() => cfTimeCodec('seconds since 2000-01-01 00:00:60'), /invalid datetime/);
  assert.equal(cfTimeCodec('months since 2000-01-01').secondsPerUnit, 365.242198781 * 7200);
  assert.equal(cfTimeCodec('hours since 2000-01-01T00:00:00+0530').decode(0).day, 31);
});

test('CF vertical dimensional direction, SI pressure and broadcast sigma/hybrid/sleve formulas', async () => {
  const f = file(
    { lev: 2, time: 2, x: 2 },
    {
      lev: [
        ['lev'],
        [0, 1],
        { standard_name: 'atmosphere_sigma_coordinate', formula_terms: 'sigma: sigma ps: ps ptop: top' },
      ],
      sigma: [['lev'], [0, 1], { units: '1' }],
      ps: [['time', 'x'], [1000, 900, 800, 700], { units: 'hPa' }],
      top: [[], [100], { units: 'hPa' }],
      a: [['lev'], [0.1, 0.2], { units: '1' }],
      b: [['lev'], [0.9, 0.8], { units: '1' }],
      p0: [[], [1000], { units: 'hPa' }],
      ap: [['lev'], [100, 200], { units: 'hPa' }],
      orog: [['x'], [1, 2], { units: 'km' }],
      ha: [['lev'], [1, 2], { units: 'km' }],
      ztop: [[], [10], { units: 'km' }],
    },
  );
  const sigma = await readCFVertical(f, 'lev', { indices: { time: 1 } });
  assert.deepEqual(sigma.dimensions, ['lev', 'x']);
  assert.deepEqual([...sigma.data], [10000, 10000, 80000, 70000]);
  assert.equal(sigma.positive, 'down');
  f.variables.lev.attributes = attrs({
    standard_name: 'atmosphere_hybrid_sigma_pressure_coordinate',
    formula_terms: 'a: a b: b p0: p0 ps: ps',
  });
  const hybrid = await readCFVertical(f, 'lev', { indices: { time: 0 } });
  assert.deepEqual([...hybrid.data], [100000, 91000, 100000, 92000]);
  f.variables.lev.attributes.formula_terms = 'ap: ap b: b ps: ps';
  assert.deepEqual((await readCFVertical(f, 'lev', { indices: { time: 0 } })).data, hybrid.data);
  f.variables.lev.attributes = attrs({
    standard_name: 'atmosphere_hybrid_height_coordinate',
    formula_terms: 'a: ha b: b orog: orog',
  });
  assert.deepEqual([...(await readCFVertical(f, 'lev')).data], [1900, 2800, 2800, 3600]);
  f.variables.lev.attributes = attrs({
    standard_name: 'atmosphere_sleve_coordinate',
    formula_terms: 'a: a ztop: ztop b1: a zsurf1: orog',
  });
  assert.deepEqual([...(await readCFVertical(f, 'lev')).data], [1100, 1200, 2200, 2400]);
  f.variables.lev.attributes = attrs({
    standard_name: 'atmosphere_ln_pressure_coordinate',
    formula_terms: 'lev: sigma p0: p0',
  });
  near((await readCFVertical(f, 'lev')).data[1], 100000 / Math.E);
  f.variables.lev.attributes = attrs({ standard_name: 'depth', units: 'km', positive: 'down' });
  assert.deepEqual([...(await readCFVertical(f, 'lev')).data], [0, 1000]);
  await assert.rejects(readCFVertical(f, 'lev', { maxElements: 1 }), /maxElements/);
});

test('CF ocean sigma and s coordinates preserve surface and seafloor, use missing-defined sigma-z, and mask dry cells', async () => {
  const f = file(
    { k: 3, x: 2 },
    {
      k: [
        ['k'],
        [-1, -0.5, 0],
        { standard_name: 'ocean_sigma_coordinate', formula_terms: 'sigma: k eta: eta depth: depth' },
      ],
      s: [['k'], [-1, -0.5, 0], { units: '1' }],
      C: [['k'], [-1, -0.3, 0], { units: '1' }],
      eta: [['x'], [2, 3], { units: 'm' }],
      depth: [['x'], [100, 200], { units: 'm' }],
      dc: [[], [10], { units: 'm' }],
      a: [[], [0], { units: '1' }],
      b: [[], [0.5], { units: '1' }],
      sig: [['k'], [NaN, -0.5, 0], { units: '1' }],
      zlev: [['k'], [-100, NaN, NaN], { units: 'm' }],
    },
  );
  assert.deepEqual([...(await readCFVertical(f, 'k')).data], [-100, -200, -49, -98.5, 2, 3]);
  for (const name of ['ocean_s_coordinate', 'ocean_s_coordinate_g1', 'ocean_s_coordinate_g2']) {
    f.variables.k.attributes = attrs({
      standard_name: name,
      formula_terms: 's: s C: C eta: eta depth: depth depth_c: dc a: a b: b',
    });
    const data = (await readCFVertical(f, 'k')).data;
    near(data[0], -100);
    near(data[1], -200);
    near(data[4], 2);
    near(data[5], 3);
  }
  f.variables.k.attributes = attrs({
    standard_name: 'ocean_sigma_z_coordinate',
    formula_terms: 'sigma: sig zlev: zlev eta: eta depth: depth depth_c: dc',
  });
  assert.deepEqual([...(await readCFVertical(f, 'k')).data], [-100, -100, -4, -3.5, 2, 3]);
});

test('rectilinear sampling wraps complete cycles, handles descending regional axes and obeys NaN policies', () => {
  const a = cfSampler(grid());
  near(a(5, 5), 15);
  assert.ok(Number.isNaN(a(11, 5)));
  near(a(360, 0), 0);
  const g = grid([0, 10, 20, 30], { longitude: Float64Array.of(175, -175), latitude: Float64Array.of(10, 0) });
  near(cfSampler(g)(180, 5), 15);
  assert.ok(Number.isNaN(cfSampler(g)(0, 5)));
  const periodic = grid([0, 90, 180, 270, 10, 100, 190, 280], { nx: 4, longitude: Float64Array.of(0, 90, 180, 270) });
  near(cfSampler(periodic)(315, 0), 135);
  near(cfSampler(periodic)(-45, 0), 135);
  const masked = grid([0, 10, 20, NaN]);
  assert.ok(Number.isNaN(cfSampler(masked)(5, 5)));
  near(cfSampler(masked, { missing: 'renormalize' })(5, 5), 10);
  near(cfSampler(masked)(0, 0), 0);
  const own = cfSampler(masked);
  masked.values.fill(999);
  near(own(0, 0), 0);
  near(cfSampler(grid(), { method: 'nearest' })(9, 1), 10);
  assert.throws(() => cfSampler(grid([], {})), /shape mismatch/);
});

test('curvilinear inversion reproduces a bilinear field through the dateline and masks folds and holes', () => {
  const g = grid([0, 10, 20, 30], {
    curvilinear: true,
    longitude: Float64Array.of(175, 185, 177, 189),
    latitude: Float64Array.of(0, 1, 10, 12),
  });
  const sample = cfSampler(g);
  near(sample(181.5, 5.75), 15);
  near(sample(-178.5, 5.75), 15);
  assert.ok(Number.isNaN(sample(0, 5)));
  const folded = { ...g, latitude: Float64Array.of(0, 10, 10, 0) };
  assert.ok(Number.isNaN(cfSampler(folded)(180, 5)));
  g.values[3] = NaN;
  assert.ok(Number.isNaN(cfSampler(g)(181.5, 5.75)));
  near(cfSampler(g, { missing: 'renormalize' })(181.5, 5.75), 10);
});

test('inverse-map masks the projection boundary, applies independent land fractions and honors cancellation', () => {
  const g = grid([1, 2, 3, 4]),
    mask = grid([0, 100, 0, 100], { units: '%' }),
    target = {
      projection: { name: 'plate', centralMeridian: 0, forward: (x, y) => [x, y], inverse: (x, y) => [x, y] },
      extent: [0, 0, 10, 10],
      width: 2,
      height: 2,
    };
  const land = regridCF(g, target, { landMask: mask });
  assert.deepEqual([...land.values], [NaN, 2.25, NaN, 3.25]);
  const ocean = regridCF(g, target, { landMask: mask, keep: 'ocean' });
  assert.deepEqual([...ocean.values], [1.75, NaN, 2.75, NaN]);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => regridCF(g, target, { signal: controller.signal }), { name: 'AbortError' });
  assert.throws(() => regridCF(g, { ...target, width: 1e10 }), /maxCells/);
});

test('conservative rectilinear cell averages preserve the area integral, CF bounds, dateline and missing coverage', () => {
  const s = grid([1, 3, 5, 7], {
    longitude: Float64Array.of(-90, 90),
    latitude: Float64Array.of(-45, 45),
    longitudeBounds: Float64Array.of(-180, 0, 0, 180),
    latitudeBounds: Float64Array.of(-90, 0, 0, 90),
  });
  const t = { longitude: Float64Array.of(-135, -45, 45, 135), latitude: Float64Array.of(-67.5, -22.5, 22.5, 67.5) };
  const result = conservativeCF(s, t);
  near(result.values[0], 1);
  near(result.values.at(-1), 7);
  assert.ok(result.coverage.every((v) => Math.abs(v - 1) < 1e-12));
  const integral = (g) => {
    let n = 0;
    for (let j = 0; j < g.ny; j++) {
      const lo = (((j / g.ny) * 180 - 90) * Math.PI) / 180,
        hi = ((((j + 1) / g.ny) * 180 - 90) * Math.PI) / 180;
      for (let i = 0; i < g.nx; i++) n += (g.values[j * g.nx + i] * (Math.sin(hi) - Math.sin(lo)) * 2 * Math.PI) / g.nx;
    }
    return n;
  };
  near(integral(s), integral(result));
  const one = conservativeCF(s, {
    longitude: Float64Array.of(0),
    latitude: Float64Array.of(0),
    longitudeBounds: Float64Array.of(-180, 180),
    latitudeBounds: Float64Array.of(-90, 90),
  });
  near(one.values[0], 4);
  s.values[0] = NaN;
  const masked = conservativeCF(
    s,
    {
      longitude: Float64Array.of(0),
      latitude: Float64Array.of(0),
      longitudeBounds: Float64Array.of(-180, 180),
      latitudeBounds: Float64Array.of(-90, 90),
    },
    { missing: 'renormalize' },
  );
  near(masked.values[0], 5);
  near(masked.coverage[0], 0.75);
});
