import { parseGLTFAsync } from '@margoengine/gltf/pbr';
import { MeshoptDecoder } from '@margoengine/decoders/meshopt';
import { buildVisitors } from './visitors.js';
import asset from './visitor.mesh?url';

export async function finishVisitors(engine,world,lights,signal) {
  const response=await fetch(asset,{signal});
  if(!response.ok)throw new Error('The gallery visitor textures could not be loaded.');
  const bytes=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  performance.mark('museum-detail-bytes');
  const model=await parseGLTFAsync(engine,bytes,{signal,decoders:{meshopt:MeshoptDecoder}});
  performance.mark('museum-detail-model');
  model.root.visible=false;
  let actors;
  try {
    actors=await buildVisitors(world,model,lights,signal);
    performance.mark('museum-detail-rigs');
    await model.compile();
    performance.mark('museum-detail-pipelines');
    return actors;
  } catch(error) {
    if(actors)for(const actor of actors)actor.dispose();
    else if(!model.disposed)model.dispose();
    throw error;
  }
}
