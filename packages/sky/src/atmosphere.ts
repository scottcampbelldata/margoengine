// Earth, kilometer units. Coarse four-dimensional tables keep this optional pass lightweight.
// The header is split so a sky without Bruneton omits its phase functions and table lookups; with Bruneton the
// pieces join back into the exact original text (see bruneton.ts).
export const head=`
const R=6360.0;const TOP=6460.0;const BETA_R=vec3f(0.005802,0.013558,0.033100);
struct Frame {inverse:mat4x4f,eye:vec4f,sun:vec4f,settings:vec4f,moon:vec4f,moonColor:vec4f,clouds:vec4f,nightZenith:vec4f,nightHorizon:vec4f,nightMoon:vec4f,nightMoonColor:vec4f,nightParams:vec4f,nightOn:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
fn mie()->f32{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5);}
fn densities(r:f32)->vec2f{return exp(-max(0.0,r-R)/vec2f(8.0,1.2));}
fn extinction(r:f32)->vec3f{let d=densities(r);return BETA_R*d.x+vec3f(mie()/0.9*d.y);}
`;
export const mid=`fn ground(r:f32,mu:f32)->bool{return mu<0.0&&r*r*(mu*mu-1.0)+R*R>=0.0;}
fn boundary(r:f32,mu:f32)->f32{if(ground(r,mu)){return max(0.0,-r*mu-sqrt(max(0.0,r*r*(mu*mu-1.0)+R*R)));}return max(0.0,-r*mu+sqrt(max(0.0,r*r*(mu*mu-1.0)+TOP*TOP)));}
fn trans(t:texture_2d<f32>,r:f32,mu:f32)->vec3f {
 if(ground(r,mu)){return vec3f(0);}let uv=vec2f((sign(mu)*sqrt(abs(mu))+1.0)*0.5,sqrt(clamp((r-R)/100.0,0.0,1.0)));
 let p=uv*vec2f(127,31);let a=vec2i(floor(p));let f=fract(p);let b=min(a+1,vec2i(127,31));
 return mix(mix(textureLoad(t,a,0).rgb,textureLoad(t,vec2i(b.x,a.y),0).rgb,f.x),mix(textureLoad(t,vec2i(a.x,b.y),0).rgb,textureLoad(t,b,0).rgb,f.x),f.y);
}
`;
export const transmittance=`
@group(0) @binding(1) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,32))){return;}let u=f32(id.x)/127.0*2.0-1.0;let mu=u*abs(u);let r=R+100.0*pow(f32(id.y)/31.0,2.0)+0.001;
 var result=vec3f(0);if(!ground(r,mu)){let step=boundary(r,mu)/64.0;var optical=vec3f(0);for(var i=0u;i<64u;i++){let d=(f32(i)+0.5)*step;optical+=extinction(sqrt(r*r+d*d+2.0*r*mu*d))*step;}result=exp(-optical);}
 textureStore(output,vec2i(id.xy),vec4f(result,1));
}`;
