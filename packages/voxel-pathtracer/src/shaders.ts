// WGSL of @margoengine/voxel-pathtracer, written from public literature:
// - traversal: Amanatides and Woo's grid walk (1987) over 8^3 bricks and voxels (same walk as traverse.ts), instances
//   in a bounding volume hierarchy, rays moved into each instance's model space by its affine inverse;
// - path tracing: unidirectional path tracing with next-event estimation and multiple importance sampling with the
//   power heuristic (Veach 1997), Russian roulette, PBRT's light transport structure (Pharr, Jakob, Humphreys);
// - surfaces: Lambert, GGX / Trowbridge-Reitz microfacets with height-correlated Smith masking (Walter et al. 2007,
//   Heitz 2014) sampled from visible normals (Heitz 2018), Schlick's Fresnel for conductors and coats, exact unpolarised
//   dielectric Fresnel with refraction for glass; orthonormal bases by Duff et al. (2017);
// - volumes: homogeneous media by free-flight sampling with Beer-Lambert absorption as a weight, Henyey-Greenstein
//   phase function; environment maps importance sampled by marginal and conditional CDFs (PBRT);
// - random numbers: PCG (O'Neill 2014) with the hash of Jarzynski and Olano (2020);
// - denoising: the edge-avoiding a-trous wavelet filter (Dammertz et al. 2010) with variance-guided luminance weights
//   (Schied et al. 2017, "Spatiotemporal Variance-Guided Filtering"), on albedo-demodulated radiance.
// Material flags and record sizes must match scene.ts and layout.ts.
import { displayShader } from '../../shared/display.js';
import { DELTA_ALPHA, EMISSIVE, MEDIA, SMOOTH } from './scene.js';
import {
  FLAG_CLAMP,
  FLAG_ENV,
  FLAG_GROUND,
  FLAG_JITTER,
  FLAG_MOTION,
  FLAG_SUN,
  INSTANCE_WORDS,
  MODEL_WORDS,
} from './layout.js';

/** Frame uniform shared by the trace and ids entry points (layout in layout.ts, FRAME_BYTES). */
const FRAME = /* wgsl */ `
struct Frame {
 origins:array<vec4f,4>,
 eye:vec4f,
 forward:vec4f,
 right:vec4f,
 up:vec4f,
 image:vec4u,
 tile:vec4u,
 config:vec4u,
 scene:vec4u,
 lights:vec4u,
 env:vec4u,
 sky:vec4f,
 sun:vec4f,
 sunLight:vec4f,
 ground:vec4f,
 weights:vec4f,
 directions:array<vec4f,4>,
}
`;

