import test from 'node:test';
import assert from 'node:assert/strict';
import {Clustered} from '../dist/index.js';
import {AreaLights, MAX_AREA_LIGHTS} from '../dist/area.js';
import {wgsl} from '../../core/src/shaders.ts';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {ltc, bruteForce} from './ltc-reference.js';

const pack = (...list) => {const a = new AreaLights({lights: {setLights() {}}}); a.setLights(list); return list.map((_, i) => Array.from(a['data'].subarray(4 + i * 16, 20 + i * 16)));};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const close = (a, b, tolerance, label) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tolerance, `${label}: ${a} vs ${b}`));

test('area lights pack centre, half extents along direction x up, radiance and the two-sided flag; bad input changes nothing', () => {
  const [l] = pack({position: [1, 2, 3], direction: [0, -2, 0], width: 4, height: 1, color: [1, 0.5, 0.25], intensity: 8, twoSided: true});
  close(l.slice(0, 4), [1, 2, 3, 1], 1e-6, 'centre');
  const right = l.slice(4, 7), up = l.slice(8, 11);
  assert.ok(Math.abs(Math.hypot(...right) - 2) < 1e-6 && Math.abs(Math.hypot(...up) - 0.5) < 1e-6 && Math.abs(dot(right, up)) < 1e-6);
  close(cross(right, up).map(v => v / 1), [0, -1, 0], 1e-6, 'emits along direction'); // |right x up| = 1
  close(l.slice(12, 15), [8, 4, 2], 1e-6, 'radiance');
  const [side] = pack({position: [0, 0, 0], direction: [1, 0, 0], width: 1, height: 2, up: [0, 0, 1]});
  close(side.slice(8, 11), [0, 0, 1], 1e-6, 'explicit up'); assert.equal(side[3], 0);
  const a = new AreaLights({lights: {setLights() {}}}), keep = {position: [0, 1, 0], direction: [0, -1, 0], width: 1, height: 1};
  a.setLights([keep]); const before = a['data'].slice();
  for (const bad of [{...keep, width: 0}, {...keep, height: -1}, {...keep, direction: [0, 0, 0]}, {...keep, up: [0, 3, 0]}, {...keep, intensity: -1}, {...keep, color: [1, -1, 0]}, {...keep, position: [0, NaN, 0]}, {...keep, twoSided: 1}])
    assert.throws(() => a.setLights([keep, bad]), /area light/i);
  assert.throws(() => a.setLights(Array(MAX_AREA_LIGHTS + 1).fill(keep)), RangeError);
  assert.deepEqual(a['data'], before);
  assert.throws(() => new AreaLights({}), TypeError);
});

test('area lights add shader code, binding 17 and one buffer only while there are lights', () => {
  const h = optionalGPU(), lights = new Clustered({grid: [2, 2, 2]}); lights.setLights([{position: [0, 2, 1], range: 6}]); h.engine.use(lights);
  const frame = () => {h.context.shader = wgsl; h.context.bindings.length = 0; h.engine.frameGraph.execute(h.context); return {shader: h.context.shader, bindings: h.context.bindings.map(b => b.binding)};};
  try {
    const plain = frame(), buffers = h.counts.buffers, pbr = lights.pbr(2).declarations;
    const area = new AreaLights({lights}); h.engine.use(area);
    assert.deepEqual(frame(), plain, 'attached without lights'); assert.equal(h.counts.buffers, buffers); assert.equal(lights.area, undefined);
    area.setLights([{position: [0, 2, 0], direction: [0, -1, 0], width: 2, height: 1, intensity: 5}]);
    const lit = frame();
    assert.match(lit.shader, /@binding\(17\) var<storage,read> areaLights/); assert.match(lit.shader, /\(result\+clusterAreaLighting\(position,n,v,nv,base,roughness,metal\)\)\*clusterFrame/);
    assert.deepEqual(lit.bindings, [...plain.bindings, 17]); assert.equal(h.counts.buffers, buffers + 1);
    assert.match(lights.pbr(2).declarations, /@group\(2\) @binding\(17\)/);
    const buffer = area.bindings()[0].resource.buffer, words = new Uint32Array(buffer.data);
    assert.equal(words[0], 1); assert.ok(new Float32Array(buffer.data, 16, 16).every(Number.isFinite)); assert.ok(words.subarray(4 + 64 * 16).some(v => v !== 0), 'LTC table uploaded');
    area.setLights([]); assert.deepEqual(frame(), plain, 'emptied'); assert.equal(lights.pbr(2).declarations, pbr);
    area.setLights([{position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1}]); frame(); assert.equal(h.counts.buffers, buffers + 1, 'buffer kept');
    area.onDeviceRestored(h.engine); assert.ok(buffer.destroyed); assert.deepEqual(frame(), lit);
    area.dispose(); assert.deepEqual(frame(), plain, 'disposed'); assert.equal(lights.area, undefined);
  } finally {lights.dispose();}
  assert.ok(h.resources.every(resource => resource.destroyed));
});

// Linearly transformed cosines vs quadrature of the BRDF they approximate (GGX with height-correlated Smith, Schlick Fresnel;
// Lambert diffuse). Receiver at the origin, normal +y, viewed from angle theta in the xy plane.
const lights = {
  overhead: {position: [0.5, 2, 0.3], direction: [0, -1, 0], width: 2, height: 1},
  tilted: {position: [-1.5, 1.2, 0], direction: [1, -0.6, 0.2], width: 1.5, height: 0.8},
  ahead: {position: [-2, 1, 0], direction: [1, 0, 0], width: 1, height: 1.6},
  straddle: {position: [1.2, 0.3, 0], direction: [-1, 0, 0], width: 1.4, height: 1.2}, // crosses the receiver's horizon
};
const view = degrees => [Math.sin(degrees * Math.PI / 180), Math.cos(degrees * Math.PI / 180), 0], n = [0, 1, 0], o = [0, 0, 0];

