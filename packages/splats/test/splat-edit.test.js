// Splat formats and editing (@margoengine/splats/data): Gaussian-splat PLY (binary and ascii, SH degrees 0-3,
// first-order linear SH), the .splat writer round trip, covariance decomposition, crop and filter, affine transforms
// with SH rotation, merging and moment-matched level of detail.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cropSplats,
  decimateSplats,
  decomposeCovariance,
  encodeSplat,
  filterSplats,
  mergeSplats,
  parsePly,
  parseSplat,
  transformSplats,
} from '../dist/data.js';

const near = (a, b, tolerance, label) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} is not within ${tolerance} of ${b}`);
const C0 = 0.2820947918;
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A binary little-endian Gaussian-splat PLY of `rows` (objects of property values), with `rest` f_rest values. */
function ply(rows, rest = 0, format = 'binary_little_endian') {
  const names = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  for (let i = 0; i < rest; i++) names.push(`f_rest_${i}`);
  names.push('opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3');
  const header = `ply\nformat ${format} 1.0\ncomment made by a test\nelement vertex ${rows.length}\n${names
    .map((n) => `property float ${n}`)
    .join('\n')}\nend_header\n`;
  const head = new TextEncoder().encode(header);
  if (format === 'ascii') {
    const body = rows.map((r) => names.map((n) => r[n] ?? 0).join(' ')).join('\n');
    return new TextEncoder().encode(header + body + '\n');
  }
  const bytes = new Uint8Array(head.length + rows.length * names.length * 4);
  bytes.set(head);
  const view = new DataView(bytes.buffer, head.length);
  rows.forEach((r, i) => names.forEach((n, k) => view.setFloat32((i * names.length + k) * 4, r[n] ?? 0, true)));
  return bytes;
}
const splat = (over = {}) => ({
  x: 1,
  y: 2,
  z: 3,
  f_dc_0: 0.5,
  f_dc_1: -0.5,
  f_dc_2: 0,
  opacity: 0, // sigmoid 0.5
  scale_0: Math.log(0.1),
  scale_1: Math.log(0.2),
  scale_2: Math.log(0.3),
  rot_0: 1, // w
  rot_1: 0,
  rot_2: 0,
  rot_3: 0,
  ...over,
});

test('parsePly decodes position, sigmoid opacity, exp scales, rotation and linear colour, binary and ascii', () => {
  for (const format of ['binary_little_endian', 'ascii']) {
    const half = Math.SQRT1_2,
      data = parsePly(ply([splat(), splat({ x: -1, rot_0: half, rot_3: half })], 0, format));
    assert.deepEqual(Array.from(data.positions.subarray(0, 3)), [1, 2, 3]);
    near(data.colors[3], 0.5, 1e-7, 'opacity is the sigmoid of the logit');
    // Identity rotation: the covariance is diag(scale^2).
    const c = data.covariances;
    near(c[0], 0.01, 1e-8, 'xx');
    near(c[3], 0.04, 1e-8, 'yy');
    near(c[5], 0.09, 1e-8, 'zz');
    near(c[1], 0, 1e-9, 'xy');
    // 90 degrees about z swaps the x and y scales.
    near(c[6], 0.04, 1e-7, 'turned xx');
    near(c[9], 0.01, 1e-7, 'turned yy');
    near(data.colors[0], linear(0.5 + C0 * 0.5), 1e-6, 'red: display colour to linear');
    near(data.colors[1], linear(0.5 - C0 * 0.5), 1e-6, 'green');
    assert.equal(data.sphericalHarmonics, undefined, 'degree 0 keeps plain colours');
  }
});

test('parsePly keeps SH degrees 1-3, reordered from channel-major and converted to linear to first order', () => {
  for (const [degree, perChannel] of [
    [1, 3],
    [2, 8],
    [3, 15],
  ]) {
    const row = splat();
    // Channel-major f_rest: R coefficients 1..n, then G, then B.
    for (let c = 0; c < 3; c++)
      for (let j = 0; j < perChannel; j++) row[`f_rest_${c * perChannel + j}`] = (c + 1) * 0.01 * (j + 1);
    const data = parsePly(ply([row], perChannel * 3)),
      n = perChannel + 1,
      sh = data.sphericalHarmonics;
    assert.equal(sh.length, n * 3, `degree ${degree}: ${n} coefficients per channel`);
    // The base band reproduces the linear colour exactly.
    for (let c = 0; c < 3; c++) near(0.5 + C0 * sh[c], data.colors[c], 1e-6, `DC channel ${c}`);
    // Higher bands: the display coefficient times the sRGB curve's slope at the base colour.
    const display = 0.5 + C0 * 0.5,
      k = (2.4 / 1.055) * ((display + 0.055) / 1.055) ** 1.4,
      kGreen = (2.4 / 1.055) * ((0.5 - C0 * 0.5 + 0.055) / 1.055) ** 1.4;
    near(sh[1 * 3 + 0], 0.01 * k, 1e-7, 'red band 1');
    near(sh[2 * 3 + 1], 0.02 * 2 * kGreen, 1e-7, 'green second coefficient');
  }
});

test('parsePly rejects files that are not splat PLYs, naming what is missing', () => {
  assert.throws(() => parsePly(new TextEncoder().encode('hello')), /Not a PLY/);
  const header =
    'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n';
  const bytes = new Uint8Array(header.length + 12);
  bytes.set(new TextEncoder().encode(header));
  assert.throws(() => parsePly(bytes), /missing f_dc_0/);
  assert.throws(
    () => parsePly(new TextEncoder().encode(header.replace('binary_little_endian', 'binary_big_endian'))),
    (e) => e.code === 'unsupported' && /little_endian/.test(e.message),
  );
  const short = ply([splat()]);
  assert.throws(() => parsePly(short.subarray(0, short.length - 4)), /shorter/);
  assert.throws(() => parsePly(ply([splat()], 5)), /f_rest/);
});

test('decomposeCovariance recovers axis scales and rotation; encodeSplat round-trips through parseSplat', () => {
  const half = Math.sin(0.4),
    data = parsePly(
      ply([splat({ rot_0: Math.cos(0.4), rot_1: half * 0.6, rot_2: half * 0.8 }), splat({ x: 5, opacity: 2 })]),
    );
  const { scale } = decomposeCovariance(data.covariances, 0);
  assert.deepEqual(scale.map((s) => Math.round(s * 1e6) / 1e6).sort(), [0.1, 0.2, 0.3]);
  const bytes = encodeSplat(data);
  assert.equal(bytes.length, 64);
  const back = parseSplat(bytes);
  for (let i = 0; i < 6; i++) near(back.positions[i], data.positions[i], 1e-6, `position ${i}`);
  for (let i = 0; i < 12; i++) near(back.covariances[i], data.covariances[i], 0.004, `covariance ${i}`);
  for (let i = 0; i < 8; i++) near(back.colors[i], data.colors[i], 0.01, `colour ${i}`);
});

/** A small cloud: n splats on a line along x, spheres of radius 0.1, grey. */
function line(n, sh = 0) {
  const positions = new Float32Array(n * 3),
    covariances = new Float32Array(n * 6),
    colors = new Float32Array(n * 4).fill(0.5);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = i;
    covariances.set([0.01, 0, 0, 0.01, 0, 0.01], i * 6);
  }
  const data = { positions, covariances, colors };
  if (sh) data.sphericalHarmonics = new Float32Array(n * sh * 3).map((_, i) => ((i * 7) % 11) / 50 - 0.1);
  return data;
}

test('crop and filter keep the splats inside a box or sphere, or outside with invert', () => {
  const cloud = line(10, 4);
  const box = cropSplats(cloud, { box: { min: [2, -1, -1], max: [5, 1, 1] } });
  assert.deepEqual(Array.from(box.positions.filter((_, i) => i % 3 === 0)), [2, 3, 4, 5]);
  assert.equal(box.sphericalHarmonics.length, 4 * 4 * 3, 'SH travels with the kept splats');
  assert.deepEqual(
    Array.from(box.sphericalHarmonics.subarray(0, 12)),
    Array.from(cloud.sphericalHarmonics.subarray(24, 36)),
  );
  const outside = cropSplats(cloud, { sphere: { center: [0, 0, 0], radius: 7.5 } }, { invert: true });
  assert.deepEqual(Array.from(outside.positions.filter((_, i) => i % 3 === 0)), [8, 9]);
  assert.equal(filterSplats(cloud, (i) => i % 2 === 0).positions.length, 15);
  assert.throws(() => cropSplats(cloud, { box: { min: [50, 0, 0], max: [60, 1, 1] } }), /No splats/);
  assert.throws(() => cropSplats(cloud, { cube: 1 }), /crop region/);
});

test('transformSplats moves centres, stretches covariances and turns view-dependent colour with the rotation', () => {
  // 90 degrees about y (column-major), scaled by 2, moved by (10, 0, 0).
  const m = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 10, 0, 0, 1],
    cloud = line(2, 16);
  cloud.covariances.set([0.04, 0, 0, 0.01, 0, 0.01], 6); // splat 1 is long along x
  const moved = transformSplats(cloud, m);
  // (1, 0, 0) -> rotate to (0, 0, -1), scale 2 -> (0, 0, -2), move -> (10, 0, -2).
  assert.deepEqual(
    Array.from(moved.positions.subarray(3, 6)).map((v) => Math.round(v * 1e6) / 1e6),
    [10, 0, -2],
  );
  // Long axis now along z, doubled: zz = 0.04 * 4.
  near(moved.covariances[6 + 5], 0.16, 1e-6, 'stretched along z');
  near(moved.covariances[6 + 0], 0.04, 1e-6, 'xx from the old zz, doubled');
  // The SH function turns with the cloud: f'(R d) = f(d) for any direction d.
  const value = (sh, i, d) => {
    const [x, y, z] = d,
      b = [
        0.2820947918,
        -0.4886025119 * y,
        0.4886025119 * z,
        -0.4886025119 * x,
        1.0925484306 * x * y,
        -1.0925484306 * y * z,
        0.3153915653 * (3 * z * z - 1),
        -1.0925484306 * x * z,
        0.5462742153 * (x * x - y * y),
        -0.5900435899 * y * (3 * x * x - y * y),
        2.8906114426 * x * y * z,
        -0.4570457995 * y * (5 * z * z - 1),
        0.3731763326 * z * (5 * z * z - 3),
        -0.4570457995 * x * (5 * z * z - 1),
        1.4453057213 * z * (x * x - y * y),
        -0.5900435899 * x * (x * x - 3 * y * y),
      ];
    return b.reduce((sum, v, k) => sum + v * sh[(i * 16 + k) * 3], 0);
  };
  for (const d of [
    [1, 0, 0],
    [0, 1, 0],
    [0.6, 0, 0.8],
    [0.48, 0.6, 0.64],
  ]) {
    const rotatedDir = [d[2], d[1], -d[0]];
    near(value(moved.sphericalHarmonics, 0, rotatedDir), value(cloud.sphericalHarmonics, 0, d), 1e-5, `SH at ${d}`);
  }
  assert.throws(() => transformSplats(cloud, [1, 0, 0]), /16 finite/);
  assert.throws(() => transformSplats(cloud, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), /invertible/);
});

test('merge joins clouds; decimate keeps each cell weighted mean and second moment', () => {
  const merged = mergeSplats(line(3), line(2));
  assert.equal(merged.positions.length, 15);
  assert.throws(() => mergeSplats(line(2), line(2, 4)), /same spherical-harmonics degree/);
  // Two splats in one cell, two in another.
  const cloud = line(4);
  cloud.positions.set([0.1, 0, 0, 0.3, 0, 0, 5.1, 0, 0, 5.5, 0, 0]);
  cloud.colors.set([1, 0, 0, 1, 0, 0, 1, 1], 0);
  const lod = decimateSplats(cloud, { cellSize: 1 });
  assert.equal(lod.positions.length, 6, 'two cells, two splats');
  // Equal volumes and opacities in the first cell: the mean is the midpoint and the spread adds (0.1)^2 on x.
  near(lod.positions[0], 0.2, 1e-6, 'mean');
  near(lod.covariances[0], 0.01 + 0.01, 1e-6, 'second moment along x');
  near(lod.covariances[3], 0.01, 1e-7, 'unchanged across');
  near(lod.colors[0], 0.5, 1e-6, 'mean colour');
  assert.throws(() => decimateSplats(cloud, { cellSize: 0 }), /cellSize/);
});
