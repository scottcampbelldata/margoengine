// Counts JavaScript heap allocations of the physics frame path. physics.test.js runs it in a child process with
// `--expose-gc --min-semi-space-size=64 --max-semi-space-size=64`: the young generation then holds a whole measured
// window, so bytes allocated = growth of the new space, and v8.GCProfiler proves no collection emptied it meanwhile.
// Prints one JSON line {case: {bytes, calls, gcs}}: the smallest of three windows, less the measuring loop's own bytes.
import v8 from 'node:v8';
import { pathToFileURL } from 'node:url';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Physics } from '../dist/index.js';

const RAPIER = (await import(pathToFileURL(process.argv[2]).href)).default;
const warn = console.warn;
console.warn = () => {};
await RAPIER.init();
console.warn = warn;

const store = await TransformStore.create(64);
const engine = new Engine(
  { width: 1, height: 1 },
  store,
  { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
  undefined,
  null,
);
const physics = new Physics(engine, { rapier: RAPIER, gravity: [0, 0, 0] });
// Moving bodies on root meshes and on children of a rotated, scaled parent: every sync writes all 16.
const parent = engine.createMesh().setPosition([1, 2, 3]).setRotation([0.3, 0.5, 0.1]).setScale([2, 2, 2]);
const bodies = [];
for (let i = 0; i < 16; i++) {
  const mesh = engine
    .createMesh(i % 2 ? parent : undefined)
    .setGeometry(box(0.5, 0.5, 0.5))
    .setPosition([i * 2, 0, 0]);
  bodies.push(
    physics.addBody(mesh, {
      canSleep: false,
      linearVelocity: [0.1, 0.2 * (i % 3), -0.1],
      angularVelocity: [0.3, 0.1 * i, 0.2],
    }),
  );
}
let ticks = 0;
physics.on('beforestep', () => {
  ticks++;
});
physics.on('afterstep', () => {
  ticks++;
});
for (let i = 0; i < 4; i++) physics.update(1 / 60); // previous and current poses differ for every body

const young = () => {
  let bytes = 0;
  for (const space of v8.getHeapSpaceStatistics())
    if (space.space_name === 'new_space' || space.space_name === 'new_large_object_space')
      bytes += space.space_used_size;
  return bytes;
};
function window(frame, calls) {
  globalThis.gc();
  const profiler = new v8.GCProfiler();
  profiler.start();
  const before = young();
  for (let i = 0; i < calls; i++) frame(i);
  const after = young();
  return { bytes: after - before, gcs: profiler.stop().statistics.length };
}
function measure(frame, calls) {
  for (let i = 0; i < calls; i++) frame(i); // warm up so the optimizing compilers take the hot paths
  let best = null;
  for (let round = 0; round < 3; round++) {
    const r = window(frame, calls);
    if (!best || r.gcs < best.gcs || (r.gcs === best.gcs && r.bytes < best.bytes)) best = r;
  }
  return { ...best, bytes: best.bytes - window(() => {}, calls).bytes, calls };
}
// Interpolation factors as already-boxed numbers (a generic array), so passing one to sync() boxes nothing.
const alphas = Array.from({ length: 16 }, (_, i) => i / 16 + 1 / 64);
alphas.push('generic');
const result = {
  // Pose buffers -> core transform storage (8 children convert through their parent's world matrix).
  sync: measure((i) => physics.sync(alphas[i & 15]), 20000),
};
// Not asserted, reported: what Rapier's own JS glue allocates (World.step with these 16 awake bodies; one pose getter
// with a target, which still makes a Float32Array view of the Wasm memory per call).
const raw = bodies[0].raw,
  target = { x: 0, y: 0, z: 0 };
const rapier = {
  step: measure(() => physics.world.step(physics['queue']), 2000),
  getter: measure(() => raw.translation(target), 20000),
};
// The wrapper's own step: listeners, pose snapshots and the event drain, with Rapier's allocating calls stubbed out
// (World.step, and pose getters that fill their target without Rapier 0.21's per-call typed-array view).
const world = physics.world,
  step = world.step;
world.step = () => {};
function translation(target) {
  const p = this.fixedPose;
  target.x = p[0];
  target.y = p[1];
  target.z = p[2];
  return target;
}
function rotation(target) {
  const p = this.fixedPose;
  target.x = p[3];
  target.y = p[4];
  target.z = p[5];
  target.w = p[6];
  return target;
}
for (const body of bodies) {
  const raw = body.raw,
    t = raw.translation(),
    r = raw.rotation();
  raw.fixedPose = Float64Array.of(t.x, t.y, t.z, r.x, r.y, r.z, r.w);
  raw.translation = translation;
  raw.rotation = rotation;
}
result.wrapperStep = measure(() => physics.step(), 20000);
world.step = step;
if (!(ticks > 0)) throw new Error('step listeners did not run');
physics.dispose();
engine.dispose();
console.log(JSON.stringify({ ...result, rapier }));
