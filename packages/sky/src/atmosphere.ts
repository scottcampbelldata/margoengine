// Earth, kilometer units. Coarse four-dimensional tables keep this optional pass lightweight.
export const atmosphere=`
const R=6360.0;const TOP=6460.0;const BETA_R=vec3f(0.005802,0.013558,0.033100);
struct Frame {inverse:mat4x4f,eye:vec4f,sun:vec4f,settings:vec4f,moon:vec4f,moonColor:vec4f,clouds:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
fn mie()->f32{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5);}
fn densities(r:f32)->vec2f{return exp(-max(0.0,r-R)/vec2f(8.0,1.2));}
fn extinction(r:f32)->vec3f{let d=densities(r);return BETA_R*d.x+vec3f(mie()/0.9*d.y);}
fn phaseR(nu:f32)->f32{return 0.0596831037*(1.0+nu*nu);}
fn phaseM(nu:f32)->f32 {let g=0.8;return 0.1193662073*(1.0-g*g)*(1.0+nu*nu)/((2.0+g*g)*pow(max(0.01,1.0+g*g-2.0*g*nu),1.5));}
fn ground(r:f32,mu:f32)->bool{return mu<0.0&&r*r*(mu*mu-1.0)+R*R>=0.0;}
fn boundary(r:f32,mu:f32)->f32{if(ground(r,mu)){return max(0.0,-r*mu-sqrt(max(0.0,r*r*(mu*mu-1.0)+R*R)));}return max(0.0,-r*mu+sqrt(max(0.0,r*r*(mu*mu-1.0)+TOP*TOP)));}
fn trans(t:texture_2d<f32>,r:f32,mu:f32)->vec3f {
 if(ground(r,mu)){return vec3f(0);}let uv=vec2f((sign(mu)*sqrt(abs(mu))+1.0)*0.5,sqrt(clamp((r-R)/100.0,0.0,1.0)));
 let p=uv*vec2f(127,31);let a=vec2i(floor(p));let f=fract(p);let b=min(a+1,vec2i(127,31));
 return mix(mix(textureLoad(t,a,0).rgb,textureLoad(t,vec2i(b.x,a.y),0).rgb,f.x),mix(textureLoad(t,vec2i(a.x,b.y),0).rgb,textureLoad(t,b,0).rgb,f.x),f.y);
}
fn coordinates(pixel:vec2u)->vec4f {let nu=f32(pixel.x%8u)/7.0*2.0-1.0;let mus=f32(pixel.x/8u)/15.0*2.0-1.0;let v=f32(pixel.y%32u)/31.0*2.0-1.0;return vec4f(R+100.0*pow(f32(pixel.y/32u)/7.0,2.0)+0.001,v*abs(v),mus,nu);}
fn lookup(t:texture_2d<f32>,r:f32,mu:f32,mus:f32,nu:f32)->vec3f {
 let p=clamp(vec4f((nu+1.0)*3.5,(mus+1.0)*7.5,(sign(mu)*sqrt(abs(mu))+1.0)*15.5,sqrt(clamp((r-R)/100.0,0.0,1.0))*7.0),vec4f(0),vec4f(7,15,31,7));
 let low=vec4i(floor(p));let f=fract(p);var result=vec3f(0);
 for(var i=0u;i<16u;i++){let bits=vec4i(vec4u(i&1u,(i>>1u)&1u,(i>>2u)&1u,(i>>3u)&1u));let q=min(low+bits,vec4i(7,15,31,7));let weight=select(vec4f(1)-f,f,bits==vec4i(1));result+=textureLoad(t,vec2i(q.y*8+q.x,q.w*32+q.z),0).rgb*weight.x*weight.y*weight.z*weight.w;}return result;
}
fn directions(c:vec4f)->mat2x3f{
 let w=vec3f(sqrt(max(0.0,1.0-c.y*c.y)),c.y,0);let sx=clamp((c.w-c.y*c.z)/max(w.x,0.00001),-sqrt(max(0.0,1.0-c.z*c.z)),sqrt(max(0.0,1.0-c.z*c.z)));
 return mat2x3f(w,vec3f(sx,c.z,sqrt(max(0.0,1.0-c.z*c.z-sx*sx))));
}`;
export const transmittance=atmosphere+`
@group(0) @binding(1) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,32))){return;}let u=f32(id.x)/127.0*2.0-1.0;let mu=u*abs(u);let r=R+100.0*pow(f32(id.y)/31.0,2.0)+0.001;
 var result=vec3f(0);if(!ground(r,mu)){let step=boundary(r,mu)/64.0;var optical=vec3f(0);for(var i=0u;i<64u;i++){let d=(f32(i)+0.5)*step;optical+=extinction(sqrt(r*r+d*d+2.0*r*mu*d))*step;}result=exp(-optical);}
 textureStore(output,vec2i(id.xy),vec4f(result,1));
}`;
export const single=atmosphere+`
@group(0) @binding(1) var transmission:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var total:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let nu=dot(w,sun);
 let step=boundary(c.x,c.y)/32.0;var throughput=vec3f(1);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let p=vec3f(0,c.x,0)+w*((f32(i)+0.5)*step);let r=length(p);let rho=densities(r);let absorb=exp(-extinction(r)*step);
  result+=throughput*sqrt(absorb)*trans(transmission,r,dot(p/r,sun))*(BETA_R*rho.x*phaseR(nu)+vec3f(mie()*rho.y*phaseM(nu)))*step*20.0;throughput*=absorb;
 }textureStore(output,vec2i(id.xy),vec4f(result,1));textureStore(total,vec2i(id.xy),vec4f(result,1));
}`;
export const density=atmosphere+`
@group(0) @binding(1) var previous:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let rho=densities(c.x);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let y=1.0-2.0*(f32(i)+0.5)/32.0;let angle=f32(i)*2.39996323;let radial=sqrt(1.0-y*y);let direction=vec3f(cos(angle)*radial,y,sin(angle)*radial);let nu=dot(w,direction);
  result+=lookup(previous,c.x,y,c.z,dot(direction,sun))*(BETA_R*rho.x*phaseR(nu)+vec3f(mie()*rho.y*phaseM(nu)))*(12.5663706/32.0);
 }textureStore(output,vec2i(id.xy),vec4f(result,1));
}`;
export const multiple=atmosphere+`
@group(0) @binding(1) var input:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let step=boundary(c.x,c.y)/32.0;var result=vec3f(0);var throughput=vec3f(1);
 for(var i=0u;i<32u;i++){let p=vec3f(0,c.x,0)+w*((f32(i)+0.5)*step);let r=length(p);let absorb=exp(-extinction(r)*step);
  result+=throughput*sqrt(absorb)*lookup(input,r,dot(p/r,w),dot(p/r,sun),dot(w,sun))*step;throughput*=absorb;
 }textureStore(output,vec2i(id.xy),vec4f(result,1));
}`;
export const add=`
@group(0) @binding(0) var total:texture_2d<f32>;
@group(0) @binding(1) var delta:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=vec2u(128,256))){return;}let p=vec2i(id.xy);textureStore(output,p,textureLoad(total,p,0)+textureLoad(delta,p,0));}`;
