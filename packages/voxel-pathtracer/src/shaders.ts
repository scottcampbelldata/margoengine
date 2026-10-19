// WGSL of @margoengine/voxel-pathtracer, written from public literature:
// - traversal: Amanatides and Woo's grid walk (1987) over 8^3 bricks and voxels (same walk as traverse.ts), instances
//   in a bounding volume hierarchy, rays moved into each instance's model space by its affine inverse;
// - path tracing: unidirectional path tracing with next-event estimation and multiple importance sampling with the
//   power heuristic (Veach 1997), Russian roulette, PBRT's light transport structure (Pharr, Jakob, Humphreys);
// - surfaces: Lambert, GGX / Trowbridge-Reitz microfacets with height-correlated Smith masking (Walter et al. 2007,
//   Heitz 2014) sampled from visible normals (Heitz 2018), Schlick's Fresnel for conductors and coats, exact unpolarised
//   dielectric Fresnel with refraction for glass; orthonormal bases by Duff et al. (2017);
// - energy compensation: the multiple-scattering lobe of Kulla and Conty ("Revisiting Physically Based Shading at
//   Imageworks", 2017) for conductors, Fresnel-weighted by the hemispherical average of Schlick's Fresnel, and an
//   albedo normalisation for rough dielectrics (as in Turquin, "Practical multiple scattering compensation for
//   microfacet models", 2019); the albedo tables are integrated on the GPU at start-up by TABLES below, with the
//   tracer's own sampling code and a low-discrepancy R2/R3 sequence (Roberts 2018);
// - next-event estimation through smooth glass for distant lights (sun, environment): voxel glass faces are planes,
//   so the shadow ray refracts deterministically (Snell, exact Fresnel transmission, tint, absorption) with the
//   solid-angle Jacobian of each interface (radiance invariant L / n^2), and is kept when it leaves in the light's
//   direction; from inside glass the six face orientations are tried. Inside up to 8 light-sampled glass instances
//   (one smooth glass, orthogonal faces) total internal reflection continues the chain, so it may also leave in a
//   mirrored or (IOR below sqrt 2) perpendicular face's direction: those few candidate directions follow from Snell's
//   law per axis and are tried too, as is the reflection of the light by each face orientation of up to 8 mirror
//   instances (smooth pure metal). BSDF-sampled paths through the same chains are weighted against them by MIS (a
//   planar special case of specular next-event estimation, cf. Hanika et al. 2015, "Manifold Next Event Estimation");
// - volumes: homogeneous media by free-flight sampling with Beer-Lambert absorption as a weight, Henyey-Greenstein
//   phase function; environment maps importance sampled by marginal and conditional CDFs (PBRT);
// - dispersion: a path takes one wavelength at its first dispersive glass (sampled, weighted by its linear sRGB colour
//   matching weight over its density; spectrum.ts), Cauchy's index from the Abbe number;
// - random numbers: PCG (O'Neill 2014) with the hash of Jarzynski and Olano (2020);
// - denoising: the edge-avoiding a-trous wavelet filter (Dammertz et al. 2010) with variance-guided luminance weights
//   (Schied et al. 2017, "Spatiotemporal Variance-Guided Filtering"), on albedo-demodulated radiance.
// Material flags and record sizes must match scene.ts and layout.ts.
import { displayShader } from '../../shared/display.js';
import { DELTA_ALPHA, EMISSIVE, MATERIAL_FLOATS, MEDIA, SMOOTH } from './scene.js';
import { SPECTRUM } from './spectrum.js';
import {
  FLAG_CLAMP,
  FLAG_ENV,
  FLAG_GROUND,
  FLAG_JITTER,
  FLAG_MOTION,
  FLAG_SPLIT,
  FLAG_AREA,
  FLAG_CAMERA_MOTION,
  FLAG_CLEAR_GLASS,
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
 // The camera at shutter open (camera motion blur): corner rays and lens frame as above.
 prevOrigins:array<vec4f,4>,
 prevDirections:array<vec4f,4>,
 prevEye:vec4f,
 prevForward:vec4f,
 prevRight:vec4f,
 prevUp:vec4f,
 // Projection mode (0 camera, 1 panorama, 2 fisheye), fisheye mapping (0 equidistant, 1 equisolid), distortion on.
 projection:vec4u,
 // Fisheye field of view (radians) and sin(fov / 4).
 lensFov:vec4f,
 // Brown-Conrady k1, k2, p1, p2.
 distortion:vec4f,
}
`;

// Fixed-point multipliers of the R2 and R3 sequences (fract(k * alpha) computed exactly in u32 arithmetic).
const fixed = (a: number) => `${Math.round(a * 2 ** 32) % 2 ** 32}u`;

/** Constants and microfacet functions shared by the tracer and the table generator. */
const COMMON = /* wgsl */ `
const PI=3.141592653589793;
const TAU=6.283185307179586;
const INV_PI=0.3183098861837907;
fn basis(n:vec3f)->mat3x3f {
 let s=select(-1.0,1.0,n.z>=0.0);let a=-1.0/(s+n.z);let b=n.x*n.y*a;
 return mat3x3f(vec3f(1.0+s*n.x*n.x*a,s*b,-s*n.x),vec3f(b,s+n.y*n.y*a,-n.y),n);
}
fn ggxD(a2:f32,nh:f32)->f32 {let k=nh*nh*(a2-1.0)+1.0;return a2/(PI*k*k);}
fn lambdaG(a2:f32,c:f32)->f32 {let c2=max(c*c,1e-8);return 0.5*(sqrt(1.0+a2*(1.0-c2)/c2)-1.0);}
fn fresnel(ci:f32,eta:f32)->f32 {
 let s2=eta*eta*max(0.0,1.0-ci*ci);
 if(s2>=1.0){return 1.0;}
 let ct=sqrt(1.0-s2);
 let rs=(eta*ci-ct)/(eta*ci+ct);let rp=(ci-eta*ct)/(ci+eta*ct);
 return 0.5*(rs*rs+rp*rp);
}
// A GGX microfacet normal sampled from the normals visible from wo (Heitz 2018), for uniform numbers u.
fn vndfU(wo:vec3f,alpha:f32,n:vec3f,u:vec2f)->vec3f {
 let tb=basis(n);let w=transpose(tb)*wo;
 let vh=normalize(vec3f(alpha*w.x,alpha*w.y,w.z));
 let l2=vh.x*vh.x+vh.y*vh.y;
 let t1=select(vec3f(1.0,0.0,0.0),vec3f(-vh.y,vh.x,0.0)*inverseSqrt(max(l2,1e-20)),l2>1e-12);
 let t2=cross(vh,t1);
 let r=sqrt(u.x);let p=TAU*u.y;
 let p1=r*cos(p);let s=0.5*(1.0+vh.z);let p2=(1.0-s)*sqrt(max(0.0,1.0-p1*p1))+s*r*sin(p);
 let m=p1*t1+p2*t2+sqrt(max(0.0,1.0-p1*p1-p2*p2))*vh;
 return tb*normalize(vec3f(alpha*m.x,alpha*m.y,max(1e-6,m.z)));
}
`;

/** Floats of the albedo tables (TABLES), as vec4: E(mu, r) 32 x 32, Eavg(r) 32, glass E(mu, r, eta) 16 x 16 x 32. */
export const TABLE_VEC4 = 2312;

/**
 * Albedo tables for energy compensation, one cell per invocation: directional albedo E(mu, roughness) of the GGX
 * conductor lobe with Fresnel 1, its cosine-weighted average Eavg(roughness), and the directional albedo of the rough
 * dielectric interface E(mu, roughness, eta) (reflection plus refraction). Each is the expected weight of the tracer's
 * own estimator (visible-normal sampling, G2 / G1 weights) over 4,096 (65,536 for Eavg) low-discrepancy samples.
 */
export const TABLES: string = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<storage,read_write> table:array<f32>;
const E_MU=32u;const E_R=32u;const G_MU=16u;const G_R=16u;const G_ETA=32u;
const E_AVG_BASE=1024u;const GLASS_BASE=1056u;const TABLE_SIZE=9248u;const SAMPLES=4096u;
fn seq(k:u32,a:u32)->f32 {return f32((k*a+0x80000000u)>>8u)*5.960464477539063e-8;}
fn muAt(i:u32,n:u32)->f32 {return max(f32(i)/f32(n-1u),0.002);}
fn roughAt(j:u32,n:u32)->f32 {return f32(j)/f32(n-1u);}
fn reflectWeight(mu:f32,alpha:f32,u:vec2f)->f32 {
 let a2=alpha*alpha;let n=vec3f(0.0,0.0,1.0);let wo=vec3f(sqrt(max(0.0,1.0-mu*mu)),0.0,mu);
 let lo=lambdaG(a2,mu);let wi=reflect(-wo,vndfU(wo,alpha,n,u));
 return select(0.0,(1.0+lo)/(1.0+lo+lambdaG(a2,wi.z)),wi.z>0.0);
}
fn albedoE(mu:f32,r:f32)->f32 {
 let alpha=max(r*r,1e-4);var sum=0.0;
 for(var k=0u;k<SAMPLES;k++){sum+=reflectWeight(mu,alpha,vec2f(seq(k,${fixed(0.7548776662466927)}),seq(k,${fixed(0.5698402909980532)})));}
 return sum/f32(SAMPLES);
}
fn averageE(r:f32)->f32 {
 let alpha=max(r*r,1e-4);var sum=0.0;let n=SAMPLES*16u;
 for(var k=0u;k<n;k++){
  let mu=max(sqrt(seq(k,${fixed(0.8191725133961645)})),0.002);
  sum+=reflectWeight(mu,alpha,vec2f(seq(k,${fixed(0.6710436067037893)}),seq(k,${fixed(0.5497004779019703)})));
 }
 return sum/f32(n);
}
fn albedoGlass(mu:f32,r:f32,eta:f32)->f32 {
 let alpha=max(r*r,1e-4);let a2=alpha*alpha;let n=vec3f(0.0,0.0,1.0);let wo=vec3f(sqrt(max(0.0,1.0-mu*mu)),0.0,mu);
 let lo=lambdaG(a2,mu);var sum=0.0;
 for(var k=0u;k<SAMPLES;k++){
  let m=vndfU(wo,alpha,n,vec2f(seq(k,${fixed(0.7548776662466927)}),seq(k,${fixed(0.5698402909980532)})));
  let c=dot(wo,m);
  if(c<=0.0){continue;}
  let fr=fresnel(c,eta);
  let wr=reflect(-wo,m);
  if(wr.z>0.0){sum+=fr*(1.0+lo)/(1.0+lo+lambdaG(a2,wr.z));}
  if(fr<1.0){let wt=refract(-wo,m,eta);if(wt.z<0.0){sum+=(1.0-fr)*(1.0+lo)/(1.0+lo+lambdaG(a2,-wt.z));}}
 }
 return sum/f32(SAMPLES);
}
@compute @workgroup_size(64) fn tables(@builtin(global_invocation_id) g:vec3u) {
 let i=g.x;
 if(i<E_AVG_BASE){table[i]=albedoE(muAt(i%E_MU,E_MU),roughAt(i/E_MU,E_R));return;}
 if(i<GLASS_BASE){table[i]=averageE(roughAt(i-E_AVG_BASE,E_R));return;}
 if(i<TABLE_SIZE){
  let j=i-GLASS_BASE;
  let eta=exp((2.0*f32(j/(G_MU*G_R))/f32(G_ETA-1u)-1.0)*log(3.0));
  table[i]=albedoGlass(muAt(j%G_MU,G_MU),roughAt((j/G_MU)%G_R,G_R),eta);
 }
}
`;

