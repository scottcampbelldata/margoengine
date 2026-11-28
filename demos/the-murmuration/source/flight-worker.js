import { createFlockState, stepFlockCPU } from '@margoengine/vfx/flocking';
import { count, flightOptions, flightInfluences, openingFormation, seed } from './birds.js';

const state=createFlockState(flightOptions);
const options={...flightOptions};
const initial=openingFormation(seed).boids;
let steps=0;
function reset() {
  state.boids.set(initial);
  state.debugData.fill(0);
  steps=0;
}
reset();
// Warm the same hash, neighbour and integration path, then publish only the untouched seed.
stepFlockCPU(state,options,.046);
reset();
postMessage({ready:true});
addEventListener('message',event=>{
  const {generation,record,delta,time,predator}=event.data;
  if(event.data.reset) {
    reset();
    return;
  }
  options.attractors=flightInfluences(time);
  options.predators=predator?[predator]:[];
  steps+=stepFlockCPU(state,options,delta);
  const boids=state.boids.slice();
  postMessage({generation,record,count,steps,boids},[boids.buffer]);
});
