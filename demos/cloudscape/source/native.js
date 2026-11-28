import {Engine} from '@margoengine/core';
import {Sky} from '@margoengine/sky/base';
import {preetham} from '@margoengine/sky/preetham';
import {VolumetricClouds} from '@margoengine/sky/volumetric-clouds';
import {Bloom} from '@margoengine/post/bloom';
import {installCoast} from './coast.js';
import {profile} from './coast-field.mjs';

export async function openNative(canvas,{sun,signal,fail}){
  const engine=await Engine.create(canvas,{backend:'webgpu',signal,exactSize:true,antialias:false,
    camera:{near:25,far:39000,fov:55}});
  engine.onError=fail;
  signal.throwIfAborted();
  engine.lighting.direction.set([...sun,4.1]);
  engine.lighting.radiance.set([1,.86,.67,.61]);
  const bloom=Bloom.attach(engine,{strength:.10,threshold:1.3,radius:.36,fireflies:'karis',exposure:-.13});
  const sky=Sky.attach(engine,{sunDirection:sun,timeScale:0,turbidity:1.85,exposure:-.8},{preetham});
  const depth=()=>bloom.depthTexture;
  const clouds=VolumetricClouds.attach(engine,{sky,type:'cumulus',bottom:profile.base,top:profile.top,
    coverage:.49,density:.023,scale:6450,wind:[13,3],evolution:0,steps:39,lightSteps:4,depth,
    maxDistance:23000,stepCap:200,dimLight:false,groundAlbedo:.21});
  const coast=installCoast(engine);
  let shadowField,shafts;
  return {
    renderer:'webgpu',
    draw(frame){
      engine.camera.position=frame.eye;engine.camera.target=frame.look;
      clouds.options.coverage=frame.cover;
      if(shadowField)shadowField.options.strength=frame.shadows ? .84 : 0;
      if(shafts)shafts.options.intensity=frame.shafts ? .11 : 0;
      engine.render({delta:frame.delta});
    },
    finish:()=>engine.gpu.queue.onSubmittedWorkDone(),
    async prepareLighting(){
      const [{Shadows},{volumetricCloudShadows},{LightShafts}]=await Promise.all([
        import('@margoengine/shadows'),import('@margoengine/sky/cloud-shadows'),import('@margoengine/sky/shafts')
      ]);
      signal.throwIfAborted();
      shadowField=volumetricCloudShadows(clouds,{strength:.84,samples:7});
      const shadows=Shadows.attach(engine,{cascades:1,size:512,distance:16500,filter:'hard',effects:[shadowField]});
      for(const piece of coast)shadows.add(piece,{static:true,castShadow:false,receiveShadow:true});
      shafts=LightShafts.attach(engine,{sky,clouds,depth,intensity:.11,decay:.95,samples:22,cloudSamples:7});
    },
    dispose:()=>engine.dispose(),
  };
}