/** The path tracer: entry points `trace` (accumulate samples) and `ids` (pixel-centre instance and palette ids). */
export const TRACE: string = /* wgsl */ `${FRAME}${COMMON}${SPECTRUM}
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
const SPLIT=${FLAG_SPLIT}u;
const AREA_NEE=${FLAG_AREA}u;
const CAMERA_MOTION=${FLAG_CAMERA_MOTION}u;
const CLEAR_GLASS=${FLAG_CLEAR_GLASS}u;
const MODEL=${MODEL_WORDS}u;
const INSTANCE=${INSTANCE_WORDS}u;
@group(0) @binding(0) var<uniform> f:Frame;
const MV=${MATERIAL_FLOATS / 4}u;
@group(0) @binding(1) var<uniform> materials:array<vec4f,${(256 * MATERIAL_FLOATS) / 4}>;
@group(0) @binding(2) var<storage,read> voxels:array<u32>;
@group(0) @binding(3) var<storage,read> scene:array<u32>;
@group(0) @binding(4) var<storage,read> lights:array<u32>;
@group(0) @binding(5) var<storage,read> envmap:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> albedo:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> normals:array<vec4f>;
@group(0) @binding(9) var<uniform> tables:array<vec4f,${TABLE_VEC4}>;
@group(0) @binding(10) var<storage,read_write> caustics:array<vec4f>;
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
fn extinction(v:u32)->f32 {let x=materials[v*MV+3u];return select(-1.0,x.x,(u32(x.w)&MEDIA)!=0u);}
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
// A surface of another instance that coincides with the current volume's own exit (glass resting on a floor model)
// wins the tie: the path meets the floor rather than leaving the glass into it.
fn traceInstance(i:u32,o:vec3f,d:vec3f,medium:u32,mInst:u32,h:ptr<function,Hit>) {
 let m=localX(i);
 var r:Hit;
 let own=i==mInst;
 let exitTie=!own&&(*h).inst==mInst&&(*h).value==0u;
 let tMax=select((*h).t,(*h).t*1.0001+1e-4,exitTie);
 if(march(scene[f.scene.y+i*INSTANCE+36u],xpoint(m,o),xdir(m,d),0.0,tMax,select(0u,medium,own),&r)){
  if(exitTie){if(r.value!=0u||r.t<(*h).t){r.inst=i;*h=r;}return;}
  if(own&&r.value==0u&&(*h).inst!=NONE&&(*h).t<r.t*1.0001+1e-4){return;}
  r.inst=i;*h=r;
 }
}
fn opaqueArea(k:u32)->bool {return ll(f.lights.z+k*16u+15u)!=0.0;}
// Distance along o + t d (t > 0) to area light k's rectangle from either face, -1 when the ray misses it.
fn rectHit(k:u32,o:vec3f,d:vec3f)->f32 {
 let b=f.lights.z+k*16u;
 let c=vec3f(ll(b),ll(b+1u),ll(b+2u));let eu=vec3f(ll(b+4u),ll(b+5u),ll(b+6u));let ev=vec3f(ll(b+8u),ll(b+9u),ll(b+10u));
 let n=cross(eu,ev);let dn=dot(d,n);
 if(abs(dn)<1e-20){return -1.0;}
 let t=dot(c-o,n)/dn;
 if(t<=0.0){return -1.0;}
 let q=o+d*t-c;
 let uu=dot(eu,eu);let uv=dot(eu,ev);let vv=dot(ev,ev);let qu=dot(q,eu);let qv=dot(q,ev);let den=uu*vv-uv*uv;
 let s=(qu*vv-qv*uv)/den;let r=(qv*uu-qu*uv)/den;
 if(s<0.0||s>1.0||r<0.0||r>1.0){return -1.0;}
 return t;
}
// Closest boundary along a world ray: ground plane, area lights, then voxels through the hierarchy. In a volume
// (medium != 0) the volume's own instance is walked for the cell where the volume ends.
fn closest(o:vec3f,d:vec3f,medium:u32,mInst:u32)->Hit {
 var h:Hit;h.t=INF;h.inst=NONE;
 if((f.config.z&HAS_GROUND)!=0u&&abs(d.y)>1e-9){let t=(f.ground.w-o.y)/d.y;if(t>0.0){h.t=t;h.inst=GROUND;}}
 for(var k=0u;k<f.config.w;k++){
  // The back of a see-through one-sided light is not there; solid lights are hit from both faces.
  let b=f.lights.z+k*16u;
  if(ll(b+7u)==0.0&&!opaqueArea(k)&&dot(d,cross(vec3f(ll(b+4u),ll(b+5u),ll(b+6u)),vec3f(ll(b+8u),ll(b+9u),ll(b+10u))))>0.0){continue;}
  let t=rectHit(k,o,d);
  if(t<=0.0||t>=h.t){continue;}
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
 // Solid area lights (a light sampled on its own rectangle ends just before it).
 for(var k=0u;k<f.config.w;k++){if(opaqueArea(k)){let t=rectHit(k,o,d);if(t>0.0&&t<tMax*(1.0-1e-4)){return 0.0;}}}
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
 var o=mix(mix(f.origins[0],f.origins[1],uv.x),mix(f.origins[2],f.origins[3],uv.x),uv.y).xyz;
 var d=mix(mix(f.directions[0],f.directions[1],uv.x),mix(f.directions[2],f.directions[3],uv.x),uv.y).xyz;
 if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){
  // Camera motion blur: the corner rays interpolated between the shutter-open and shutter-close poses.
  let po=mix(mix(f.prevOrigins[0],f.prevOrigins[1],uv.x),mix(f.prevOrigins[2],f.prevOrigins[3],uv.x),uv.y).xyz;
  let pd=mix(mix(f.prevDirections[0],f.prevDirections[1],uv.x),mix(f.prevDirections[2],f.prevDirections[3],uv.x),uv.y).xyz;
  o=mix(po,o,motion);d=mix(pd,d,motion);
 }
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
// The undistorted pixel position seen at pixel position px (Brown-Conrady, inverted by fixed-point iteration), in
// units of half the image height from the centre, y up.
fn undistort(px:vec2f)->vec2f {
 let W=f32(f.image.x);let H=f32(f.image.y);
 let xd=vec2f(px.x-0.5*W,0.5*H-px.y)/(0.5*H);
 let k=f.distortion;
 var u=xd;
 for(var i=0;i<20;i++){
  let r2=dot(u,u);
  let radial=1.0+k.x*r2+k.y*r2*r2;
  let t=vec2f(2.0*k.z*u.x*u.y+k.w*(r2+2.0*u.x*u.x),k.z*(r2+2.0*u.y*u.y)+2.0*k.w*u.x*u.y);
  u=(xd-t)/radial;
 }
 return vec2f(u.x*0.5*H+0.5*W,0.5*H-u.y*0.5*H);
}
// Panorama and fisheye rays from the eye along the camera's axes (interpolated with camera motion); d = 0 outside a
// fisheye's circle.
fn wideRay(px:vec2f)->Ray {
 var eye=f.eye.xyz;var fw=f.forward.xyz;var rt=f.right.xyz;var up=f.up.xyz;
 if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){
  eye=mix(f.prevEye.xyz,eye,motion);fw=normalize(mix(f.prevForward.xyz,fw,motion));
  rt=normalize(mix(f.prevRight.xyz,rt,motion));up=normalize(mix(f.prevUp.xyz,up,motion));
 }
 let W=f32(f.image.x);let H=f32(f.image.y);
 if(f.projection.x==1u){
  let phi=(px.x/W-0.5)*TAU;let el=(0.5-px.y/H)*PI;
  return Ray(eye,normalize(cos(el)*(sin(phi)*rt+cos(phi)*fw)+sin(el)*up));
 }
 let p=vec2f(px.x-0.5*W,0.5*H-px.y)/(0.5*H);
 let r=length(p);
 var th=r*0.5*f.lensFov.x;
 if(f.projection.y==1u){let s=r*f.lensFov.y;if(s>1.0){return Ray(eye,vec3f(0.0));}th=2.0*asin(s);}
 if(th>0.5*f.lensFov.x+1e-6){return Ray(eye,vec3f(0.0));}
 let a=select(vec2f(0.0),p/r,r>0.0);
 return Ray(eye,normalize(cos(th)*fw+sin(th)*(a.x*rt+a.y*up)));
}
// The ray through pixel position px without the lens: the projection's, distortion applied.
fn viewRay(px:vec2f)->Ray {
 if(f.projection.x!=0u){return wideRay(px);}
 return pinhole(select(px,undistort(px),f.projection.z!=0u));
}
fn cameraRay(px:vec2f)->Ray {
 var r=viewRay(px);
 if(f.forward.w>0.0&&f.projection.x==0u){
  var eye=f.eye;var fw=f.forward.xyz;var rt=f.right.xyz;var up=f.up.xyz;
  if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){
   eye=mix(f.prevEye,f.eye,motion);fw=normalize(mix(f.prevForward.xyz,fw,motion));
   rt=normalize(mix(f.prevRight.xyz,rt,motion));up=normalize(mix(f.prevUp.xyz,up,motion));
  }
  let t=(eye.w-dot(r.o-eye.xyz,fw))/dot(r.d,fw);
  let focus=r.o+r.d*t;
  let l=lensPoint()*f.forward.w;
  r.o=r.o+rt*l.x+up*l.y;
  r.d=normalize(focus-r.o);
 }
 return r;
}

// Materials: 4 vec4 per palette index (scene.ts packMaterial).
// disp: Cauchy coefficient B (square micrometres; 0 without dispersion), ior the index at the d line.
struct Mat {color:vec3f,alpha:f32,metal:f32,glass:f32,spec:f32,f0:f32,emission:vec3f,ior:f32,density:f32,scatter:f32,g:f32,flags:u32,disp:f32}
fn material(id:u32)->Mat {
 let a=materials[id*MV];let b=materials[id*MV+1u];let c=materials[id*MV+2u];let e=materials[id*MV+3u];
 let x=materials[id*MV+4u];
 return Mat(a.xyz,a.w,b.x,b.y,b.z,b.w,c.xyz,c.w,e.x,e.y,e.z,u32(e.w),x.x);
}
// Index of a dispersive material at wavelength l (nanometres).
fn iorAt(m:Mat,l:f32)->f32 {let x=l*0.001;return m.ior+m.disp*(1.0/(x*x)-1.0/(LAMBDA_D*LAMBDA_D));}
// Smooth glass without dispersion: what light sampling refracts through.
fn clearGlass(m:Mat)->bool {return (m.flags&SMOOTH)!=0u&&m.disp==0.0;}
// The path's wavelength, taken at its first dispersive interface (or fixed by the frame): the throughput is weighted
// by that wavelength's RGB weight over its density.
fn collapse(lambda:ptr<function,f32>,thr:ptr<function,vec3f>) {
 if(*lambda>0.0){return;}
 let w=sampleLambda(vec2f(rand(),rand()));
 *thr*=spectralRgb(w.x)/w.y;*lambda=w.x;
}
fn groundMat()->Mat {var m:Mat;m.color=f.ground.xyz;m.alpha=1.0;m.ior=1.5;return m;}
fn schlick3(f0:vec3f,c:f32)->vec3f {return f0+(1.0-f0)*pow(1.0-clamp(c,0.0,1.0),5.0);}
fn schlick1(f0:f32,c:f32)->f32 {return f0+(1.0-f0)*pow(1.0-clamp(c,0.0,1.0),5.0);}
fn cosineDir(n:vec3f)->vec3f {
 let u=vec2f(rand(),rand());let r=sqrt(u.x);let p=TAU*u.y;
 return basis(n)*vec3f(r*cos(p),r*sin(p),sqrt(max(0.0,1.0-u.x)));
}
fn vndf(wo:vec3f,alpha:f32,n:vec3f)->vec3f {return vndfU(wo,alpha,n,vec2f(rand(),rand()));}
// Albedo tables (TABLES): bilinear in (mu, roughness), trilinear with log(eta) for the dielectric.
fn tab(i:u32)->f32 {return tables[i>>2u][i&3u];}
fn tableE(mu:f32,r:f32)->f32 {
 let x=clamp(mu,0.0,1.0)*31.0;let y=clamp(r,0.0,1.0)*31.0;let x0=min(u32(x),30u);let y0=min(u32(y),30u);
 let fx=x-f32(x0);let fy=y-f32(y0);let i=x0+32u*y0;
 return mix(mix(tab(i),tab(i+1u),fx),mix(tab(i+32u),tab(i+33u),fx),fy);
}
fn tableEavg(r:f32)->f32 {let y=clamp(r,0.0,1.0)*31.0;let y0=min(u32(y),30u);return mix(tab(1024u+y0),tab(1025u+y0),y-f32(y0));}
fn tableGlass(mu:f32,r:f32,eta:f32)->f32 {
 let x=clamp(mu,0.0,1.0)*15.0;let y=clamp(r,0.0,1.0)*15.0;let z=clamp((log(eta)/log(3.0)+1.0)*0.5,0.0,1.0)*31.0;
 let x0=min(u32(x),14u);let y0=min(u32(y),14u);let z0=min(u32(z),30u);
 let fx=x-f32(x0);let fy=y-f32(y0);let fz=z-f32(z0);
 let i=1056u+x0+16u*(y0+16u*z0);
 let a=mix(mix(tab(i),tab(i+1u),fx),mix(tab(i+16u),tab(i+17u),fx),fy);
 let b=mix(mix(tab(i+256u),tab(i+257u),fx),mix(tab(i+272u),tab(i+273u),fx),fy);
 return mix(a,b,fz);
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
  var qms=0.0;
  if(m.metal>0.0){
   // Multiple scattering between the microfacets (Kulla and Conty): (1 - E(mu_o)) (1 - E(mu_i)) / (pi (1 - Eavg)),
   // scaled by Favg^2 Eavg / (1 - Favg (1 - Eavg)) with Favg the hemispherical average of Schlick's Fresnel.
   let rough=sqrt(m.alpha);let ea=tableEavg(rough);
   qms=clamp(1.0-tableE(co,rough),0.0,1.0);
   let fa=m.color+(1.0-m.color)/21.0;
   e.f+=m.metal*fa*fa*ea/(1.0-fa*(1.0-ea))*qms*(1.0-tableE(ci,rough))/(PI*max(1.0-ea,1e-4))*ci;
  }
  e.pdf+=(m.metal*(1.0-qms)+pb*pc)*d/((1.0+lo)*4.0*co)+m.metal*qms*ci*INV_PI;
 }
 return e;
}
// lobe: 0 cosine (diffuse, multiple scattering), 1 microfacet reflection, 2 perfect mirror, 3 dielectric.
struct Bounce {wi:vec3f,w:vec3f,pdf:f32,transmit:bool,ok:bool,lobe:u32}
// Dielectric interface with relative index eta = n(incident side) / n(other side); smooth or GGX-rough. Rough
// interfaces divide by their directional albedo, so the energy masking and shadowing would lose comes back.
fn dielectric(alpha:f32,n:vec3f,wo:vec3f,eta:f32,isSmooth:bool)->Bounce {
 var s:Bounce;
 s.lobe=3u;
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
 if(!isSmooth){
  let a2=alpha*alpha;let co=dot(n,wo);let lo=lambdaG(a2,co);
  s.w=vec3f((1.0+lo)/(1.0+lo+lambdaG(a2,abs(dot(n,s.wi))))/max(tableGlass(co,sqrt(alpha),eta),0.05));
 }
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
  if(r<qm){s.wi=reflect(-wo,n);s.w=schlick3(m.color,co);s.ok=true;s.lobe=2u;return s;}
  if(r<qm+qc){s.wi=reflect(-wo,n);s.w=vec3f(1.0);s.ok=true;s.lobe=2u;return s;}
  s.wi=cosineDir(n);
 } else {
  let qms=select(0.0,clamp(1.0-tableE(co,sqrt(m.alpha)),0.0,1.0),m.metal>0.0);
  if(r<qm*(1.0-qms)+qc){s.wi=reflect(-wo,vndf(wo,m.alpha,n));s.lobe=1u;}
  else{s.wi=cosineDir(n);}
 }
 let e=evalSurface(m,n,wo,s.wi);
 if(e.pdf<=0.0){return s;}
 s.w=e.f/e.pdf;s.pdf=e.pdf;s.ok=true;
 return s;
}
// Interior of a volume: free-flight sampling coefficient, scattering weight, absorption, phase anisotropy.
// emit: radiance a medium adds per world unit (media only).
struct Medium {sigma:f32,albedo:vec3f,absorb:vec3f,g:f32,media:bool,emit:vec3f}
fn mediumOf(id:u32)->Medium {
 var r:Medium;
 if(id==0u){return r;}
 let m=material(id);
 r.g=m.g;
 if((m.flags&MEDIA)!=0u){r.sigma=m.density;r.albedo=m.color;r.media=true;r.emit=m.emission;}
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
// Radiance of the environment and sun disk in direction d, weighted against light sampling when the path was sampled
// with density bsdfPdf (0: no light sampling could have found it) through a chain of refractions with Jacobian j.
fn environment(d:vec3f,bsdfPdf:f32,j:f32)->vec3f {
 var c=f.sky.xyz;
 if((f.config.z&ENV)!=0u){
  let t=envTexel(envUV(d));
  c=t.xyz*f.sky.w;
  if(bsdfPdf>0.0){c*=power2(bsdfPdf,envPdf(d,t)/j);}
 }
 if((f.config.z&SUN)!=0u&&f.sunLight.w>0.0&&dot(d,f.sun.xyz)>=f.sun.w){
  c+=f.sunLight.xyz*select(1.0,power2(bsdfPdf,1.0/f.sunLight.w/j),bsdfPdf>0.0);
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
// Shadow rays toward distant lights through smooth glass and off mirrors are walked by the path loop itself (radiance,
// one closest-hit call for both): refraction with Fresnel transmission, entry tint, absorption and media, the product
// of the interfaces' solid-angle Jacobians dw(near) / dw(far), and the direction it finally leaves in. A vertex offers
// every candidate that needs such a walk with a selection weight and one is kept with probability weight / total
// (weighted reservoir sampling), its result scaled by total / weight: an unbiased estimate of their sum at the cost of
// one walk. light, lp: the light's radiance and density; f (BSDF value times light times total / weight) and pdf are
// filled in for the kept one.
struct Walk {total:f32,weight:f32,o:vec3f,d:vec3f,medium:u32,mInst:u32,s:vec3f,want:u32,light:vec3f,lp:f32,f:vec3f,pdf:f32}
fn offer(w:ptr<function,Walk>,weight:f32,o:vec3f,d0:vec3f,medium:u32,mInst:u32,s:vec3f,want:u32,light:vec3f,lp:f32) {
 (*w).total+=weight;
 if(rand()*(*w).total<weight){
  (*w).weight=weight;(*w).o=o;(*w).d=d0;(*w).medium=medium;(*w).mInst=mInst;(*w).s=s;(*w).want=want;(*w).light=light;
  (*w).lp=lp;
 }
}
fn prismAt(inst:u32)->bool {return (scene[f.scene.y+inst*INSTANCE+37u]&2u)!=0u;}
fn mirrorAt(inst:u32)->bool {return (scene[f.scene.y+inst*INSTANCE+37u]&4u)!=0u;}
fn isMirror(m:Mat)->bool {return m.metal>=1.0&&(m.flags&SMOOTH)!=0u;}
// Directions equal to float precision (refraction chains through axis faces reproduce them to about 1e-7); mirror
// candidates skip components smaller than SAME_C, whose flip would repeat a direction.
const SAME_C=1e-5;
// Selection weight of a candidate whose chain a box model makes unlikely (likely ones weigh 1).
const UNLIKELY=0.02;
fn same(a:vec3f,b:vec3f)->bool {let e=a-b;return dot(e,e)<SAME_C*SAME_C;}
fn rowSel(u0:vec3f,u1:vec3f,u2:vec3f,k:u32)->vec3f {return select(select(u2,u1,k==1u),u0,k==0u);}
fn comp(v:vec3f,k:u32)->f32 {return select(select(v.z,v.y,k==1u),v.x,k==0u);}
// Whether the ray o + t d (t > 0) meets the model box [0, sz] of an instance whose world-to-model transform is x.
// Where the ray o + t d (t > 0) meets the model box [0, sz] of an instance whose world-to-model transform is x: the
// axis of the face it enters through (0..2; 3 when it starts inside, 4 when it misses) and the distance to it.
fn boxEntry(x:Xform,sz:vec3f,o:vec3f,d:vec3f)->vec2f {
 let lo=xpoint(x,o);let inv=safeInv(xdir(x,d));
 let ta=-lo*inv;let tb=(sz-lo)*inv;let tn=min(ta,tb);let tf=max(ta,tb);
 let t0=max(max(tn.x,tn.y),tn.z);let t1=min(min(tf.x,tf.y),tf.z);
 if(!(t0<t1&&t1>0.0)){return vec2f(4.0,0.0);}
 if(t0<=0.0){return vec2f(3.0,0.0);}
 return vec2f(select(select(2.0,1.0,t0==tn.y),0.0,t0==tn.x),t0);
}
// The axis of the box face that a ray from inside (o, d) leaves through.
fn boxExit(x:Xform,sz:vec3f,o:vec3f,d:vec3f)->u32 {
 let lo=xpoint(x,o);let inv=safeInv(xdir(x,d));
 let tf=max(-lo*inv,(sz-lo)*inv);let t1=min(min(tf.x,tf.y),tf.z);
 return select(select(2u,1u,t1==tf.y),0u,t1==tf.x);
}
// Bits (1, 2, 4) of the axes along which v has a component that a mirror visibly flips.
fn flippable(v:vec3f,u0:vec3f,u1:vec3f,u2:vec3f)->u32 {
 return select(0u,1u,abs(dot(v,u0))>=SAME_C)|select(0u,2u,abs(dot(v,u1))>=SAME_C)|select(0u,4u,abs(dot(v,u2))>=SAME_C);
}
// v with the components along the unit axes u0, u1, u2 flipped where bits (1, 2, 4) are set.
fn flipped(v:vec3f,u0:vec3f,u1:vec3f,u2:vec3f,bits:u32)->vec3f {
 var r=v;
 if((bits&1u)!=0u){r-=2.0*dot(v,u0)*u0;}
 if((bits&2u)!=0u){r-=2.0*dot(v,u1)*u1;}
 if((bits&4u)!=0u){r-=2.0*dot(v,u2)*u2;}
 return r;
}
// Candidate directions d0 at a vertex for distant light leaving the glass in direction s (radiance light, density lp),
// offered for the shadow walk: want = NONE for chains that keep their direction after leaving the vertex's own glass,
// else the light-sampled instance that must turn it (exactly once); distinct candidates are distinct directions, so no
// chain is counted twice. Faces of a voxel instance have three orthogonal normals; mirrors (total internal
// reflection) flip components along them and refraction keeps the tangential component times the IOR ratio, so the
// directions that leave a light-sampled instance in s are: s mirrored along any axes (in and out through parallel
// faces) and, for IOR below sqrt 2, the per-axis magnitudes of Snell through two perpendicular faces with every sign. A
// mirror instance reflects s by each of its face orientations. The straight direction is direct()'s.
fn glassCandidates(kind:u32,m:Mat,n:vec3f,o:vec3f,medium:u32,mInst:u32,s:vec3f,light:vec3f,lp:f32,w:ptr<function,Walk>) {
 // Groups: inside glass the vertex's own instance (face k = j / 8, mirrors j % 8); outside, per light-sampled
 // instance, 7 mirrors and 6 x 8 perpendicular-face directions.
 let inGlass=medium!=0u&&(material(medium).flags&MEDIA)==0u;
 var ior=1.0;
 if(inGlass){let mm=material(medium);if(!clearGlass(mm)){return;}ior=mm.ior;}
 let gb=lights[0];
 let groups=select(1u+lights[1],1u,inGlass);
 for(var g=select(1u,0u,inGlass);g<groups;g++){
  var inst=mInst;var eta=ior;var per=48u;var want=NONE;
  if(!inGlass){
   per=1u;
   if(g>0u){inst=lights[gb+g*2u-2u];eta=ll(gb+g*2u-1u);want=inst;per=select(select(55u,7u,eta*eta>=2.0),6u,eta==0.0);}
  }
  // The instance's frame (unit face normals) and box, read once per group (none for the straight direction).
  var u0=vec3f(1.0,0.0,0.0);var u1=vec3f(0.0,1.0,0.0);var u2=vec3f(0.0,0.0,1.0);
  var x:Xform;var sz=vec3f(0.0);
  if(inGlass||g>0u){
   x=localX(inst);u0=normalize(x.r0.xyz);u1=normalize(x.r1.xyz);u2=normalize(x.r2.xyz);
   let mb=f.scene.x+scene[f.scene.y+inst*INSTANCE+36u]*MODEL;
   sz=vec3f(f32(scene[mb]),f32(scene[mb+1u]),f32(scene[mb+2u]));
  }
  let c=vec3f(dot(s,u0),dot(s,u1),dot(s,u2));
  let mirrors=inGlass&&prismAt(inst);
  for(var j=0u;j<per;j++){
   var d0=s;var weight=1.0;
   if(inGlass){
    // Out through face k after mirrors b (never along k's own axis).
    let k=j>>3u;let b=j&7u;
    let nout=select(-1.0,1.0,(k&1u)==0u)*rowSel(u0,u1,u2,k>>1u);
    if(dot(nout,s)<=0.0||(b!=0u&&!mirrors)){continue;}
    let tin=refract(-s,nout,1.0/eta);
    if(dot(tin,tin)<0.5){continue;}
    if((b&~(flippable(tin,u0,u1,u2)&~(1u<<(k>>1u))))!=0u){continue;}
    d0=-flipped(tin,u0,u1,u2,b);
    // Selection weight: in a box, the ray first reaches face k (no mirror) or a mirroring face.
    let first=boxExit(x,sz,o,d0);
    if((b==0u&&first!=(k>>1u))||(b!=0u&&(b&(1u<<first))==0u)){weight=UNLIKELY;}
   } else if(g>0u){
    // The axes the walk should enter the instance's box through and, for glass, the first faces it should meet inside
    // (bits), for the selection weight.
    var axes=7u;var inner=0u;
    if(eta==0.0){
     // Reflected by a mirror face k toward the vertex.
     let nk=select(-1.0,1.0,(j&1u)==0u)*rowSel(u0,u1,u2,j>>1u);
     if(dot(nk,s)<=0.0){continue;}
     d0=reflect(s,nk);axes=1u<<(j>>1u);
    } else if(j<7u){
     // In and out through parallel faces with mirrors between: s mirrored (never along the entry axis, IOR >= sqrt 2).
     if(((j+1u)&~flippable(s,u0,u1,u2))!=0u){continue;}
     d0=flipped(s,u0,u1,u2,j+1u);axes=select(7u,7u&~(j+1u),eta*eta>=2.0);inner=j+1u;
    } else {
     // In through a face of axis a (vertex side), out through one of axis b: magnitudes per axis, then every sign.
     let pair=(j-7u)>>3u;let sg=(j-7u)&7u;
     let a=pair>>1u;let bb=(a+1u+(pair&1u))%3u;let cc=3u-a-bb;
     let tA=abs(comp(c,a))/eta;let dC=abs(comp(c,cc));let tC=dC/eta;
     let tB2=1.0-tA*tA-tC*tC;
     if(tB2<0.0){continue;}
     let dB=eta*sqrt(tB2);
     let dA2=1.0-dB*dB-dC*dC;
     if(dA2<0.0){continue;}
     // Selects, not dynamic indexing (which can push the vector to memory).
     let ax=vec3u(0u,1u,2u);
     let mag=select(vec3f(0.0),vec3f(sqrt(dA2)),ax==vec3u(a))+select(vec3f(0.0),vec3f(dB),ax==vec3u(bb))+select(vec3f(0.0),vec3f(dC),ax==vec3u(cc));
     let signs=select(0u,1u,mag.x>=SAME_C)|select(0u,2u,mag.y>=SAME_C)|select(0u,4u,mag.z>=SAME_C);
     if((sg&~signs)!=0u){continue;}
     let q=select(mag,-mag,vec3<bool>((sg&1u)!=0u,(sg&2u)!=0u,(sg&4u)!=0u));
     d0=q.x*u0+q.y*u1+q.z*u2;axes=1u<<a;inner=1u<<bb;
    }
    let be=boxEntry(x,sz,o,d0);let entry=u32(be.x);
    if(entry==4u){continue;}
    // Selection weight: unlikely chains (another entry face, which needs a non-convex model, or another first face
    // inside the box than the chain's) are rarely walked and weighted accordingly.
    if(entry<3u&&(axes&(1u<<entry))==0u){weight=UNLIKELY;}
    else if(entry<3u&&eta>0.0&&inner!=0u){
     let ue=rowSel(u0,u1,u2,entry);let ne=select(ue,-ue,dot(d0,ue)>0.0);
     let ti=refract(d0,ne,1.0/eta);
     if((inner&(1u<<boxExit(x,sz,o+d0*be.y,ti)))==0u){weight=UNLIKELY;}
    }
   }
   // A surface's own back side cannot see the light (the BSDF of the kept one is evaluated by direct()).
   if(kind==0u&&m.glass==0.0&&dot(n,d0)<=0.0){continue;}
   offer(w,weight,o,d0,medium,mInst,s,want,light,lp);
  }
 }
}
// Next-event estimation at a surface (kind 0) or a medium scattering point (kind 1): one sample of each light kind,
// all through one BSDF evaluation and one shadow ray (the shader stays small): 0 the sun, 1 an emissive face, 2 an
// area light, 3 the environment; 4 evaluates the BSDF for the glass walk kept among the candidates. Distant lights also
// through smooth glass (straight chains blocked by it and the candidates of glassCandidates are walked by the path
// loop); emissive voxels and area lights from outside glass only.
fn direct(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f,medium:u32,mInst:u32,w:ptr<function,Walk>)->vec3f {
 var L=vec3f(0.0);
 let air=medium==0u||(material(medium).flags&MEDIA)!=0u;
 for(var q=0u;q<5u;q++){
  var wi=vec3f(0.0);var dist=INF;var radiance=vec3f(0.0);var lp=0.0;var far=false;
  if(q==0u){
   if((f.config.z&SUN)==0u){continue;}
   wi=f.sun.xyz;
   if(f.sunLight.w>0.0){wi=cone(f.sun.xyz,f.sun.w);}
   radiance=f.sunLight.xyz;lp=select(0.0,1.0/f.sunLight.w,f.sunLight.w>0.0);far=true;
  } else if(q<3u){
   if(!air||(q==1u&&f.lights.x==0u)||(q==2u&&(f.config.z&AREA_NEE)==0u)){continue;}
   var ls:LightPoint;
   if(q==1u){ls=sampleEmitter();}else{ls=sampleArea();}
   if(ls.pdfA<=0.0){continue;}
   let v=ls.p-o;let d2=dot(v,v);dist=sqrt(d2);wi=v/dist;
   var cl=-dot(ls.n,wi);
   if(ls.twoSided){cl=abs(cl);}
   if(cl<=0.0){continue;}
   radiance=ls.radiance;lp=ls.pdfA*d2/cl;
  } else if(q==3u){
   if((f.config.z&ENV)==0u){continue;}
   let ew=f.env.x;let eh=f.env.y;
   let u1=rand();
   var lo=0u;var hi=eh-1u;
   while(lo<hi){let mid=(lo+hi)/2u;if(ll(f.env.z+mid)<u1){lo=mid+1u;}else{hi=mid;}}
   let row=lo;let cb=f.env.w+row*ew;let u2=rand();
   lo=0u;hi=ew-1u;
   while(lo<hi){let mid=(lo+hi)/2u;if(ll(cb+mid)<u2){lo=mid+1u;}else{hi=mid;}}
   let uv=vec2f((f32(lo)+rand())/f32(ew),(f32(row)+rand())/f32(eh));
   let phi=(uv.x-0.5)*TAU+f.weights.y;let th=uv.y*PI;
   wi=vec3f(sin(th)*sin(phi),cos(th),-sin(th)*cos(phi));
   let t=envmap[row*ew+lo];
   lp=envPdf(wi,t);
   if(lp<=0.0){continue;}
   radiance=t.xyz*f.sky.w;far=true;
  } else {
   if((*w).total==0.0){continue;}
   wi=(*w).d;
  }
  let e=evalAt(kind,m,n,wo,wi);
  if(q==4u){
   if(any(e.f>vec3f(0.0))){(*w).f=e.f*(*w).light*((*w).total/(*w).weight);(*w).pdf=e.pdf;}else{(*w).total=0.0;}
   continue;
  }
  // The straight direction (not from inside glass, where glassCandidates finds the ways out).
  if(any(e.f>vec3f(0.0))&&(air||!far)){
   let v=shadow(o,wi,dist);
   if(v>0.0){L+=e.f*radiance*v*select(1.0,power2(lp,e.pdf)/lp,lp>0.0);}
   else if(far&&(f.config.z&CLEAR_GLASS)!=0u){offer(w,1.0,o,wi,medium,mInst,wi,NONE,radiance,lp);}
  }
  if(far){glassCandidates(kind,m,n,o,medium,mInst,wi,radiance,lp,w);}
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
 let n=normalize(cross(vec3f(ll(b+4u),ll(b+5u),ll(b+6u)),vec3f(ll(b+8u),ll(b+9u),ll(b+10u))));
 // The back of a one-sided solid light is black.
 if(ll(b+7u)==0.0&&dot(d,n)>0.0){return vec3f(0.0);}
 if(lastPdf<=0.0){return radiance;}
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

// caustic: the part of color that arrived after a diffuse-like vertex was followed by a specular or glossy one
// (light focused by glass and mirrors onto diffuse surfaces); the denoiser filters it separately and more widely.
// primary: 1 when the albedo and normal are the first hit's (0 when seen through glass or a mirror).
struct Path {color:vec3f,albedo:vec3f,normal:vec3f,inv:f32,caustic:vec3f,primary:f32}
fn radiance(px:vec2u)->Path {
 var res:Path;
 var jit=vec2f(0.5);
 if((f.config.z&JITTER)!=0u){jit=vec2f(rand(),rand());}
 motion=1.0;
 if((f.config.z&MOTION)!=0u){motion=1.0-f.weights.z*rand();}
 let ray=cameraRay(vec2f(px)+jit);
 if(dot(ray.d,ray.d)==0.0){res.albedo=vec3f(0.0);res.primary=1.0;return res;}
 var o=ray.o;var d=ray.d;
 var thr=vec3f(1.0);var L=vec3f(0.0);
 var medium=0u;var mInst=NONE;
 var lastPdf=0.0;
 var bounces=0u;
 var feature=true;var tint=vec3f(1.0);var primary=true;
 var diffuse=false;var focused=false;var C=vec3f(0.0);
 // Distant-light MIS: density of the last vertex that sampled distant lights, Jacobian of the refractions since,
 // whether the chain is one light sampling also builds (smooth transmissions, mirrors inside light-sampled glass),
 // whether it has left the start vertex's own glass, and the crossings since that turned it (light sampling builds at
 // most one, by a light-sampled instance, and none when the vertex is inside glass).
 var sunPdf=0.0;var jChain=1.0;var chainOk=false;var chainSet=false;
 var glassStart=false;var deflections=0u;var deflectOk=true;var entryDir=vec3f(0.0);
 // Wavelength of the path (nanometres) once dispersive glass has been met, or fixed for the whole frame.
 var lambda=bitcast<f32>(f.lights.w);
 // The shadow walk a vertex left (pending), being walked (walking): ray, medium, transmittance, Jacobian, turns and
 // the instance of the last, whether the current glass was entered from air and in which direction; then its weight.
 var pending=false;var walking=false;var done=false;
 var wo=vec3f(0.0);var wd=vec3f(0.0);var wMedium=0u;var wInst=NONE;var wT=vec3f(1.0);var wJ=1.0;var wN=0u;var wG=NONE;
 var wEntered=false;var wIn=vec3f(0.0);var wSteps=0u;var wS=vec3f(0.0);var wWant=NONE;var wAdd=vec3f(0.0);
 var wLp=0.0;var wPdf=0.0;var wCaustic=false;
 res.albedo=vec3f(1.0);res.normal=-d;res.primary=1.0;
 let limit=f.config.x*4u+16u+(f.config.x+1u)*16u;
 for(var it=0u;it<limit;it++){
  if(pending){
   pending=false;walking=true;wT=vec3f(1.0);wJ=1.0;wN=0u;wG=NONE;wEntered=false;wIn=wd;wSteps=0u;
  }
  if(!walking&&done){break;}
  let h=closest(select(o,wo,walking),select(d,wd,walking),select(medium,wMedium,walking),select(mInst,wInst,walking));
  if(walking){
   // One step of the shadow walk.
   wSteps++;
   var stop=false;var ok=false;
   if(wMedium!=0u){let md=mediumOf(wMedium);wT*=exp(-(md.absorb+md.sigma)*min(h.t,1e30));}
   if(h.inst==NONE){stop=true;ok=same(wd,wS)&&select(wN==1u&&wG==wWant,wN==0u,wWant==NONE);}
   else if(h.inst==GROUND||wSteps>16u){stop=true;}
   else if(h.inst==AREA){if(opaqueArea(h.value)){stop=true;}else{wo=wo+wd*(h.t+1e-4*max(1.0,h.t));}}
   else {
    let wp=wo+wd*h.t;
    let wn=h.sgn*normalize(rowOf(localX(h.inst),h.axis));
    let woff=h.sgn*EPS*colOf(worldX(h.inst),h.axis);
    let wGlass=wMedium!=0u&&(material(wMedium).flags&MEDIA)==0u;
    let ci=-dot(wn,wd);
    if(h.value==0u){
     let ma=material(wMedium);
     if((ma.flags&MEDIA)!=0u){wMedium=0u;wInst=NONE;wo=wp-woff;}
     else if(!clearGlass(ma)){stop=true;}
     else {
      let fr=fresnel(ci,ma.ior);
      if(fr>=1.0){
       // Total internal reflection: part of the chain in light-sampled instances only (as on the path side).
       if(!prismAt(wInst)){stop=true;}else{wd=reflect(wd,wn);wo=wp+woff;}
      } else {
       let dt=refract(wd,wn,ma.ior);
       wT*=1.0-fr;wJ*=-dot(wn,dt)/(ma.ior*ma.ior*ci);
       if(wEntered&&!same(dt,wIn)){wN++;wG=wInst;}
       wEntered=false;wMedium=0u;wInst=NONE;wo=wp-woff;wd=dt;
      }
     }
    } else {
     let mb=material(h.value);
     // Glass to media or to other glass: left to path sampling (the path side ends its chain there too).
     if(wGlass){stop=true;}
     else if((mb.flags&MEDIA)!=0u){wMedium=h.value;wInst=h.inst;wo=wp-woff;}
     else if(isMirror(mb)&&mirrorAt(h.inst)){wT*=schlick3(mb.color,ci);wN++;wG=h.inst;wd=reflect(wd,wn);wo=wp+woff;}
     else if(mb.glass<0.999||!clearGlass(mb)){stop=true;}
     else {
      let eta=1.0/mb.ior;
      let fr=fresnel(ci,eta);
      let dt=refract(wd,wn,eta);
      wT*=mb.color*(1.0-fr);wJ*=-dot(wn,dt)/(eta*eta*ci);
      wEntered=true;wIn=wd;wMedium=h.value;wInst=h.inst;wo=wp-woff;wd=dt;
     }
    }
   }
   if(stop){
    walking=false;
    if(ok&&any(wT>vec3f(0.0))){
     let add=wAdd*wT*wJ*select(1.0,power2(wLp/wJ,wPdf)/wLp,wLp>0.0);L+=add;if(wCaustic){C+=add;}
    }
   }
   continue;
  }
  if(primary){primary=false;res.inv=select(0.0,1.0/max(h.t,1e-6),h.inst!=NONE);}
  // The vertex: a scattering point in a medium (kind 1) or a surface (kind 0); light sampling is called from one place
  // for both (the shader stays small).
  var scatter=false;var p=o+d*h.t;
  if(medium!=0u){
   let md=mediumOf(medium);
   var ts=INF;
   if(md.sigma>0.0){ts=-log(1.0-rand())/md.sigma;}
   // Emission along the segment by the track-length estimator: E[j min(ts, t)] = j (1 - e^(-sigma t)) / sigma.
   if(any(md.emit!=vec3f(0.0))){let add=thr*md.emit*min(ts,min(h.t,1e30));L+=add;if(focused){C+=add;}}
   if(md.sigma>0.0){
    if(ts<h.t){
     thr*=exp(-md.absorb*ts)*md.albedo;
     p=o+d*ts;
     if(feature){feature=false;res.albedo=tint*md.albedo;res.normal=-d;res.primary=select(0.0,1.0,bounces==0u);}
     bounces++;
     if(bounces>f.config.x){break;}
     scatter=true;
    }
   }
   if(!scatter){thr*=exp(-md.absorb*h.t);}
  }
  var n=vec3f(0.0);var off=vec3f(0.0);var m:Mat;var soft=true;
  if(scatter){m=material(medium);}
  else {
   if(h.inst==NONE){
    let kept=chainOk&&chainSet&&(deflections==0u||(deflections==1u&&deflectOk&&!glassStart));
    let add=thr*environment(d,select(0.0,sunPdf,kept),jChain);L+=add;if(focused){C+=add;}
    break;
   }
   if(h.inst==AREA){
    let add=thr*areaHit(h.value,d,h.t,lastPdf);L+=add;if(focused){C+=add;}
    if(feature){feature=false;res.albedo=tint;res.normal=-d;res.primary=select(0.0,1.0,bounces==0u);}
    break;
   }
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
     var mm=material(medium);
     if((mm.flags&MEDIA)!=0u){medium=0u;mInst=NONE;o=p-off;continue;}
     if(mm.disp>0.0){collapse(&lambda,&thr);mm.ior=iorAt(mm,lambda);}
     let sm=(mm.flags&SMOOTH)!=0u;
     let s=dielectric(mm.alpha,n,-d,mm.ior,sm);
     if(!s.ok){break;}
     focused=focused||diffuse;
     if(s.transmit&&clearGlass(mm)){
      jChain*=abs(dot(n,s.wi))/(mm.ior*mm.ior*dot(n,-d));
      if(!chainSet){chainSet=true;}
      else if(!same(s.wi,entryDir)){deflections++;deflectOk=deflectOk&&prismAt(mInst);}
     } else if(!(clearGlass(mm)&&prismAt(mInst)&&fresnel(dot(n,-d),mm.ior)>=1.0)){chainOk=false;}
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
    if((m.flags&MEDIA)!=0u){
     if(medium!=0u&&(material(medium).flags&MEDIA)==0u){chainOk=false;}
     medium=h.value;mInst=h.inst;o=p-off;continue;
    }
   }
   if((m.flags&EMISSIVE)!=0u){let add=thr*m.emission*emitWeight(h,n,d,m.emission,lastPdf);L+=add;if(focused){C+=add;}}
   let pb=max(0.0,1.0-m.metal-m.glass);
   soft=pb>1e-6||((m.flags&SMOOTH)==0u&&m.metal>0.0);
   if(feature&&(soft||bounces>=3u)){feature=false;res.albedo=tint*m.color;res.normal=n;res.primary=select(0.0,1.0,bounces==0u);}
  }
  // Light sampled at a glossy metal seen from a diffuse vertex is a caustic too (light focused by the metal).
  if(soft){
   var walk:Walk;
   let add=thr*direct(select(0u,1u,scatter),m,n,-d,p+off,medium,mInst,&walk);L+=add;
   let caustic=focused||(diffuse&&!scatter&&m.metal>0.5&&m.alpha<0.1);
   if(caustic){C+=add;}
   if(walk.total>0.0){
    // Walked from the next loop turn on; the path resumes after it.
    pending=true;wo=walk.o;wd=walk.d;wMedium=walk.medium;wInst=walk.mInst;wS=walk.s;wWant=walk.want;
    wAdd=thr*walk.f;wLp=walk.lp;wPdf=walk.pdf;wCaustic=caustic;
   }
  }
  if(scatter){
   let md=mediumOf(medium);
   diffuse=true;
   let wi=sampleHg(d,md.g);
   lastPdf=select(0.0,hgPdf(dot(d,wi),md.g),md.media);
   sunPdf=hgPdf(dot(d,wi),md.g);jChain=1.0;chainOk=true;chainSet=md.media;
   glassStart=!md.media;deflections=0u;deflectOk=true;
   o=p;d=wi;
   if(!roulette(&thr,bounces)){done=true;}
   continue;
  }
  let inAir=medium==0u||(material(medium).flags&MEDIA)!=0u;
  let wo=-d;
  var etaI=1.0;
  if(!inAir){var mi=material(medium);if(mi.disp>0.0){collapse(&lambda,&thr);mi.ior=iorAt(mi,lambda);}etaI=mi.ior;}
  if(m.disp>0.0&&m.glass>0.0){collapse(&lambda,&thr);m.ior=iorAt(m,lambda);}
  let s=sampleSurface(m,n,wo,etaI);
  if(!s.ok){done=true;continue;}
  if(s.lobe<=1u){
   // A new chain starts here; light sampling of distant lights ran unless the vertex is inside rough glass.
   let roughGlass=!inAir&&!clearGlass(material(medium));
   sunPdf=select(s.pdf,0.0,roughGlass);jChain=1.0;chainOk=true;chainSet=inAir;
   glassStart=!inAir;deflections=0u;deflectOk=true;
  } else if(s.lobe==3u&&s.transmit&&clearGlass(m)&&m.glass>=0.999&&inAir){
   // Into pure smooth glass from air or media (light sampling does not refract glass into glass or mixed voxels).
   jChain*=abs(dot(n,s.wi))*m.ior*m.ior/dot(n,wo);
   entryDir=d;
  } else if(s.lobe==2u&&isMirror(m)&&inAir&&h.inst!=GROUND&&mirrorAt(h.inst)){
   deflections++;
  } else {chainOk=false;}
  // Diffuse-like after this vertex: cosine lobes and rough microfacets; specular: mirrors, glass, glossy (alpha < 0.1).
  if(s.lobe==0u||(s.lobe==1u&&m.alpha>=0.1)){diffuse=true;}else{focused=focused||diffuse;}
  thr*=s.w;
  if(s.transmit){
   if(h.inst==GROUND){done=true;continue;}
   medium=h.value;mInst=h.inst;o=p-off;thr*=m.color;
  } else {o=p+off;}
  if(feature){tint*=s.w;}
  d=s.wi;lastPdf=select(0.0,s.pdf,inAir);
  bounces++;
  if(bounces>f.config.x||!roulette(&thr,bounces)){done=true;}
 }
 res.color=L;res.caustic=C;
 if((f.config.z&CLAMP)!=0u){let l=lum(res.color);if(l>f.weights.w){res.color*=f.weights.w/l;res.caustic*=f.weights.w/l;}}
 // Finite values only (dispersive paths may carry negative channel weights; their mean is right).
 if(!all(abs(res.color)<vec3f(1e30))||!all(abs(res.caustic)<vec3f(1e30))){res.color=vec3f(0.0);res.caustic=vec3f(0.0);}
 return res;
}

@compute @workgroup_size(8,8) fn trace(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 let px=vec2u(gid.x+f.image.z,gid.y+f.image.w);
 let pixel=px.y*f.image.x+px.x;
 let slot=gid.y*f.tile.x+gid.x;
 var c=vec4f(0.0);var a=vec4f(0.0);var nn=vec4f(0.0);var cs=vec4f(0.0);
 let split=(f.config.z&SPLIT)!=0u;
 for(var s=0u;s<f.tile.w;s++){
  rng=hash((pixel*0x9e3779b1u)^hash(f.tile.z+s+hash(f.config.y)));
  let r=radiance(px);
  let l=select(lum(r.color),lum(r.color-r.caustic),split);let lc=lum(r.caustic);
  c+=vec4f(r.color,l*l);
  cs+=vec4f(r.caustic,lc*lc);
  a+=vec4f(r.albedo,r.inv);
  nn+=vec4f(r.normal,r.primary);
 }
 if(f.tile.z==0u){accum[slot]=c;albedo[slot]=a;normals[slot]=nn;if(split){caustics[slot]=cs;}}
 else{accum[slot]+=c;albedo[slot]+=a;normals[slot]+=nn;if(split){caustics[slot]+=cs;}}
}

@compute @workgroup_size(8,8) fn ids(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 motion=1.0;
 let ray=viewRay(vec2f(f32(gid.x+f.image.z)+0.5,f32(gid.y+f.image.w)+0.5));
 var h:Hit;h.inst=NONE;
 if(dot(ray.d,ray.d)>0.0){h=closest(ray.o,ray.d,0u,NONE);}
 var v=-1.0;
 if(h.inst==GROUND){v=-2.0;}else if(h.inst==AREA){v=-3.0;}else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value);}
 normals[gid.y*f.tile.x+gid.x].w=v;
}
`;

