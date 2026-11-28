// No package text names a vertex limit the code does not have. Core's `Geometry` cap and gltf/pbr's per-primitive
// cap both rose from one million vertices, and comments kept saying one million (KB0097 in loaders, then
// KB-VERTCAP-TEXT1 in voxel-edit, loaders and mesh-edit), so a reader split or refused meshes the engine takes.
// The packages whose own cap is one million (materials meshes, the light glTF loader, geometry/gpu) name themselves.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MILLION = String.raw`(?:1,000,000|1_000_000|[Oo]ne million|a million)`;
// A claim is the owner and the number close together in one sentence (no full stop between them), either way round.
const STALE = [
  new RegExp(String.raw`\b[Cc]ore\W{1,3}(?:s\W+)?Geometry\W[^.\n]{0,40}${MILLION}`),
  new RegExp(String.raw`${MILLION}[^.\n]{0,40}\b[Cc]ore\W{1,3}(?:s\W+)?Geometry`),
  new RegExp(String.raw`\bcore (?:vertex )?(?:limit|cap)[^.\n]{0,30}${MILLION}`),
  new RegExp(String.raw`${MILLION} as the core (?:vertex )?(?:limit|cap)`),
  new RegExp(String.raw`gltf\\?/pbr(?:'s| takes| draws)(?: up to)? ${MILLION}`),
];

function texts() {
  const files = [join(root, 'README.md')];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|js|mjs|md)$/.test(entry.name)) files.push(path);
    }
  };
  for (const name of readdirSync(join(root, 'packages'))) {
    const folder = join(root, 'packages', name);
    if (existsSync(join(folder, 'src'))) walk(join(folder, 'src'));
    if (existsSync(join(folder, 'README.md'))) files.push(join(folder, 'README.md'));
  }
  return files;
}

const stale = (line) => STALE.some((pattern) => pattern.test(line));

test('the patterns find the sentences that were wrong', () => {
  for (const line of [
    '`partitionMesh` splits a mesh into parts of at most 250,000 quads (one million vertices, core `Geometry`’s limit)',
    '/** Most quads per part, 1 to 250,000 (core `Geometry` takes at most 1,000,000 vertices). Default 250,000. */',
    ' * Splits a mesh from {@link meshGrid} into parts a core `Geometry` (at most 1,000,000 vertices) and one material',
    '   * Lower it for a renderer whose per-primitive limit is smaller (gltf/pbr takes 1,000,000).',
    "/** @throws RangeError when the mesh is over gltf\\/pbr's 1,000,000 vertices per primitive. */",
    'loaders named 1,000,000 as the core limit',
  ])
    assert.ok(stale(line), line);
  assert.ok(!stale('A part fits one materials mesh (at most 1,000,000 vertices).'));
  assert.ok(!stale('Core takes any size. The light glTF loader takes up to 1,000,000 vertices.'));
});

test("no package source or README names a million vertices as core's or gltf/pbr's limit", () => {
  const found = [];
  for (const file of texts())
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (stale(line)) found.push(`${file.slice(root.length)}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
  assert.deepEqual(found, []);
});

test('the limits the text may name are the ones the code enforces', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  assert.match(read('packages/loaders/src/geometry.ts'), /CORE_MAX_VERTICES = 11_184_810;/);
  assert.match(read('packages/gltf/src/parts.ts'), /PRIMITIVE_VERTICES = 16_777_216;/);
});
