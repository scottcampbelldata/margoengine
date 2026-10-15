// Proof for @margoengine/animator: pose sampling writes through one scratch buffer per track width into the vectors
// the pose already owns, and clip blending normalizes quaternions in place, instead of allocating per track and joint.
// Run: node examples/package-benchmarks/proofs/animator.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/animator.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('animator', ref, undefined, pin);

// A 64-joint humanoid: every joint has translation, rotation and scale tracks in each full-body clip, the face joint
// carries four morph weights, and 'Wave' only touches one arm (the usual additive upper-body layer).
const JOINTS = 64, KEYS = 32, noise = seed => {let s = seed >>> 0; return () => ((s = Math.imul(s ^ s >>> 15, s | 1) + 0x6d2b79f5 >>> 0) / 4294967296);};
function clip(name, seed, joints, interpolations) {
  const next = noise(seed), tracks = [], times = Float32Array.from({length: KEYS}, (_, i) => i / 30);
  for (const node of joints) for (const [path, width] of [['translation', 3], ['rotation', 4], ['scale', 3]]) {
    const interpolation = interpolations[(node + width) % interpolations.length], factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
    const values = Float32Array.from({length: KEYS * width * factor}, () => path === 'scale' ? 0.5 + next() : next() * 2 - 1);
    tracks.push({node, path, times, values, width, interpolation});
  }
  return {name, duration: times.at(-1), tracks};
}
function world(log) {
  const all = Array.from({length: JOINTS}, (_, i) => i), next = noise(7), count = JOINTS + 1;
  const transforms = Object.fromEntries(['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map(key => [key, Float32Array.from({length: count}, () => key[0] === 's' ? 1 : key === 'qw' ? 1 : key[0] === 'q' ? 0 : next())]));
  const store = {transforms, parents: Int32Array.from({length: count}, (_, i) => i - 1)}, engine = {store};
  const write = (kind, value) => {if (log) {log.push(kind, value.length); for (let i = 0; i < value.length; i++) log.push(value[i]);}};
  const nodes = all.map(i => ({id: i + 1, engine, setPosition(v) {write(1, v); return this;}, setScale(v) {write(2, v); return this;}, setQuaternion(v) {write(3, v); return this;}}));
  const clips = [clip('Idle', 1, all, ['LINEAR']), clip('Walk', 2, all, ['LINEAR', 'LINEAR', 'STEP']), clip('Run', 3, all, ['LINEAR', 'CUBICSPLINE']), clip('Strafe', 4, all, ['LINEAR']), clip('Wave', 5, [20, 21, 22, 23], ['LINEAR'])];
  // Morph weights: one track on a joint with a primitive, one narrower than its primitive, one on a joint without any.
  const weights = (node, width, seed) => {const n = noise(seed); return {node, path: 'weights', times: clips[0].tracks[0].times, values: Float32Array.from({length: KEYS * width}, n), width, interpolation: 'LINEAR'};};
  clips[1].tracks.push(weights(5, 4, 11), weights(6, 3, 12), weights(40, 2, 13)); clips[2].tracks.push(weights(5, 4, 14)); clips[4].tracks.push(weights(5, 4, 15));
  clips.push({name: 'Still', duration: 0, tracks: [{node: 3, path: 'rotation', times: new Float32Array([0]), values: new Float32Array([0, 0.6, 0, 0.8]), width: 4, interpolation: 'STEP'}]});
  const primitives = [{nodeIndex: 5, weights: new Float32Array(4)}, {nodeIndex: 6, weights: new Float32Array(4)}];
  return {animation: {name: 'animation:hero', playing: true, clips, model: {name: 'hero', nodes, primitives, root: {engine}, disposed: false}}, primitives};
}
const states = {
  idle: 'Idle', still: 'Still',
  locomotion: {parameter: 'speed', samples: [{value: 0, clip: 'Idle'}, {value: 1.5, clip: 'Walk'}, {value: 5, clip: 'Run'}]},
  strafe: {parameters: ['x', 'y'], samples: [{value: [0, 0], clip: 'Idle'}, {value: [0, 1], clip: 'Walk'}, {value: [1, 0], clip: 'Strafe'}, {value: [0, 2], clip: 'Run'}]},
};
const options = initial => ({states, initial, parameters: {speed: 0, x: 0, y: 0}, transitions: [{from: 'idle', to: 'locomotion', when: p => p.speed > 4.9, duration: 0.2}]});

// Same answers first: a scripted 900-frame session covering every blend tree, automatic and manual transitions with
// and without fades (including a fade interrupted by another), additive layers with a reference pose, zero-length
// clips, exact blend sample hits and uneven frame times. Every setPosition/setScale/setQuaternion call and the morph
// weights written to the primitives must match bit for bit.
function session(module) {
  const log = [], {animation, primitives} = world(log), animator = new module.Animator(animation, options('idle'));
  let removeLayer;
  for (let frame = 0; frame < 900; frame++) {
    const p = animator.parameters; p.speed = 2.5 + 2.5 * Math.sin(frame / 40); p.x = Math.abs(Math.sin(frame / 25)); p.y = 1 + Math.cos(frame / 31);
    if (frame === 150) animator.transition('strafe', 0.3);
    if (frame === 160) animator.transition('locomotion', 0.5);
    if (frame === 300) removeLayer = animator.addLayer({clip: 'Wave', weight: 0.6, mask: [20, 21, 22, 23, 5], referenceTime: 0.1});
    if (frame === 400) animator.transition('still', 0.25);
    if (frame === 450) animator.transition('strafe', 0);
    if (frame === 500) {p.x = 0; p.y = 1;}
    if (frame === 600) {removeLayer(); animator.addLayer({clip: 'Walk', weight: 1, mask: [5, 6, 40]});}
    if (frame === 700) animator.transition('idle');
    animator.onPreUpdate(frame % 7 === 0 ? 0 : 1 / 60 + (frame % 5) * 0.002);
    for (const primitive of primitives) log.push(4, ...primitive.weights);
  }
  let error = ''; try {animator.onPreUpdate(-1);} catch (e) {error = `${e.constructor.name}: ${e.message}`;}
  return {bytes: Buffer.from(new Float64Array(log).buffer), error, state: animator.state, time: animator.time};
}
const a = session(baseline), b = session(candidate);
assert.ok(a.bytes.length > 1e6 && a.bytes.equals(b.bytes), 'animator output differs from the baseline');
assert.deepEqual([b.error, b.state, b.time], [a.error, a.state, a.time]);
// tests/modern-animator-allocation.test.js pins the vector copies of a two-clip blend to the two clip samples.
{
  const {animation} = world(), animator = new candidate.Animator(animation, {...options('locomotion'), parameters: {speed: 1}}), slice = Array.prototype.slice;
  let copies = 0;
  try {Array.prototype.slice = function (...args) {if ((this.length === 3 || this.length === 4) && this.every(Number.isFinite)) copies++; return slice.apply(this, args);}; animator.onPreUpdate(0.5);}
  finally {Array.prototype.slice = slice;}
  assert.equal(copies, 6 * JOINTS);
}

const cases = [];
for (const [name, initial, parameters, setup] of [
  ['one clip, 64 joints', 'idle', {speed: 0}],
  ['1D blend of two clips', 'locomotion', {speed: 1}],
  ['2D blend of four clips', 'strafe', {x: 0.4, y: 0.7}],
  ['1D blend with a fade and an additive arm layer', 'locomotion', {speed: 3}, animator => animator.addLayer({clip: 'Wave', weight: 0.6, mask: [20, 21, 22, 23]})],
]) {
  // 600 frames is ten seconds of one character at 60 FPS; a crowd multiplies it.
  const frames = 600, make = module => {
    const animator = new module.Animator(world().animation, {states, initial, parameters: {speed: 0, x: 0, y: 0, ...parameters}}); setup?.(animator);
    return () => {for (let i = 0; i < frames; i++) {if (setup && i % 120 === 0) {animator.transition('strafe', 0.4); animator.transition('locomotion', 0.4);} animator.onPreUpdate(1 / 60);}};
  };
  cases.push({case: name, frames, ...time(make(baseline), make(candidate))});
}
await record('animator', ref, cases, 'Pose sampling uses sampleTrackInto with a scratch buffer per track width and copies into the pose; mix blends quaternions in place. The cloned rest pose per clip sample is unchanged.', pin);
