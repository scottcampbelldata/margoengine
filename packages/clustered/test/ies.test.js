import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { IESLights, parseIES, iesCandela, MAX_IES_PROFILES } from '../dist/ies.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { iesFactor, iesFile, range } from './ies-reference.js';

// A downlight: cos^2 falloff to 60 degrees (none past it), brighter toward horizontal angle 0 (1 + 0.5 cos phi).
const beam = (theta, phi) => (theta <= 60 ? 800 * Math.cos((theta * Math.PI) / 180) ** 2 : 0),
  asymmetric = (theta, phi) => beam(theta) * (1 + 0.5 * Math.cos((phi * Math.PI) / 180));
const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

test('parseIES reads an LM-63-2002 file: keywords, angles, candela with its multiplier, peak and flux', () => {
  const bowl = (theta) => 800 * Math.cos((theta * Math.PI) / 180) ** 2,
    profile = parseIES(iesFile(range(0, 90, 5), [0], bowl, { multiplier: 2 }));
  assert.equal(profile.format, 'IESNA:LM-63-2002');
  assert.equal(profile.keywords.MANUFAC, 'Margo tests\nsecond line');
  assert.equal(profile.vertical.length, 19);
  assert.deepEqual(profile.horizontal, [0]);
  assert.equal(profile.candela[0][0], 1600);
  assert.equal(profile.peak, 1600);
  assert.equal(profile.lampLumens, -1);
  // Flux of 1600 cos^2(theta) over the lower hemisphere: 2 pi 1600 / 3, from the file's 5-degree samples.
  const exact = (2 * Math.PI * 1600) / 3;
  assert.ok(Math.abs(profile.flux / exact - 1) < 0.01, `${profile.flux} vs ${exact}`);
  const isotropic = parseIES(iesFile([0, 90, 180], [0], () => 1000));
  assert.ok(Math.abs(isotropic.flux / (4 * Math.PI * 1000) - 1) < 1e-4, `${isotropic.flux}`);
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.candela[0]));
});

test('parseIES skips tilt data, folds mirrored horizontal angles and rejects what it cannot read', () => {
  const tilted = iesFile([0, 90], [0], () => 5).replace('TILT=NONE', 'TILT=INCLUDE\r\n1\r\n3\r\n0 45 90\r\n1 0.9 0.8');
  assert.equal(parseIES(tilted).candela[0][1], 5);
  // Quadrant symmetry (0-90): 135 degrees reads 45, 270 reads 90.
  const quadrant = parseIES(iesFile([0, 90], [0, 45, 90], (t, p) => 100 + p));
  assert.equal(iesCandela(quadrant, 0, 135), 145);
  assert.equal(iesCandela(quadrant, 0, 270), 190);
  assert.equal(iesCandela(quadrant, 0, 22.5), 122.5);
  // Bilateral (0-180): 300 reads 60; full circle without 360 wraps from the last angle to 0.
  const bilateral = parseIES(iesFile([0, 90], [0, 60, 180], (t, p) => p));
  assert.equal(iesCandela(bilateral, 45, 300), 60);
  const full = parseIES(iesFile([0, 90], [0, 90, 180, 270], (t, p) => p));
  assert.equal(iesCandela(full, 0, 315), 135);
  assert.equal(iesCandela(full, 120, 0), 0, 'past the last vertical angle');
  assert.throws(() => parseIES(iesFile([0, 90], [0], () => 1).replace(' 1 2 0.1', ' 3 2 0.1')), /type A/);
  for (const bad of [
    'no tilt line',
    iesFile([0, 90], [0], () => 1).replace('0 90\r\n', '90 0\r\n'),
    iesFile([0, 90], [0], () => 1).replace(/\d+\.?\d*\r\n$/, ''),
    iesFile([0, 90], [0], () => -1),
  ])
    assert.throws(() => parseIES(bad), RangeError);
  assert.throws(() => parseIES(5), TypeError);
});

