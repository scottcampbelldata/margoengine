import {KernelWorld,loadKernel} from '@margoengine/physics';
import {createReplay} from './model.js';

export async function openReplay(signal){
  await loadKernel({signal});
  signal.throwIfAborted();
  const replay=createReplay(KernelWorld);
  performance.mark('rewind-solver');
  return replay;
}
