import {CubeTexture,LambertMaterial,PbrMaterial,Texture,UnlitMaterial,createMesh} from '@margoengine/materials';
import {Transmission} from '@margoengine/gltf/transmission';
import {PostStack} from '@margoengine/post/stack';
import {Tonemap} from '@margoengine/tonemap';
import {chartGeometry,lensGeometry,lightGeometry} from './art.js';
import {glass,irradianceScale,modes} from './optics.js';

const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mapOptions={colorSpace:'srgb',wrapS:'clamp',wrapT:'clamp',mipmaps:false};

function reflectionStudio(){
  const width=64,height=64;
  const faces=Array.from({length:6},(_,face)=>{
    const data=new Uint8Array(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const u=(x+.5)*2/width-1,v=(y+.5)*2/height-1;
      const p=[[1,-v,-u],[-1,-v,u],[u,1,v],[u,-1,-v],[u,-v,1],[-u,-v,-1]][face];
      const l=Math.hypot(...p),[X,Y,Z]=p.map(n=>n/l),gloss=[];
      for(const lamp of [
        {d:[-.80,.50,.34],w:[.19,.71,.06],rgb:[.44,.57,.69]},
        {d:[.68,.41,-.60],w:[.09,.43,.15],rgb:[.70,.78,.87]},
        {d:[.07,.95,.28],w:[.25,.12,.48],rgb:[.82,.69,.55]}
      ]){
        const edge=Math.max(...[X,Y,Z].map((value,j)=>Math.abs(value-lamp.d[j])/lamp.w[j]));
        const power=clamp((1.21-edge)*6);
        gloss.push(lamp.rgb.map(c=>power*c));
      }
      const floor=.035*(Y*.65+.75);
      const base=[.045+floor,.069+floor,.112+floor];
      for(let c=0;c<3;c++)data[(y*width+x)*4+c]=Math.round(clamp(gloss.reduce((s,g)=>s+g[c],base[c]))*255);
      data[(y*width+x)*4+3]=255;
    }
    return {data,width,height};
  });
  return new CubeTexture(faces,{colorSpace:'srgb',mipmaps:false});
}

function refractScene(engine,lens){
  PostStack.attach(engine,[new Tonemap({curve:'neutral'})]);
  const transmission=Transmission.attach(engine);
  transmission.add(lens);
}

export function fullBench(engine,slate,maps,start){
  const display=new Texture(slate,mapOptions),reflections=reflectionStudio();
  const textures=new Map();
  const texture=key=>{
    let record=textures.get(key);
    if(record?.raw!==maps[key]||!record){
      record?.texture.dispose();
      record={raw:maps[key],texture:new Texture(maps[key],mapOptions)};
      textures.set(key,record);
    }
    return record.texture;
  };
  const root=(name,geometry,material)=>{
    const model=createMesh(engine,geometry,material);
    model.root.name=name;
    return model;
  };


  const receiver=new LambertMaterial({color:[1,1,1],map:display,lightMap:texture(start),
    lightMapResponse:'lambertian',lightMapIntensity:irradianceScale});
  root('SM_SlateReceiver',chartGeometry(),receiver);
  const clear=new PbrMaterial({color:'#eef6ee',roughness:.055,transmission:1,ior:modes.spectrum.ior,
    dispersion:modes.spectrum.dispersion,thickness:.289,attenuationColor:glass.attenuationColor,
    attenuationDistance:glass.attenuationDistance,envMap:reflections,envMapIntensity:1.6});
  const lens=root('SM_ConvexFlintLens',lensGeometry(),clear);
  const {diffuser,panels}=lightGeometry();
  root('SM_CollimatorAperture',diffuser,new UnlitMaterial({color:'#faebc8',side:'double'}));
  root('SM_ColdBounceStrips',panels,new UnlitMaterial({color:'#82b5d9',side:'double'}));
  refractScene(engine,lens);
  return {
    update(key){
      receiver.lightMap=texture(key);
      clear.roughness=key==='ground'?.28:.055;
      clear.dispersion=modes[key].dispersion;
    },
    dispose(){display.dispose();reflections.dispose();for(const record of textures.values())record.texture.dispose();}
  };
}
