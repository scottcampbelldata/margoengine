import { opacityCode, solidVertexDepth } from '../../shared/caster.js';
import { displacementCode } from '../../shared/displacement.js';
import { sectionShader } from '../../shared/section.js';

const frame = `struct Temporal {current:mat4x4f,previous:mat4x4f,inverse:mat4x4f,settings:vec4f}
@group(0) @binding(0) var<uniform> temporal:Temporal;`;
export const fullscreen = `struct Fullscreen {@builtin(position) clip:vec4f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Fullscreen {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Fullscreen;o.clip=vec4f(p[i],0,1);return o;}`;
const motion = `struct Motion {@location(0) velocity:vec2f,@location(1) depth:f32}
fn motion(current:vec2f,previous:vec4f)->Motion {var o:Motion;o.velocity=vec2f(0);o.depth=-1;
  if(previous.w>0){o.velocity=current-(previous.xy/previous.w*vec2f(0.5,-0.5)+0.5);o.depth=previous.z/previous.w;}return o;}`;
export const cameraVelocity =
  frame +
  fullscreen +
  motion +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@fragment fn fragment(i:Fullscreen)->Motion {let size=vec2f(textureDimensions(depth));let uv=i.clip.xy/size;let d=textureLoad(depth,vec2i(i.clip.xy),0);
  let world=temporal.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),d,1);var o=motion(uv,temporal.previous*world);
  if(d==0){o.depth=-1;}return o;}`;
export function objectVelocity(
  pbr: boolean,
  transformed = false,
  opacity = false,
  solid = false,
  displaced = false,
  clipped = false,
  graph?: (code: string, group: number) => string,
): string {
  let code = `${opacity ? opacityCode(0, 5) : ''}
struct ObjectCamera {current:mat4x4f,previous:mat4x4f,settings:vec4f}
struct ObjectFrame {model:mat4x4f,previousModel:mat4x4f,settings:vec4f,alpha:vec4f${transformed ? ',alphaUV0:vec4f,alphaUV1:vec4f' : ''}}
@group(0) @binding(0) var<uniform> f:ObjectFrame;
@group(0) @binding(4) var<uniform> camera:ObjectCamera;
${pbr ? '@group(0) @binding(1) var<storage,read> previousVertices:array<vec4f>;\n@group(0) @binding(2) var alphaMap:texture_2d<f32>;\n@group(0) @binding(3) var alphaSampler:sampler;' : ''}
struct Input {@location(0) position:${pbr ? 'vec4f' : 'vec3f'}${pbr ? ',@location(1) uv:vec4f,@location(2) color:vec4f' : ''}}
struct Out {@builtin(position) clip:vec4f,@location(0) previous:vec4f${pbr ? ',@location(1) uv:vec4f,@location(2) alpha:f32' : ''}}
@vertex fn vertex(i:Input,@builtin(vertex_index) index:u32)->Out {var o:Out;let p=vec4f(i.position.xyz,1);let valid=f.settings.z*camera.settings.z>0;${pbr ? 'let world=f.model*p;o.clip=camera.current*world;' : 'o.clip=camera.current*f.model*p;'}
  ${pbr ? 'let old=select(p,vec4f(previousVertices[index*5].xyz,1),valid);' : 'let old=p;'}
  o.previous=camera.previous*f.previousModel*old;if(!valid){o.previous.w=-1;}
  ${pbr ? 'o.uv=i.uv;o.alpha=i.color.a;' : ''}return o;}