test('LTC diffuse equals the exact form factor, horizon clipping included', () => {
  for (const [name, light] of Object.entries(lights)) {
    const [l] = pack(light), a = ltc(l, o, n, view(40), [0.8, 0.8, 0.8], 0.5, 0), b = bruteForce(l, o, n, view(40), [0.8, 0.8, 0.8], 0.5, 0, 384);
    assert.ok(Math.abs(a.diffuse[0] / b.diffuse[0] - 1) < 2e-3, `${name}: ${a.diffuse[0]} vs ${b.diffuse[0]}`);
  }
});

test('LTC GGX specular matches brute-force integration over the rectangle', () => {
  // [light, view angle, roughness]: the highlight inside or near the light, glossy to rough, normal to grazing.
  const cases = [['overhead', 0, 0.1], ['overhead', 0, 0.25], ['overhead', 0, 0.5], ['overhead', 0, 0.8], ['overhead', 0, 1], ['overhead', 30, 0.5],
    ['tilted', 60, 0.1], ['tilted', 60, 0.25], ['tilted', 60, 0.5], ['tilted', 30, 0.25], ['ahead', 60, 0.25], ['ahead', 60, 0.5], ['ahead', 80, 0.1], ['ahead', 80, 0.5], ['straddle', 0, 0.8]];
  const rows = [];
  for (const [name, theta, roughness] of cases) {
    const [l] = pack(lights[name]), v = view(theta), k = roughness < 0.2 ? 640 : 256;
    const metal = ltc(l, o, n, v, [1, 1, 1], roughness, 1).specular[0], metalRef = bruteForce(l, o, n, v, [1, 1, 1], roughness, 1, k).specular[0];
    const plastic = ltc(l, o, n, v, [0.5, 0.5, 0.5], roughness, 0).total[0], plasticRef = bruteForce(l, o, n, v, [0.5, 0.5, 0.5], roughness, 0, k).total[0];
    rows.push({name, theta, roughness, metal: +(metal / metalRef - 1).toFixed(4), plastic: +(plastic / plasticRef - 1).toFixed(4)});
  }
  console.log(JSON.stringify(rows));
  // Specular-only (F = 1) is the LTC fit's own error; dielectric (diffuse + Schlick specular) is what a lit pixel shows. The
  // worst case is the 80° grazing view at roughness 0.5 (about +16% specular, -19% dielectric, as three.js's fit); up to 60°
  // specular stays within 5% and dielectric within 14%. Past ~84° on glossy surfaces the fit is off by up to ~40% (README).
  for (const r of rows) {
    const bound = r.theta >= 80 ? 0.2 : 0.15;
    assert.ok(Math.abs(r.metal) < bound, `specular ${r.name} ${r.theta}° r${r.roughness}: ${r.metal}`);
    assert.ok(Math.abs(r.plastic) < bound, `dielectric ${r.name} ${r.theta}° r${r.roughness}: ${r.plastic}`);
  }
  const mean = rows.reduce((s, r) => s + Math.abs(r.metal), 0) / rows.length; assert.ok(mean < 0.04, `mean specular error ${mean}`);
});

test('a small area light matches a clustered point light of intensity radiance x area; one- and two-sided', () => {
  const size = 0.04, radiance = 50, position = [0.6, 3, -0.4], [l] = pack({position, direction: [-0.6, -3, 0.4], width: size, height: size, intensity: radiance});
  const d = Math.hypot(...position), cos = position[1] / d, base = [0.6, 0.6, 0.6], lit = ltc(l, o, n, view(20), base, 1, 0).diffuse[0];
  const point = base[0] / Math.PI * radiance * size * size * cos / (d * d); // clustered: base/pi * I * n.l / d^2 (inside its range window)
  assert.ok(Math.abs(lit / point - 1) < 1e-3, `${lit} vs ${point}`);
  // Seen from behind: a one-sided light is dark, a two-sided one lights the same as from the front.
  const [back] = pack({position: [0, 2, 0], direction: [0, 1, 0], width: 1, height: 1, intensity: 3}), [both] = pack({position: [0, 2, 0], direction: [0, 1, 0], width: 1, height: 1, intensity: 3, twoSided: true}), [front] = pack({position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 3});
  assert.deepEqual(ltc(back, o, n, view(30), base, 0.4, 0).total, [0, 0, 0]);
  close(ltc(both, o, n, view(30), base, 0.4, 0).total, ltc(front, o, n, view(30), base, 0.4, 0).total, 1e-6, 'two-sided');
});

test('LTC stays finite at normal incidence, on the light plane and at a corner', () => {
  const [l] = pack({position: [0, 1, 0], direction: [0, -1, 0], width: 2, height: 2, twoSided: true});
  for (const [p, v] of [[o, [0, 1, 0]], [[1, 1, 1], [0, 1, 0]], [[3, 1, 0], [0.3, 0.9, 0]], [[0.2, 0.5, 0], [0, 1, 0]]])
    for (const roughness of [0, 0.3, 1]) assert.ok(ltc(l, p, n, v, [1, 1, 1], roughness, 0.5).total.every(Number.isFinite), `${p} ${roughness}`);
});
