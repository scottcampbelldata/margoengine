// Proof for @margoengine/animation: sampling a track into a reused buffer versus a fresh one per call.
// Run: node examples/package-benchmarks/proofs/animation.proof.js [ref] [pin]
// Pinned: 59350fc against f47ff3f, the commit that recorded results/animation.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('59350fc', 'f47ff3f'), {baseline, candidate} = await versions('animation', ref, undefined, pin);
const cases = [];
for (const [interpolation, width, quaternion] of [['LINEAR', 3, false], ['LINEAR', 4, true], ['CUBICSPLINE', 3, false], ['STEP', 3, false]]) {
  const keys = 64, times = Float32Array.from({length: keys}, (_, i) => i / 30);
  const values = Float32Array.from({length: keys * width * (interpolation === 'CUBICSPLINE' ? 3 : 1)}, (_, i) => Math.sin(i * 1.7) + 0.2);
  const out = new Float32Array(width), at = i => (i % 997) / 997 * (keys - 1) / 30;
  // Same answers first, then speed: 200,000 samples is about 55 animated joints for one minute at 60 FPS.
  for (let i = 0; i < 2000; i++) assert.deepEqual(candidate.sampleTrackInto(times, values, width, at(i), interpolation, quaternion, out), baseline.sampleTrack(times, values, width, at(i), interpolation, quaternion));
  cases.push({case: `${interpolation} width ${width}`, samples: 200000, ...time(
    () => {for (let i = 0; i < 200000; i++) baseline.sampleTrack(times, values, width, at(i), interpolation, quaternion);},
    () => {for (let i = 0; i < 200000; i++) candidate.sampleTrackInto(times, values, width, at(i), interpolation, quaternion, out);})});
}
await record('animation', ref, cases, 'Animation.seek now samples into per-track buffers; sampleTrack still returns a fresh array.', pin);