/**
 * Denoiser: `prepare` splits the accumulated radiance into its regular and caustic parts, demodulates both by albedo,
 * estimates the variance of each pixel's mean and writes the guide (normal, first-hit distance, pixel footprint);
 * `atrous` runs one wavelet level of either chain (remodulating at its last); `combine` adds the filtered caustics to the
 * filtered rest. Edges stop on normals, on the distance of a neighbour's first hit from the pixel's tangent plane (in
 * pixel footprints, so coplanar voxel faces blend and parallel ones at other heights do not; skipped for pixels whose
 * features are seen through glass or a mirror, which blend only with each other) and on the luminance difference
 * against its standard deviation, from both pixels' variances: a test against the centre's alone rejects bright,
 * high-variance neighbours more than dark ones and darkens the image (the median of a skewed distribution is below its
 * mean). The stop widens at low sample counts, where the variance itself is uncertain. The caustic chain has more
 * levels and a looser stop, because focused light is found by rare, strong samples (separate filtering of such
 * components as in Zimmer et al. 2015, "Path-space Motion Estimation and Decomposition for Robust Animation
 * Filtering", and Schied et al.).
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
@group(0) @binding(7) var<storage,read> caustics:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> dst2:array<vec4f>;
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
// Variance of a pixel's mean luminance (mean c, mean squared luminance m2); from the 3x3 neighbourhood while there are
// too few samples.
fn variance(i:u32,c:vec3f,m2:f32,caustic:bool,g:vec2u)->f32 {
 let k=p.sigma.w;let n=1.0/k;let l=lum(c);let w=p.size.x;let h=p.size.y;
 var v=max(0.0,m2-l*l)/max(n-1.0,1.0);
 if(n<4.0){
  var s1=0.0;var s2=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
   let q=u32(clamp(i32(g.y)+y,0,i32(h)-1))*w+u32(clamp(i32(g.x)+x,0,i32(w)-1));
   var lq=lum(caustics[q].xyz*k);
   if(!caustic){lq=lum(accum[q].xyz*k)-select(0.0,lq,(p.size.w&2u)!=0u);}
   s1+=lq;s2+=lq*lq;
  }}
  v=max(v,max(0.0,s2/9.0-(s1/9.0)*(s1/9.0)));
 }
 return v;
}
@compute @workgroup_size(8,8) fn prepare(@builtin(global_invocation_id) g:vec3u) {
 let w=p.size.x;let h=p.size.y;
 if(g.x>=w||g.y>=h){return;}
 let i=g.y*w+g.x;let k=p.sigma.w;let n=1.0/k;
 let split=(p.size.w&2u)!=0u;
 let cc=select(vec3f(0.0),caustics[i].xyz*k,split);
 let c=accum[i].xyz*k-cc;let a=albedoAt(i);
 let la=max(lum(a),0.02);
 dst[i]=vec4f(c/a,variance(i,c,accum[i].w*k,false,g.xy)/(la*la));
 if(split){dst2[i]=vec4f(cc/a,variance(i,cc,caustics[i].w*k,true,g.xy)/(la*la));}
 let nn=normals[i].xyz;let len=length(nn);
 let inv=albedo[i].w*k;
 let t=select(0.0,1.0/inv,inv>0.0);
 let x=f32(g.x)+0.5;let y=f32(g.y)+0.5;
 let foot=select(0.0,length(hitPoint(x+1.0,y,t)-hitPoint(x,y,t)),t>0.0);
 // Features seen through glass or a mirror (most samples): no plane test, the first hit's plane is not theirs.
 let through=normals[i].w*k<0.5;
 guide[i]=vec4f(oct(select(vec3f(0.0,0.0,1.0),nn/len,len>1e-6)),t,select(foot,-1.0,through||(p.size.w&4u)!=0u));
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
 // Variance of the centre (3x3 prefiltered) plus each neighbour's: the variance of their difference.
 let vp=max(vsum/vw,0.0);
 let sl=p.sigma.x*(1.0+2.0*sqrt(p.sigma.w));
 let lp=lum(cp.xyz);
 let plane=p.sigma.z*gp.w+1e-6;
 var sum=vec3f(0.0);var vs=0.0;var ws=0.0;
 for(var y=-2;y<=2;y++){for(var x=-2;x<=2;x++){
  let qx=at.x+x*st;let qy=at.y+y*st;
  if(qx<0||qy<0||qx>=i32(w)||qy>=i32(h)){continue;}
  let q=u32(qy)*w+u32(qx);
  let cq=src[q];let gq=guide[q];
  var wg=select(0.0,1.0,(gp.z>0.0)==(gq.z>0.0)&&(gp.w<0.0)==(gq.w<0.0));
  if(gp.z>0.0&&gq.z>0.0&&gp.w>=0.0&&gq.w>=0.0){wg=exp(-abs(dot(np,hitPoint(f32(qx)+0.5,f32(qy)+0.5,gq.z)-pp))/plane);}
  let wn=pow(max(0.0,dot(np,unoct(gq.xy))),p.sigma.y);
  let wl=exp(-abs(lum(cq.xyz)-lp)/(sl*sqrt(vp+max(cq.w,0.0))+1e-6));
  let wt=tap(x)*tap(y)*wn*wg*wl;
  sum+=cq.xyz*wt;vs+=cq.w*wt*wt;ws+=wt;
 }}
 var r=vec4f(sum/ws,vs/(ws*ws));
 if((p.size.w&1u)!=0u){r=vec4f(r.xyz*albedoAt(i),1.0);}
 dst[i]=r;
}
// The filtered caustics (src) added to the filtered rest (dst), both remodulated.
@compute @workgroup_size(8,8) fn combine(@builtin(global_invocation_id) g:vec3u) {
 if(g.x>=p.size.x||g.y>=p.size.y){return;}
 let i=g.y*p.size.x+g.x;
 dst[i]=vec4f(dst[i].xyz+src[i].xyz,1.0);
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
