import * as module0 from '@margoengine/input';
import {materialLobes,sheen,specular,anisotropy,iridescence,type MaterialLobeOptions} from '@margoengine/materials';
import type {MaterialExtension} from '@margoengine/gltf-pro';

export function materialExtensions(view:GPUTextureView,sampler:GPUSampler):MaterialExtension {
  const options:MaterialLobeOptions={ior:1.5,sheen:{colorFactor:[0.3,0.2,0.1],sheenColorTexture:{view,sampler,texCoord:1,transform:{offset:[0.2,0.1],rotation:0.3,scale:[0.5,0.75]}}},specular:{factor:0.8,colorFactor:[2,1,0.5]},anisotropy:{strength:0.5,rotation:0.2},iridescence:{factor:0.6,ior:1.3,thicknessMinimum:100,thicknessMaximum:400}};
  const defaults=[sheen(),specular(),anisotropy(),iridescence()];
  // @ts-expect-error Factors are numeric, never WGSL source.
  sheen({roughnessFactor:'0.5'});
  // @ts-expect-error Only the two fixed UV sets are exposed.
  anisotropy({anisotropyTexture:{view,texCoord:2}});
  return materialLobes(options,defaults[0]);
}
import * as module1 from '@margoengine/ecs';
import * as module2 from '@margoengine/fsm';
import * as module3 from '@margoengine/navmesh';
import * as module4 from '@margoengine/cinematic';
import * as module5 from '@margoengine/splines';
import * as module6 from '@margoengine/transitions';
import * as module7 from '@margoengine/toon';
import * as module8 from '@margoengine/water';
import * as module9 from '@margoengine/sky';
import * as module10 from '@margoengine/selection';
import * as module11 from '@margoengine/wfc';
import * as module12 from '@margoengine/procedural';
import * as module13 from '@margoengine/road';
import * as module14 from '@margoengine/scatter';
import * as module15 from '@margoengine/html';
import * as module16 from '@margoengine/video';
import * as module17 from '@margoengine/net';
import * as module18 from '@margoengine/stats';
import * as module19 from '@margoengine/inspector';
import * as module20 from '@margoengine/navigation';
import * as module21 from '@margoengine/tween';
import * as module22 from '@margoengine/fbx';
import * as module23 from '@margoengine/usdz-export';
import * as module24 from '@margoengine/bvh';
import * as module25 from '@margoengine/lines';
import * as module26 from '@margoengine/environment';
import * as module27 from '@margoengine/geometry';
import * as module28 from '@margoengine/loaders';
import * as module29 from '@margoengine/exporters';
import * as module30 from '@margoengine/decoders';
import * as module31 from '@margoengine/text';
import * as module32 from '@margoengine/controls';
import * as module33 from '@margoengine/gizmo';
import * as module34 from '@margoengine/points';
import * as module35 from '@margoengine/audio';
import * as module36 from '@margoengine/physics';
import * as module37 from '@margoengine/terrain';
import {PbrMaterial, type EngineKernel} from '@margoengine/core';
export const modules = [module0,module1,module2,module3,module4,module5,module6,module7,module8,module9,module10,module11,module12,module13,module14,module15,module16,module17,module18,module19,module20,module21,module22,module23,module24,module25,module26,module27,module28,module29,module30,module31,module32,module33,module34,module35,module36,module37];
export function example(engine:EngineKernel){
 const world=new module1.World(64),position=world.component({x:Float32Array});
 position.add(world.create(),{x:1});
 const curve=new module5.Spline([[0,0,0],[0,0,10]]);
 const path=new module3.NavMesh([[0,0,0],[1,0,0],[0,0,1]],[[0,1,2]]).path([0.1,0,0.1],[0.2,0,0.2]);
 const input=new module0.Input({jump:[{type:'key',code:'Space'}]});
 const road=module13.road(curve);
 const height=module12.createIslandHeight(731),cabin=module12.generateCabinMesh(height,[-10,23]),grass=module12.generateGrassMesh(3);
 const ground=module37.heightfieldGeometry(height,{size:[160,160],resolution:32});
 module37.TerrainHeightmap.attach(engine,height,{size:[160,160],resolution:256});
 const material=new PbrMaterial(),rig=module12.createHumanoid(engine,[material,material,material]);
 module12.poseHumanoid(rig,new Float32Array([0,0,0]),0,0,0);
 const camera=module4.Cinematic.attach(engine);camera.setOrbitOffset(0,0.3,14,0.8);
 const tree=module12.generateTreeMesh('conifer'),shrub=module12.generateShrubMesh();
 const layout=new module14.PlacementLayout([[-3,-4,3,4]]);
 const bushes=layout.place([[5,0,1,0],[7,0,0.7,1]],0.85);
 module6.Transitions.attach(engine).start('radial',1);
 module7.Toon.attach(engine);
 module8.Water.attach(engine,{waves:[{direction:[1,0],amplitude:0.1,wavelength:10}]});
 module9.Sky.attach(engine,{model:'bruneton',clouds:{coverage:0.45,speed:8,height:1500}});
 module14.Scatter.attach(engine,module27.toGeometry(grass),{wind:[1,0.35,0.2]});
 const selected=module10.Selection.attach(engine);selected.set([engine.createMesh().setGeometry(road.geometry)]);
 module10.Picking.attach(engine);
 module15.HTML.attach(engine).add(document.createElement('span'),{position:[0,1,0]});
 const snapshot=module17.createSnapshot();new module17.SnapshotBuffer().sample(1,snapshot);
 return {world,path,input,tree,shrub,bushes,cabin,grass,ground};
}
export async function navigation(){
 const nav=await module20.Navigation.create([0,0,0,1,0,0,0,0,1],[0,2,1]);
 const points=nav.path({x:0,y:0,z:0},{x:1,y:0,z:1});
 nav.dispose();return points;
}

