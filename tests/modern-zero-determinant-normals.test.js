// Class check for KB-GLTFA B1 (zero scale): a normal turned by the cofactor matrix must not be multiplied by sign() of
// the model determinant. sign(0) is 0 for a node flattened by a zero scale, so the normal became zero and the lit colour
// NaN, and a handedness of 0 flipped the single-sided test. Shaders write select(-1.0,1.0,det>=0.0) (GLSL:
// d<0.?-1.:1.), and JS writes det < 0 ? -1 : 1, so det = 0 counts as not mirrored. References: Turkowski,
// "Properties of Surface-Normal Transformations", Graphics Gems (1990); glTF 2.0 section 3.5.3.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const packages = new URL('../packages/', import.meta.url);

// sign() of a scalar triple product dot(a,cross(b,c)): the determinant of a 3x3 matrix, in WGSL, GLSL or JS.
const tripleSign = /\bsign\(\s*dot\([^;]*?\bcross\(/;
// sign() of a variable named det or determinant.
const detSign = /\bsign\(\s*(?:det|determinant)\s*\)/;

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
    const lines = readFileSync(new URL(file, packages), 'utf8').split(/\r?\n/);
    scanned++;
    lines.forEach((line, i) => {
      if (allowed.has(file)) return;
      if (tripleSign.test(line) || detSign.test(line)) found.push(`packages/${file}:${i + 1}`);
    });
  }
  assert.ok(scanned > 500, `scanned ${scanned} source files`);
  assert.deepEqual(found, [], 'use select(-1.0,1.0,det>=0.0) or det < 0 ? -1 : 1, and guard a zero normal');
});

test('every allowed site still holds a sign of a determinant, so the list cannot go stale', () => {
  for (const file of allowed.keys()) {
    const text = readFileSync(new URL(file, packages), 'utf8');
    assert.ok(tripleSign.test(text) || detSign.test(text), `${file} no longer needs its entry`);
  }
});
