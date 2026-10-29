// Runs in its own process (node --expose-gc) so no other test, timer or promise shares the heap while it is measured.
// Core's whole steady-state frame on the CPU: the frame loop (engine.start's requestAnimationFrame callback, stubbed),
// an onFrame callback, a plugin's onPreUpdate, CAD camera controls, the camera, the kernel tick, instance patching and
// the WebGPU renderer's frame on a stand-in device (tests/support/still-gpu.mjs). Three meshes move every frame
// through the position, Euler and quaternion setters. `--shadows` adds @margoengine/shadows with eight moving
// casters. Prints JSON { bytes: [JavaScript heap bytes per frame, one per window of 1,000 frames] }.
// `--allocate` makes every frame allocate on purpose, to prove the probe notices.
import { CADCameraControls } from '../../packages/core/dist/controls.js';
import { Engine, TransformStore, box } from '../../packages/core/dist/extension.js';
import { bytesPerFrame, frameDriver, stillRenderer } from './still-gpu.mjs';

const allocate = process.argv.includes('--allocate'),
  shadows = process.argv.includes('--shadows');
const run = frameDriver(),
  { canvas, renderer } = stillRenderer(),
  engine = new Engine(canvas, await TransformStore.create(16), renderer, undefined, null);

const geometry = box(),
  meshes = [0, 1, 2].map((i) =>
    engine
      .createMesh()
      .setGeometry(geometry)
      .setPosition([i * 2 - 2, 0, 0]),
  ),
  controls = new CADCameraControls(engine.camera, canvas),
  clock = new Float64Array(1),
  quaternion = new Float64Array(4),
  kept = [];
if (shadows) {
  const { Shadows } = await import('../../packages/shadows/dist/index.js');
  for (let i = 0; i < 8; i++)
    meshes.push(
      engine
        .createMesh()
        .setGeometry(box(0.5, 0.5, 0.5))
        .setPosition([i, 1, 0]),
    );
  const plugin = new Shadows({ resolution: 1024 });
  engine.use(plugin);
  for (const mesh of engine.meshes.values()) plugin.add(mesh);
}
engine.use({ name: 'controls', setup() {}, onPreUpdate: (delta) => controls.update(delta) });
engine.onFrame((_, delta) => {
  const time = (clock[0] += delta);
  meshes[0].position.y = Math.sin(time);
  meshes[1].rotation.y = time;
  quaternion[1] = Math.sin(time / 2);
  quaternion[3] = Math.cos(time / 2);
  meshes[2].setQuaternion(quaternion);
  for (let i = 3; i < meshes.length; i++) meshes[i].position.y = 1 + Math.sin(time + i);
  if (allocate) kept.push(new Array(64).fill(0));
});
engine.start();
run(20_000);
if (globalThis.__profile) await globalThis.__profile(run);
const bytes = await bytesPerFrame(run);
engine.dispose();
console.log(JSON.stringify({ bytes }));
