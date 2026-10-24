// Collada on a real file: Cesium Man (Khronos glTF-Sample-Models sourceModels, CC BY 4.0, Cesium), a 20-joint skinned
// walk cycle exported from Blender. The skin bound for the GPU (bindDAESkin + daeKeyframeClip, posed by the animation
// package's Skeleton and Skin) must match the loader's own CPU pose (poseDAE + flattenDAE) vertex for vertex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDAE, poseDAE, flattenDAE, bindDAESkin, daeKeyframeClip } from '../dist/index.js';
import { Skeleton, Skin, createKeyframeClip, applyKeyframeClip } from '../../animation/dist/index.js';

const text = readFileSync(new URL('../../../examples/assets/khronos-samples/CesiumMan.dae', import.meta.url), 'utf8');
const box = (p) => {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k]);
      max[k] = Math.max(max[k], p[i + k]);
    }
  return { min, max };
};
const positionsOf = (flat) => flat.positions ?? flat.meshes?.[0]?.positions ?? flat[0]?.positions;

test('Cesium Man parses cleanly into a Y-up, metre-sized, 20-joint skin with a 2 s walk', () => {
  const dae = parseDAE(text);
  assert.deepEqual(dae.warnings, []);
  assert.equal(dae.skins.length, 1);
  const binding = bindDAESkin(dae);
  assert.equal(binding.bones.length, 20);
  assert.equal(binding.geometry.positions.length / 3, 14016);
  assert.equal(binding.joints.length, (binding.geometry.positions.length / 3) * 4);
  for (let v = 0; v < binding.weights.length; v += 4) {
    const sum = binding.weights[v] + binding.weights[v + 1] + binding.weights[v + 2] + binding.weights[v + 3];
    assert.ok(Math.abs(sum - 1) < 1e-5, `vertex ${v / 4} weights sum to ${sum}`);
  }
  const { min, max } = box(binding.geometry.positions);
  assert.ok(min[1] > -0.01 && Math.abs(max[1] - 1.507) < 0.01, `stands on y = 0, 1.5 m tall: ${min[1]}..${max[1]}`);
  const clip = createKeyframeClip(daeKeyframeClip(dae, { fps: 30 }));
  assert.equal(clip.duration, 2);
});

test('the GPU skin path poses Cesium Man exactly as the loader does, and the walk moves', () => {
  const dae = parseDAE(text),
    binding = bindDAESkin(dae),
    skeleton = new Skeleton(binding.bones, binding.inverseBindMatrices),
    skin = new Skin(skeleton, binding.joints, binding.weights),
    clip = createKeyframeClip(daeKeyframeClip(dae, { fps: 30 }));
  let previous;
  for (const seconds of [0, 0.5, 1.25, 1.9]) {
    applyKeyframeClip(clip, skeleton, seconds);
    const gpu = skin.pose(binding.geometry.positions).positions,
      cpu = positionsOf(flattenDAE(dae, poseDAE(dae, seconds)));
    assert.equal(gpu.length, cpu.length);
    let worst = 0;
    for (let i = 0; i < cpu.length; i++) worst = Math.max(worst, Math.abs(gpu[i] - cpu[i]));
    // The clip is resampled at 30 fps, so between samples the two agree to well under a millimetre.
    assert.ok(worst < 1e-3, `at ${seconds} s the two poses differ by ${worst} m`);
    assert.ok(!cpu.some(Number.isNaN));
    if (previous) {
      let moved = 0;
      for (let i = 0; i < cpu.length; i++) moved = Math.max(moved, Math.abs(cpu[i] - previous[i]));
      assert.ok(moved > 0.05, `the walk moves between frames (${moved} m)`);
    }
    previous = cpu;
  }
});