${motion}
@fragment fn fragment(i:Out)->Motion {${pbr ? 'var uv=select(i.uv.xy,i.uv.zw,f.alpha.z>0.5);' + (transformed ? 'uv=vec2f(dot(f.alphaUV0.xy,uv)+f.alphaUV0.z,dot(f.alphaUV1.xy,uv)+f.alphaUV1.z);' : '') + `let alpha=textureSample(alphaMap,alphaSampler,uv).a*${opacity ? 'margoOpacityAt(i.uv)*' : ''}i.alpha*f.alpha.x;if(alpha<f.alpha.y){discard;}` : ''}
  return motion(i.clip.xy/camera.settings.xy,i.previous);}`;
  if (solid) code = solidVertexDepth(code);
  // The previous frame's vertex moves by the same amount: a map or scale changing moves a surface without any velocity.
  if (graph)
    code = graph(
      code
        .replace(',@location(1) uv:vec4f,', ',@location(3) normal:vec4f,@location(1) uv:vec4f,')
        .replace('let p=vec4f(i.position.xyz,1);', 'let shift=margoPosition-i.position.xyz;let p=vec4f(margoPosition,1);')
        .replace('vec4f(previousVertices[index*5].xyz,1)', 'vec4f(previousVertices[index*5].xyz+shift,1)'),
      1,
    );
  else if (displaced)
    code =
      displacementCode(1) +
      code
        .replace(',@location(1) uv:vec4f,', ',@location(3) normal:vec4f,@location(1) uv:vec4f,')
        .replace(
          'let p=vec4f(i.position.xyz,1);',
          'let shift=i.normal.xyz*margoDisplacement(i.uv);let p=vec4f(i.position.xyz+shift,1);',
        )
        .replace('vec4f(previousVertices[index*5].xyz,1)', 'vec4f(previousVertices[index*5].xyz+shift,1)');
  if (clipped)
    code = sectionShader(
      code
        .replace('struct Out {', 'struct Out {@location(3) position:vec3f,')
        .replace('o.uv=i.uv;', 'o.position=world.xyz;o.uv=i.uv;'),
      0,
      8,
      'materialClip',
    );
  return code;
}
export const snapshot = `@group(0) @binding(0) var<storage,read> source:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> destination:array<vec4f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {if(id.x<arrayLength(&destination)){destination[id.x]=source[id.x];}}`;
// sRGB decode: IEC 61966-2-1. RGB to/from YCoCg: Malvar & Sullivan, "YCoCg-R" (2003).
export const color = `override manualSRGB:bool=true;
fn linear(c:vec3f)->vec3f{if(!manualSRGB){return c;}return select(c/12.92,pow((c+0.055)/1.055,vec3f(2.4)),c>vec3f(0.04045));}
fn ycocg(c:vec3f)->vec3f {return vec3f(dot(c,vec3f(0.25,0.5,0.25)),(c.r-c.b)*0.5,dot(c,vec3f(-0.25,0.5,-0.25)));}
fn rgb(c:vec3f)->vec3f {return vec3f(c.x+c.y-c.z,c.x+c.z,c.x-c.y-c.z);}`;
// Reprojection, 3x3 YCoCg neighbourhood clamp and history blend after B. Karis, "High Quality Temporal Supersampling"
// (SIGGRAPH 2014 course); the depth rejection of history is Margo's.
export const resolve =
  frame +
  color +
  `
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var velocity:texture_2d<f32>;
@group(0) @binding(3) var expected:texture_2d<f32>;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var history:texture_2d<f32>;
@group(0) @binding(6) var historyDepth:texture_2d<f32>;
@group(0) @binding(7) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(8) var outputDepth:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}let p=vec2i(id.xy);let current=linear(textureLoad(scene,p,0).rgb);
  var lo=vec3f(1e30);var hi=vec3f(-1e30);for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let sample=ycocg(linear(textureLoad(scene,clamp(p+vec2i(x,y),vec2i(0),vec2i(size)-1),0).rgb));lo=min(lo,sample);hi=max(hi,sample);}}
  let uv=(vec2f(id.xy)+0.5)/vec2f(size)-textureLoad(velocity,p,0).xy;
  let previousDepth=textureLoad(expected,p,0).r;var result=current;
  if(temporal.settings.z>0&&previousDepth>0&&previousDepth<=1&&all(uv>=vec2f(0))&&all(uv<vec2f(1))){
    let q=uv*vec2f(size)-0.5;let base=vec2i(floor(q));let fraction=fract(q);var old=vec3f(0);var total=0.0;
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){let pixel=clamp(base+vec2i(x,y),vec2i(0),vec2i(size)-1);
      let d=textureLoad(historyDepth,pixel,0).r;let weight=select(1-fraction.x,fraction.x,x==1)*select(1-fraction.y,fraction.y,y==1);
      if(abs(d-previousDepth)<=max(0.000001,temporal.settings.y*max(d,previousDepth))){old+=textureLoad(history,pixel,0).rgb*weight;total+=weight;}}}
    if(total>0.001){result=mix(current,rgb(clamp(ycocg(old/total),lo,hi)),temporal.settings.x);}}
  textureStore(output,p,vec4f(max(result,vec3f(0)),1));textureStore(outputDepth,p,vec4f(textureLoad(depth,p,0)));}`;
// `stochastic` (TAAOptions): a surface cut by noise holds two depths per pixel, so history is accepted over the 3x3 depth
// range, and the nearest pixel there gives the motion.
export const stochasticResolve = () =>
  resolve
    .replace(
      `  let uv=(vec2f(id.xy)+0.5)/vec2f(size)-textureLoad(velocity,p,0).xy;
  let previousDepth=textureLoad(expected,p,0).r;var result=current;
`,
      `  var previousDepth=textureLoad(expected,p,0).r;var result=current;var far=previousDepth;var moved=p;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let q=clamp(p+vec2i(x,y),vec2i(0),vec2i(size)-1);
    let d=textureLoad(expected,q,0).r;far=min(far,d);if(d>previousDepth){previousDepth=d;moved=q;}}}
  let uv=(vec2f(id.xy)+0.5)/vec2f(size)-textureLoad(velocity,moved,0).xy;
`,
    )
    .replace(
      'if(abs(d-previousDepth)<=max(0.000001,temporal.settings.y*max(d,previousDepth))){old+=',
      'let slack=max(0.000001,temporal.settings.y*max(d,previousDepth));if(d>=far-slack&&d<=previousDepth+slack){old+=',
    );
export const present =
  fullscreen +
  `
override manualSRGB:bool=true;
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(i:Fullscreen)->@location(0) vec4f {let c=max(textureLoad(image,vec2i(i.clip.xy),0).rgb,vec3f(0));
  return vec4f(select(c,select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308)),manualSRGB),1);}`;
