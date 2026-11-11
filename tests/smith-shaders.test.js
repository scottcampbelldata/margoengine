// Regression (KB6016, 2026-11-11): KB5875a moved core, its WebGL2 twin and gltf-pro to the height-correlated Smith G2
// (Heitz 2014, JCGT 3(2), eq. 99), but clustered, materials, terrain, lod imposters, animation VAT, post material decals
// and voxel still wrote the separable G1 G1 of the shared `smithG` (and `ggxNamed`), so a clustered light and the sun
// shaded one surface with different masking. Every PBR direct light now writes G2; the separable text is gone.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import * as terms from '../packages/shared/light-terms.js';
import { correlatedG2, shaderExpression, smithGrid } from './support/smith-reference.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('the shared light terms offer only the height-correlated G2, by name and over prefixed names', () => {
  assert.equal('smithG' in terms, false, 'the separable smithG export is gone');
  assert.equal('smithGFloat' in terms, false, 'the separable smithGFloat export is gone');
  const named = shaderExpression(terms.ggxNamed('q2', 'qh', 'qv', 'ql')[1], ['ql', 'qv', 'q2']);
  for (const [nl, nv, a2] of smithGrid())
    assert.ok(Math.abs(named(nl, nv, a2) - correlatedG2(nl, nv, a2)) < 1e-12, `ggxNamed G at ${nl}, ${nv}, ${a2}`);
});

// Each direct light that declares `g` takes it from the shared height-correlated text.
const users = {
  'packages/clustered/src/shader.ts': 2,
  'packages/materials/src/eye.ts': 1,
  'packages/materials/src/shader.ts': 1,
  'packages/materials/src/skin.ts': 1,
  'packages/terrain/src/shader.ts': 1,
  'packages/animation/src/vat.ts': 2,
  'packages/lod/src/imposter.ts': 1,
  'packages/post/src/material-decals.ts': 1,
  'packages/voxel/src/render.ts': 1,
};

test('every PBR direct light takes g from smithGCorrelated', () => {
  for (const [file, count] of Object.entries(users)) {
    const text = read(file),
      found = [...text.matchAll(/let g=\$\{(\w+)\};/g)].map((match) => match[1]);
    assert.equal(found.length, count, `${file} declares g ${count} times`);
    for (const name of found) assert.match(name, /^smithGCorrelated(Float)?$/, `${file} uses ${name}`);
  }
});

test("materials' anisotropic lobe is the height-correlated G2 and meets the isotropic one at equal widths", () => {
  const text = /let materialG2=([^;]+);/.exec(read('packages/materials/src/lobe-shader.ts'))?.[1];
  assert.ok(text, 'the anisotropic lobe declares materialG2');
  const g2 = shaderExpression(text, ['materialNL', 'materialNV', 'materialViewLength', 'materialLightLength']);
  // Isotropic widths: |(a tv, a bv, nv)| = sqrt(a2 (1 - nv^2) + nv^2).
  const length = (c, a2) => Math.sqrt(a2 * (1 - c * c) + c * c);
  for (const [nl, nv, a2] of smithGrid())
    assert.ok(Math.abs(g2(nl, nv, length(nv, a2), length(nl, a2)) - correlatedG2(nl, nv, a2)) < 1e-12);
});

// The separable form G1(v) G1(l), each G1 written 2 x / (x + sqrt(...)) or 2 x / (x + width), anywhere in package
// source. One known exception remains, tracked as its own row.
const separable = /2(?:\.0)?\s*\*\s*(\w+)\s*\/\s*(?:max\()?\(?\s*\1\s*\+\s*(?:sqrt\(|length\(|\w+\))/;
const exceptions = {
  // KB6016b: environment's split-sum DFG table (Karis 2013) still integrates the separable G; changing it moves every
  // image-based-lighting picture and the batch 160 reference budgets, so it is its own row.
  'packages/environment/src/shaders.ts': 1,
};

function* sources(dir) {
  for (const name of readdirSync(new URL(dir, root))) {
    const path = `${dir}/${name}`;
    if (statSync(new URL(path, root)).isDirectory()) yield* sources(path);
    else if (/\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

test('no package source writes the separable Smith product outside the listed exception', () => {
  const hits = {};
  const dirs = readdirSync(new URL('packages', root))
    .map((name) => `packages/${name}/src`)
    .filter((dir) => {
      try {
        return statSync(new URL(dir, root)).isDirectory();
      } catch {
        return false;
      }
    });
  for (const file of [...dirs.flatMap((dir) => [...sources(dir)]), ...sources('packages/shared')]) {
    const count = read(file)
      .split('\n')
      .filter((line) => separable.test(line)).length;
    if (count) hits[file] = count;
  }
  assert.deepEqual(hits, exceptions);
});

// Regression (KB6016c, 2026-11-11): the shared GGX D wrote |n x h|^2 + a2 nh^2, which equals the textbook
// nh^2 (a2 - 1) + 1 only where dot(n, h) >= 0; with nh clamped to 0 and h facing away it fell below 1 and reached 0 as
// h turned to -n, so D was unbounded on back-facing shading normals (terrain crest specks on the WebGL2 layer). Every
// shader that takes ggxD or ggxDOf gets a2 / pi there, and the textbook value where h faces the normal.
test('the shared GGX D is a2 / pi where the half vector faces away, and the textbook D elsewhere', () => {
  const forms = {
      ggxD: shaderExpression(terms.ggxD, ['n', 'h', 'nh', 'a2']),
      ggxDFloat: shaderExpression(terms.ggxDFloat, ['n', 'h', 'nh', 'a2']),
      ggxDOf: shaderExpression(terms.ggxDOf('s.n', 'q'), ['s', 'q', 'nh', 'a2']),
    },
    n = [0, 0, 1];
  assert.equal(terms.ggxD, terms.ggxDOf('n', 'h'), 'ggxD is ggxDOf over n and h, written as a literal so bundles drop it unused');
  for (const [name, d] of Object.entries(forms)) {
    const call = (h, nh, a2) => (name === 'ggxDOf' ? d({ n }, h, nh, a2) : d(n, h, nh, a2));
    for (const c of [-0.999, -0.9, -0.5, -0.1, -1e-6, 0.3, 0.9, 0.999])
      for (const roughness of [0.03, 0.2, 0.5, 1]) {
        const a2 = roughness ** 4,
          h = [Math.sqrt(1 - c * c), 0, c],
          nh = Math.max(0, c),
          want = a2 / (3.14159265 * (nh * nh * (a2 - 1) + 1) ** 2);
        assert.ok(Math.abs(call(h, nh, a2) / want - 1) < 1e-6, `${name} at dot(n, h) ${c}, roughness ${roughness}`);
      }
  }
});
