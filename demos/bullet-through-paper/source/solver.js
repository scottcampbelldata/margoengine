import {KernelWorld,loadKernel} from '@margoengine/physics';
import {makeExperiment} from './experiment.js';

export function openExperiment(signal){
  const solver=loadKernel({signal}).then(()=>{
    signal.throwIfAborted();
    const solve=makeExperiment(KernelWorld);
    performance.mark('divider-solver');
    return solve;
  });
  return {ready:solver,async run(){const solve=await solver;signal.throwIfAborted();return solve();}};
}