test('parseIES reads the 2019 first line, and scales by the ballast-lamp factor only where the format has one', () => {
  const file = (format, factor) =>
    iesFile([0, 90], [0], () => 100)
      .replace('IESNA:LM-63-2002', format)
      .replace('1.0 1.0 20', `1.0 ${factor} 20`);
  // 2019 holds the file generation type here and 2002 a retired field: neither is a photometric factor.
  const current = parseIES(file('IES:LM-63-2019', 1.10001));
  assert.equal(current.format, 'IES:LM-63-2019');
  assert.equal(current.peak, 100);
  assert.equal(parseIES(file('IESNA:LM-63-2002', 1.5)).peak, 100);
  assert.equal(parseIES(file('IESNA:LM-63-1995', 1.5)).peak, 150);
  assert.equal(parseIES(file('IESNA91', 1.5)).peak, 150);
  assert.equal(parseIES(file('IESNA:LM-63-1995', 0)).peak, 100, 'an unset factor counts as 1');
});

/** A type B file: `candela(V, H)` at each vertical and horizontal angle. */
const typeB = (vertical, horizontal, candela) =>
  iesFile(vertical, horizontal, (v, h) => candela(v, h)).replace(/ 1 2 0\.1/, ' 2 2 0.1');
test('parseIES puts a type B table on the type C grid: beam at vertical 0, H along plane 0 and V along plane 90', () => {
  const angles = range(-90, 90, 10),
    // Linear in both angles, so reading between table angles is exact.
    plane = (v, h) => 1000 + 3 * h + 2 * v,
    profile = parseIES(typeB(angles, angles, plane));
  assert.equal(profile.vertical[0], 0);
  assert.equal(profile.horizontal.at(-1), 360);
  const near = (theta, phi, want) => {
    const got = iesCandela(profile, theta, phi);
    assert.ok(Math.abs(got - want) < 1e-6, `${theta}, ${phi}: ${got} against ${want}`);
  };
  near(0, 0, 1000);
  near(30, 0, plane(0, 30));
  near(30, 180, plane(0, -30));
  near(40, 90, plane(40, 0));
  near(40, 270, plane(-40, 0));
  // Off both planes: x = sin 60 cos 45, y = sin 60 sin 45, z = cos 60, so H = asin(x) and V = atan2(y, z).
  const t = Math.PI / 3,
    x = Math.sin(t) * Math.SQRT1_2,
    degrees = 180 / Math.PI;
  near(60, 45, plane(Math.atan2(x, Math.cos(t)) * degrees, Math.asin(x) * degrees));
  // Behind the fixture, past V = 90, nothing was measured.
  assert.equal(iesCandela(profile, 120, 90), 0);
  assert.equal(iesCandela(profile, 180, 0), 0);
});

test('a type B table from 0 mirrors, and a table that stops short emits nothing past its end', () => {
  const quarter = parseIES(typeB(range(0, 90, 10), range(0, 90, 10), (v, h) => 500 + h + 2 * v));
  assert.ok(Math.abs(iesCandela(quarter, 30, 180) - 530) < 1e-6, 'H mirrors');
  assert.ok(Math.abs(iesCandela(quarter, 30, 270) - 560) < 1e-6, 'V mirrors');
  const narrow = parseIES(typeB(range(-20, 20, 10), range(-20, 20, 10), () => 100));
  assert.equal(iesCandela(narrow, 10, 0), 100);
  assert.equal(iesCandela(narrow, 30, 0), 0);
  assert.equal(iesCandela(narrow, 30, 90), 0);
  for (const bad of [
    typeB([0, 90], [0], () => 1),
    typeB([-120, 0], [0, 90], () => 1),
    typeB([0, 90], [-120, 0], () => 1),
    typeB([0, 120], [0, 90], () => 1),
  ])
    assert.throws(() => parseIES(bad), RangeError);
});

