// The tornado's WGSL, loaded by import() at a `TornadoCloud`'s first frame, so a page that only reads a `Tornado`'s
// wind and rain does not carry it.
//
// One full-screen pass marches each view ray through a vertical cylinder round the storm: the condensation funnel
// (its radius from the CPU's table of the pressure deficit's condensation surface, `funnelProfile`), the wall cloud
// hanging under the base, the turning mesocyclone base, and the debris cloud at the ground. Steps shrink near the
// funnel's axis (a distance-based step, as in sphere tracing: Hart 1996, "Sphere tracing", The Visual Computer 12),
// so a funnel tens of metres wide is not stepped over from kilometres away. Each lit sample takes three density reads
// toward the sun for its shadow, the light energy-conserving over the step (Hillaire 2016, "Physically based sky,
// atmosphere and cloud rendering in Frostbite", SIGGRAPH course). The cloud texture turns with the vortex's angular
// speed in two phases cross-faded half a period apart (Vlachos 2010, "Water flow in Portal 2"), so it turns without
// shearing apart. Output is premultiplied: the scene times the transmittance plus the light.
export const TORNADO_FLOATS = 96;
/** WGSL of the tornado pass for scene depth `depth` (`depthWGSL` of binding 1, or '' for none). */
export function tornadoShader(fullscreen: string, display: string, depth: string): string {
  return /* wgsl */ `${fullscreen}${display}
struct Tornado {inverse:mat4x4f,eye:vec4f,sun:vec4f,sunColor:vec4f,ambient:vec4f,centre:vec4f,shape:vec4f,spin:vec4f,tilt:vec4f,debris:vec4f,debrisColor:vec4f,march:vec4f,rect:vec4f,profile:array<vec4f,8>}
@group(0) @binding(0) var<uniform> tor:Tornado;
${depth}
fn torHash(p:vec3f)->f32 {let q=fract(p*vec3f(0.1031,0.1030,0.0973));let r=q+dot(q,q.yxz+33.33);return fract((r.x+r.y)*r.z);}
fn torNoise(p:vec3f)->f32 {
 let i=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
 return mix(mix(mix(torHash(i),torHash(i+vec3f(1,0,0)),u.x),mix(torHash(i+vec3f(0,1,0)),torHash(i+vec3f(1,1,0)),u.x),u.y),
  mix(mix(torHash(i+vec3f(0,0,1)),torHash(i+vec3f(1,0,1)),u.x),mix(torHash(i+vec3f(0,1,1)),torHash(i+vec3f(1,1,1)),u.x),u.y),u.z);
}
fn torFbm(p:vec3f)->f32 {return 0.5*torNoise(p)+0.3*torNoise(p*2.03+17.0)+0.2*torNoise(p*4.11+41.0);}
// The funnel's radius at height h: the CPU's 32 heights from the ground to the wall cloud's base, linear between.
fn torFunnel(h:f32)->f32 {
 let x=clamp(h/max(tor.centre.z,1.0),0.0,1.0)*31.0;let i=u32(floor(x));let j=min(i+1u,31u);
 let a=tor.profile[i/4u][i%4u];let b=tor.profile[j/4u][j%4u];return mix(a,b,x-f32(i));
}
// Offset of the axis at height h from the centre: the foot displaced by the tilt, a weave of the meander along it.
fn torAxis(h:f32)->vec2f {
 let s=clamp(h/max(tor.centre.z,1.0),0.0,1.0);let m=tor.tilt.z*sin(3.14159*s);let a=tor.tilt.w+h*0.004;
 return tor.tilt.xy*(1.0-s)+m*vec2f(cos(a),sin(a));
}
// Angular speed of the cloud round the axis at r: solid turning in the core, falling off outside (r^-(1+decay)), and
// no slower than the mesocyclone's turn inside its radius.
fn torOmega(r:f32)->f32 {let rc=tor.shape.x;let w=tor.spin.y;return max(select(w*pow(rc/max(r,1.0),1.0+tor.spin.w),w,r<rc),select(0.0,tor.spin.z,r<tor.shape.z));}
// Texture coordinates of p turned back by the vortex over a phase, two phases cross-faded.
fn torTurn(d:vec2f,h:f32,angle:f32)->vec3f {let c=cos(angle);let s=sin(angle);return vec3f(d.x*c-d.y*s,h,d.x*s+d.y*c);}
struct TorSample {cloud:f32,debris:f32}
fn torDensity(p:vec3f,detail:bool)->TorSample {
 var out=TorSample(0.0,0.0);let h=p.y;if(h<0.0||h>tor.centre.w+250.0){return out;}
 let d=p.xz-tor.centre.xy-torAxis(h);let r=length(d);let zw=tor.centre.z;let zb=tor.centre.w;
 let phase=tor.march.y;let w1=1.0-abs(1.0-2.0*phase);let period=tor.march.z;
 let omega=torOmega(r)*tor.spin.x;
 var n=0.5;
 if(detail){
  let scale=1.0/max(tor.shape.x*0.6,8.0);
  let n1=torFbm(torTurn(d,h*0.6,-omega*phase*period)*scale);
  let n2=torFbm(torTurn(d,h*0.6,-omega*fract(phase+0.5)*period)*scale+vec3f(7.3,1.1,3.7));
  n=mix(n2,n1,w1);
 }
 let rough=tor.debrisColor.w;
 // The funnel: solid inside the condensation radius, its edge roughened.
 let rf=torFunnel(h);
 if(rf>0.0){let edge=rf*(1.0+rough*0.5*(n-0.5));out.cloud+=tor.debris.w*smoothstep(edge*1.04,edge*0.9,r);}
 // The wall cloud: from its ragged base to the main base, its sides frayed.
 let rw=tor.shape.y;
 if(h>zw-60.0&&h<zb+50.0){
  let side=rw*(0.85+0.3*n);let bottom=zw+80.0*(n-0.5)+0.2*max(r-0.6*rw,0.0)*0.1;
  out.cloud+=tor.ambient.w*smoothstep(side,side*0.75,r)*smoothstep(bottom,bottom+60.0,h)*smoothstep(zb+50.0,zb,h);
 }
 // The mesocyclone base: a thin turning sheet under the deck, striated round the axis.
 let rm=tor.shape.z;
 if(h>zb-120.0&&r<rm*1.1){
  let a=atan2(d.y,d.x)*tor.spin.x+log(max(r,1.0))*3.0;let stripe=0.6+0.4*sin(a*7.0+n*3.0);
  out.cloud+=tor.ambient.w*0.6*stripe*smoothstep(rm*1.1,rm*0.7,r)*smoothstep(zb-120.0+60.0*n,zb-20.0,h);
 }
 // The debris cloud: lofted round the core where the wind lofts debris, densest low, rising into a cone.
 let rd=tor.debris.x;let hd=tor.debris.y;
 if(rd>0.0&&h<hd){
  let s=h/max(hd,1.0);let reach=rd*(0.75+0.5*s)*(0.8+0.4*n);
  out.debris=tor.debris.z*0.04*smoothstep(reach,reach*0.5,r)*(1.0-s)*(1.0-s)*(0.5+n);
 }
 return out;
}
struct TorLight {light:vec3f,transmittance:f32}
fn torMarch(origin:vec3f,dir:vec3f,start:f32,end:f32,jitter:f32)->TorLight {
 var result=TorLight(vec3f(0),1.0);
 let s=tor.sun.xyz;let nu=dot(dir,s);let g=0.35;
 let phase=(1.0-g*g)/pow(max(1.0+g*g-2.0*g*nu,0.0001),1.5)/12.566371;
 let sunLight=tor.sunColor.rgb*tor.sun.w;let n=u32(tor.march.x);
 let minStep=max(tor.shape.x*0.15,2.0);let maxStep=max(tor.shape.y*0.06,minStep);
 var t=start+jitter*minStep;
 for(var i=0u;i<n;i++){
  if(t>=end){break;}
  let p=origin+dir*t;
  let d=p.xz-tor.centre.xy-torAxis(max(p.y,0.0));let r=length(d);
  let near=max(torFunnel(max(p.y,0.0)),tor.debris.x)*1.2;
  let dt=clamp(0.4*(r-near),minStep,maxStep);
  let rho=torDensity(p,true);let sigma=rho.cloud+rho.debris;
  if(sigma>0.00001){
   var od=0.0;for(var k=1;k<=3;k++){let q=torDensity(p+s*(f32(k*k)*25.0),false);od+=(q.cloud+q.debris)*f32(2*k-1)*25.0;}
   let albedo=mix(vec3f(0.92),tor.debrisColor.rgb,rho.debris/sigma);
   let sky=tor.ambient.rgb*(0.55+0.45*clamp(p.y/max(tor.centre.w,1.0),0.0,1.0));
   let lit=albedo*(sunLight*phase*exp(-od)+sky);
   let step=exp(-sigma*dt);result.light+=result.transmittance*(1.0-step)*lit;result.transmittance*=step;
   if(result.transmittance<0.01){break;}
  }
  t+=dt;
 }
 return result;
}
fn torRay(uv:vec2f)->vec3f {
 let a=tor.inverse*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,0.000001,1);let b=tor.inverse*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,1.0,1);
 return normalize(a.xyz/a.w-b.xyz/b.w);
}
// The span of the ray inside the storm's cylinder (vertical axis through the centre, radius tor.shape.w) between
// the ground and the base's top, or an empty one.
fn torSpan(o:vec3f,d:vec3f)->vec2f {
 let top=tor.centre.w+250.0;var lo=0.0;var hi=1e9;
 if(abs(d.y)<1e-6){if(o.y<0.0||o.y>top){return vec2f(1,0);}}
 else{let a=(0.0-o.y)/d.y;let b=(top-o.y)/d.y;lo=max(lo,min(a,b));hi=min(hi,max(a,b));}
 let q=o.xz-tor.centre.xy;let dd=d.xz;let A=dot(dd,dd);let R=tor.shape.w;
 if(A<1e-9){if(dot(q,q)>R*R){return vec2f(1,0);}return vec2f(lo,hi);}
 let B=dot(q,dd);let C=dot(q,q)-R*R;let disc=B*B-A*C;if(disc<0.0){return vec2f(1,0);}
 let root=sqrt(disc);lo=max(lo,(-B-root)/A);hi=min(hi,(-B+root)/A);return vec2f(lo,hi);
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let view=(i.uv-tor.rect.xy)/tor.rect.zw;let d=torRay(view);let o=tor.eye.xyz;
 var span=torSpan(o,d);
 ${depth ? `let z=sceneDepthAt(vec2i(i.position.xy));if(z>0.0){let w=tor.inverse*vec4f(view.x*2.0-1.0,1.0-view.y*2.0,z,1);span.y=min(span.y,length(w.xyz/w.w-o));}` : ''}
 if(span.y<=span.x){return vec4f(0,0,0,1);}
 let jitter=fract(52.9829189*fract(dot(i.position.xy,vec2f(0.06711056,0.00583715))));
 let m=torMarch(o,d,span.x,span.y,jitter);
 var light=m.light;if(tor.sunColor.w>0.5){light=toDisplay(light);}
 return vec4f(light,m.transmittance);
}
`;
}
