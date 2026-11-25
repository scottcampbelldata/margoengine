// The replay in a page. No WebGPU and no engine: the kernel and the Physics class, as a game's simulation runs them.
import { KernelWorld, Physics } from '../dist/index.js';
import { kernelScene, physicsScene } from './replay-scene.js';

window.runReplay = async () => {
  await Physics.load();
  const arena = { kernel: [], kernelBlock: [], physics: [] };
  return {
    kernel: kernelScene(KernelWorld, undefined, undefined, undefined, arena.kernel),
    kernelBlock: kernelScene(KernelWorld, undefined, undefined, { blockSolver: true }, arena.kernelBlock),
    physics: physicsScene(Physics, undefined, arena.physics),
    arena,
  };
};
