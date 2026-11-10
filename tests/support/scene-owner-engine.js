// A real core Engine on a recording mock GPU, for scene ownership tests: a plugin attached to a second scene must
// detach from that scene, not the default one (docs/integration-fixtures.md).
import { Engine, TransformStore } from '../../packages/core/dist/extension.js';
import { mockGPU } from '../../examples/package-benchmarks/proofs/gpu-recorder.js';

/** `{ engine, scene, decoy }` on `canvas`: `scene` is a second scene; the default scene holds `decoy` under `name`. */
export async function sceneOwnerEngine(name, canvas = { width: 64, height: 64 }) {
  const engine = new Engine(canvas, await TransformStore.create(64), {
    backend: 'webgpu',
    gpu: mockGPU().device,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const decoy = { name, disposed: 0, setup() {}, dispose() {
    this.disposed++;
  } };
  engine.use(decoy);
  return { engine, scene: engine.createScene('second'), decoy };
}
