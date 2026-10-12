export const frame=`struct Temporal {current:mat4x4f,previous:mat4x4f,inverse:mat4x4f,settings:vec4f}
@group(0) @binding(0) var<uniform> temporal:Temporal;`;
export const fullscreen=`struct Fullscreen {@builtin(position) clip:vec4f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Fullscreen {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Fullscreen;o.clip=vec4f(p[i],0,1);return o;}`;
const motion=`struct Motion {@location(0) velocity:vec2f,@location(1) depth:f32}
fn motion(current:vec2f,previous:vec4f)->Motion {var o:Motion;o.velocity=vec2f(0);o.depth=-1;
  if(previous.w>0){o.velocity=current-(previous.xy/previous.w*vec2f(0.5,-0.5)+0.5);o.depth=previous.z/previous.w;}return o;}`;
export const cameraVelocity=frame+fullscreen+motion+`
@group(0) @binding(1) var depth:texture_depth_2d;
@fragment fn fragment(i:Fullscreen)->Motion {let size=vec2f(textureDimensions(depth));let uv=i.clip.xy/size;let d=textureLoad(depth,vec2i(i.clip.xy),0);
  let world=temporal.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),d,1);var o=motion(uv,temporal.previous*world);
  if(d==0){o.depth=-1;}return o;}`;
export function objectVelocity(pbr:boolean):string {return `
struct ObjectFrame {current:mat4x4f,previous:mat4x4f,model:mat4x4f,previousModel:mat4x4f,settings:vec4f,alpha:vec4f}
@group(0) @binding(0) var<uniform> f:ObjectFrame;
${pbr?'@group(0) @binding(1) var<storage,read> previousVertices:array<vec4f>;\n@group(0) @binding(2) var alphaMap:texture_2d<f32>;\n@group(0) @binding(3) var alphaSampler:sampler;':''}
struct Input {@location(0) position:${pbr?'vec4f':'vec3f'}${pbr?',@location(1) uv:vec4f,@location(2) color:vec4f':''}}
struct Out {@builtin(position) clip:vec4f,@location(0) previous:vec4f${pbr?',@location(1) uv:vec4f,@location(2) alpha:f32':''}}
@vertex fn vertex(i:Input,@builtin(vertex_index) index:u32)->Out {var o:Out;let p=vec4f(i.position.xyz,1);o.clip=f.current*f.model*p;
  ${pbr?'let old=select(p,vec4f(previousVertices[index*5].xyz,1),f.settings.z>0);':'let old=p;'}
  o.previous=f.previous*f.previousModel*old;if(f.settings.z==0){o.previous.w=-1;}
  ${pbr?'o.uv=i.uv;o.alpha=i.color.a;':''}return o;}
${motion}
@fragment fn fragment(i:Out)->Motion {${pbr?'let uv=select(i.uv.xy,i.uv.zw,f.alpha.z>0.5);let alpha=textureSample(alphaMap,alphaSampler,uv).a*i.alpha*f.alpha.x;if(alpha<f.alpha.y){discard;}':''}
  return motion(i.clip.xy/f.settings.xy,i.previous);}`;}
export const snapshot=`@group(0) @binding(0) var<storage,read> source:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> destination:array<vec4f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {if(id.x<arrayLength(&destination)){destination[id.x]=source[id.x];}}`;
const color=`fn linear(c:vec3f)->vec3f{return select(c/12.92,pow((c+0.055)/1.055,vec3f(2.4)),c>vec3f(0.04045));}
fn ycocg(c:vec3f)->vec3f {return vec3f(dot(c,vec3f(0.25,0.5,0.25)),(c.r-c.b)*0.5,dot(c,vec3f(-0.25,0.5,-0.25)));}
fn rgb(c:vec3f)->vec3f {return vec3f(c.x+c.y-c.z,c.x+c.z,c.x-c.y-c.z);}`;
export const resolve=frame+color+`
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
export const present=fullscreen+`
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(i:Fullscreen)->@location(0) vec4f {let c=max(textureLoad(image,vec2i(i.clip.xy),0).rgb,vec3f(0));
  return vec4f(select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308)),1);}`;
