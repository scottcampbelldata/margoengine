// The replay in a page. No WebGPU and no engine: the kernel and the Physics class, as a game's simulation runs them.
import { KernelWorld, Physics } from '../dist/index.js';
import { REPLAY_ADAPTIVE_STEPS, kernelScene, physicsScene } from './replay-scene.js';

window.runReplay = async () => {
  await Physics.load();
  const arena = { kernel: [], kernelSweeps: [], physics: [], physicsAdaptive: [] };
  return {
    kernel: kernelScene(KernelWorld, undefined, undefined, undefined, arena.kernel),
    kernelSweeps: kernelScene(KernelWorld, undefined, undefined, { blockSolver: false }, arena.kernelSweeps),
    physics: physicsScene(Physics, undefined, arena.physics),
    physicsAdaptive: physicsScene(Physics, REPLAY_ADAPTIVE_STEPS, arena.physicsAdaptive, true),
    arena,
  };
};
