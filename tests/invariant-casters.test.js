// Guard for one class of bug: a shadow or depth caster whose clip position is not @invariant.
//
// Two programs that draw the same surface into one depth target must write the same depth. WGSL lets each program
// reassociate and fuse float operations (W3C WGSL 15.7.5), so the same light*model*p lands one or a few ulps apart
// unless the position output is declared @invariant (WGSL 12.10); on an Apple M6 (Chromium, Metal) that moved 37% of
// a shadow map's covered texels and shaded a receiver a level apart (docs/known-bugs.md, culling dynamic-check).
//
// The rule: every vertex position output of a caster shader in packages/*/src declares @invariant. Casters are found
// by tests/invariant-positions.mjs (by name, plus the colour modules a package also draws as its caster). A shader
// that only reads depth is listed in READS_DEPTH with its reason. A new caster that forgets the attribute, in any
// package, fails here; each package's own invariant-casters test covers its known casters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CASTER_MODULES, isCaster, positions, root } from './invariant-positions.mjs';

/**
 * Shaders named for depth that only read it, keyed `file:name` with the reason: no position of theirs lands in a shared
 * depth target. Full-screen triangles are skipped by the finder itself.
 */
const READS_DEPTH = {};

test('every shadow and depth caster position is @invariant (WGSL 12.10)', () => {
  const all = positions(),
    missing = [],
    seen = new Set();
  for (const p of all.filter(isCaster)) {
    const key = `${p.file}:${p.name}`;
    if (key in READS_DEPTH) {
      seen.add(key);
      continue;
    }
    if (!p.invariant) missing.push(`${p.file}:${p.line} (${p.struct || p.name})`);
  }
  assert.deepEqual(
    missing,
    [],
    'declare @invariant on these caster positions, or list a pure depth reader in READS_DEPTH',
  );
  for (const key of Object.keys(READS_DEPTH))
    assert.ok(seen.has(key), `READS_DEPTH lists ${key}, which no longer exists`);
  for (const file of Object.keys(CASTER_MODULES))
    assert.ok(
      all.some((p) => p.file === file && p.invariant),
      `${file} no longer declares an @invariant position`,
    );
});

test('the known casters are found by the rule', () => {
  // Each package with a custom caster: a rename or move that loses its attribute fails here instead of passing silently.
  const casters = positions().filter((p) => p.invariant);
  for (const file of [
    'packages/shadows/src/index.ts',
    'packages/shadows/src/shader.ts',
    'packages/culling/src/dynamic.ts',
    'packages/culling/src/parts.ts',
    'packages/culling/src/shadows.ts',
    'packages/culling/src/shaders.ts',
    'packages/culling/src/occluders.ts',
    'packages/scatter/src/index.ts',
    'packages/scatter/src/instances.ts',
    'packages/lod/src/imposter.ts',
    'packages/terrain/src/shader.ts',
    'packages/voxel/src/render.ts',
    'packages/voxel/src/bevel.ts',
    'packages/vfx/src/shadows.ts',
    'packages/splats/src/lighting.ts',
    'packages/animation/src/vat.ts',
    'packages/shader/src/raw.ts',
    'packages/clustered/src/shadows.ts',
    'packages/clustered/src/local-shadows.ts',
    'packages/studio/src/index.ts',
  ])
    assert.ok(
      casters.some((p) => p.file === file),
      `${file}: no @invariant caster position`,
    );
});

// A pass that redraws meshes with depthCompare 'equal' keeps only the pixels whose depth matches the colour pass bit for
// bit, so both its vertex and the colour vertex it replays must declare @invariant (WGSL 12.10); without it a compiler
// may fuse or reorder either program's float work and the replay drops pixels (docs/known-bugs.md, depth-equal
// replays). Each file that builds such a pipeline names the vertex positions it relies on, as `file: [struct or name]`.
const DEPTH_EQUAL = {
  // SSAO's ambient replay, SSGI's and SSR's replays redraw with core's shader (c.shader): core's colour vertex.
  // SSAO's occlusion replay also redraws registered gltf/pbr models with their own colour vertex (SSAOSource 'occlusion').
  'packages/post/src/ssao.ts': { 'packages/core/src/shaders.ts': ['Output'], 'packages/gltf/src/shader.ts': ['Out'] },
  'packages/post/src/ssgi.ts': { 'packages/core/src/shaders.ts': ['Output'] },
  'packages/post/src/ssr.ts': { 'packages/core/src/shaders.ts': ['Output'] },
  // The selection mask redraws core meshes with shared's meshVertex against core's colour depth.
  'packages/selection/src/index.ts': {
    'packages/core/src/shaders.ts': ['Output'],
    'packages/shared/gpu.js': ['Output'],
  },
  // TAA's object velocity redraws core meshes and gltf/pbr primitives with its own vertex, against their colour
  // depth; its world=f.model*p then camera*world matches gltf/pbr's colour vertex expression order.
  'packages/taa/src/index.ts': {
    'packages/core/src/shaders.ts': ['Output'],
    'packages/gltf/src/shader.ts': ['Out'],
    'packages/taa/src/shader.ts': ['Out'],
  },
  // RawShaders' MargoVelocity against the raw vertex entry.
  'packages/shader/src/raw.ts': { 'packages/shader/src/raw.ts': ['MargoVelocity'] },
  // XR's AR alpha pass replays no mesh: a full-screen triangle at the constant depth 0 matches only the pixels still at
  // reversed depth's clear value 0, which no vertex expression can round differently.
  'packages/xr/src/eyes.ts': {},
};

test('every depth-equal replay vertex and the colour vertex it replays are @invariant (WGSL 12.10)', () => {
  const all = positions(),
    found = [];
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', pkg, 'src');
    if (!existsSync(src)) continue;
    for (const path of walk(src))
      if (/depthCompare:\s*'equal'/.test(readFileSync(path, 'utf8')))
        found.push(relative(root, path).split('\\').join('/'));
  }
  assert.deepEqual(
    found.filter((file) => !(file in DEPTH_EQUAL)),
    [],
    "a new depthCompare 'equal' pass: list the vertex positions it relies on in DEPTH_EQUAL",
  );
  const missing = [];
  for (const [replay, vertices] of Object.entries(DEPTH_EQUAL)) {
    assert.ok(found.includes(replay), `DEPTH_EQUAL lists ${replay}, which no longer draws with depthCompare 'equal'`);
    for (const [file, names] of Object.entries(vertices))
      for (const name of names) {
        const matches = all.filter((p) => p.file === file && (p.struct === name || p.name === name));
        assert.ok(matches.length, `${file}: no vertex position output in ${name}`);
        for (const p of matches) if (!p.invariant) missing.push(`${replay} -> ${p.file}:${p.line} (${name})`);
      }
  }
  assert.deepEqual([...new Set(missing)], [], 'declare @invariant on these positions');
});

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}
