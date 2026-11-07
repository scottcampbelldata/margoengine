// The replay in a page. No WebGPU and no engine: the kernel and the Physics class, as a game's simulation runs them.
import { KernelWorld, Physics } from '../dist/next.js';
import { kernelScene, physicsScene } from './replay-scene.js';

window.runReplay = async () => {
  await Physics.load();
  return { kernel: kernelScene(KernelWorld), physics: physicsScene(Physics) };
};