/** The path tracer: entry points `trace` (accumulate samples) and `ids` (pixel-centre instance and palette ids). */
export const TRACE: string = /* wgsl */ `${FRAME}
const PI=3.141592653589793;
const TAU=6.283185307179586;
const INV_PI=0.3183098861837907;
const INF=3.0e38;
const NONE=0xffffffffu;
const GROUND=0xfffffffeu;
const AREA=0xfffffffdu;
const EPS=2e-3;
const MEDIA=${MEDIA}u;
const EMISSIVE=${EMISSIVE}u;
const SMOOTH=${SMOOTH}u;
const DELTA=${DELTA_ALPHA};
const SUN=${FLAG_SUN}u;
const HAS_GROUND=${FLAG_GROUND}u;
const ENV=${FLAG_ENV}u;
const MOTION=${FLAG_MOTION}u;
const JITTER=${FLAG_JITTER}u;
const CLAMP=${FLAG_CLAMP}u;
const MODEL=${MODEL_WORDS}u;
const INSTANCE=${INSTANCE_WORDS}u;
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<uniform> materials:array<vec4f,1024>;
@group(0) @binding(2) var<storage,read> voxels:array<u32>;
@group(0) @binding(3) var<storage,read> scene:array<u32>;
@group(0) @binding(4) var<storage,read> lights:array<u32>;
@group(0) @binding(5) var<storage,read> envmap:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> albedo:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> normals:array<vec4f>;
var<private> rng:u32;
var<private> motion:f32;

fn lum(c:vec3f)->f32 {return dot(c,vec3f(0.2126,0.7152,0.0722));}
fn hash(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn rand()->f32 {rng=rng*747796405u+2891336453u;let w=((rng>>((rng>>28u)+4u))^rng)*277803737u;return f32(((w>>22u)^w)>>8u)*5.960464477539063e-8;}
fn power2(a:f32,b:f32)->f32 {let a2=a*a;let b2=b*b;return select(1.0,a2/(a2+b2),a2+b2>0.0);}
fn fl(i:u32)->f32 {return bitcast<f32>(scene[i]);}
fn ll(i:u32)->f32 {return bitcast<f32>(lights[i]);}

// Affine transforms as three rows.
struct Xform {r0:vec4f,r1:vec4f,r2:vec4f}
fn rowAt(i:u32)->vec4f {return vec4f(fl(i),fl(i+1u),fl(i+2u),fl(i+3u));}
fn xpoint(m:Xform,p:vec3f)->vec3f {return vec3f(dot(m.r0.xyz,p)+m.r0.w,dot(m.r1.xyz,p)+m.r1.w,dot(m.r2.xyz,p)+m.r2.w);}
fn xdir(m:Xform,d:vec3f)->vec3f {return vec3f(dot(m.r0.xyz,d),dot(m.r1.xyz,d),dot(m.r2.xyz,d));}
fn rowOf(m:Xform,k:u32)->vec3f {return select(select(m.r2.xyz,m.r1.xyz,k==1u),m.r0.xyz,k==0u);}
fn colOf(m:Xform,k:u32)->vec3f {return vec3f(m.r0[k],m.r1[k],m.r2[k]);}
fn invertX(m:Xform)->Xform {
 let a=m.r0.xyz;let b=m.r1.xyz;let c=m.r2.xyz;
 let c0=cross(b,c);let c1=cross(c,a);let c2=cross(a,b);let k=1.0/dot(a,c0);
 let r0=vec3f(c0.x,c1.x,c2.x)*k;let r1=vec3f(c0.y,c1.y,c2.y)*k;let r2=vec3f(c0.z,c1.z,c2.z)*k;
 let t=vec3f(m.r0.w,m.r1.w,m.r2.w);
 return Xform(vec4f(r0,-dot(r0,t)),vec4f(r1,-dot(r1,t)),vec4f(r2,-dot(r2,t)));
}
// Instance transforms at this path's shutter time (motion 1 = matrix, 0 = previousMatrix).
fn worldX(i:u32)->Xform {
 let b=f.scene.y+i*INSTANCE;
 let m=Xform(rowAt(b+12u),rowAt(b+16u),rowAt(b+20u));
 if((scene[b+37u]&1u)==0u||motion>=1.0){return m;}
 let q=Xform(rowAt(b+24u),rowAt(b+28u),rowAt(b+32u));
 return Xform(mix(q.r0,m.r0,motion),mix(q.r1,m.r1,motion),mix(q.r2,m.r2,motion));
}
fn localX(i:u32)->Xform {
 let b=f.scene.y+i*INSTANCE;
 if((scene[b+37u]&1u)==0u||motion>=1.0){return Xform(rowAt(b),rowAt(b+4u),rowAt(b+8u));}
 return invertX(worldX(i));
}

struct Hit {t:f32,inst:u32,value:u32,axis:u32,sgn:f32,cell:vec3i}
fn safeInv(d:vec3f)->vec3f {
 let s=select(vec3f(-1e-12),vec3f(1e-12),d>=vec3f(0.0));
 return 1.0/select(d,s,abs(d)<vec3f(1e-12));
}
fn found(h:ptr<function,Hit>,t:f32,v:u32,a:u32,stp:vec3i,d:vec3f,c:vec3i)->bool {
 var axis=a;
 if(axis==3u){let q=abs(d);axis=select(select(2u,1u,q.y>=q.z),0u,q.x>=q.y&&q.x>=q.z);}
 (*h).t=t;(*h).value=v;(*h).axis=axis;(*h).sgn=-f32(stp[axis]);(*h).cell=c;
 return true;
}
// Two-level walk of model 'model' along o + t d (model space) for t in [tMin, tMax): the first boundary into a cell
// whose palette index is not 'want'; with want != 0 also the exit through the model's box (value 0).
fn march(model:u32,o:vec3f,d:vec3f,tMin:f32,tMax:f32,want:u32,h:ptr<function,Hit>)->bool {
 let mb=f.scene.x+model*MODEL;
 let sz=vec3i(i32(scene[mb]),i32(scene[mb+1u]),i32(scene[mb+2u]));
 let grid=scene[mb+3u];
 let nb=vec3i(i32(scene[mb+4u]),i32(scene[mb+5u]),i32(scene[mb+6u]));
 let inv=safeInv(d);
 let ta=-o*inv;let tb=(vec3f(sz)-o)*inv;let tn=min(ta,tb);let tf=max(ta,tb);
 let tEnter=max(max(tn.x,tn.y),max(tn.z,tMin));
 let boxExit=min(min(tf.x,tf.y),tf.z);
 let tExit=min(boxExit,tMax);
 if(!(tEnter<tExit)){return false;}
 var axis=3u;
 if(tEnter>tMin){axis=select(select(2u,1u,tEnter==tn.y),0u,tEnter==tn.x);}
 let pos=d>=vec3f(0.0);
 let stp=select(vec3i(-1),vec3i(1),pos);
 let up=select(vec3f(0.0),vec3f(1.0),pos);
 let ad=abs(inv);
 var bc=clamp(vec3i(floor((o+d*tEnter)*0.125)),vec3i(0),nb-1);
 var bn=((vec3f(bc)+up)*8.0-o)*inv;
 var t=tEnter;
 loop {
  let entry=voxels[grid+u32(bc.x+nb.x*(bc.z+nb.z*bc.y))];
  let tOut=min(min(bn.x,bn.y),min(bn.z,tExit));
  let lo=bc*8;let hi=min(lo+8,sz)-1;
  if(entry==0u||entry>=0x80000000u){
   let u=select(0u,entry&255u,entry!=0u);
   if(u!=want){return found(h,t,u,axis,stp,d,clamp(vec3i(floor(o+d*t)),lo,hi));}
  } else {
   var c=clamp(vec3i(floor(o+d*t)),lo,hi);
   var vn=(vec3f(c)+up-o)*inv;
   var vt=t;var va=axis;
   loop {
    let l=vec3u(c-lo);let k=l.x+8u*(l.z+8u*l.y);
    let v=(voxels[entry+(k>>2u)]>>((k&3u)*8u))&255u;
    if(v!=want){return found(h,vt,v,va,stp,d,c);}
    if(vn.x<vn.y&&vn.x<vn.z){va=0u;vt=vn.x;c.x+=stp.x;vn.x+=ad.x;}
    else if(vn.y<vn.z){va=1u;vt=vn.y;c.y+=stp.y;vn.y+=ad.y;}
    else{va=2u;vt=vn.z;c.z+=stp.z;vn.z+=ad.z;}
    if(vt>=tOut||any(c<lo)||any(c>hi)){break;}
   }
  }
  if(tOut>=tExit){break;}
  if(bn.x<bn.y&&bn.x<bn.z){axis=0u;t=bn.x;bc.x+=stp.x;bn.x+=ad.x*8.0;}
  else if(bn.y<bn.z){axis=1u;t=bn.y;bc.y+=stp.y;bn.y+=ad.y*8.0;}
  else{axis=2u;t=bn.z;bc.z+=stp.z;bn.z+=ad.z*8.0;}
  if(any(bc<vec3i(0))||any(bc>=nb)){break;}
 }
 if(want==0u||boxExit>=tMax){return false;}
 let ex=select(select(2u,1u,tf.y<=tf.z),0u,tf.x<=tf.y&&tf.x<=tf.z);
 return found(h,boxExit,0u,ex,stp,d,vec3i(floor(o+d*boxExit)));
}
// Extinction of a see-through cell for shadow rays, -1 when the cell blocks light (only media let it through).
fn extinction(v:u32)->f32 {let x=materials[v*4u+3u];return select(-1.0,x.x,(u32(x.w)&MEDIA)!=0u);}
// Optical depth along a shadow ray through one model, -1 when blocked.
fn marchShadow(model:u32,o:vec3f,d:vec3f,tMax:f32)->f32 {
 let mb=f.scene.x+model*MODEL;
 let sz=vec3i(i32(scene[mb]),i32(scene[mb+1u]),i32(scene[mb+2u]));
 let grid=scene[mb+3u];
 let nb=vec3i(i32(scene[mb+4u]),i32(scene[mb+5u]),i32(scene[mb+6u]));
 let inv=safeInv(d);
 let ta=-o*inv;let tb=(vec3f(sz)-o)*inv;let tn=min(ta,tb);let tf=max(ta,tb);
 let tEnter=max(max(tn.x,tn.y),max(tn.z,0.0));
 let tExit=min(min(tf.x,tf.y),min(tf.z,tMax));
 if(!(tEnter<tExit)){return 0.0;}
 let pos=d>=vec3f(0.0);
 let stp=select(vec3i(-1),vec3i(1),pos);
 let up=select(vec3f(0.0),vec3f(1.0),pos);
 let ad=abs(inv);
 var bc=clamp(vec3i(floor((o+d*tEnter)*0.125)),vec3i(0),nb-1);
 var bn=((vec3f(bc)+up)*8.0-o)*inv;
 var t=tEnter;var depth=0.0;
 loop {
  let entry=voxels[grid+u32(bc.x+nb.x*(bc.z+nb.z*bc.y))];
  let tOut=min(min(bn.x,bn.y),min(bn.z,tExit));
  let lo=bc*8;let hi=min(lo+8,sz)-1;
  if(entry>=0x80000000u){
   let k=extinction(entry&255u);if(k<0.0){return -1.0;}depth+=k*(tOut-t);
  } else if(entry!=0u){
   var c=clamp(vec3i(floor(o+d*t)),lo,hi);
   var vn=(vec3f(c)+up-o)*inv;
   var vt=t;
   loop {
    let l=vec3u(c-lo);let k=l.x+8u*(l.z+8u*l.y);
    let v=(voxels[entry+(k>>2u)]>>((k&3u)*8u))&255u;
    let next=min(min(vn.x,vn.y),min(vn.z,tOut));
    if(v!=0u){let x=extinction(v);if(x<0.0){return -1.0;}depth+=x*max(next-vt,0.0);}
    if(vn.x<vn.y&&vn.x<vn.z){vt=vn.x;c.x+=stp.x;vn.x+=ad.x;}
    else if(vn.y<vn.z){vt=vn.y;c.y+=stp.y;vn.y+=ad.y;}
    else{vt=vn.z;c.z+=stp.z;vn.z+=ad.z;}
    if(vt>=tOut||any(c<lo)||any(c>hi)){break;}
   }
  }
  if(tOut>=tExit){break;}
  if(bn.x<bn.y&&bn.x<bn.z){t=bn.x;bc.x+=stp.x;bn.x+=ad.x*8.0;}
  else if(bn.y<bn.z){t=bn.y;bc.y+=stp.y;bn.y+=ad.y*8.0;}
  else{t=bn.z;bc.z+=stp.z;bn.z+=ad.z*8.0;}
  if(any(bc<vec3i(0))||any(bc>=nb)){break;}
 }
 return depth;
}
fn traceInstance(i:u32,o:vec3f,d:vec3f,medium:u32,mInst:u32,h:ptr<function,Hit>) {
 let m=localX(i);
 var r:Hit;
 if(march(scene[f.scene.y+i*INSTANCE+36u],xpoint(m,o),xdir(m,d),0.0,(*h).t,select(0u,medium,i==mInst),&r)){r.inst=i;*h=r;}
}
// Closest boundary along a world ray: ground plane, area lights, then voxels through the hierarchy. In a volume
// (medium != 0) the volume's own instance is walked for the cell where the volume ends.
fn closest(o:vec3f,d:vec3f,medium:u32,mInst:u32)->Hit {
 var h:Hit;h.t=INF;h.inst=NONE;
 if((f.config.z&HAS_GROUND)!=0u&&abs(d.y)>1e-9){let t=(f.ground.w-o.y)/d.y;if(t>0.0){h.t=t;h.inst=GROUND;}}
 for(var k=0u;k<f.config.w;k++){
  let b=f.lights.z+k*16u;
  let c=vec3f(ll(b),ll(b+1u),ll(b+2u));let eu=vec3f(ll(b+4u),ll(b+5u),ll(b+6u));let ev=vec3f(ll(b+8u),ll(b+9u),ll(b+10u));
  let n=cross(eu,ev);let dn=dot(d,n);
  if(abs(dn)<1e-20||(dn>0.0&&ll(b+7u)==0.0)){continue;}
  let t=dot(c-o,n)/dn;
  if(t<=0.0||t>=h.t){continue;}
  let q=o+d*t-c;
  let uu=dot(eu,eu);let uv=dot(eu,ev);let vv=dot(ev,ev);let qu=dot(q,eu);let qv=dot(q,ev);let den=uu*vv-uv*uv;
  let s=(qu*vv-qv*uv)/den;let r=(qv*uu-qu*uv)/den;
  if(s<0.0||s>1.0||r<0.0||r>1.0){continue;}
  h.t=t;h.inst=AREA;h.value=k;
 }
 if(f.scene.w==0u){return h;}
 let inv=safeInv(d);
 var stack:array<u32,32>;var sp=0u;var node=0u;
 loop {
  let b=f.scene.z+node*8u;
  let t0=(vec3f(fl(b),fl(b+1u),fl(b+2u))-o)*inv;let t1=(vec3f(fl(b+4u),fl(b+5u),fl(b+6u))-o)*inv;
  let tn=max(max(min(t0.x,t1.x),min(t0.y,t1.y)),max(min(t0.z,t1.z),0.0));
  let tf=min(min(max(t0.x,t1.x),max(t0.y,t1.y)),min(max(t0.z,t1.z),h.t));
  var down=false;
  if(tn<=tf){
   let count=scene[b+7u];let start=scene[b+3u];
   if(count>0u){for(var i=start;i<start+count;i++){traceInstance(i,o,d,medium,mInst,&h);}}
   else{down=true;}
  }
  if(down){if(sp<32u){stack[sp]=scene[b+3u]+1u;sp++;}node=scene[b+3u];continue;}
  if(sp==0u){break;}
  sp--;node=stack[sp];
 }
 return h;
}
// Transmittance toward a light: 0 when the ground or a non-medium voxel blocks it, else exp(-optical depth).
fn shadow(o:vec3f,d:vec3f,tMax:f32)->f32 {
 if((f.config.z&HAS_GROUND)!=0u&&abs(d.y)>1e-9){let t=(f.ground.w-o.y)/d.y;if(t>0.0&&t<tMax){return 0.0;}}
 if(f.scene.w==0u){return 1.0;}
 let inv=safeInv(d);
 var tau=0.0;
 var stack:array<u32,32>;var sp=0u;var node=0u;
 loop {
  let b=f.scene.z+node*8u;
  let t0=(vec3f(fl(b),fl(b+1u),fl(b+2u))-o)*inv;let t1=(vec3f(fl(b+4u),fl(b+5u),fl(b+6u))-o)*inv;
  let tn=max(max(min(t0.x,t1.x),min(t0.y,t1.y)),max(min(t0.z,t1.z),0.0));
  let tf=min(min(max(t0.x,t1.x),max(t0.y,t1.y)),min(max(t0.z,t1.z),tMax));
  var down=false;
  if(tn<=tf){
   let count=scene[b+7u];let start=scene[b+3u];
   if(count>0u){
    for(var i=start;i<start+count;i++){
     let m=localX(i);
     let k=marchShadow(scene[f.scene.y+i*INSTANCE+36u],xpoint(m,o),xdir(m,d),tMax);
     if(k<0.0){return 0.0;}
     tau+=k;
    }
   } else {down=true;}
  }
  if(down){if(sp<32u){stack[sp]=scene[b+3u]+1u;sp++;}node=scene[b+3u];continue;}
  if(sp==0u){break;}
  sp--;node=stack[sp];
 }
 return exp(-tau);
}
fn voxelAt(model:u32,c:vec3i)->u32 {
 let mb=f.scene.x+model*MODEL;
 let nb=vec3i(i32(scene[mb+4u]),i32(scene[mb+5u]),i32(scene[mb+6u]));
 let b=c>>vec3u(3u);
 let entry=voxels[scene[mb+3u]+u32(b.x+nb.x*(b.z+nb.z*b.y))];
 if(entry==0u){return 0u;}
 if(entry>=0x80000000u){return entry&255u;}
 let l=vec3u(c&vec3i(7));let k=l.x+8u*(l.z+8u*l.y);
 return (voxels[entry+(k>>2u)]>>((k&3u)*8u))&255u;
}

// Camera rays: origins on the near plane and directions, computed in float64 on the CPU at the image's corners and
// interpolated (exact for perspective and orthographic projections, whose near plane and ray directions are affine in
// the pixel position); a thin lens moves the origin across the aperture and aims at the focus plane.
struct Ray {o:vec3f,d:vec3f}
fn pinhole(px:vec2f)->Ray {
 let uv=px/vec2f(f32(f.image.x),f32(f.image.y));
 let o=mix(mix(f.origins[0],f.origins[1],uv.x),mix(f.origins[2],f.origins[3],uv.x),uv.y).xyz;
 let d=mix(mix(f.directions[0],f.directions[1],uv.x),mix(f.directions[2],f.directions[3],uv.x),uv.y).xyz;
 return Ray(o,normalize(d));
}
fn lensPoint()->vec2f {
 let u=vec2f(rand(),rand());
 let blades=f.right.w;
 if(blades<3.0){
  // Concentric disk mapping (Shirley and Chiu 1997).
  let p=2.0*u-1.0;
  if(p.x==0.0&&p.y==0.0){return vec2f(0.0);}
  var r:f32;var a:f32;
  if(abs(p.x)>abs(p.y)){r=p.x;a=PI*0.25*(p.y/p.x);}else{r=p.y;a=PI*0.5-PI*0.25*(p.x/p.y);}
  return r*vec2f(cos(a),sin(a));
 }
 let k=floor(rand()*blades);let a0=f.up.w+k*TAU/blades;let a1=a0+TAU/blades;
 var s=u;if(s.x+s.y>1.0){s=1.0-s;}
 return vec2f(cos(a0),sin(a0))*s.x+vec2f(cos(a1),sin(a1))*s.y;
}
fn cameraRay(px:vec2f)->Ray {
 var r=pinhole(px);
 if(f.forward.w>0.0){
  let t=(f.eye.w-dot(r.o-f.eye.xyz,f.forward.xyz))/dot(r.d,f.forward.xyz);
  let focus=r.o+r.d*t;
  let l=lensPoint()*f.forward.w;
  r.o=r.o+f.right.xyz*l.x+f.up.xyz*l.y;
  r.d=normalize(focus-r.o);
 }
 return r;
}

// Materials: 4 vec4 per palette index (scene.ts packMaterial).
struct Mat {color:vec3f,alpha:f32,metal:f32,glass:f32,spec:f32,f0:f32,emission:vec3f,ior:f32,density:f32,scatter:f32,g:f32,flags:u32}
fn material(id:u32)->Mat {
 let a=materials[id*4u];let b=materials[id*4u+1u];let c=materials[id*4u+2u];let e=materials[id*4u+3u];
 return Mat(a.xyz,a.w,b.x,b.y,b.z,b.w,c.xyz,c.w,e.x,e.y,e.z,u32(e.w));
}
fn groundMat()->Mat {var m:Mat;m.color=f.ground.xyz;m.alpha=1.0;m.ior=1.5;return m;}
fn schlick3(f0:vec3f,c:f32)->vec3f {return f0+(1.0-f0)*pow(1.0-clamp(c,0.0,1.0),5.0);}
fn schlick1(f0:f32,c:f32)->f32 {return f0+(1.0-f0)*pow(1.0-clamp(c,0.0,1.0),5.0);}
fn ggxD(a2:f32,nh:f32)->f32 {let k=nh*nh*(a2-1.0)+1.0;return a2/(PI*k*k);}
fn lambdaG(a2:f32,c:f32)->f32 {let c2=max(c*c,1e-8);return 0.5*(sqrt(1.0+a2*(1.0-c2)/c2)-1.0);}
fn basis(n:vec3f)->mat3x3f {
 let s=select(-1.0,1.0,n.z>=0.0);let a=-1.0/(s+n.z);let b=n.x*n.y*a;
 return mat3x3f(vec3f(1.0+s*n.x*n.x*a,s*b,-s*n.x),vec3f(b,s+n.y*n.y*a,-n.y),n);
}
fn cosineDir(n:vec3f)->vec3f {
 let u=vec2f(rand(),rand());let r=sqrt(u.x);let p=TAU*u.y;
 return basis(n)*vec3f(r*cos(p),r*sin(p),sqrt(max(0.0,1.0-u.x)));
}
// A GGX microfacet normal sampled from the normals visible from wo (Heitz 2018).
fn vndf(wo:vec3f,alpha:f32,n:vec3f)->vec3f {
 let tb=basis(n);let w=transpose(tb)*wo;
 let vh=normalize(vec3f(alpha*w.x,alpha*w.y,w.z));
 let l2=vh.x*vh.x+vh.y*vh.y;
 let t1=select(vec3f(1.0,0.0,0.0),vec3f(-vh.y,vh.x,0.0)*inverseSqrt(max(l2,1e-20)),l2>1e-12);
 let t2=cross(vh,t1);
 let u=vec2f(rand(),rand());let r=sqrt(u.x);let p=TAU*u.y;
 let p1=r*cos(p);let s=0.5*(1.0+vh.z);let p2=(1.0-s)*sqrt(max(0.0,1.0-p1*p1))+s*r*sin(p);
 let m=p1*t1+p2*t2+sqrt(max(0.0,1.0-p1*p1-p2*p2))*vh;
 return tb*normalize(vec3f(alpha*m.x,alpha*m.y,max(1e-6,m.z)));
}
struct Eval {f:vec3f,pdf:f32}
// BSDF times cos(wi) and the density of sampling wi, over the lobes other than glass and perfectly specular ones.
fn evalSurface(m:Mat,n:vec3f,wo:vec3f,wi:vec3f)->Eval {
 var e:Eval;
 let ci=dot(n,wi);let co=dot(n,wo);
 if(ci<=0.0||co<=0.0){return e;}
 let pb=max(0.0,1.0-m.metal-m.glass);
 let pc=m.spec*schlick1(m.f0,co);
 e.f=pb*(1.0-pc)*m.color*(ci*INV_PI);
 e.pdf=pb*(1.0-pc)*ci*INV_PI;
 if((m.flags&SMOOTH)==0u){
  let h=normalize(wo+wi);let nh=dot(n,h);let vh=max(dot(wo,h),0.0);let a2=m.alpha*m.alpha;
  let d=ggxD(a2,nh);let lo=lambdaG(a2,co);let g2=1.0/(1.0+lo+lambdaG(a2,ci));
  let spec=d*g2/(4.0*co);
  e.f+=(m.metal*schlick3(m.color,vh)+pb*m.spec*schlick1(m.f0,vh))*spec;
  e.pdf+=(m.metal+pb*pc)*d/((1.0+lo)*4.0*co);
 }
 return e;
}
fn fresnel(ci:f32,eta:f32)->f32 {
 let s2=eta*eta*max(0.0,1.0-ci*ci);
 if(s2>=1.0){return 1.0;}
 let ct=sqrt(1.0-s2);
 let rs=(eta*ci-ct)/(eta*ci+ct);let rp=(ci-eta*ct)/(ci+eta*ct);
 return 0.5*(rs*rs+rp*rp);
}
struct Bounce {wi:vec3f,w:vec3f,pdf:f32,transmit:bool,ok:bool}
// Dielectric interface with relative index eta = n(incident side) / n(other side); smooth or GGX-rough.
fn dielectric(alpha:f32,n:vec3f,wo:vec3f,eta:f32,isSmooth:bool)->Bounce {
 var s:Bounce;
 var m=n;
 if(!isSmooth){m=vndf(wo,alpha,n);}
 let c=dot(wo,m);
 if(c<=0.0){return s;}
 if(rand()<fresnel(c,eta)){
  s.wi=reflect(-wo,m);
  if(dot(s.wi,n)<=0.0){return s;}
 } else {
  s.wi=refract(-wo,m,eta);
  s.transmit=true;
  if(dot(s.wi,n)>=0.0){return s;}
 }
 s.w=vec3f(1.0);
 if(!isSmooth){let a2=alpha*alpha;let lo=lambdaG(a2,dot(n,wo));s.w=vec3f((1.0+lo)/(1.0+lo+lambdaG(a2,abs(dot(n,s.wi)))));}
 s.ok=true;
 return s;
}
// One lobe picked by its weight, then the estimator over all non-glass lobes (pdf 0: no light-sampling weight).
fn sampleSurface(m:Mat,n:vec3f,wo:vec3f,etaI:f32)->Bounce {
 var s:Bounce;
 var r=rand();
 if(r<m.glass){return dielectric(m.alpha,n,wo,etaI/m.ior,(m.flags&SMOOTH)!=0u);}
 let rest=max(1.0-m.glass,1e-6);
 r=(r-m.glass)/rest;
 let co=dot(n,wo);
 let pb=max(0.0,1.0-m.metal-m.glass);
 let pc=m.spec*schlick1(m.f0,co);
 let qm=m.metal/rest;let qc=pb*pc/rest;
 if((m.flags&SMOOTH)!=0u){
  if(r<qm){s.wi=reflect(-wo,n);s.w=schlick3(m.color,co);s.ok=true;return s;}
  if(r<qm+qc){s.wi=reflect(-wo,n);s.w=vec3f(1.0);s.ok=true;return s;}
  s.wi=cosineDir(n);
 } else {
  if(r<qm+qc){s.wi=reflect(-wo,vndf(wo,m.alpha,n));}
  else{s.wi=cosineDir(n);}
 }
 let e=evalSurface(m,n,wo,s.wi);
 if(e.pdf<=0.0){return s;}
 s.w=e.f/e.pdf;s.pdf=e.pdf;s.ok=true;
 return s;
}
// Interior of a volume: free-flight sampling coefficient, scattering weight, absorption, phase anisotropy.
struct Medium {sigma:f32,albedo:vec3f,absorb:vec3f,g:f32,media:bool}
fn mediumOf(id:u32)->Medium {
 var r:Medium;
 if(id==0u){return r;}
 let m=material(id);
 r.g=m.g;
 if((m.flags&MEDIA)!=0u){r.sigma=m.density;r.albedo=m.color;r.media=true;}
 else{r.sigma=m.scatter;r.albedo=vec3f(1.0);r.absorb=m.density*-log(max(m.color,vec3f(1e-4)));}
 return r;
}
fn hgPdf(c:f32,g:f32)->f32 {let d=1.0+g*g-2.0*g*c;return (1.0-g*g)/(4.0*PI*d*sqrt(max(d,1e-12)));}
fn sampleHg(d:vec3f,g:f32)->vec3f {
 let u=vec2f(rand(),rand());
 var c=1.0-2.0*u.x;
 if(abs(g)>=1e-3){let k=(1.0-g*g)/(1.0+g-2.0*g*u.x);c=(1.0+g*g-k*k)/(2.0*g);}
 let s=sqrt(max(0.0,1.0-c*c));let p=TAU*u.y;
 return basis(d)*vec3f(s*cos(p),s*sin(p),c);
}
fn evalAt(kind:u32,m:Mat,n:vec3f,wo:vec3f,wi:vec3f)->Eval {
 if(kind==1u){let p=hgPdf(dot(-wo,wi),m.g);return Eval(vec3f(p),p);}
 return evalSurface(m,n,wo,wi);
}

// Lights.
fn envUV(d:vec3f)->vec2f {
 var u=atan2(d.x,-d.z)/TAU+0.5-f.weights.y/TAU;
 u=u-floor(u);
 return vec2f(u,acos(clamp(d.y,-1.0,1.0))/PI);
}
fn envTexel(uv:vec2f)->vec4f {
 let x=min(u32(uv.x*f32(f.env.x)),f.env.x-1u);let y=min(u32(uv.y*f32(f.env.y)),f.env.y-1u);
 return envmap[y*f.env.x+x];
}
fn envPdf(d:vec3f,t:vec4f)->f32 {
 let s=sqrt(max(0.0,1.0-d.y*d.y));
 if(s<=1e-6||f.weights.x<=0.0){return 0.0;}
 return t.w/f.weights.x/(2.0*PI*PI*s);
}
fn environment(d:vec3f,lastPdf:f32)->vec3f {
 var c=f.sky.xyz;
 if((f.config.z&ENV)!=0u){
  let t=envTexel(envUV(d));
  c=t.xyz*f.sky.w;
  if(lastPdf>0.0){c*=power2(lastPdf,envPdf(d,t));}
 }
 if((f.config.z&SUN)!=0u&&f.sunLight.w>0.0&&dot(d,f.sun.xyz)>=f.sun.w){
  c+=f.sunLight.xyz*select(1.0,power2(lastPdf,1.0/f.sunLight.w),lastPdf>0.0);
 }
 return c;
}
fn cone(axis:vec3f,cosMax:f32)->vec3f {
 let u=vec2f(rand(),rand());let c=1.0-u.x*(1.0-cosMax);let s=sqrt(max(0.0,1.0-c*c));let p=TAU*u.y;
 return basis(axis)*vec3f(s*cos(p),s*sin(p),c);
}
struct LightPoint {p:vec3f,n:vec3f,radiance:vec3f,pdfA:f32,twoSided:bool}
// An emissive voxel face: instance by its share of emitted power, face by its palette luminance, point uniform.
fn sampleEmitter()->LightPoint {
 var r:LightPoint;
 let u=rand();
 var lo=0u;var hi=f.lights.x-1u;
 while(lo<hi){let mid=(lo+hi)/2u;if(ll(f.lights.y+mid*2u+1u)<u){lo=mid+1u;}else{hi=mid;}}
 let inst=lights[f.lights.y+lo*2u];
 let ib=f.scene.y+inst*INSTANCE;
 let model=scene[ib+36u];let mb=f.scene.x+model*MODEL;
 let faces=scene[mb+8u];let count=scene[mb+9u];let total=fl(mb+10u);
 if(count==0u||total<=0.0){return r;}
 let u2=rand();
 lo=0u;hi=count-1u;
 while(lo<hi){let mid=(lo+hi)/2u;if(ll(faces+mid*2u+1u)<u2){lo=mid+1u;}else{hi=mid;}}
 let code=lights[faces+lo*2u];
 let cell=vec3i(i32(code&255u),i32((code>>8u)&255u),i32((code>>16u)&255u));
 let face=code>>24u;let axis=face>>1u;let sg=select(-1.0,1.0,(face&1u)==0u);
 var lp=vec3f(cell)+vec3f(rand(),rand(),rand());
 lp[axis]=f32(cell[axis])+select(0.0,1.0,sg>0.0)+sg*EPS;
 let w=worldX(inst);let l=localX(inst);
 let a1=(axis+1u)%3u;let a2=(axis+2u)%3u;
 let area=length(cross(colOf(w,a1),colOf(w,a2)));
 let m=material(voxelAt(model,cell));
 r.p=xpoint(w,lp);
 r.n=sg*normalize(rowOf(l,axis));
 r.radiance=m.emission;
 r.pdfA=fl(ib+38u)*lum(m.emission)/total/area;
 return r;
}
fn sampleArea()->LightPoint {
 var r:LightPoint;
 let u=rand();
 var k=0u;
 for(;k+1u<f.config.w;k++){if(ll(f.lights.z+k*16u+3u)>=u){break;}}
 let b=f.lights.z+k*16u;
 let c=vec3f(ll(b),ll(b+1u),ll(b+2u));let eu=vec3f(ll(b+4u),ll(b+5u),ll(b+6u));let ev=vec3f(ll(b+8u),ll(b+9u),ll(b+10u));
 let pk=ll(b+3u)-select(0.0,ll(b-13u),k>0u);
 r.p=c+eu*rand()+ev*rand();
 r.n=normalize(cross(eu,ev));
 r.radiance=vec3f(ll(b+12u),ll(b+13u),ll(b+14u));
 r.pdfA=pk/ll(b+11u);
 r.twoSided=ll(b+7u)!=0.0;
 return r;
}
fn lightTerm(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f,ls:LightPoint)->vec3f {
 if(ls.pdfA<=0.0){return vec3f(0.0);}
 let v=ls.p-o;let d2=dot(v,v);let dist=sqrt(d2);let wi=v/dist;
 var cl=-dot(ls.n,wi);
 if(ls.twoSided){cl=abs(cl);}
 if(cl<=0.0){return vec3f(0.0);}
 let e=evalAt(kind,m,n,wo,wi);
 if(!any(e.f>vec3f(0.0))){return vec3f(0.0);}
 let tr=shadow(o,wi,dist);
 if(tr<=0.0){return vec3f(0.0);}
 let lp=ls.pdfA*d2/cl;
 return e.f*ls.radiance*tr*power2(lp,e.pdf)/lp;
}
// Next-event estimation at a surface (kind 0) or a medium scattering point (kind 1): one sample of each light kind.
fn direct(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f)->vec3f {
 var L=vec3f(0.0);
 if((f.config.z&SUN)!=0u){
  var wi=f.sun.xyz;
  if(f.sunLight.w>0.0){wi=cone(f.sun.xyz,f.sun.w);}
  let e=evalAt(kind,m,n,wo,wi);
  if(any(e.f>vec3f(0.0))){
   let tr=shadow(o,wi,INF);
   if(tr>0.0){
    if(f.sunLight.w>0.0){let lp=1.0/f.sunLight.w;L+=e.f*f.sunLight.xyz*tr*power2(lp,e.pdf)/lp;}
    else{L+=e.f*f.sunLight.xyz*tr;}
   }
  }
 }
 if(f.lights.x>0u){L+=lightTerm(kind,m,n,wo,o,sampleEmitter());}
 if(f.config.w>0u){L+=lightTerm(kind,m,n,wo,o,sampleArea());}
 if((f.config.z&ENV)!=0u){
  let w=f.env.x;let h=f.env.y;
  let u1=rand();
  var lo=0u;var hi=h-1u;
  while(lo<hi){let mid=(lo+hi)/2u;if(ll(f.env.z+mid)<u1){lo=mid+1u;}else{hi=mid;}}
  let row=lo;let cb=f.env.w+row*w;let u2=rand();
  lo=0u;hi=w-1u;
  while(lo<hi){let mid=(lo+hi)/2u;if(ll(cb+mid)<u2){lo=mid+1u;}else{hi=mid;}}
  let uv=vec2f((f32(lo)+rand())/f32(w),(f32(row)+rand())/f32(h));
  let phi=(uv.x-0.5)*TAU+f.weights.y;let th=uv.y*PI;
  let wi=vec3f(sin(th)*sin(phi),cos(th),-sin(th)*cos(phi));
  let t=envmap[row*w+lo];
  let lp=envPdf(wi,t);
  if(lp>0.0){
   let e=evalAt(kind,m,n,wo,wi);
   if(any(e.f>vec3f(0.0))){
    let tr=shadow(o,wi,INF);
    if(tr>0.0){L+=e.f*t.xyz*f.sky.w*tr*power2(lp,e.pdf)/lp;}
   }
  }
 }
 return L;
}
// Weight of an emissive face found by BSDF sampling against light sampling of the same face.
fn emitWeight(h:Hit,n:vec3f,d:vec3f,radiance:vec3f,lastPdf:f32)->f32 {
 if(lastPdf<=0.0){return 1.0;}
 let ib=f.scene.y+h.inst*INSTANCE;
 let pick=fl(ib+38u);
 let total=fl(f.scene.x+scene[ib+36u]*MODEL+10u);
 if(pick<=0.0||total<=0.0){return 1.0;}
 let w=worldX(h.inst);
 let area=length(cross(colOf(w,(h.axis+1u)%3u),colOf(w,(h.axis+2u)%3u)));
 let lp=pick*lum(radiance)/total/area*h.t*h.t/max(-dot(n,d),1e-6);
 return power2(lastPdf,lp);
}
fn areaHit(k:u32,d:vec3f,t:f32,lastPdf:f32)->vec3f {
 let b=f.lights.z+k*16u;
 let radiance=vec3f(ll(b+12u),ll(b+13u),ll(b+14u));
 if(lastPdf<=0.0){return radiance;}
 let n=normalize(cross(vec3f(ll(b+4u),ll(b+5u),ll(b+6u)),vec3f(ll(b+8u),ll(b+9u),ll(b+10u))));
 let pk=ll(b+3u)-select(0.0,ll(b-13u),k>0u);
 let lp=pk/ll(b+11u)*t*t/max(abs(dot(n,d)),1e-6);
 return radiance*power2(lastPdf,lp);
}
fn roulette(thr:ptr<function,vec3f>,bounces:u32)->bool {
 if(bounces<3u){return true;}
 let q=clamp(max(max((*thr).x,(*thr).y),(*thr).z),0.05,1.0);
 if(rand()>=q){return false;}
 *thr/=q;
 return true;
}

struct Path {color:vec3f,albedo:vec3f,normal:vec3f,inv:f32}
fn radiance(px:vec2u)->Path {
 var res:Path;
 var jit=vec2f(0.5);
 if((f.config.z&JITTER)!=0u){jit=vec2f(rand(),rand());}
 motion=1.0;
 if((f.config.z&MOTION)!=0u){motion=1.0-f.weights.z*rand();}
 let ray=cameraRay(vec2f(px)+jit);
 var o=ray.o;var d=ray.d;
 var thr=vec3f(1.0);var L=vec3f(0.0);
 var medium=0u;var mInst=NONE;
 var lastPdf=0.0;
 var bounces=0u;
 var feature=true;var tint=vec3f(1.0);var primary=true;
 res.albedo=vec3f(1.0);res.normal=-d;
 let limit=f.config.x*4u+16u;
 for(var it=0u;it<limit;it++){
  let h=closest(o,d,medium,mInst);
  if(primary){primary=false;res.inv=select(0.0,1.0/max(h.t,1e-6),h.inst!=NONE);}
  if(medium!=0u){
   let md=mediumOf(medium);
   if(md.sigma>0.0){
    let ts=-log(1.0-rand())/md.sigma;
    if(ts<h.t){
     thr*=exp(-md.absorb*ts)*md.albedo;
     let p=o+d*ts;
     if(feature){feature=false;res.albedo=tint*md.albedo;res.normal=-d;}
     bounces++;
     if(bounces>f.config.x){break;}
     if(md.media){L+=thr*direct(1u,material(medium),vec3f(0.0),-d,p);}
     let wi=sampleHg(d,md.g);
     lastPdf=select(0.0,hgPdf(dot(d,wi),md.g),md.media);
     o=p;d=wi;
     if(!roulette(&thr,bounces)){break;}
     continue;
    }
   }
   thr*=exp(-md.absorb*h.t);
  }
  if(h.inst==NONE){L+=thr*environment(d,lastPdf);break;}
  let p=o+d*h.t;
  if(h.inst==AREA){
   L+=thr*areaHit(h.value,d,h.t,lastPdf);
   if(feature){feature=false;res.albedo=tint;res.normal=-d;}
   break;
  }
  var n:vec3f;var off:vec3f;var m:Mat;
  if(h.inst==GROUND){
   n=vec3f(0.0,select(-1.0,1.0,d.y<0.0),0.0);
   off=n*max(1e-4,1e-6*length(p));
   m=groundMat();
  } else {
   let lx=localX(h.inst);
   n=h.sgn*normalize(rowOf(lx,h.axis));
   off=h.sgn*EPS*colOf(worldX(h.inst),h.axis);
   if(h.value==0u){
    // Leaving a volume into empty space: media end without a surface, glass refracts out or reflects back in.
    let mm=material(medium);
    if((mm.flags&MEDIA)!=0u){medium=0u;mInst=NONE;o=p-off;continue;}
    let s=dielectric(mm.alpha,n,-d,mm.ior,(mm.flags&SMOOTH)!=0u);
    if(!s.ok){break;}
    thr*=s.w;
    if(s.transmit){medium=0u;mInst=NONE;o=p-off;}else{o=p+off;}
    d=s.wi;lastPdf=0.0;
    if(feature){tint*=s.w;}
    bounces++;
    if(bounces>f.config.x){break;}
    if(!roulette(&thr,bounces)){break;}
    continue;
   }
   m=material(h.value);
   if((m.flags&MEDIA)!=0u){medium=h.value;mInst=h.inst;o=p-off;continue;}
  }
  if((m.flags&EMISSIVE)!=0u){L+=thr*m.emission*emitWeight(h,n,d,m.emission,lastPdf);}
  let inAir=medium==0u||(material(medium).flags&MEDIA)!=0u;
  let wo=-d;
  let pb=max(0.0,1.0-m.metal-m.glass);
  let soft=pb>1e-6||((m.flags&SMOOTH)==0u&&m.metal>0.0);
  if(feature&&(soft||bounces>=3u)){feature=false;res.albedo=tint*m.color;res.normal=n;}
  if(inAir&&soft){L+=thr*direct(0u,m,n,wo,p+off);}
  let s=sampleSurface(m,n,wo,select(material(medium).ior,1.0,inAir));
  if(!s.ok){break;}
  thr*=s.w;
  if(s.transmit){
   if(h.inst==GROUND){break;}
   medium=h.value;mInst=h.inst;o=p-off;thr*=m.color;
  } else {o=p+off;}
  if(feature){tint*=s.w;}
  d=s.wi;lastPdf=select(0.0,s.pdf,inAir);
  bounces++;
  if(bounces>f.config.x){break;}
  if(!roulette(&thr,bounces)){break;}
 }
 res.color=L;
 if((f.config.z&CLAMP)!=0u){let l=lum(res.color);if(l>f.weights.w){res.color*=f.weights.w/l;}}
 if(!all((res.color>=vec3f(0.0))&(res.color<vec3f(1e30)))){res.color=vec3f(0.0);}
 return res;
}

@compute @workgroup_size(8,8) fn trace(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 let px=vec2u(gid.x+f.image.z,gid.y+f.image.w);
 let pixel=px.y*f.image.x+px.x;
 let slot=gid.y*f.tile.x+gid.x;
 var c=vec4f(0.0);var a=vec4f(0.0);var nn=vec3f(0.0);
 for(var s=0u;s<f.tile.w;s++){
  rng=hash((pixel*0x9e3779b1u)^hash(f.tile.z+s+hash(f.config.y)));
  let r=radiance(px);
  let l=lum(r.color);
  c+=vec4f(r.color,l*l);
  a+=vec4f(r.albedo,r.inv);
  nn+=r.normal;
 }
 if(f.tile.z==0u){accum[slot]=c;albedo[slot]=a;normals[slot]=vec4f(nn,0.0);}
 else{accum[slot]+=c;albedo[slot]+=a;let q=normals[slot];normals[slot]=vec4f(q.xyz+nn,q.w);}
}

@compute @workgroup_size(8,8) fn ids(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 motion=1.0;
 let ray=pinhole(vec2f(f32(gid.x+f.image.z)+0.5,f32(gid.y+f.image.w)+0.5));
 let h=closest(ray.o,ray.d,0u,NONE);
 var v=-1.0;
 if(h.inst==GROUND){v=-2.0;}else if(h.inst==AREA){v=-3.0;}else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value);}
 normals[gid.y*f.tile.x+gid.x].w=v;
}
`;