test('IESLights packs one profile per distinct file, per-light ids and rotations; the shader mirror matches the profile', () => {
  const symmetric = parseIES(iesFile(range(0, 90, 2.5), [0], beam)),
    turned = parseIES(iesFile(range(0, 90, 2.5), range(0, 180, 15), asymmetric)),
    ies = new IESLights({ lights: { setLights() {} } });
  ies.setProfiles([symmetric, null, { profile: turned, rotation: 0.5 }, symmetric]);
  const words = ies['words'];
  assert.deepEqual(Array.from(words.subarray(0, 2)), [4, 2]);
  assert.deepEqual(Array.from(words.subarray(68, 76)), [
    1,
    0,
    0,
    0,
    2,
    new Uint32Array(new Float32Array([0.5]).buffer)[0],
    1,
    0,
  ]);
  assert.deepEqual([words[5], words[9]], [1, 72], 'columns');
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const d = unit([Math.sin(i * 1.7) * 0.9, -1, Math.cos(i * 2.3) * 0.9]),
      theta = (Math.acos(-d[1]) * 180) / Math.PI;
    // Point light: axis straight down, horizontal angle 0 along +x, counterclockwise seen from above (+x toward -z).
    const phi = (Math.atan2(-d[2], d[0]) * 180) / Math.PI;
    worst = Math.max(
      worst,
      Math.abs(iesFactor(words, 0, null, d) - iesCandela(symmetric, theta, 0) / symmetric.peak),
      Math.abs(iesFactor(words, 2, null, d) - iesCandela(turned, theta, phi - (0.5 * 180) / Math.PI) / turned.peak),
    );
  }
  assert.ok(worst < 0.01, `grid lookup vs profile: ${worst}`);
  assert.equal(iesFactor(words, 1, null, [0, -1, 0]), 1, 'no profile');
  assert.equal(iesFactor(words, 9, null, [0, -1, 0]), 1, 'past the entries');
  // A spot's axis is its direction.
  const axis = unit([1, -1, 0]);
  assert.ok(Math.abs(iesFactor(words, 0, axis, axis) - 1) < 1e-4);
  const before = words.slice();
  for (const bad of [[{ profile: symmetric, rotation: NaN }], [{}], [5]])
    assert.throws(() => ies.setProfiles(bad), /IES/);
  const many = Array.from({ length: MAX_IES_PROFILES + 1 }, () => parseIES(iesFile([0, 90], [0], () => 1)));
  assert.throws(() => ies.setProfiles(many), RangeError);
  assert.deepEqual(ies['words'], before);
});

test('IESLights add clusterIes, binding 142 and one buffer only while a light has a profile', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([{ position: [0, 2, 1], range: 6 }]);
  h.engine.use(lights);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
    return { shader: h.context.shader, bindings: h.context.bindings.map((b) => b.binding) };
  };
  try {
    const plain = frame(),
      buffers = h.counts.buffers;
    const ies = new IESLights({ lights });
    h.engine.use(ies);
    ies.setProfiles([null, null]);
    assert.deepEqual(frame(), plain, 'attached, no profiles');
    assert.equal(h.counts.buffers, buffers);
    const profile = parseIES(iesFile(range(0, 90, 5), [0], beam));
    ies.setProfiles([profile]);
    const lit = frame();
    assert.match(lit.shader, /@binding\(142\) var<storage,read> clusterIesData/);
    assert.ok(lit.shader.includes('let index=clusterIndices[cell*1024u+j];let light=clusterLights[index];'));
    assert.ok(lit.shader.includes('*cone*clusterIes(index,light,l)'));
    assert.deepEqual(lit.bindings, [...plain.bindings, 142]);
    assert.equal(h.counts.buffers, buffers + 1);
    const buffer = ies.bindings()[0].resource.buffer;
    assert.deepEqual(new Uint32Array(buffer.data, 0, 2), new Uint32Array([1, 1]));
    ies.setProfiles([]);
    assert.deepEqual(frame(), plain, 'emptied');
    ies.onDeviceRestored(h.engine);
    assert.ok(buffer.destroyed);
    ies.dispose();
    assert.equal(lights.ies, undefined);
  } finally {
    lights.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
