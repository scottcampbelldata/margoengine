// Plants round 1 (2026-11-28, "Above the Treeline"): grass grew right up to every boulder, and every kind of plant
// covered the ground evenly. Clearings thin instances around placed objects, clumps gather them into patches, and
// `reach` lets the parts of one plant keep the same instances. Their GPU counts are in grass.browser.mjs (step 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Scatter, scatterCullShader } from '../dist/index.js';

test('scatterCullShader: no clearings and no clumps leave the text as it was', () => {
  assert.equal(scatterCullShader({ clearings: [] }), scatterCullShader({}));
  assert.doesNotMatch(scatterCullShader({}), /var clear=|var clump=/);
});

test('scatterCullShader: clearings read their rows after the exclusions and path segments', () => {
  const code = scatterCullShader({
    exclusions: [[0, 0, 1, 1]],
    paths: [{ points: [[0, 0], [1, 0], [2, 0]], width: 1 }],
    clearings: [{ center: [3, 4], radius: 1, falloff: 2 }, { center: [5, 6], radius: 0.5 }],
  });
  // One exclusion and two segments of two rows each put the clearings at row 5.
  assert.match(code, /for\(var j=0u;j<2u;j\+\+\)\{let c=exclusions\[5u\+j\];/);
  assert.match(code, /if\(hash\(\(i\*7u\+6u\)\^0x2d1b6d2bu\)>=clear\)\{return;\}/);
  // Before the frustum test.
  assert.ok(code.indexOf('var clear=') < code.indexOf('frame.planes[j]'));
  // With follow, the hash is the world cell's.
  assert.match(scatterCullShader({ follow: true, clearings: [{ center: [0, 0], radius: 1 }] }), /hash\(\(key\*7u\+6u\)/);
});

test('scatterCullShader: clumps cut two octaves of noise at the cover with a soft rim', () => {
  const code = scatterCullShader({ clumps: { size: 6, cover: 0.4 } });
  assert.match(code, /let q=p\.xz\/6\.0\*/);
  assert.match(code, /clamp\(\(0\.4-clump\)\/0\.2\+0\.5,0\.0,1\.0\)/);
  assert.match(scatterCullShader({ clumps: { size: 2.5, cover: 1, edge: 0.05 } }), /\(1\.0-clump\)\/0\.05\+0\.5/);
});

test('Scatter: clearings fill the exclusions buffer after the paths, and reach widens the cull bounds', () => {
  const mesh = box(0.2, 0.4, 0.2);
  const plain = new Scatter(mesh, {});
  const wide = new Scatter(mesh, { reach: 3 });
  assert.equal(wide.values[35], 3);
  assert.ok(plain.values[35] < 1);
  const s = new Scatter(mesh, {
    exclusions: [[0, 0, 1, 1]],
    clearings: [{ center: [3, 4], radius: 1, falloff: 2 }],
  });
  assert.deepEqual([...s.exclusionValues.subarray(4, 8)], [3, 4, 1, 2]);
});

test('Scatter: clumps, clearings and reach are checked with messages that say how to fix them', () => {
  const mesh = box(0.2, 0.4, 0.2);
  for (const clumps of [{ size: 0, cover: 0.5 }, { size: 1, cover: 2 }, { size: 1, cover: 0.5, edge: 0 }, 3])
    assert.throws(() => new Scatter(mesh, { clumps }), /Scatter clumps need size/, JSON.stringify(clumps));
  for (const clearings of [
    [{ center: [0], radius: 1 }],
    [{ center: [0, 0], radius: -1 }],
    [{ center: [0, 0], radius: 1, falloff: Number.NaN }],
  ])
    assert.throws(() => new Scatter(mesh, { clearings }), /Scatter clearings need/, JSON.stringify(clearings));
  assert.throws(() => new Scatter(mesh, { reach: -1 }), /Scatter reach must be/);
});
