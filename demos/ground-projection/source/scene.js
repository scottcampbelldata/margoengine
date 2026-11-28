
import {EnvironmentLighting} from '@margoengine/environment';
import {GroundProjectedBackground} from '@margoengine/environment/ground';
import {loadPrefilteredEnvironment} from '@margoengine/environment/prefiltered';
import {decodePhoto,backgroundSource} from './radiance.js';
import {parseGLTF} from '@margoengine/gltf/pbr-model';
import {ContactShadows} from '@margoengine/studio';

import {connectProjection} from './controls.js';
class CoastProjection extends GroundProjectedBackground {
  grounded=true;
  shaderCode(){
    const source=super.shaderCode(),start="fn project(ray: vec3f) -> vec3f {";
    if(!source.includes(start))throw Error("The coastal projection needs the pinned Margo ground hook.");
    return source.replace(start,start+"\n  if (u.dome.y > 0.5) { return ray; }");
  }
  writeExtra(values){super.writeExtra(values);values[33]=this.grounded?0:1;}
}

export async function install(engine,canvas,photo,car,field,signal){
  const [image,result,env]=await Promise.all([photo.then(decodePhoto),car.then(source=>parseGLTF(engine,source)),
    field.then(bytes=>loadPrefilteredEnvironment(engine,bytes,{signal}))]);
  performance.mark("ground-assets");
  signal.throwIfAborted();
  env.rotation=.61;env.intensity=.97;
  const panorama=backgroundSource(env,image);
  performance.mark("ground-environment");
  engine.lighting.direction.set([-.16,.41,.89,.47]);
  engine.lighting.radiance.set([1,.89,.80,.25]);
  engine.lighting.ambient.set([.66,.73,.89]);
  const lighting=EnvironmentLighting.attach(engine,env);
  lighting.add(result);
  const settings={name:'coastal environment',exposure:.76,source:'equirect',order:.24};
  const ground=new CoastProjection(panorama.source,{...settings,height:1.58,radius:68});
  ground.setup(engine);
  const contact=ContactShadows.attach(engine,{position:[0,.004,0],size:[5.8,3.1],height:1.38,opacity:.73,blur:.18,resolution:192,static:true});
  contact.add(result);
  const removeBackground=engine.scene.frameGraph.add({name:'coastal projection',order:.24,execute(context){
    if(context.backend==='webgpu')ground.record(context);
  }});
  return connectProjection(engine,canvas,signal,mode=>{ground.grounded=mode==='ground';engine.render({delta:0});},
    ()=>engine.gpu.queue.onSubmittedWorkDone(),()=>{removeBackground();ground.dispose();panorama.dispose();});
}
