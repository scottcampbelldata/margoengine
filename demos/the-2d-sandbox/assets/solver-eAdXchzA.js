import {Physics2D} from '@margoengine/physics2d';
import {createModel} from './model.js';

export async function prepare(signal,wasm){
  await Physics2D.load({signal,wasm});
  signal.throwIfAborted();
  performance.mark('sandbox-solver');
  return ()=>createModel(Physics2D);
}
