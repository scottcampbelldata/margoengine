import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// KB-TERRAIN-ROCKSMEAR1 (Above the Treeline look round 10): with `TerrainOptions.rock` the lit shader picked the layer
// colour's triplanar projections by the rock structure's normal, so a bench's near-level normal or a facet's tilt on a
// steep face projected the texture along the face and drew it as streaks down every rock wall. The structure only
// shades: the colour reads the surface's own normal, in the terrain's shader and in the layer materials' patch.
const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('the rock structure shades, while the layer colour reads the surface normal', () => {
  for (const [name, text] of [
    ['shader.ts', source('shader.ts')],
    ['layers-pbr.ts', source('layers-pbr.ts')],
  ]) {
    const calls = text.match(/terrainColor\(i\.position,[^)]*\)\)?\*terrainRockShade/g) ?? [];
    assert.ok(calls.length >= 2, `${name} shades rock`);
    for (const call of calls)
      assert.equal(call, 'terrainColor(i.position,normalize(i.normal))*terrainRockShade', `${name}: ${call}`);
  }
});