/**
 * Denoiser: `prepare` demodulates by albedo, estimates the variance of each pixel's mean and writes the guide (normal,
 * first-hit distance, pixel footprint); `atrous` runs one wavelet level (remodulating at the last). Edges stop on
 * normals, on the distance of a neighbour's first hit from the pixel's tangent plane (in pixel footprints, so coplanar
 * voxel faces blend and parallel ones at other heights do not) and on luminance against its standard deviation.
 */
export const DENOISE: string = /* wgsl */ `
struct Params {size:vec4u,sigma:vec4f,tile:vec4u,origins:array<vec4f,4>,directions:array<vec4f,4>}
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> accum:array<vec4f>;
@group(0) @binding(2) var<storage,read> albedo:array<vec4f>;
@group(0) @binding(3) var<storage,read> normals:array<vec4f>;
@group(0) @binding(4) var<storage,read> src:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> dst:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> guide:array<vec4f>;
fn lum(c:vec3f)->f32 {return dot(c,vec3f(0.2126,0.7152,0.0722));}
fn oct(n:vec3f)->vec2f {
 let a=n/(abs(n.x)+abs(n.y)+abs(n.z));
 if(a.z>=0.0){return a.xy;}
 return (1.0-abs(a.yx))*select(vec2f(-1.0),vec2f(1.0),a.xy>=vec2f(0.0));
}
fn unoct(e:vec2f)->vec3f {
 var n=vec3f(e,1.0-abs(e.x)-abs(e.y));
 let t=max(-n.z,0.0);
 n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
 return normalize(n);
}
// First-hit point at distance t along the camera ray through tile pixel position (x, y) (corner rays as the tracer's).
fn hitPoint(x:f32,y:f32,t:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 let o=mix(mix(p.origins[0],p.origins[1],uv.x),mix(p.origins[2],p.origins[3],uv.x),uv.y).xyz;
 let d=mix(mix(p.directions[0],p.directions[1],uv.x),mix(p.directions[2],p.directions[3],uv.x),uv.y).xyz;
 return o+normalize(d)*t;
}
fn albedoAt(i:u32)->vec3f {return max(albedo[i].xyz*p.sigma.w,vec3f(0.02));}
@compute @workgroup_size(8,8) fn prepare(@builtin(global_invocation_id) g:vec3u) {
 let w=p.size.x;let h=p.size.y;
 if(g.x>=w||g.y>=h){return;}
 let i=g.y*w+g.x;let k=p.sigma.w;let n=1.0/k;
 let c=accum[i].xyz*k;let a=albedoAt(i);
 let l=lum(c);
 // Variance of the pixel's mean luminance; from the 3x3 neighbourhood while there are too few samples.
 var v=max(0.0,accum[i].w*k-l*l)/max(n-1.0,1.0);
 if(n<4.0){
  var s1=0.0;var s2=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
   let q=u32(clamp(i32(g.y)+y,0,i32(h)-1))*w+u32(clamp(i32(g.x)+x,0,i32(w)-1));
   let lq=lum(accum[q].xyz*k);s1+=lq;s2+=lq*lq;
  }}
  v=max(v,max(0.0,s2/9.0-(s1/9.0)*(s1/9.0)));
 }
 let la=max(lum(a),0.02);
 dst[i]=vec4f(c/a,v/(la*la));
 let nn=normals[i].xyz;let len=length(nn);
 let inv=albedo[i].w*k;
 let t=select(0.0,1.0/inv,inv>0.0);
 let x=f32(g.x)+0.5;let y=f32(g.y)+0.5;
 let foot=select(0.0,length(hitPoint(x+1.0,y,t)-hitPoint(x,y,t)),t>0.0);
 guide[i]=vec4f(oct(select(vec3f(0.0,0.0,1.0),nn/len,len>1e-6)),t,foot);
}
fn tap(x:i32)->f32 {return select(select(0.0625,0.25,abs(x)==1),0.375,x==0);}
@compute @workgroup_size(8,8) fn atrous(@builtin(global_invocation_id) g:vec3u) {
 let w=p.size.x;let h=p.size.y;
 if(g.x>=w||g.y>=h){return;}
 let i=g.y*w+g.x;let st=i32(p.size.z);
 let cp=src[i];let gp=guide[i];let np=unoct(gp.xy);
 let at=vec2i(g.xy);
 let pp=hitPoint(f32(g.x)+0.5,f32(g.y)+0.5,gp.z);
 var vsum=0.0;var vw=0.0;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let q=u32(clamp(at.y+y,0,i32(h)-1))*w+u32(clamp(at.x+x,0,i32(w)-1));
  let k=select(0.25,0.5,x==0)*select(0.25,0.5,y==0);vsum+=src[q].w*k;vw+=k;
 }}
 let sl=p.sigma.x*sqrt(max(vsum/vw,0.0))+1e-6;
 let lp=lum(cp.xyz);
 let plane=p.sigma.z*gp.w+1e-6;
 var sum=vec3f(0.0);var vs=0.0;var ws=0.0;
 for(var y=-2;y<=2;y++){for(var x=-2;x<=2;x++){
  let qx=at.x+x*st;let qy=at.y+y*st;
  if(qx<0||qy<0||qx>=i32(w)||qy>=i32(h)){continue;}
  let q=u32(qy)*w+u32(qx);
  let cq=src[q];let gq=guide[q];
  var wg=select(0.0,1.0,(gp.z>0.0)==(gq.z>0.0));
  if(gp.z>0.0&&gq.z>0.0){wg=exp(-abs(dot(np,hitPoint(f32(qx)+0.5,f32(qy)+0.5,gq.z)-pp))/plane);}
  let wn=pow(max(0.0,dot(np,unoct(gq.xy))),p.sigma.y);
  let wl=exp(-abs(lum(cq.xyz)-lp)/sl);
  let wt=tap(x)*tap(y)*wn*wg*wl;
  sum+=cq.xyz*wt;vs+=cq.w*wt*wt;ws+=wt;
 }}
 var r=vec4f(sum/ws,vs/(ws*ws));
 if((p.size.w&1u)!=0u){r=vec4f(r.xyz*albedoAt(i),1.0);}
 dst[i]=r;
}
`;

