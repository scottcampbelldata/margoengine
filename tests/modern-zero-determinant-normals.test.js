// Class check for KB-GLTFA B1 (zero scale): a normal turned by the cofactor matrix must not be multiplied by sign() of
// the model determinant. sign(0) is 0 for a node flattened by a zero scale, so the normal became zero and the lit colour
// NaN, and a handedness of 0 flipped the single-sided test. Shaders write select(-1.0,1.0,det>=0.0) (GLSL:
// d<0.?-1.:1.), and JS writes det < 0 ? -1 : 1, so det = 0 counts as not mirrored. References: Turkowski,
// "Properties of Surface-Normal Transformations", Graphics Gems (1990); glTF 2.0 section 3.5.3.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const packages = new URL('../packages/', import.meta.url);

// The ways a determinant reaches sign(), in WGSL, GLSL or JS. Each is matched over a whole file, so an argument that
// starts on the next line (a call Prettier wraps as `Math.sign(` then the expression) is caught too: a line-by-line
// scan missed the selection pick pass's node handedness that way.
const patterns = [
  // sign() of a scalar triple product dot(a,cross(b,c)): the determinant of a 3x3 matrix.
  /\bsign\(\s*dot\([^;]*?\bcross\(/g,
  // sign() of a value or call named det or determinant (det, detM, det3(m), m.determinant(), determinant(m)).
  /\bsign\(\s*(?:[\w$]+(?:\[[^\]]*\])?\.)*[dD]et(?:erminant)?(?:[A-Z0-9_][\w$]*)?(?![\w$])/g,
  // sign() of a cofactor expansion written out: a * (b * c - d * e) ...
  /\bsign\(\s*[^;()]*?\*\s*\(\s*[^;()]*?\*[^;()]*?-[^;()]*?\*[^;()]*?\)/g,
];

/** The 1-based line of every sign() of a determinant in `text`. */
const signedDeterminants = (text) => {
  const lines = new Set();
  for (const re of patterns) for (const m of text.matchAll(re)) lines.add(text.slice(0, m.index).split('\n').length);
  return [...lines].sort((a, b) => a - b);
};

// Sites where det is never 0 or is not a model matrix's determinant, with the reason.
const allowed = new Map([
  ['geometry/src/decal.ts', 'throws on a singular matrix before the sign'],
  ['geometry/src/utils.ts', 'throws on a singular matrix before the sign'],
  ['labels/src/callouts-route.ts', 'a 2D orientation test, guarded against 0'],
  ['math/src/quat.ts', 'splitTRS returns singular for det 0 right after'],
  ['sciviz/src/curvilinear-grid.ts', 'throws on a singular cell before the sign'],
  ['sciviz/src/probe.ts', 'throws on det 0 before the sign'],
  ['terrain/src/shader.ts', 'screen-space bump frame, 0 gives no bump'],
]);

const sources = () => {
  const files = [];
  for (const name of readdirSync(packages, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const src = new URL(`${name.name}/src/`, packages);
    let entries;
    try {
      entries = readdirSync(src, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = String(entry).replaceAll('\\', '/');
      if (/\.(ts|js|mjs|wgsl|glsl)$/.test(path) && !path.endsWith('.d.ts')) files.push(`${name.name}/src/${path}`);
    }
  }
  return files;
};

test('no normal path multiplies by sign() of a model determinant (a zero scale gives a zero normal)', () => {
  const found = [];
  let scanned = 0;
  for (const file of sources()) {
    const text = readFileSync(new URL(file, packages), 'utf8');
    scanned++;
    if (allowed.has(file)) continue;
    for (const line of signedDeterminants(text)) found.push(`packages/${file}:${line}`);
  }
  assert.ok(scanned > 500, `scanned ${scanned} source files`);
  assert.deepEqual(found, [], 'use select(-1.0,1.0,det>=0.0) or det < 0 ? -1 : 1, and guard a zero normal');
});

test('every allowed site still holds a sign of a determinant, so the list cannot go stale', () => {
  for (const file of allowed.keys()) {
    const text = readFileSync(new URL(file, packages), 'utf8');
    assert.ok(signedDeterminants(text).length > 0, `${file} no longer needs its entry`);
  }
});

test('the matcher finds a sign() whose determinant starts on the next line, and leaves the safe forms alone', () => {
  // The selection pick pass's node handedness before 0aed03c203, which the line-by-line scan missed.
  const wrapped = [
    '      values[34] = p.texCoord ?? 0;',
    '      values[35] = Math.sign(',
    '        m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]),',
    '      );',
  ].join('\n');
  assert.deepEqual(signedDeterminants(wrapped), [2]);
  assert.deepEqual(signedDeterminants('a;\nn *= sign(\n  dot(m0.xyz,\n  cross(m1.xyz, m2.xyz)));'), [2]);
  assert.deepEqual(signedDeterminants('let s = sign(determinant(m));'), [1]);
  assert.deepEqual(signedDeterminants('const s = Math.sign(\r\n  detM,\r\n);'), [1]);
  assert.deepEqual(signedDeterminants('const s = Math.sign(this.matrix.determinant());'), [1]);
  for (const safe of [
    'o.face=select(-1.0,1.0,dot(cross(a,b),c)>=0.0);',
    'const s = det < 0 ? -1 : 1;',
    'float s = d < 0. ? -1. : 1.;',
    'const s = Math.sign(detail);',
    'const s = Math.sign(x - y);',
  ])
    assert.deepEqual(signedDeterminants(safe), [], safe);
});
