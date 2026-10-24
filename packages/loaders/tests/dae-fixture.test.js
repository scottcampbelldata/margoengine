// The demo's Collada file (examples/assets/animation-formats/bend-tube.dae): a 208-vertex tube skinned to three
// joints, its two upper joints bent about Z by LINEAR keys. The posed top ring must sit where the joint chain puts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDAE, poseDAE, flattenDAE, bindDAESkin, daeKeyframeClip } from '../dist/index.js';

const text = readFileSync(new URL('../../../examples/assets/animation-formats/bend-tube.dae', import.meta.url), 'utf8');

test('the bend-tube fixture binds three joints and poses its top ring by the joint chain', () => {
  const dae = parseDAE(text);
  assert.deepEqual(dae.warnings, []);
  const binding = bindDAESkin(dae);
  assert.deepEqual(
    binding.bones.map((b) => b.name),
    ['J0', 'J1', 'J2'],
  );
  assert.equal(binding.geometry.positions.length / 3, 208);
  const clip = daeKeyframeClip(dae, { fps: 30 });
  assert.ok(clip.tracks.length >= 2);
  for (const [seconds, a1, a2] of [
    [0, 0, 0],
    [0.5, 35, 45],
    [0.25, 17.5, 22.5],
    [1.5, -35, -45],
  ]) {
    const meshes = flattenDAE(dae, poseDAE(dae, seconds)),
      positions = meshes.positions ?? meshes.meshes?.[0]?.positions ?? meshes[0]?.positions;
    // Centre of the last ring (y = 3 at rest): J2 + R(a1 + a2) * (0, 1, 0), J2 = (0, 1, 0) + R(a1) * (0, 1, 0).
    const r1 = (a1 * Math.PI) / 180,
      r2 = ((a1 + a2) * Math.PI) / 180,
      expected = [-Math.sin(r1) - Math.sin(r2), 1 + Math.cos(r1) + Math.cos(r2)];
    const top = positions.length / 3 - 16,
      centre = [0, 0, 0];
    for (let i = top; i < top + 16; i++) for (let k = 0; k < 3; k++) centre[k] += positions[i * 3 + k] / 16;
    assert.ok(Math.abs(centre[0] - expected[0]) < 1e-3, `x at ${seconds}s: ${centre[0]} vs ${expected[0]}`);
    assert.ok(Math.abs(centre[1] - expected[1]) < 1e-3, `y at ${seconds}s: ${centre[1]} vs ${expected[1]}`);
    assert.ok(Math.abs(centre[2]) < 1e-3);
  }
});
