import {acesShader} from '../../shared/aces.js';
export const pbrShader = /* wgsl */`
${acesShader}
struct Frame {
  camera:mat4x4f, model:mat4x4f, normalMatrix:mat4x4f, view:mat4x4f,
  eye:vec4f, light:vec4f, radiance:vec4f, base:vec4f, factors:vec4f, emissive:vec4f,
  settings:vec4f, coordsA:vec4f, coordsB:vec4f
}
@group(0) @binding(0) var<uniform> f:Frame;
@group(1) @binding(0) var baseMap:texture_2d<f32>;
@group(1) @binding(1) var baseSampler:sampler;
@group(1) @binding(2) var mrMap:texture_2d<f32>;
@group(1) @binding(3) var mrSampler:sampler;
@group(1) @binding(4) var normalMap:texture_2d<f32>;
@group(1) @binding(5) var normalSampler:sampler;
@group(1) @binding(6) var aoMap:texture_2d<f32>;
@group(1) @binding(7) var aoSampler:sampler;
@group(1) @binding(8) var emissiveMap:texture_2d<f32>;
@group(1) @binding(9) var emissiveSampler:sampler;
struct Input {
  @location(0) position:vec4f, @location(1) normal:vec4f,
  @location(2) tangent:vec4f, @location(3) uv:vec4f, @location(4) color:vec4f
}
struct Out {
  @builtin(position) clip:vec4f, @location(0) position:vec3f, @location(1) normal:vec3f,
  @location(2) tangent:vec4f, @location(3) uv:vec4f, @location(4) color:vec4f
}
@vertex fn vertex(i:Input)->Out {
  var o:Out; let p=f.model*vec4f(i.position.xyz,1);
  o.clip=f.camera*p; o.position=p.xyz;
  o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;
  o.tangent=vec4f((f.model*vec4f(i.tangent.xyz,0)).xyz,i.tangent.w*f.coordsB.y);
  o.uv=i.uv; o.color=i.color; return o;
}
fn uv(i:Out, coord:f32)->vec2f {return select(i.uv.xy,i.uv.zw,coord>0.5);}
struct Surface {base:vec4f, n:vec3f, roughness:f32, metal:f32, occlusion:f32, emissive:vec3f}
fn surface(i:Out,front:bool)->Surface {
  var s:Surface;
  s.base=textureSample(baseMap,baseSampler,uv(i,f.coordsA.x))*f.base*i.color;
  let mr=textureSample(mrMap,mrSampler,uv(i,f.coordsA.y));
  let sampledNormal=textureSample(normalMap,normalSampler,uv(i,f.coordsA.z)).xyz*2-1;
  s.occlusion=mix(1.0,textureSample(aoMap,aoSampler,uv(i,f.coordsA.w)).r,f.factors.w);
  s.emissive=textureSample(emissiveMap,emissiveSampler,uv(i,f.coordsB.x)).rgb*f.emissive.xyz;
  s.roughness=clamp(mr.g*f.factors.x,0.045,1.0); s.metal=clamp(mr.b*f.factors.y,0.0,1.0);
  let facing=front==(f.coordsB.y>0); let n=normalize(i.normal)*select(-1.0,1.0,facing);
  var t=i.tangent.xyz-n*dot(n,i.tangent.xyz);
  var b=cross(n,t)*i.tangent.w;
  let dp1=dpdx(i.position); let dp2=dpdy(i.position); let duv1=dpdx(uv(i,f.coordsA.z)); let duv2=dpdy(uv(i,f.coordsA.z));
  if(abs(i.tangent.w)<0.5) {
    let p1=cross(n,dp1); let p2=cross(dp2,n);
    t=p2*duv1.x+p1*duv2.x; b=p2*duv1.y+p1*duv2.y;
    let scale=inverseSqrt(max(max(dot(t,t),dot(b,b)),0.000001)); t*=scale; b*=scale;
  } else {t=normalize(t); b=normalize(cross(n,t))*i.tangent.w;}
  s.n=normalize(t*sampledNormal.x*f.factors.z+b*sampledNormal.y*f.factors.z+n*sampledNormal.z);
  if(!facing&&f.settings.z<0.5){discard;}
  if(f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y){discard;}
  return s;
}
fn hemisphere_ambient(s:Surface)->vec3f {
  let f0=mix(vec3f(0.04),s.base.rgb,s.metal);
  let hemisphere=mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0));
  return (s.base.rgb*(1-s.metal)+f0*0.5)*hemisphere*f.radiance.w*s.occlusion;
}
// Keep the established lighting-effect splice point for optional environment plugins.
fn ambient(s:Surface)->vec3f {
  return hemisphere_ambient(s);
}
fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {
  let h=(v+l)/max(length(v+l),0.0001);
  let nl=clamp(dot(s.n,l),0.0,1.0); let nv=clamp(dot(s.n,v),0.0001,1.0); let nh=clamp(dot(s.n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0);
  let a=s.roughness*s.roughness; let a2=a*a; let d=a2/(3.14159265*pow(nh*nh*(a2-1)+1,2.0));
  let g=2*nv/(nv+sqrt(a2+(1-a2)*nv*nv))*2*nl/max(nl+sqrt(a2+(1-a2)*nl*nl),0.0001);
  let f0=mix(vec3f(0.04),s.base.rgb,s.metal); let fresnel=f0+(1-f0)*pow(1-vh,5.0);
  return ((1-fresnel)*(1-s.metal)*s.base.rgb/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl*f.radiance.rgb*f.light.w;
}
@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); let v=normalize(f.eye.xyz-i.position); let l=normalize(f.light.xyz);
  let direct=direct_light(s,v,l);
  var color=direct+ambient(s)+s.emissive;
  if(f.settings.w<0.5) {color=aces(max(color,vec3f(0))/0.6); color=select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308));}
  return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));
}
@fragment fn gbuffer(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); return vec4f(normalize((f.view*vec4f(s.n,0)).xyz),-(f.view*vec4f(i.position,1)).z);
}
@fragment fn ambientFragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); return vec4f(ambient(s),select(1.0,s.base.a,f.settings.x>1.5));
}
`;
