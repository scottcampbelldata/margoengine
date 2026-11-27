import {bakeSurfaceMaps} from '@margoengine/mesh-edit/bake';
import {createClay, lowResolution, lowSurface, mapHeight, mapWidth} from './model.mjs';

const low = lowSurface(createClay(...lowResolution));
self.addEventListener('message', ({data:{job, revision, high}}) => {
  try {
    const {normal, covered, missed, shared}=bakeSurfaceMaps(low, high, {
      width:mapWidth, height:mapHeight, maps:['normal'], distance:.33, padding:5,
    });
    if (!normal || covered === 0) throw new Error('The low mesh yielded no normal map.');
    self.postMessage({job, revision, texture:normal.data, covered, missed, shared},[normal.data.buffer]);
  } catch (reason) {
    self.postMessage({job, revision,error:reason instanceof Error?reason.message:String(reason)});
  }
});
