import {Node,Program} from '@margoengine/shader';
import {simplex4} from '@margoengine/shader/noise';
import {createTextureBaker} from '@margoengine/procedural/textures';
import {seed} from './field.js';

function compileField(){
  const torus=new Node('vec4f','torus-input',[],()=> 'p');
  const noise=simplex4(torus,seed).mul(.67).add(simplex4(torus.mul(2),seed).mul(.24))
    .add(simplex4(torus.mul(4),seed).mul(.09));
  const program=new Program();
  const f=program.stage({kind:'fragment',builtins:{}},[noise]);
  return program.declare(0)+'fn torusNoise(p:vec4f)->f32{\n'+f.lines.join('\n')+'\nreturn '+f.values[0]+';\n}';
}
export const tileShader=()=>compileField()+/* wgsl */`
@group(0) @binding(1) var periodic:texture_2d<f32>;
@group(0) @binding(2) var periodicSampler:sampler;
fn material(uv:vec2f)->vec3f {
  let cellCount=vec2f(3.0,2.0);
  let grid=uv*cellCount;
  let phase=camera.settings.y;
  let theta=(grid+vec2f(phase,phase*.33))*6.28318530718;
  let radius=camera.settings.x*.192;
  let s=sin(theta);
  let c=cos(theta);
  let q=torusNoise(radius*vec4f(c.x,s.x,c.y,s.y));
  let bands=fract(q*5.9+.36);
  let silk=1-smoothstep(.012,.172,min(bands,1-bands));
  let glaze=textureSampleLevel(periodic,periodicSampler,grid,0).rgb;
  let base=mix(vec3f(.119,.246,.219),vec3f(.510,.714,.564),smoothstep(-.45,.55,q));
  let shadow=mix(.89,1.08,smoothstep(.16,.81,uv.y));
  let copper=vec3f(.28,.132,.050)*silk;
  return base*shadow*.79+glaze*.235+copper;
}
`;

export async function bakeTile(device,signal){
  const baker=await createTextureBaker(device,{signal});
  try{
    const output=await baker.bake({pattern:'wood',width:128,height:128,repeat:[4,6],seed,detail:.55,
      color:[.74,.57,.28],secondary:[.105,.30,.23],signal});
    return {texture:output.texture,dispose:()=>baker.dispose()};
  }catch(error){
    baker.dispose();
    throw error;
  }
}
