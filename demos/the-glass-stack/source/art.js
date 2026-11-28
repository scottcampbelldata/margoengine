import { parseGLTF } from '@margoengine/gltf/pbr-model';
import { installStaging } from './staging.js';
function roundedPanel(width,height){
  const ratio=.065,halfW=width/2,halfH=height/2,radius=Math.min(width,height)*ratio;
  const positions=[0,0,0],normals=[0,0,1],uvs=[.5,.5],indices=[];
  let points=0;
  for(const [x,y,start] of [[1,1,0],[-1,1,Math.PI/2],[-1,-1,Math.PI],[1,-1,1.5*Math.PI]]){
    for(let i=0;i<=8;i++){
      const t=start+(i/8)*Math.PI/2,px=x*(halfW-radius)+radius*Math.cos(t),py=y*(halfH-radius)+radius*Math.sin(t);
      positions.push(px,py,0);normals.push(0,0,1);
      uvs.push(.5+px/width,.5+py/height);
      points++;
    }
  }
  for(let i=1;i<=points;i++)indices.push(0,i,1+i%points);
  return {positions,normals,uvs,indices};
}

const clearPixel={width:1,height:1,data:new Uint8Array([255,255,255,255])};
function linearColor(hex){
  return [1,3,5].map(i=>Number.parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
}
function glaze(engine,geometry,hex,opacity,image=clearPixel){
  const arrays=[Float32Array.from(geometry.positions),Float32Array.from(geometry.normals),
    Float32Array.from(geometry.uvs),Uint16Array.from(geometry.indices)];
  const {width,height}=image;
  const doc={asset:{version:'2.0'},extensionsUsed:['KHR_materials_unlit'],scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},indices:3,material:0}]}],
    buffers:arrays.map(buffer=>({byteLength:buffer.byteLength})),
    bufferViews:arrays.map((buffer,index)=>({buffer:index,byteOffset:0,byteLength:buffer.byteLength,target:index===3?34963:34962})),
    accessors:arrays.map((buffer,index)=>({bufferView:index,byteOffset:0,componentType:index===3?5123:5126,
      type:index===3?'SCALAR':index===2?'VEC2':'VEC3',
      count:buffer.length/(index===3?1:index===2?2:3)})),
    materials:[{alphaMode:'BLEND',doubleSided:true,extensions:{KHR_materials_unlit:{}},pbrMetallicRoughness:{baseColorFactor:[...linearColor(hex),opacity],
      baseColorTexture:{index:0},roughnessFactor:.45,metallicFactor:.02}}],
    samplers:[{magFilter:9729,minFilter:9729,wrapS:33071,wrapT:33071}],
    textures:[{sampler:0,source:0}],images:[{name:width===1&&height===1?'Clear glass coverage':'Procedural smoke'}]};
  return parseGLTF(engine,doc,arrays,[image]);
}

function vaporTexture(){
  const size=96,data=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const s=x/(size-1)*2-1,t=y/(size-1)*2-1,r=Math.hypot(s,t);
    const knot=(s-.09*Math.sin(4.7*t))**2/.42+(t+.17*Math.sin(3.2*s))**2/.61;
    const threads=.55+.16*Math.sin(9.4*s+4.1*t)+.10*Math.sin(17.9*t-14.3*s)+.07*Math.cos(28.1*s+12.4*t);
    const rim=Math.max(0,1-r**2.6)**2,alpha=Math.exp(-1.9*knot)*rim*threads;
    const i=4*(y*size+x);
    data.set([241,245,252,Math.round(alpha*255)],i);
  }
  return {data,width:size,height:size};
}
export function makeGlassRoom(engine){
  const room=installStaging(engine),haze=vaporTexture();
  const assemble=(spec,image)=>{
    const {width,height,color,opacity,anchor}=spec;
    const model=glaze(engine,roundedPanel(width,height),color,opacity,image);
    model.root.setParent(anchor);return model;
  };
  return {fixture:room.fixture,glazes:room.glazes.map(spec=>assemble(spec)),smoke:room.smoke.map(spec=>assemble(spec,haze))};
}
