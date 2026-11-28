// Scott, 2026-11-27: "Nothing should be in a demo directly ever." check:demo-sources keeps a demo's source/ to wiring,
// UI and content, with a ratchet allowlist that only shrinks. This file tests the rules on fixtures, the ratchet logic,
// and the real tree against scripts/web-demos/source-allowlist.json. CPU only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RULES, R5_FLOOR, allowlistPath, compare, demosDir, entryFor, format, mask, scanDemos, scanText } from '../scripts/check-demo-sources.mjs';

const rules = (text) => scanText(text).hits.map((h) => h.rule);
const has = (text, rule) => assert.ok(rules(text).includes(rule), `${rule} expected in: ${text}`);
const hasNot = (text, rule) => assert.ok(!rules(text).includes(rule), `${rule} not expected in: ${text}`);

test('R1 finds shader text, raw shader imports and raw GPU use', () => {
  has('const code = `@fragment fn main() -> @location(0) vec4f { return vec4f(1); }`;', 'R1');
  has('const s = `#version 300 es\\nvoid main(){ gl_Position = vec4(0); }`;', 'R1');
  has("import { RawMesh } from '@margoengine/shader/raw';", 'R1');
  has('const m = device.createShaderModule({ code });', 'R1');
  has('engine.gpu.device.createBuffer({ size: 4 });', 'R1');
  has('device.queue.writeBuffer(buf, 0, data);', 'R1');
});

test('R1 leaves the demo-status readiness fence and backend tag alone', () => {
  hasNot('await engine.gpu.queue.onSubmittedWorkDone();', 'R1');
  hasNot("const kind = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu';", 'R1');
  hasNot('if (engine.gpu) await engine.gpu.queue.onSubmittedWorkDone();', 'R1');
});

test('R2 finds time-step updates, solver functions and physical constants', () => {
  has('body.y += body.vy * dt;', 'R2');
  has('state.x = state.x + v * stepTime;', 'R2');
  has('function integrate(s, dt) { s.x += 1; }', 'R2');
  has('const solve = (a, b) => a + b;', 'R2');
  has('const fall = 0.5 * 9.81 * t * t;', 'R2');
  has('const g = 9.80665;', 'R2');
  has('const drag = viscosity * speed;', 'R2');
});

test('R2 leaves wrappers over a package, comments, strings and constants handed to options', () => {
  hasNot('function step() { physics.step(); steps++; }', 'R2');
  hasNot('export function advance(s, seconds) {\n  s.physics.update(seconds);\n  s.time += seconds;\n}', 'R2');
  hasNot('async function advance() { await next(); }', 'R2');
  hasNot('function step(now) { requestAnimationFrame(step); }', 'R2');
  hasNot('// the sim does x += v * dt in the package', 'R2');
  hasNot("label.textContent = 'gravity 9.81 * dt';", 'R2');
  hasNot('export const gravity = 9.81;', 'R2');
  hasNot('colliders: { shape: "sphere", restitution, friction: 0.1 }', 'R2');
  hasNot('const smooth = 1 - Math.exp(-dt * 23);', 'R2');
});

test('R3 finds raw mesh data', () => {
  has('const positions = new Float32Array(3 * n);', 'R3');
  has('positions.push(x, y, z);', 'R3');
  has('indices.push(a, b, c);', 'R3');
  has('const g = new Geometry(p, n, i);', 'R3');
  has('mesh.set({ positions: [0, 0, 0, 1, 0, 0], indices: [0, 1, 2] });', 'R3');
});

test('R3 leaves a package geometry wrapped as is and an empty option list', () => {
  hasNot('const wrap = (g) => new Geometry(g.positions, g.normals, g.indices);', 'R3');
  hasNot('const convert = ({ positions, normals, indices }) => new Geometry(positions, normals, indices);', 'R3');
  hasNot("new Line({ positions: [], color: 'red' });", 'R3');
});

test('R4 finds local helpers but not a package import of the same name', () => {
  has('const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], 0, 0];', 'R4');
  has('function normalize(v) { return v; }', 'R4');
  has('function mulberry32(seed) { return () => 0; }', 'R4');
  has('const hash = (x) => x;', 'R4');
  has('function fbm(x, y) { return 0; }', 'R4');
  hasNot("import { cross, normalize } from '@margoengine/math';", 'R4');
  hasNot('const c = cross(a, b);', 'R4');
});

test('IMP allows @margoengine/*, margo-demo-status, relative paths and node: only', () => {
  hasNot("import { Stage } from '@margoengine/stage';\nimport './style.css';\nimport s from '../shared.js';\nimport { report } from 'margo-demo-status';", 'IMP');
  hasNot("import { readFile } from 'node:fs/promises';", 'IMP');
  has("import { IfcAPI } from 'web-ifc';", 'IMP');
  has("const lib = await import('lodash');", 'IMP');
  hasNot("const text = 'taken from \"somewhere\" else';", 'IMP');
});

