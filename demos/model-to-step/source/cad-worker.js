import { model,parseSTEP } from '@margoengine/brep';
import { makeFlange,inspectSolid,compareSolids } from './flange.mjs';

let lastDiameter, lastBody, lastDisplay;
function current(diameter) {
  if (lastDiameter!==diameter) {
    const body=makeFlange(model,diameter);
    const display=inspectSolid(model,body);
    lastDiameter=diameter;
    lastBody=body;
    lastDisplay=display;
  }
  return {body:lastBody,display:lastDisplay};
}

function importSolid(buffer) {
  const step=parseSTEP(buffer);
  if (step.bodies.length!==1 || step.bodies[0].kind!=='solid') {
    throw new Error('Choose a STEP file containing one closed solid.');
  }
  if (step.bodies[0].faces.length>500) throw new Error('This exhibit accepts solids with up to 500 faces.');
  const result=model.bodiesFromSTEP(step);
  if (result.problems.length || !result.bodies[0]) {
    throw new Error(result.problems[0]?.problem ?? 'The STEP solid could not be read.');
  }
  return inspectSolid(model,result.bodies[0]);
}

function reply(id,result) {
  const mesh=result.mesh;
  if (mesh) {
    const positions=Float32Array.from(mesh.positions);
    const normals=Float32Array.from(mesh.normals);
    const indices=Uint32Array.from(mesh.indices);
    postMessage({id,result:{...result,mesh:{positions,normals,indices}}},
      [positions.buffer,normals.buffer,indices.buffer]);
  } else postMessage({id,result});
}

addEventListener('message',({data})=>{
  const {id,type,diameter}=data;
  try {
    const {body,display}=current(diameter);
    if (type==='model') reply(id,display);
    else if (type==='export') reply(id,{step:model.bodiesToSTEP([body])});
    else if (type==='import') {
      const received=importSolid(data.buffer);
      reply(id,{...received,comparison:compareSolids(display,received)});
    }
  } catch (error) {
    postMessage({id,error:error?.message ?? String(error)});
  }
});