/** Draws the accumulated (or denoised) image: bilinear upsampling, exposure, tone mapping, first-hit depth. */
export const DISPLAY: string = /* wgsl */ `${displayShader}
struct View {matrix:mat4x4f,inverse:mat4x4f,size:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> v:View;
@group(0) @binding(1) var<storage,read> color:array<vec4f>;
@group(0) @binding(2) var<storage,read> features:array<vec4f>;
struct VOut {@builtin(position) pos:vec4f}
@vertex fn vs(@builtin(vertex_index) i:u32)->VOut {
 let p=vec2f(f32((i<<1u)&2u),f32(i&2u));
 var o:VOut;o.pos=vec4f(p*2.0-1.0,0.0,1.0);return o;
}
struct FOut {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
fn srgb(c:vec3f)->vec3f {return select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));}
@fragment fn fs(i:VOut)->FOut {
 let tw=v.size.x;let th=v.size.y;let W=u32(tw);
 let q=i.pos.xy*vec2f(tw,th)/v.size.zw-0.5;
 let a=floor(q);let fr=q-a;
 let x0=u32(clamp(a.x,0.0,tw-1.0));let x1=u32(clamp(a.x+1.0,0.0,tw-1.0));
 let y0=u32(clamp(a.y,0.0,th-1.0));let y1=u32(clamp(a.y+1.0,0.0,th-1.0));
 let c=mix(mix(color[y0*W+x0].xyz,color[y0*W+x1].xyz,fr.x),mix(color[y1*W+x0].xyz,color[y1*W+x1].xyz,fr.x),fr.y)*v.params.x*v.params.y;
 var rgb=max(c,vec3f(0.0));
 let mode=u32(v.params.z);
 if((mode&1u)==0u){if((mode&2u)!=0u){rgb=srgb(min(rgb,vec3f(1.0)));}else{rgb=toDisplay(rgb);}}
 var o:FOut;
 o.color=vec4f(rgb,1.0);
 let nx=u32(clamp(floor(i.pos.x*tw/v.size.z),0.0,tw-1.0));let ny=u32(clamp(floor(i.pos.y*th/v.size.w),0.0,th-1.0));
 let inv=features[ny*W+nx].w*v.params.w;
 var z=0.0;
 if(inv>0.0){
  let ndc=vec2f(i.pos.x/v.size.z*2.0-1.0,1.0-i.pos.y/v.size.w*2.0);
  let a0=v.inverse*vec4f(ndc,1.0,1.0);let b0=v.inverse*vec4f(ndc,0.5,1.0);
  let pa=a0.xyz/a0.w;let pb=b0.xyz/b0.w;
  let clip=v.matrix*vec4f(pa+normalize(pb-pa)/inv,1.0);
  z=clamp(clip.z/clip.w,0.0,1.0);
 }
 o.depth=z;
 return o;
}
`;