test('mask keeps line numbers and blanks comments and strings', () => {
  const text = "a /* x\ny */ b // c\nd 'e f' `g\nh`\n";
  const out = mask(text);
  assert.equal(out.length, text.length);
  assert.equal(out.split('\n').length, text.split('\n').length);
  assert.ok(!/[xycefgh]/.test(out.replace(/\s+/g, '')));
});

test('R5 counts code lines only', () => {
  assert.equal(scanText('// note\n\nconst a = 1;\n/* b\n c */\nconst b = 2;\n').code, 2);
});

const counts = (over = {}) => ({ R1: 0, R2: 0, R3: 0, R4: 0, R5: 100, IMP: 0, ...over });
const scan = (c) => ({ demo: { counts: counts(c), hits: [{ rule: 'R4', file: 'demos/demo/source/a.js', line: 3, text: 'const cross = 1' }] } });

test('ratchet: a count above the allowlist fails and names file:line and the fix', () => {
  const problems = compare(scan({ R4: 2 }), { demos: { demo: { R4: 1 } } });
  assert.deepEqual(problems.map((p) => [p.kind, p.rule]), [['rose', 'R4']]);
  const message = format(problems);
  assert.match(message, /demos\/demo R4/);
  assert.match(message, /demos\/demo\/source\/a\.js:3/);
  assert.match(message, /use the package that owns it; see demos\/README\.md/);
});

test('ratchet: a demo missing from the allowlist fails on any hit, and R5 passes up to the floor', () => {
  assert.deepEqual(compare(scan({ R1: 1 }), { demos: {} }).map((p) => p.kind), ['rose']);
  assert.deepEqual(compare(scan({ R5: R5_FLOOR }), { demos: {} }), []);
  assert.deepEqual(compare(scan({ R5: R5_FLOOR + 1 }), { demos: {} }).map((p) => p.rule), ['R5']);
});

test('ratchet: a count that fell but was not lowered fails', () => {
  assert.deepEqual(compare(scan({ R4: 1 }), { demos: { demo: { R4: 3 } } }).map((p) => p.kind), ['fell']);
  assert.deepEqual(compare(scan({ R5: R5_FLOOR + 40 }), { demos: { demo: { R5: R5_FLOOR + 90 } } }).map((p) => p.kind), ['fell']);
});

test('ratchet: stale entries fail (zero count, unknown demo, unknown rule, R5 at or under the floor)', () => {
  assert.deepEqual(compare(scan({}), { demos: { demo: { R4: 0 } } }).map((p) => p.kind), ['stale']);
  assert.deepEqual(compare(scan({}), { demos: { gone: { R4: 1 } } }).map((p) => p.kind), ['stale']);
  assert.deepEqual(compare(scan({}), { demos: { demo: { R9: 1 } } }).map((p) => p.kind), ['stale']);
  assert.deepEqual(compare(scan({ R5: 120 }), { demos: { demo: { R5: R5_FLOOR + 10 } } }).map((p) => p.kind), ['stale']);
});

test('ratchet: equal counts pass', () => {
  assert.deepEqual(compare(scan({ R4: 1, R5: 500 }), { demos: { demo: { R4: 1, R5: 500 } } }), []);
  assert.deepEqual(entryFor(counts({ R4: 2, R5: 500 })), { R4: 2, R5: 500 });
  assert.deepEqual(entryFor(counts()), {});
});

test('the real demos match the allowlist; newtons-cradle runs on the package and scores zero everywhere but wiring lines', () => {
  const found = scanDemos(demosDir);
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  const problems = compare(found, allowlist);
  assert.deepEqual(problems, [], `\n${format(problems)}`);
  assert.ok(Object.keys(found).length >= 200, 'the scan should see every demo with a source/ folder');
  const cradle = found['newtons-cradle'].counts;
  for (const rule of RULES.filter((r) => r !== 'R5')) assert.equal(cradle[rule], 0, `newtons-cradle ${rule}`);
  assert.ok(!('newtons-cradle' in allowlist.demos) || !('R2' in allowlist.demos['newtons-cradle']));
});

test('the allowlist is well formed', () => {
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  assert.equal(allowlist.r5Floor, R5_FLOOR);
  for (const [demo, entry] of Object.entries(allowlist.demos)) {
    assert.ok(!/[\\/]/.test(demo), demo);
    for (const [rule, value] of Object.entries(entry)) {
      assert.ok(RULES.includes(rule), `${demo}: ${rule}`);
      assert.ok(Number.isInteger(value) && value > 0, `${demo}.${rule}`);
    }
  }
});
