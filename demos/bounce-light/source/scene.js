import {SSGI} from '@margoengine/post/ssgi';
import {RTGI} from '@margoengine/post/rt-gi';
import {PostStack} from '@margoengine/post/stack';
import {MeshBVH} from '@margoengine/bvh';
import {GPUSceneBVH} from '@margoengine/bvh/gpu-scene';
import {FlatRoomGI} from './flat-trace.js';

export {flattenRoom} from './flat-trace.js';

export function makeIndirect(engine,room,canTrace,flatRoom){
  const options={rays:10,steps:29,thickness:.19,maxDistance:7.8,intensity:1.2,multiBounce:false};
  let effect,scene,device,mode='direct';

  function rayScene(){
    if(device!==engine.gpu){
      scene?.dispose();
      device=engine.gpu;
      scene=GPUSceneBVH.forShader(device,room.map(({geometry,surface})=>({
        bvh:MeshBVH.fromGeometry(geometry),
        material:surface,
        side:'double',
      })));
    }
    return scene;
  }

  function pick(next){
    if(next==='traced'&&!canTrace)return mode;
    if(next==='direct'&&!effect)return 'direct';
    const trace=next==='traced';
    if(flatRoom){
      if(!effect){
        effect=new FlatRoomGI(options,flatRoom,engine);
        PostStack.attach(engine,[effect]);
      }
      effect.activeTrace=trace;
    }else if(!effect||(trace!==(effect instanceof RTGI))){
      if(engine.hasPlugin('post:stack'))engine.removePlugin('post:stack');
      effect=trace?new RTGI({...options,scene:rayScene(),shadows:true,bias:.012}):new SSGI(options);
      PostStack.attach(engine,[effect]);
    }else if(trace){
      effect.options.scene=rayScene();
    }
    effect.enabled=next!=='direct';
    mode=next;
    return mode;
  }

  return {pick,dispose(){scene?.dispose();}};
}
