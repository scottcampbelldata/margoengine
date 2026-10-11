// GGX/Smith/Schlick direct lighting follows the existing engine's PBR equations.
export const glVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 position; layout(location=1) in vec3 normal;
layout(location=2) in vec4 m0; layout(location=3) in vec4 m1; layout(location=4) in vec4 m2; layout(location=5) in vec4 m3;
layout(location=6) in vec4 color; layout(location=7) in vec4 factors;
uniform mat4 camera; out vec3 worldPosition; out vec3 worldNormal; out vec3 base; out vec4 material;
void main() {
  mat4 model=mat4(m0,m1,m2,m3); vec4 p=model*vec4(position,1);
  vec3 a=m0.xyz,b=m1.xyz,c=m2.xyz;
  worldNormal=mat3(cross(b,c),cross(c,a),cross(a,b))*normal*sign(dot(a,cross(b,c)));
  worldPosition=p.xyz; base=color.rgb; material=vec4(factors.xyz,sign(dot(a,cross(b,c)))); gl_Position=camera*p;
}`;
export const glFragment = `#version 300 es
precision highp float;
in vec3 worldPosition; in vec3 worldNormal; in vec3 base; in vec4 material;
uniform vec3 eye; uniform vec4 light; uniform vec4 radiance; out vec4 outputColor;
void main() {
  bool front=gl_FrontFacing==(material.w>0.0);if(!front&&material.z<0.5)discard;
  vec3 n=normalize(worldNormal); if(!front)n=-n;
  vec3 v=normalize(eye-worldPosition),l=normalize(light.xyz),h=normalize(v+l);
  float nl=max(dot(n,l),0.0),nv=max(dot(n,v),0.0001),nh=max(dot(n,h),0.0),vh=max(dot(v,h),0.0);
  float a=material.x*material.x,a2=a*a,d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));
  float g=2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv))*2.0*nl/max(nl+sqrt(a2+(1.0-a2)*nl*nl),0.0001);
  vec3 f0=mix(vec3(0.04),base,material.y),f=f0+(1.0-f0)*pow(1.0-vh,5.0);
  vec3 direct=((1.0-f)*(1.0-material.y)*base/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl;
  vec3 linear=direct*radiance.rgb*light.w+base*(1.0-material.y)*radiance.w;
  vec3 mapped=linear/(1.0+linear);
  outputColor=vec4(mix(mapped*12.92,1.055*pow(mapped,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),mapped)),1);
}`;
export const wgsl = `
struct Frame { camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f }
@group(0) @binding(0) var<uniform> frame:Frame;
struct Input { @location(0) position:vec3f,@location(1) normal:vec3f,@location(2) m0:vec4f,@location(3) m1:vec4f,@location(4) m2:vec4f,@location(5) m3:vec4f,@location(6) color:vec4f,@location(7) factors:vec4f }
struct Output { @builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f,@location(3) material:vec4f }
@vertex fn vertex(i:Input)->Output {
  let model=mat4x4f(i.m0,i.m1,i.m2,i.m3); let p=model*vec4f(i.position,1);
  var o:Output; o.clip=frame.camera*p; o.position=p.xyz;
  o.normal=mat3x3f(cross(i.m1.xyz,i.m2.xyz),cross(i.m2.xyz,i.m0.xyz),cross(i.m0.xyz,i.m1.xyz))*i.normal*sign(dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz)));
  o.color=i.color.rgb; o.material=vec4f(i.factors.xyz,sign(dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz)))); return o;
}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let facing=front==(i.material.w>0.0);if(!facing&&i.material.z<0.5){discard;}
  let n=normalize(i.normal)*select(-1.0,1.0,facing); let v=normalize(frame.eye.xyz-i.position); let l=normalize(frame.light.xyz); let h=normalize(v+l);
  let nl=max(dot(n,l),0.0); let nv=max(dot(n,v),0.0001); let nh=max(dot(n,h),0.0); let vh=max(dot(v,h),0.0);
  let a=i.material.x*i.material.x; let a2=a*a; let d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));
  let g=2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv))*2.0*nl/max(nl+sqrt(a2+(1.0-a2)*nl*nl),0.0001);
  let f0=mix(vec3f(0.04),i.color,i.material.y); let f=f0+(1.0-f0)*pow(1.0-vh,5.0);
  let direct=((1.0-f)*(1.0-i.material.y)*i.color/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl;
  let linear=direct*frame.radiance.xyz*frame.light.w+i.color*(1.0-i.material.y)*frame.radiance.w;
  let mapped=linear/(1.0+linear); return vec4f(select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308)),1);
}`;
