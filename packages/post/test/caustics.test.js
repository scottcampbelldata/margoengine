// SurfaceCaustics (@margoengine/post/caustics), the CPU half: option checks, the copied geometry and the shared shader
// builders water/caustics draws with. The drawn light (flat transmission, no light past the surface, ripples that move
// light without making or losing it, both backends) is surface-caustics-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceCaustics, causticBeams, causticProject, causticRange } from '../dist/caustics.js';

const square = { positions: [0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1], indices: [0, 2, 1, 0, 3, 2] };

test('SurfaceCaustics checks its options and copies its surface', () => {
  assert.throws(() => new SurfaceCaustics(), TypeError);
  assert.throws(() => new SurfaceCaustics({ geometry: { positions: [0, 0] } }), /xyz positions/);
  assert.throws(() => new SurfaceCaustics({ geometry: { ...square, indices: [0, 1, 9] } }), /index 9 is outside 0..3/);
  assert.throws(() => new SurfaceCaustics({ geometry: { ...square, normals: [0, 1, 0] } }), /one xyz per position/);
  for (const [key, value] of [
    ['resolution', 100],
    ['resolution', 16],
    ['layers', 1],
    ['refractiveIndex', 0.9],
    ['intensity', -1],
    ['heightRange', [1, 0]],
    ['center', [0]],
    ['absorption', [0, 0]],
  ])
    assert.throws(() => new SurfaceCaustics({ geometry: square, [key]: value }), RangeError, key);
  assert.throws(() => new SurfaceCaustics({ geometry: square, shadows: {} }), TypeError);
  const positions = [...square.positions],
    effect = new SurfaceCaustics({ geometry: { positions, indices: square.indices } });
  positions[1] = 99;
  assert.equal(effect['bounds'][4], 1, 'the surface is copied');
  // Normals default to the area-weighted face normals (up for this square, wound counter-clockwise from above).
  assert.deepEqual([...effect['data'].subarray(3, 6)], [0, 1, 0]);
  assert.throws(() => effect.setup({ gpu: {} }), /runs inside a PostStack/);
  effect.dispose();
  assert.throws(() => effect.setGeometry(square), /disposed/);
});

test('the shared beam shaders take any surface and mask', () => {
  const surface = {
    prelude: '// P',
    bindings: '// B',
    sample: 'return Sample(vec3f(0),vec3f(0,1,0),vec2f(0));',
    dry: '',
    triangles: 1000,
  };
  const beams = causticBeams(surface, '');
  assert.ok(beams.startsWith('// P') && beams.includes('// B') && beams.includes('fn beamVertex'));
  assert.ok(causticRange(surface).includes('if(id.x>=1000u)'));
  const water = causticProject('', { mask: { bindings: '// field', test: '// wet' } });
  assert.ok(
    water.includes('// field') &&
      water.includes('// wet') &&
      water.includes('return vec4f(causticLight(at.xy,color.rgb),0);'),
  );
  const composite = causticProject('', { composite: true, encode: true });
  assert.ok(composite.includes('toDisplay(lit)') && !composite.includes('field'));
});
