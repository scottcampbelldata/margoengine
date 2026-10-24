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
import { agxShader } from '../../shared/agx.js';
import { acesNarkowiczShader } from '../../shared/aces.js';
import {
  ADDITIVE,
  CONTACT,
  CUTOUT,
  DELTA_ALPHA,
  GLOSSY_ALPHA,
  EMISSIVE,
  MATERIAL_FLOATS,
  MEDIA,
  SMOOTH,
  SUNLIT,
  UNTINTED,
  VOXELWISE,
} from './scene.js';
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
  FLAG_HIDE_SUN,
  FLAG_NO_COMPENSATION,
  FLAG_NO_SUN_MEDIA,
  FLAG_OPAQUE_SHADOWS,
  FLAG_SUN_DIFFUSE,
  FLAG_SUN,
  INSTANCE_WORDS,
  MODEL_WORDS,
} from './layout.js';
import { ggxDenominator } from '../../shared/light-terms.js';

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
 // Scattering events allowed per path: diffuse, specular, scatter (0xffff: no cap); w: the ground fade's distance
 // scale (f32 bits; 0 none).
 limits:vec4u,
 // Uniform fog: extinction per unit, anisotropy, on (z > 0); colour; sky-glow share by view elevation (16 values).
 fog:vec4f,
 fogColor:vec4f,
 fogHemi:array<vec4f,4>,
 // Ground fade: x the camera distance where it starts, y 1 when it fades models too.
 groundFade:vec4f,
 // Background for camera rays leaving the scene (w > 0: on); edge bands (colour, width; width 0: off); grid lines
 // (colour, spacing; half width, mode 0 off, 1 ground, 2 ground and voxels).
 background:vec4f,
 edges:vec4f,
 grid:vec4f,
 grid2:vec4f,
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
fn ggxD(a2:f32,nh:f32)->f32 {let k=${/* @__PURE__ */ ggxDenominator()};return a2/(PI*k*k);}
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
// GGX alpha below which a lobe is specular for caustics (scene.ts decides from it whether a scene has any).
const GLOSSY=${GLOSSY_ALPHA};
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
const OPAQUE_SHADOWS=${FLAG_OPAQUE_SHADOWS}u;
const SUN_DIFFUSE=${FLAG_SUN_DIFFUSE}u;
const NO_SUN_MEDIA=${FLAG_NO_SUN_MEDIA}u;
const HIDE_SUN=${FLAG_HIDE_SUN}u;
const NO_COMPENSATION=${FLAG_NO_COMPENSATION}u;
const ADDITIVE=${ADDITIVE}u;
const UNTINTED=${UNTINTED}u;
const SUNLIT=${SUNLIT}u;
const VOXELWISE=${VOXELWISE}u;
const CONTACT=${CONTACT}u;
const CUTOUT=${CUTOUT}u;
// march's want for a voxelwise volume: stop at the next voxel face whatever lies behind it.
const STEP=0xfffffffeu;
const MODEL=${MODEL_WORDS}u;
const INSTANCE=${INSTANCE_WORDS}u;
@group(0) @binding(0) var<uniform> f:Frame;
const MV=${MATERIAL_FLOATS / 4}u;
// Table 0 (scene.materials) in a uniform buffer: scenes without model tables read their materials there, faster than
// from storage (measured 5% of a frame of the material scene on an RTX A6000). Pipelines with TABLES (compiled when a
// scene has model tables) read every table from storage instead.
override TABLES:bool=false;
@group(0) @binding(1) var<uniform> table0:array<vec4f,${(256 * MATERIAL_FLOATS) / 4}>;
@group(0) @binding(2) var<storage,read> voxels:array<u32>;
// The scene records, then the lights (scene word 1 is where their header starts; every offset is absolute).
@group(0) @binding(3) var<storage,read> scene:array<u32>;
// Material tables, MV vec4f per entry, indexed by slot: the model's table << 8 | the palette index (0 stays empty).
@group(0) @binding(4) var<storage,read> materials:array<vec4f>;
// Vec4 i of the material tables (slot x MV + field): table 0 from the uniform copy.
fn mat(i:u32)->vec4f {if(TABLES){return materials[i];}return table0[i];}
@group(0) @binding(5) var<storage,read> envmap:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> albedo:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> normals:array<vec4f>;
@group(0) @binding(9) var<uniform> tables:array<vec4f,${TABLE_VEC4}>;
@group(0) @binding(10) var<storage,read_write> caustics:array<vec4f>;
var<private> rng:u32;
var<private> motion:f32;
// Whether the path entered the medium it is in through a face toward the sun; and whether the shadow ray being cast
// passes only the cell it starts in (see extinction).
var<private> sunFace:bool;
var<private> sunCell:bool;

fn lum(c:vec3f)->f32 {return dot(c,vec3f(0.2126,0.7152,0.0722));}
fn hash(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn rand()->f32 {rng=rng*747796405u+2891336453u;let w=((rng>>((rng>>28u)+4u))^rng)*277803737u;return f32(((w>>22u)^w)>>8u)*5.960464477539063e-8;}
fn power2(a:f32,b:f32)->f32 {let a2=a*a;let b2=b*b;return select(1.0,a2/(a2+b2),a2+b2>0.0);}
fn fl(i:u32)->f32 {return bitcast<f32>(scene[i]);}
fn ll(i:u32)->f32 {return bitcast<f32>(scene[i]);}

// Affine transforms as three rows.
struct Xform {r0:vec4f,r1:vec4f,r2:vec4f}
fn rowAt(i:u32)->vec4f {return vec4f(fl(i),fl(i+1u),fl(i+2u),fl(i+3u));}
fn xpoint(m:Xform,p:vec3f)->vec3f {return vec3f(dot(m.r0.xyz,p)+m.r0.w,dot(m.r1.xyz,p)+m.r1.w,dot(m.r2.xyz,p)+m.r2.w);}
fn xdir(m:Xform,d:vec3f)->vec3f {return vec3f(dot(m.r0.xyz,d),dot(m.r1.xyz,d),dot(m.r2.xyz,d));}
fn rowOf(m:Xform,k:u32)->vec3f {return select(select(m.r2.xyz,m.r1.xyz,k==1u),m.r0.xyz,k==0u);}
fn colOf(m:Xform,k:u32)->vec3f {return vec3f(m.r0[k],m.r1[k],m.r2[k]);}
fn invertX(m:Xform)->Xform {
 // Normalize before the cross products so very large or small scales stay in Float32 range.
 let h=max(max(max(abs(m.r0.x),abs(m.r0.y)),max(abs(m.r0.z),abs(m.r1.x))),max(max(abs(m.r1.y),abs(m.r1.z)),max(max(abs(m.r2.x),abs(m.r2.y)),abs(m.r2.z))));
 let a=m.r0.xyz/h;let b=m.r1.xyz/h;let c=m.r2.xyz/h;
 let c0=cross(b,c);let c1=cross(c,a);let c2=cross(a,b);let k=(1.0/h)/dot(a,c0);
 let r0=vec3f(c0.x,c1.x,c2.x)*k;let r1=vec3f(c0.y,c1.y,c2.y)*k;let r2=vec3f(c0.z,c1.z,c2.z)*k;
 let t=vec3f(m.r0.w,m.r1.w,m.r2.w);
 return Xform(vec4f(r0,-dot(r0,t)),vec4f(r1,-dot(r1,t)),vec4f(r2,-dot(r2,t)));
}
// Canonical CPU quaternion convention: [x,y,z,w], shortest arc, normalized-linear only above dot 0.9995.
// Instance word 39 points at its 16-word TRS packet: q0, q1, scale0 + angle, scale1 + 1/sin(angle).
fn motionRotation(p:u32)->mat3x3f {
 let a=normalize(rowAt(p));let q=normalize(rowAt(p+4u));let angle=fl(p+11u);let inv=fl(p+15u);
 var v=a*(1.0-motion)+q*motion;
 if(inv>0.0){v=a*(sin((1.0-motion)*angle)*inv)+q*(sin(motion*angle)*inv);}
 v=normalize(v);let x=v.x;let y=v.y;let z=v.z;let w=v.w;
 return mat3x3f(vec3f(1.0-2.0*(y*y+z*z),2.0*(x*y+w*z),2.0*(x*z-w*y)),vec3f(2.0*(x*y-w*z),1.0-2.0*(x*x+z*z),2.0*(y*z+w*x)),vec3f(2.0*(x*z+w*y),2.0*(y*z-w*x),1.0-2.0*(x*x+y*y)));
}
fn motionScale(p:u32)->vec3f {return mix(vec3f(fl(p+8u),fl(p+9u),fl(p+10u)),vec3f(fl(p+12u),fl(p+13u),fl(p+14u)),motion);}
fn motionTranslation(b:u32)->vec3f {return mix(vec3f(fl(b+27u),fl(b+31u),fl(b+35u)),vec3f(fl(b+15u),fl(b+19u),fl(b+23u)),motion);}
// Instance transforms at this path's shutter time (motion 1 = matrix, 0 = previousMatrix).
fn worldX(i:u32)->Xform {
 let b=f.scene.y+i*INSTANCE;
 let m=Xform(rowAt(b+12u),rowAt(b+16u),rowAt(b+20u));
 if((scene[b+37u]&1u)==0u||motion>=1.0){return m;}
 let q=Xform(rowAt(b+24u),rowAt(b+28u),rowAt(b+32u));
 if(motion<=0.0){return q;}
 if((scene[b+37u]&8u)!=0u){
  let p=scene[b+39u];let r=motionRotation(p);let s=motionScale(p);let t=motionTranslation(b);
  return Xform(vec4f(vec3f(r[0].x,r[1].x,r[2].x)*s,t.x),vec4f(vec3f(r[0].y,r[1].y,r[2].y)*s,t.y),vec4f(vec3f(r[0].z,r[1].z,r[2].z)*s,t.z));
 }
 return Xform(mix(q.r0,m.r0,motion),mix(q.r1,m.r1,motion),mix(q.r2,m.r2,motion));
}
fn localX(i:u32)->Xform {
 let b=f.scene.y+i*INSTANCE;
 if((scene[b+37u]&1u)==0u||motion>=1.0){return Xform(rowAt(b),rowAt(b+4u),rowAt(b+8u));}
 if((scene[b+37u]&8u)!=0u&&motion>0.0){
  let p=scene[b+39u];let r=motionRotation(p);let s=motionScale(p);let t=motionTranslation(b);
  let a=r[0]/s.x;let c=r[1]/s.y;let d=r[2]/s.z;
  return Xform(vec4f(a,-dot(a,t)),vec4f(c,-dot(c,t)),vec4f(d,-dot(d,t)));
 }
 return invertX(worldX(i));
}

struct Hit {t:f32,inst:u32,value:u32,axis:u32,sgn:f32,cell:vec3i}
fn safeInv(d:vec3f)->vec3f {
 let s=select(vec3f(-1e-12),vec3f(1e-12),d>=vec3f(0.0));
 return 1.0/select(d,s,abs(d)<vec3f(1e-12));
}
// Half-block shapes (TraceModel.shapes): a mixed brick's entry with bit 30 holds its cells' octant masks after its
// palette indices. shapeIn: the mask of cell k of brick entry (0: the whole cell). octWalk: where o + t d first reaches
// a half block of cell c that is filled (fill) or empty, from t0 (entered across axis a0, 3 inside) to t1, as (t, axis),
// t -1 when it does not (traverse.ts walks the same); octSpan: how far the ray runs through filled half blocks.
fn shapeIn(entry:u32,k:u32)->u32 {if((entry&0x40000000u)==0u){return 0u;}return (voxels[(entry&0x3fffffffu)+128u+(k>>2u)]>>((k&3u)*8u))&255u;}
fn octStart(o:vec3f,d:vec3f,c:vec3i,t0:f32,t1:f32,h:ptr<function,vec3u>,nx:ptr<function,vec3f>) {
 let p=o+d*(t0+min((t1-t0)*0.5,1e-4))-vec3f(c);
 *h=select(vec3u(0u),vec3u(1u),p>=vec3f(0.5));
 let toward=((d>vec3f(0.0))&(*h==vec3u(0u)))|((d<vec3f(0.0))&(*h==vec3u(1u)));
 *nx=select(vec3f(3e38),(vec3f(c)+0.5-o)*safeInv(d),toward);
}
fn octWalk(mask:u32,o:vec3f,d:vec3f,c:vec3i,t0:f32,t1:f32,a0:u32,fill:bool)->vec2f {
 var h:vec3u;var nx:vec3f;octStart(o,d,c,t0,t1,&h,&nx);
 var t=t0;var a=a0;
 for(var i=0u;i<4u;i++){
  if((((mask>>(h.x|(h.y<<1u)|(h.z<<2u)))&1u)!=0u)==fill){return vec2f(t,f32(a));}
  t=min(min(nx.x,nx.y),nx.z);
  if(!(t<t1)){break;}
  if(nx.x==t){a=0u;h.x^=1u;nx.x=3e38;}else if(nx.y==t){a=1u;h.y^=1u;nx.y=3e38;}else{a=2u;h.z^=1u;nx.z=3e38;}
 }
 return vec2f(-1.0,0.0);
}
fn octSpan(mask:u32,o:vec3f,d:vec3f,c:vec3i,t0:f32,t1:f32)->f32 {
 var h:vec3u;var nx:vec3f;octStart(o,d,c,t0,t1,&h,&nx);
 var t=t0;var span=0.0;
 for(var i=0u;i<4u;i++){
  let tn=min(min(min(nx.x,nx.y),nx.z),t1);
  if(((mask>>(h.x|(h.y<<1u)|(h.z<<2u)))&1u)!=0u){span+=max(tn-t,0.0);}
  if(tn>=t1){break;}
  if(nx.x==tn){h.x^=1u;nx.x=3e38;}else if(nx.y==tn){h.y^=1u;nx.y=3e38;}else{h.z^=1u;nx.z=3e38;}
  t=tn;
 }
 return span;
}
// The axis whose plane of cell c point l lies nearest (the face a ray crosses there).
fn planeAxis(l:vec3f,c:vec3i)->u32 {let e=min(abs(l-vec3f(c)),abs(l-vec3f(c+1)));return select(select(2u,1u,e.y<=e.z),0u,e.x<=e.y&&e.x<=e.z);}
// A cut-out shaped cell (palette v, mask sm) along o + t d from t0 to t1 (inside: the ray starts in it): where it stops
// on a texel that is not cut away, as (t, axis), t -1 when it passes. Each run through filled half blocks stops at the
// texel where it enters them, else at the one where it leaves them (an inner face), else goes on.
fn shapeCut(v:u32,sm:u32,o:vec3f,d:vec3f,c:vec3i,t0:f32,t1:f32,inside:bool)->vec2f {
 let cut=mat(v*MV+7u).z;let up=d>=vec3f(0.0);
 var t=t0;var a=select(planeAxis(o+d*t0,c),3u,inside);
 for(var i=0u;i<3u;i++){
  let r=octWalk(sm,o,d,c,t,t1,a,true);
  if(r.x<0.0){break;}
  let ea=u32(r.y);
  if(ea<3u&&texelAt(v,ea*2u+select(0u,1u,up[ea]),o+d*r.x).a>=cut){return r;}
  let x=octWalk(sm,o,d,c,r.x,t1,ea,false);
  let tx=select(t1,x.x,x.x>=0.0);let xa=select(planeAxis(o+d*t1,c),u32(x.y),x.x>=0.0);
  if(texelAt(v,xa*2u+select(1u,0u,up[xa]),o+d*tx).a>=cut){return vec2f(tx,f32(xa));}
  if(x.x<0.0){break;}
  t=tx;a=xa;
 }
 return vec2f(-1.0,0.0);
}
fn found(h:ptr<function,Hit>,t:f32,v:u32,a:u32,stp:vec3i,d:vec3f,c:vec3i)->bool {
 var axis=a;
 if(axis==3u){let q=abs(d);axis=select(select(2u,1u,q.y>=q.z),0u,q.x>=q.y&&q.x>=q.z);}
 (*h).t=t;(*h).value=v;(*h).axis=axis;(*h).sgn=-f32(stp[axis]);(*h).cell=c;
 return true;
}
// Two-level walk of model 'model' along o + t d (model space) for t in [tMin, tMax): the first boundary into a cell
// whose palette index is not 'want'; with want != 0 also the exit through the model's box (value 0). want == STEP:
// the first boundary after the cell the ray starts in, whatever its index (voxelwise volumes).
fn march(model:u32,o:vec3f,d:vec3f,tMin:f32,tMax:f32,want:u32,h:ptr<function,Hit>)->bool {
 let mb=f.scene.x+model*MODEL;
 // The model's material table: hits carry slots (table << 8 | palette index), as want does.
 let base=scene[mb+7u];
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
 let step=want==STEP;
 // In STEP mode the cell the ray starts in (inside the box) is passed over.
 var skip=step&&axis==3u;
 loop {
  let entry=voxels[grid+u32(bc.x+nb.x*(bc.z+nb.z*bc.y))];
  let tOut=min(min(bn.x,bn.y),min(bn.z,tExit));
  let lo=bc*8;let hi=min(lo+8,sz)-1;
  let ue=select(0u,base|(entry&255u),entry!=0u);
  if(entry==0u||(entry>=0x80000000u&&!step&&!cutMat(ue))){
   let u=ue;
   if(step){if(!skip){return found(h,t,u,axis,stp,d,clamp(vec3i(floor(o+d*t)),lo,hi));}skip=false;}
   else if(u!=want){return found(h,t,u,axis,stp,d,clamp(vec3i(floor(o+d*t)),lo,hi));}
  } else {
   var c=clamp(vec3i(floor(o+d*t)),lo,hi);
   var vn=(vec3f(c)+up-o)*inv;
   var vt=t;var va=axis;
   let uniform=entry>=0x80000000u;
   loop {
    let l=vec3u(c-lo);let k=l.x+8u*(l.z+8u*l.y);
    let pv=select((voxels[(entry&0x3fffffffu)+(k>>2u)]>>((k&3u)*8u))&255u,entry&255u,uniform);
    let v=select(0u,base|pv,pv!=0u);
    let sm=select(0u,shapeIn(entry,k),pv!=0u&&!uniform&&!step);
    if(sm!=0u){
     // A shaped cell holds v in its filled half blocks and nothing elsewhere.
     let tc=min(min(vn.x,vn.y),vn.z);
     if(v==want){let r=octWalk(sm,o,d,c,vt,tc,va,false);if(r.x>=0.0){return found(h,r.x,0u,u32(r.y),stp,d,c);}}
     else{
      // A cut-out one stops only on texels not cut away.
      var r=vec2f(-1.0,0.0);
      if(cutMat(v)){r=shapeCut(v,sm,o,d,c,vt,tc,va==3u);}else{r=octWalk(sm,o,d,c,vt,tc,va,true);}
      if(want!=0u&&(r.x<0.0||r.x>vt)){return found(h,vt,0u,va,stp,d,c);}
      if(r.x>=0.0){return found(h,r.x,v,u32(r.y),stp,d,c);}
     }
    }
    else if(step){if(!skip){return found(h,vt,v,va,stp,d,c);}skip=false;}
    else if(v!=want){
     if(!cutMat(v)){return found(h,vt,v,va,stp,d,c);}
     let r=cutThrough(v,o,d,vt,va==3u,c,vn);
     if(r==0u){return found(h,vt,v,va,stp,d,c);}
     if(r==2u){
      let ax=select(select(2u,1u,vn.y<=vn.z),0u,vn.x<=vn.y&&vn.x<=vn.z);
      return found(h,min(min(vn.x,vn.y),vn.z),v,ax,stp,d,c);
     }
    }
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
// Extinction of a see-through cell for shadow rays, -1 when the cell blocks light (only media let it through; with
// opaque shadows none, except the sun-lit volume the shadow ray starts in, or only its start cell for a sun ray from a
// walk that entered the volume through a face turned from the sun: as in MagicaVoxel's subsurface, light reaches a
// point in it through that volume alone, mostly from its faces toward the light).
fn extinction(v:u32,own:bool)->f32 {
 let x=mat(v*MV+3u);let fl=u32(x.w);
 return select(-1.0,x.x,(fl&MEDIA)!=0u&&((f.config.z&OPAQUE_SHADOWS)==0u||((fl&SUNLIT)!=0u&&own)));
}
// Optical depth along a shadow ray through one model, -1 when blocked.
fn marchShadow(model:u32,o:vec3f,d:vec3f,tMax:f32)->f32 {
 let mb=f.scene.x+model*MODEL;
 let base=scene[mb+7u];
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
 // The cell the ray starts in (when it starts inside the model), and whether it is still in the volume it started in
 // (one material from the start cell on, no gap).
 var start=tEnter==0.0;var own=start;var vol=0u;
 loop {
  let entry=voxels[grid+u32(bc.x+nb.x*(bc.z+nb.z*bc.y))];
  let tOut=min(min(bn.x,bn.y),min(bn.z,tExit));
  let lo=bc*8;let hi=min(lo+8,sz)-1;
  let ue=base|(entry&255u);
  if(entry>=0x80000000u&&!cutMat(ue)){
   // A uniform brick: one material over the whole span (when only the start cell passes light, its share first).
   own=own&&(vol==0u||vol==ue);vol=ue;
   var t1=t;
   if(own&&sunCell){
    let c0=floor(o+d*t);let cn=(c0+up-o)*inv;t1=min(min(min(cn.x,cn.y),cn.z),tOut);
    let k=extinction(ue,true);if(k<0.0){return -1.0;}depth+=k*(t1-t);own=false;
   }
   if(t1<tOut){let k=extinction(ue,own);if(k<0.0){return -1.0;}depth+=k*(tOut-t1);}
  } else if(entry==0u){own=false;}
  else {
   var c=clamp(vec3i(floor(o+d*t)),lo,hi);
   var vn=(vec3f(c)+up-o)*inv;
   var vt=t;
   let uniform=entry>=0x80000000u;
   loop {
    let l=vec3u(c-lo);let k=l.x+8u*(l.z+8u*l.y);
    let pv=select((voxels[(entry&0x3fffffffu)+(k>>2u)]>>((k&3u)*8u))&255u,entry&255u,uniform);
    let v=select(0u,base|pv,pv!=0u);
    let next=min(min(vn.x,vn.y),min(vn.z,tOut));
    let sm=select(0u,shapeIn(entry,k),pv!=0u&&!uniform);
    // A shaped cell blocks or dims the ray only where it runs through its filled half blocks.
    if(sm!=0u){
     if(cutMat(v)){if(shapeCut(v,sm,o,d,c,vt,next,start&&vt==0.0).x>=0.0){return -1.0;}}
     else{let span=octSpan(sm,o,d,c,vt,next);if(span>0.0){let x=extinction(v,false);if(x<0.0){return -1.0;}depth+=x*span;}}
     own=false;
    }
    // A cut-out cell lets the shadow through where both its texels on the ray are cut away.
    else if(cutMat(v)){if(cutThrough(v,o,d,vt,start&&vt==0.0,c,vn)!=1u){return -1.0;}own=false;}
    else if(v!=0u){
     own=own&&(vol==0u||vol==v);vol=v;
     let x=extinction(v,own);if(x<0.0){return -1.0;}depth+=x*max(next-vt,0.0);
     own=own&&!sunCell;
    } else {own=false;}
    start=false;
    if(vn.x<vn.y&&vn.x<vn.z){vt=vn.x;c.x+=stp.x;vn.x+=ad.x;}
    else if(vn.y<vn.z){vt=vn.y;c.y+=stp.y;vn.y+=ad.y;}
    else{vt=vn.z;c.z+=stp.z;vn.z+=ad.z;}
    if(vt>=tOut||any(c<lo)||any(c>hi)){break;}
   }
  }
  start=false;
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
 var want=select(0u,medium,own);
 if(own&&medium!=0u&&(u32(mat(medium*MV+3u).w)&VOXELWISE)!=0u){want=STEP;}
 if(march(scene[f.scene.y+i*INSTANCE+36u],xpoint(m,o),xdir(m,d),0.0,tMax,want,&r)){
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
fn unitAxis(a:u32)->vec3i {return select(select(vec3i(0,0,1),vec3i(0,1,0),a==1u),vec3i(1,0,0),a==0u);}
// A filled cell of instance i's model (cells outside the model are empty).
fn filled(model:u32,c:vec3i)->bool {
 let mb=f.scene.x+model*MODEL;
 let sz=vec3i(i32(scene[mb]),i32(scene[mb+1u]),i32(scene[mb+2u]));
 if(any(c<vec3i(0))||any(c>=sz)){return false;}
 return voxelAt(model,c)!=0u;
}
// Whether world point p on the face of hit h lies within the edge band: within f.edges.w (voxels) of a face edge where
// the shape turns: the face ends there (outer corner) or meets a filled cell in front of the neighbour (inner corner).
fn edgeBand(h:Hit,p:vec3f)->bool {
 let model=scene[f.scene.y+h.inst*INSTANCE+36u];
 let lp=xpoint(localX(h.inst),p);
 let nrm=unitAxis(h.axis)*i32(h.sgn);
 let w=f.edges.w;
 for(var k=1u;k<3u;k++){
  let a=(h.axis+k)%3u;let e=unitAxis(a);
  let u=dot(lp-vec3f(h.cell),vec3f(e));
  for(var s=-1;s<=1;s+=2){
   let dist=select(u,1.0-u,s>0);
   if(dist>=w){continue;}
   let nb=h.cell+e*s;
   if(!filled(model,nb)||filled(model,nb+nrm)){return true;}
  }
 }
 return false;
}
// Whether world point p on a surface with normal n lies on a grid line (every f.grid.w units, f.grid2.x half width),
// along the two axes across the surface.
fn gridLine(p:vec3f,n:vec3f)->bool {
 let s=f.grid.w;let q=abs(p/s-round(p/s))*s;let a=abs(n);
 let k=select(select(2u,1u,a.y>=a.z),0u,a.x>=a.y&&a.x>=a.z);
 return (k!=0u&&q.x<f.grid2.x)||(k!=1u&&q.y<f.grid2.x)||(k!=2u&&q.z<f.grid2.x);
}
// Block textures (scene word 0: the table's start, 0 without; per texture its first texel word, width, height): the
// texel of palette v's face (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z) at model point l as linear colour and alpha, 1 where
// the material has none. Faces tile as in @margoengine/voxel's renderer: tops by x and z, sides with v running down.
fn texelAt(v:u32,face:u32,l:vec3f)->vec4f {
 let base=scene[0];
 if(base==0u){return vec4f(1.0);}
 let slot=mat(v*MV+6u+face/4u)[face%4u];
 if(slot<0.5){return vec4f(1.0);}
 var uv=vec2f(-l.x,-l.y);
 switch face {
  case 0u {uv=vec2f(-l.z,-l.y);}
  case 1u {uv=vec2f(l.z,-l.y);}
  case 2u {uv=l.xz;}
  case 3u {uv=vec2f(l.x,-l.z);}
  case 4u {uv=vec2f(l.x,-l.y);}
  default {}
 }
 let t=base+4u*(u32(slot)-1u);let w=scene[t+1u];let ht=scene[t+2u];let q=fract(uv);
 let c=unpack4x8unorm(scene[scene[t]+min(u32(q.y*f32(ht)),ht-1u)*w+min(u32(q.x*f32(w)),w-1u)]);
 return vec4f(select(c.rgb/12.92,pow((c.rgb+0.055)/1.055,vec3f(2.4)),c.rgb>vec3f(0.04045)),c.a);
}
// The face of cell c that model point l lies on, across axis a (the side nearer l).
fn faceOf(a:u32,l:vec3f,c:vec3i)->u32 {return a*2u+select(1u,0u,l[a]-f32(c[a])>0.5);}
// Hit h's texel at world point p (its face from where p lies on the cell, so a voxel's inner faces read their own).
fn faceTexel(h:Hit,p:vec3f)->vec4f {
 if(scene[0]==0u||h.inst>=AREA){return vec4f(1.0);}
 let l=xpoint(localX(h.inst),p);
 var face=faceOf(h.axis,l,h.cell);
 // A shaped cell's mid-cell face reads the face it turns toward.
 if(abs(l[h.axis]-f32(h.cell[h.axis])-0.5)<1e-3){face=h.axis*2u+select(1u,0u,h.sgn>0.0);}
 return texelAt(h.value,face,l);
}
fn cutMat(v:u32)->bool {return v!=0u&&(u32(mat(v*MV+3u).w)&CUTOUT)!=0u;}
// A ray (model space o + t d) through cut-out cell c of palette v, entering at t0 (inside: it starts in the cell), next
// boundaries vn: 0 when the texel where it enters is solid, 1 when that and the one where it leaves are both cut away
// (it goes on), 2 when only the one where it leaves is solid (the voxel's inner face).
fn cutThrough(v:u32,o:vec3f,d:vec3f,t0:f32,inside:bool,c:vec3i,vn:vec3f)->u32 {
 let cut=mat(v*MV+7u).z;
 if(!inside){
  // The face it enters by: the axis whose cell plane the entry point lies nearest.
  let l=o+d*t0;let e=min(abs(l-vec3f(c)),abs(l-vec3f(c+1)));
  let a=select(select(2u,1u,e.y<=e.z),0u,e.x<=e.y&&e.x<=e.z);
  if(texelAt(v,faceOf(a,l,c),l).a>=cut){return 0u;}
 }
 let t1=min(min(vn.x,vn.y),vn.z);let ax=select(select(2u,1u,vn.y<=vn.z),0u,vn.x<=vn.y&&vn.x<=vn.z);
 let l=o+d*t1;
 return select(1u,2u,texelAt(v,faceOf(ax,l,c),l).a>=cut);
}
fn lineMat(c:vec3f)->Mat {var m:Mat;m.color=c;m.metalColor=c;m.alpha=1.0;m.ior=1.5;return m;}
fn voxelAt(model:u32,c:vec3i)->u32 {
 let mb=f.scene.x+model*MODEL;
 let nb=vec3i(i32(scene[mb+4u]),i32(scene[mb+5u]),i32(scene[mb+6u]));
 let b=c>>vec3u(3u);
 let entry=voxels[scene[mb+3u]+u32(b.x+nb.x*(b.z+nb.z*b.y))];
 if(entry==0u){return 0u;}
 if(entry>=0x80000000u){return entry&255u;}
 let l=vec3u(c&vec3i(7));let k=l.x+8u*(l.z+8u*l.y);
 return (voxels[(entry&0x3fffffffu)+(k>>2u)]>>((k&3u)*8u))&255u;
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
// fisheye's circle (the stereographic mapping fills the frame).
fn wideRay(px:vec2f)->Ray {
 var eye=f.eye.xyz;var fw=f.forward.xyz;var rt=f.right.xyz;var up=f.up.xyz;
 if((f.config.z&CAMERA_MOTION)!=0u&&motion<1.0){
  eye=mix(f.prevEye.xyz,eye,motion);fw=normalize(mix(f.prevForward.xyz,fw,motion));
  rt=normalize(mix(f.prevRight.xyz,rt,motion));up=normalize(mix(f.prevUp.xyz,up,motion));
 }
 let W=f32(f.image.x);let H=f32(f.image.y);
 if(f.projection.x==1u){
  // Fitted to the width (360 degrees across) or to the height (the same angle per pixel across as down).
  let phi=select((px.x/W-0.5)*TAU,(px.x-0.5*W)/H*PI,f.projection.w==1u);let el=(0.5-px.y/H)*PI;
  return Ray(eye,normalize(cos(el)*(sin(phi)*rt+cos(phi)*fw)+sin(el)*up));
 }
 let p=vec2f(px.x-0.5*W,0.5*H-px.y)/(0.5*H);
 let r=length(p);
 var th=r*0.5*f.lensFov.x;
 if(f.projection.y==1u){let s=r*f.lensFov.y;if(s>1.0){return Ray(eye,vec3f(0.0));}th=2.0*asin(s);}
 if(f.projection.y==2u){th=2.0*atan(r*f.lensFov.y);}
 else if(th>0.5*f.lensFov.x+1e-6){return Ray(eye,vec3f(0.0));}
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
struct Mat {color:vec3f,alpha:f32,metal:f32,glass:f32,spec:f32,f0:f32,emission:vec3f,ior:f32,density:f32,scatter:f32,g:f32,flags:u32,disp:f32,metalColor:vec3f,seen:vec4f}
fn material(id:u32)->Mat {
 let a=mat(id*MV);let b=mat(id*MV+1u);let c=mat(id*MV+2u);let e=mat(id*MV+3u);
 let x=mat(id*MV+4u);
 return Mat(a.xyz,a.w,b.x,b.y,b.z,b.w,c.xyz,c.w,e.x,e.y,e.z,u32(e.w),x.x,x.yzw,mat(id*MV+5u));
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
fn groundMat()->Mat {var m:Mat;m.color=f.ground.xyz;m.metalColor=f.ground.xyz;m.alpha=1.0;m.ior=1.5;return m;}
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
// BSDF times cos(wi) over the lobes in mask (1 diffuse, 2 glossy: metal and coat), and the density of sampling wi
// over all of them; glass and perfectly specular lobes are not included. An additive coat leaves the diffuse base
// whole (MagicaVoxel) instead of taking its reflection out of it.
fn evalLobes(m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {
 var e:Eval;
 let ci=dot(n,wi);let co=dot(n,wo);
 if(ci<=0.0||co<=0.0){return e;}
 let pb=max(0.0,1.0-m.metal-m.glass);
 let pc=m.spec*schlick1(m.f0,co);
 if((mask&1u)!=0u){e.f=pb*select(1.0-pc,1.0,(m.flags&ADDITIVE)!=0u)*m.color*(ci*INV_PI);}
 e.pdf=pb*(1.0-pc)*ci*INV_PI;
 if((m.flags&SMOOTH)==0u){
  let h=normalize(wo+wi);let nh=dot(n,h);let vh=max(dot(wo,h),0.0);let a2=m.alpha*m.alpha;
  let d=ggxD(a2,nh);let lo=lambdaG(a2,co);let g2=1.0/(1.0+lo+lambdaG(a2,ci));
  let spec=d*g2/(4.0*co);
  let gloss=(mask&2u)!=0u;
  if(gloss){e.f+=(m.metal*schlick3(m.metalColor,vh)+pb*m.spec*schlick1(m.f0,vh))*spec;}
  var qms=0.0;
  if(m.metal>0.0){
   // Multiple scattering between the microfacets (Kulla and Conty): (1 - E(mu_o)) (1 - E(mu_i)) / (pi (1 - Eavg)),
   // scaled by Favg^2 Eavg / (1 - Favg (1 - Eavg)) with Favg the hemispherical average of Schlick's Fresnel.
   let rough=sqrt(m.alpha);let ea=tableEavg(rough);
   qms=clamp(1.0-tableE(co,rough),0.0,1.0);
   let fa=m.metalColor+(1.0-m.metalColor)/21.0;
   if(gloss&&(f.config.z&NO_COMPENSATION)==0u){e.f+=m.metal*fa*fa*ea/(1.0-fa*(1.0-ea))*qms*(1.0-tableE(ci,rough))/(PI*max(1.0-ea,1e-4))*ci;}
  }
  e.pdf+=(m.metal*(1.0-qms)+pb*pc)*d/((1.0+lo)*4.0*co)+m.metal*qms*ci*INV_PI;
 }
 return e;
}
fn evalSurface(m:Mat,n:vec3f,wo:vec3f,wi:vec3f)->Eval {return evalLobes(m,n,wo,wi,3u);}
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
  let norm=select(max(tableGlass(co,sqrt(alpha),eta),0.05),1.0,(f.config.z&NO_COMPENSATION)!=0u);
  s.w=vec3f((1.0+lo)/(1.0+lo+lambdaG(a2,abs(dot(n,s.wi))))/norm);
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
  if(r<qm){s.wi=reflect(-wo,n);s.w=schlick3(m.metalColor,co);s.ok=true;s.lobe=2u;return s;}
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
fn evalAt(kind:u32,m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {
 if(kind==1u){let p=hgPdf(dot(-wo,wi),m.g);return Eval(vec3f(p),p);}
 return evalLobes(m,n,wo,wi,mask);
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
// Radiance filtered bilinearly between texel centres (wrapping in azimuth); sampling densities stay per texel.
fn envSmooth(uv:vec2f)->vec3f {
 let w=f.env.x;let h=f.env.y;
 let px=uv.x*f32(w)-0.5;let py=clamp(uv.y*f32(h)-0.5,0.0,f32(h-1u));
 let fx=floor(px);let ax=px-fx;let y0=u32(py);let y1=min(y0+1u,h-1u);let ay=py-f32(y0);
 let x0=u32(i32(fx)+i32(w))%w;let x1=(x0+1u)%w;
 let a=mix(envmap[y0*w+x0].xyz,envmap[y0*w+x1].xyz,ax);
 let b=mix(envmap[y1*w+x0].xyz,envmap[y1*w+x1].xyz,ax);
 return mix(a,b,ay);
}
fn envPdf(d:vec3f,t:vec4f)->f32 {
 let s=sqrt(max(0.0,1.0-d.y*d.y));
 if(s<=1e-6||f.weights.x<=0.0){return 0.0;}
 return t.w/f.weights.x/(2.0*PI*PI*s);
}
// Radiance of the environment and sun disk in direction d, weighted against light sampling when the path was sampled
// with density bsdfPdf (0: no light sampling could have found it) through a chain of refractions with Jacobian j.
// camera: the ray has not scattered yet (the sun disk then shows unless hidden; scattered rays see it unless the sun
// lights diffuse lobes only, by light sampling alone).
fn environment(d:vec3f,bsdfPdf:f32,j:f32,camera:bool)->vec3f {
 var c=f.sky.xyz;
 if((f.config.z&ENV)!=0u){
  let uv=envUV(d);let t=envTexel(uv);
  c=envSmooth(uv)*f.sky.w;
  if(bsdfPdf>0.0){c*=power2(bsdfPdf,envPdf(d,t)/j);}
 }
 let seen=select((f.config.z&SUN_DIFFUSE)==0u,(f.config.z&HIDE_SUN)==0u,camera);
 if(seen&&(f.config.z&SUN)!=0u&&f.sunLight.w>0.0&&dot(d,f.sun.xyz)>=f.sun.w){
  c+=f.sunLight.xyz*select(1.0,power2(bsdfPdf,1.0/f.sunLight.w/j),bsdfPdf>0.0);
 }
 return c;
}
// The sky behind direction d (constant sky or environment map; no sun disk).
fn skyBehind(d:vec3f)->vec3f {
 if((f.config.z&ENV)==0u){return f.sky.xyz;}
 return envSmooth(envUV(d))*f.sky.w;
}
// Sky radiance at the horizon in d's azimuth (constant sky or environment map; no sun disk).
fn horizonSky(d:vec3f)->vec3f {
 if((f.config.z&ENV)==0u){return f.sky.xyz;}
 let h=vec3f(d.x,0.0,d.z);
 if(dot(h,h)<1e-12){return envSmooth(envUV(vec3f(0.0,0.0,-1.0)))*f.sky.w;}
 return envSmooth(envUV(normalize(h)))*f.sky.w;
}
// The glow of uniform fog seen along d: sky and sun light it scatters toward the viewer (no shadows).
fn fogHemiAt(u:f32)->f32 {
 let x=clamp((u+1.0)*7.5,0.0,15.0);let i=min(u32(x),14u);let fr=x-f32(i);
 return mix(f.fogHemi[i>>2u][i&3u],f.fogHemi[(i+1u)>>2u][(i+1u)&3u],fr);
}
fn fogGlow(d:vec3f)->vec3f {
 var l=horizonSky(vec3f(0.0,0.0,-1.0))*fogHemiAt(d.y);
 if((f.config.z&SUN)!=0u){
  let e=select(f.sunLight.xyz,f.sunLight.xyz*f.sunLight.w,f.sunLight.w>0.0);
  l+=e*hgPdf(dot(f.sun.xyz,d),f.fog.y);
 }
 return f.fogColor.xyz*l;
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
 let inst=scene[f.lights.y+lo*2u];
 let ib=f.scene.y+inst*INSTANCE;
 let model=scene[ib+36u];let mb=f.scene.x+model*MODEL;
 let faces=scene[mb+8u];let count=scene[mb+9u];let total=fl(mb+10u);
 if(count==0u||total<=0.0){return r;}
 let u2=rand();
 lo=0u;hi=count-1u;
 while(lo<hi){let mid=(lo+hi)/2u;if(ll(faces+mid*3u+2u)<u2){lo=mid+1u;}else{hi=mid;}}
 // Three words per face: x | y << 16, z | face << 16 (a quarter face: bit 19, mid-cell 20, its halves 21-22),
 // cumulative probability (weighted by area, so the density below holds for quarters too).
 let c0=scene[faces+lo*3u];let c1=scene[faces+lo*3u+1u];
 let cell=vec3i(i32(c0&0xffffu),i32(c0>>16u),i32(c1&0xffffu));
 let face=(c1>>16u)&7u;let axis=face>>1u;let sg=select(-1.0,1.0,(face&1u)==0u);
 let a1=(axis+1u)%3u;let a2=(axis+2u)%3u;let quarter=((c1>>19u)&1u)!=0u;
 var lp=vec3f(cell)+vec3f(rand(),rand(),rand())*select(1.0,0.5,quarter);
 if(quarter){lp[a1]+=f32((c1>>21u)&1u)*0.5;lp[a2]+=f32((c1>>22u)&1u)*0.5;}
 lp[axis]=f32(cell[axis])+select(0.0,1.0,sg>0.0)-sg*0.5*f32((c1>>20u)&1u)+sg*EPS;
 let w=worldX(inst);let l=localX(inst);
 let area=length(cross(colOf(w,a1),colOf(w,a2)));
 let m=material(scene[mb+7u]|voxelAt(model,cell));
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
 let gb=scene[scene[1]];
 let groups=select(1u+scene[scene[1]+1u],1u,inGlass);
 for(var g=select(1u,0u,inGlass);g<groups;g++){
  var inst=mInst;var eta=ior;var per=48u;var want=NONE;
  if(!inGlass){
   per=1u;
   if(g>0u){inst=scene[gb+g*2u-2u];eta=ll(gb+g*2u-1u);want=inst;per=select(select(55u,7u,eta*eta>=2.0),6u,eta==0.0);}
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
// Next-event estimation at a surface (kind 0, over the lobes in mask: 1 diffuse, 2 glossy) or a medium scattering
// point (kind 1): one sample of each light kind,
// all through one BSDF evaluation and one shadow ray (the shader stays small): 0 the sun, 1 an emissive face, 2 an
// area light, 3 the environment; 4 evaluates the BSDF for the glass walk kept among the candidates. Distant lights also
// through smooth glass (straight chains blocked by it and the candidates of glassCandidates are walked by the path
// loop); emissive voxels and area lights from outside glass only.
fn direct(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f,medium:u32,mInst:u32,w:ptr<function,Walk>,mask:u32)->vec3f {
 var L=vec3f(0.0);
 let air=medium==0u||(material(medium).flags&MEDIA)!=0u;
 for(var q=0u;q<5u;q++){
  var wi=vec3f(0.0);var dist=INF;var radiance=vec3f(0.0);var lp=0.0;var far=false;
  // In uniform fog distant lights are out of reach (their light arrives through the fog's glow).
  let fogged=f.fog.z>0.0;
  if(q==0u){
   if(fogged||(f.config.z&SUN)==0u||(kind==1u&&(f.config.z&NO_SUN_MEDIA)!=0u&&(m.flags&SUNLIT)==0u)){continue;}
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
   if(fogged||(f.config.z&ENV)==0u){continue;}
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
   radiance=envSmooth(envUV(wi))*f.sky.w;far=true;
  } else {
   if((*w).total==0.0){continue;}
   wi=(*w).d;
  }
  // With the sun on diffuse lobes only, nothing else finds it: its light-sampled share is the whole estimate.
  let sunOnly=q==0u&&(f.config.z&SUN_DIFFUSE)!=0u;
  let lobes=select(mask,mask&1u,sunOnly);
  if(kind==0u&&lobes==0u){continue;}
  let e=evalAt(kind,m,n,wo,wi,lobes);
  if(q==4u){
   if(any(e.f>vec3f(0.0))){(*w).f=e.f*(*w).light*((*w).total/(*w).weight);(*w).pdf=e.pdf;}else{(*w).total=0.0;}
   continue;
  }
  // The straight direction (not from inside glass, where glassCandidates finds the ways out).
  if(any(e.f>vec3f(0.0))&&(air||!far)){
   sunCell=q==0u&&kind==1u&&(m.flags&SUNLIT)!=0u&&!sunFace;
   var v=shadow(o,wi,dist);
   sunCell=false;
   if(fogged&&!far){v*=exp(-f.fog.x*dist);}
   if(v>0.0){L+=e.f*radiance*v*select(1.0,select(power2(lp,e.pdf),1.0,sunOnly)/lp,lp>0.0);}
   else if(far&&!sunOnly&&(f.config.z&CLEAR_GLASS)!=0u){offer(w,1.0,o,wi,medium,mInst,wi,NONE,radiance,lp);}
  }
  if(far&&!sunOnly){glassCandidates(kind,m,n,o,medium,mInst,wi,radiance,lp,w);}
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
 // Events per kind for the caps in f.limits: diffuse, specular (low 16 bits of y), scatter (low 16 bits of z),
 // scattering in sun-lit media (subsurface, high 16 bits of z); reflections inside glass (high 16 bits of y: kept in
 // full up to that many, each one after continues with probability 1/2).
 var nd=0u;var ns=0u;var nm=0u;var nu=0u;var nir=0u;
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
     else if(isMirror(mb)&&mirrorAt(h.inst)){wT*=schlick3(mb.metalColor,ci);wN++;wG=h.inst;wd=reflect(wd,wn);wo=wp+woff;}
     else if(mb.glass<0.999||!clearGlass(mb)){stop=true;}
     else {
      let eta=1.0/mb.ior;
      let fr=fresnel(ci,eta);
      let dt=refract(wd,wn,eta);
      wT*=select(mb.color,vec3f(1.0),(mb.flags&UNTINTED)!=0u)*(1.0-fr);wJ*=-dot(wn,dt)/(eta*eta*ci);
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
  if(primary){
   primary=false;
   // The first hit's distance along the pixel centre's ray to the plane of the face this sample hit (camera rays): the
   // denoiser places first hits on centre rays, where a jittered sample's own distance lies up to half a pixel off
   // along the surface, which moves its history every frame the camera moves.
   var tc=h.t;
   if(f.projection.x==0u&&f.projection.z==0u&&h.inst!=NONE&&h.inst!=AREA){
    var n=vec3f(0.0,1.0,0.0);
    if(h.inst!=GROUND){n=rowOf(localX(h.inst),h.axis);}
    let mo=motion;motion=1.0;let c=viewRay(vec2f(px)+0.5);motion=mo;
    let den=dot(n,c.d);
    if(abs(den)>1e-4*length(n)){let t2=dot(n,o+d*h.t-c.o)/den;if(abs(t2-h.t)<0.5*h.t){tc=t2;}}
   }
   res.inv=select(0.0,1.0/max(tc,1e-6),h.inst!=NONE);
  }
  // Uniform fog outside volumes: the segment fades toward the fog's glow (all of it for a ray leaving the scene).
  if(f.fog.z>0.0&&medium==0u){
   let dl=length(d);let tr=select(exp(-f.fog.x*h.t*dl),0.0,h.inst==NONE);
   let add=thr*fogGlow(d/dl)*(1.0-tr);L+=add;if(focused){C+=add;}
   thr*=tr;
   if(h.inst==NONE){break;}
  }
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
     // Sun-lit media: each diffuse event before takes 4 from the subsurface cap (MagicaVoxel's neighbours of subsurface
     // blocks under diffuse caps 2 and 4).
     if((material(medium).flags&SUNLIT)!=0u){if(bounces>f.config.x||nu+4u*nd>=(f.limits.z>>16u)){break;}nu++;}
     else{if(bounces>f.config.x||nm>=(f.limits.z&0xffffu)){break;}nm++;}
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
    let bg=bounces==0u&&f.background.w>0.0;
    let add=thr*select(environment(d,select(0.0,sunPdf,kept),jChain,bounces==0u),f.background.xyz,bg);L+=add;if(focused){C+=add;}
    break;
   }
   if(h.inst==AREA){
    let add=thr*areaHit(h.value,d,h.t,lastPdf);L+=add;if(focused){C+=add;}
    if(feature){feature=false;res.albedo=tint;res.normal=-d;res.primary=select(0.0,1.0,bounces==0u);}
    break;
   }
   // Seen by the camera, the ground (and models, when asked) at distance D fades into the sky behind it by
   // 1 - e^(-(D - start) / fade).
   let fade=bitcast<f32>(f.limits.w);
   if(bounces==0u&&fade>0.0&&f.fog.z==0.0&&(h.inst==GROUND||f.groundFade.y>0.0)){
    let w=1.0-exp(-max(0.0,h.t*length(d)-f.groundFade.x)/fade);
    let add=thr*w*skyBehind(d);L+=add;thr*=1.0-w;
   }
   if(h.inst==GROUND){
    // The plane coordinate is known exactly. An orthographic near plane can be thousands of units away: the
    // cancellation in o + d*t can leave p below ground by more than off, making its own outgoing rays hit it again.
    p.y=f.ground.w;
    n=vec3f(0.0,select(-1.0,1.0,d.y<0.0),0.0);
    off=n*max(1e-4,1e-6*length(p));
    m=groundMat();
    if(bounces==0u&&f.grid2.y>0.0&&gridLine(p,n)){m=lineMat(f.grid.xyz);}
   } else {
    let lx=localX(h.inst);
    n=h.sgn*normalize(rowOf(lx,h.axis));
    off=h.sgn*EPS*colOf(worldX(h.inst),h.axis);
    // Leaving a contact-transmitting blend into the air: the glass share over (1 - 0.4 metal) passes, the rest scatters
    // back inside off the blend's other lobes (a diffuse event). Without metal that is the glass share itself; with it,
    // MagicaVoxel lets more light out than the share its metal leaves (B boards: half metal, half glass over white).
    var inner=false;
    if(h.value==0u&&medium!=0u){let mc=material(medium);if((mc.flags&CONTACT)!=0u&&rand()>=mc.glass/max(1e-6,1.0-0.4*mc.metal)){inner=true;}}
    if(h.value==0u&&!inner){
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
     if(s.transmit){medium=0u;mInst=NONE;o=p-off;}
     else{nir++;if(nir>(f.limits.y>>16u)&&rand()<0.5){break;}o=p+off;}
     d=s.wi;lastPdf=0.0;
     if(feature){tint*=s.w;}
     bounces++;
     if(bounces>f.config.x||ns>=(f.limits.y&0xffffu)){break;}
     ns++;
     if(!roulette(&thr,bounces)){break;}
     continue;
    }
    m=material(h.value);
    if(inner){m=material(medium);m.glass=0.0;}
    else if((m.flags&MEDIA)!=0u){
     if(medium!=0u&&(material(medium).flags&MEDIA)==0u){chainOk=false;}
     sunFace=dot(n,f.sun.xyz)>0.0;
     medium=h.value;mInst=h.inst;o=p-off;continue;
    }
    if(!inner){let tex=faceTexel(h,p).rgb;m.color*=tex;m.metalColor*=tex;}
    // Edge bands and grid lines on what the camera sees (MagicaVoxel's display settings): the line colour, lit.
    if(bounces==0u&&medium==0u){
     if(f.edges.w>0.0&&edgeBand(h,p)){m=lineMat(f.edges.xyz);}
     else if(f.grid2.y>1.5&&gridLine(p,n)){m=lineMat(f.grid.xyz);}
    }
   }
   if((m.flags&EMISSIVE)!=0u||m.seen.w>0.0){
    // Camera rays (nothing scattered yet) see the camera radiance when one is set.
    let e=select(m.emission,m.seen.xyz,bounces==0u&&m.seen.w>0.0);
    let add=thr*e*emitWeight(h,n,d,m.emission,lastPdf);L+=add;if(focused){C+=add;}
   }
   let pb=max(0.0,1.0-m.metal-m.glass);
   soft=pb>1e-6||((m.flags&SMOOTH)==0u&&m.metal>0.0);
   if(feature&&(soft||bounces>=3u)){feature=false;res.albedo=tint*m.color;res.normal=n;res.primary=select(0.0,1.0,bounces==0u);}
  }
  // Light sampled at a glossy metal seen from a diffuse vertex is a caustic too (light focused by the metal).
  if(soft){
   var walk:Walk;
   let lobes=select(0u,1u,nd<f.limits.x)|select(0u,2u,ns<(f.limits.y&0xffffu));
   let add=thr*direct(select(0u,1u,scatter),m,n,-d,p+off,medium,mInst,&walk,lobes);L+=add;
   let caustic=focused||(diffuse&&!scatter&&m.metal>0.5&&m.alpha<GLOSSY);
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
  // Straight through a voxel face inside a voxelwise volume: not a scattering event.
  let through=s.lobe==3u&&s.transmit&&!inAir&&medium==h.value&&(m.flags&VOXELWISE)!=0u;
  if(through){medium=h.value;mInst=h.inst;o=p-off;continue;}
  if(s.lobe==0u){if(nd>=f.limits.x){done=true;continue;}nd++;}
  else{if(ns>=(f.limits.y&0xffffu)){done=true;continue;}ns++;}
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
  if(s.lobe==0u||(s.lobe==1u&&m.alpha>=GLOSSY)){diffuse=true;}else{focused=focused||diffuse;}
  thr*=s.w;
  if(s.transmit){
   if(h.inst==GROUND){done=true;continue;}
   medium=h.value;mInst=h.inst;o=p-off;if((m.flags&UNTINTED)==0u){thr*=m.color;}
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

// Preview while the full tracer compiles (a small kernel compiles in a fraction of the time): the first hit lit by the
// sky behind its normal and the sun (one shadow ray), misses showing the sky or the background; one sample, written
// over the image.
@compute @workgroup_size(8,8) fn preview(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 motion=1.0;
 let ray=viewRay(vec2f(f32(gid.x+f.image.z)+0.5,f32(gid.y+f.image.w)+0.5));
 var c=vec3f(0.0);
 if(dot(ray.d,ray.d)>0.0){
  let h=closest(ray.o,ray.d,0u,NONE);
  if(h.inst==NONE){c=select(environment(ray.d,0.0,1.0,true),f.background.xyz,f.background.w>0.0);}
  else if(h.inst==AREA){c=areaHit(h.value,ray.d,h.t,0.0);}
  else {
   var p=ray.o+ray.d*h.t;
   var n=vec3f(0.0,1.0,0.0);var m:Mat;
   if(h.inst==GROUND){p.y=f.ground.w;m=groundMat();if(f.grid2.y>0.0&&gridLine(p,n)){m=lineMat(f.grid.xyz);}}
   else{
    n=normalize(h.sgn*rowOf(localX(h.inst),h.axis));m=material(h.value);
    let tex=faceTexel(h,p).rgb;m.color*=tex;m.metalColor*=tex;
    if(f.edges.w>0.0&&edgeBand(h,p)){m=lineMat(f.edges.xyz);}else if(f.grid2.y>1.5&&gridLine(p,n)){m=lineMat(f.grid.xyz);}
   }
   if(dot(n,ray.d)>0.0){n=-n;}
   c=select(m.emission,m.seen.xyz,m.seen.w>0.0)+m.color*skyBehind(n);
   let ndl=dot(n,f.sun.xyz);
   if((f.config.z&SUN)!=0u&&ndl>0.0){
    let e=select(f.sunLight.xyz,f.sunLight.xyz*f.sunLight.w,f.sunLight.w>0.0);
    c+=m.color*e*ndl/PI*shadow(p+n*max(1e-3,1e-6*length(p)),f.sun.xyz,INF);
   }
   let fade=bitcast<f32>(f.limits.w);
   if((h.inst==GROUND||f.groundFade.y>0.0)&&fade>0.0&&f.fog.z==0.0){
    let w=1.0-exp(-max(0.0,h.t*length(ray.d)-f.groundFade.x)/fade);c=mix(c,skyBehind(ray.d),w);
   }
  }
 }
 accum[gid.y*f.tile.x+gid.x]=vec4f(c,0.0);
}

// Transparent captures: the share of the pixel's camera rays (8 x 8 strata, through the lens and the shutter) that hit
// the scene, into accum.w once the denoiser has read it.
@compute @workgroup_size(8,8) fn coverage(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 let px=vec2u(gid.x+f.image.z,gid.y+f.image.w);
 var hits=0u;
 for(var s=0u;s<64u;s++){
  rng=hash(((px.y*f.image.x+px.x)*0x9e3779b1u)^hash(s+hash(f.config.y)));
  motion=1.0;
  if((f.config.z&MOTION)!=0u){motion=1.0-f.weights.z*rand();}
  let ray=cameraRay(vec2f(px)+(vec2f(f32(s%8u),f32(s/8u))+vec2f(rand(),rand()))*0.125);
  if(dot(ray.d,ray.d)>0.0&&closest(ray.o,ray.d,0u,NONE).inst!=NONE){hits++;}
 }
 accum[gid.y*f.tile.x+gid.x].w=f32(hits)/64.0;
}

@compute @workgroup_size(8,8) fn ids(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=f.tile.x||gid.y>=f.tile.y){return;}
 motion=1.0;
 let ray=viewRay(vec2f(f32(gid.x+f.image.z)+0.5,f32(gid.y+f.image.w)+0.5));
 var h:Hit;h.inst=NONE;
 if(dot(ray.d,ray.d)>0.0){h=closest(ray.o,ray.d,0u,NONE);}
 var v=-1.0;
 if(h.inst==GROUND){v=-2.0;}else if(h.inst==AREA){v=-3.0;}else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value&255u);}
 normals[gid.y*f.tile.x+gid.x].w=v;
}
`;

/**
 * Denoiser: `prepare` splits the accumulated radiance into its regular and caustic parts, demodulates both by albedo,
 * estimates the variance of each pixel's mean and writes the guide (normal, first-hit distance, pixel footprint);
 * `atrous` runs one wavelet level of either chain (remodulating at its last); `combine` adds the filtered caustics to the
 * filtered rest and, at edges from 16 samples on, weighs that against the raw mean by their estimated errors (see
 * `weighed`), writing the result to the ping buffer. Edges stop on normals, on the distance of a neighbour's first hit from the pixel's tangent plane (in
 * pixel footprints, so coplanar voxel faces blend and parallel ones at other heights do not; skipped for pixels whose
 * features are seen through glass or a mirror, which blend only with each other) and on the luminance difference
 * against its standard deviation, from both pixels' variances: a test against the centre's alone rejects bright,
 * high-variance neighbours more than dark ones and darkens the image (the median of a skewed distribution is below its
 * mean). The stop widens at low sample counts, where the variance itself is uncertain. The regular chain's wide levels
 * (steps of 4 pixels and more) also stop on the ratio of luminances, so a neighbour several times brighter or darker
 * (another part of a steep gradient, such as a wall beside a light) is not averaged into the pixel. The caustic chain has more
 * levels and a looser stop, because focused light is found by rare, strong samples (separate filtering of such
 * components as in Zimmer et al. 2015, "Path-space Motion Estimation and Decomposition for Robust Animation
 * Filtering", and Schied et al.).
 */
export const DENOISE: string = /* wgsl */ `
struct Params {size:vec4u,sigma:vec4f,tile:vec4u,origins:array<vec4f,4>,directions:array<vec4f,4>,prev:mat4x4f,prevOrigins:array<vec4f,4>,prevDirections:array<vec4f,4>}
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> accum:array<vec4f>;
@group(0) @binding(2) var<storage,read> albedo:array<vec4f>;
@group(0) @binding(3) var<storage,read> normals:array<vec4f>;
@group(0) @binding(4) var<storage,read> src:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> dst:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> guide:array<vec4f>;
@group(0) @binding(7) var<storage,read> caustics:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> dst2:array<vec4f>;
// The viewport's history, as halves in two textures: H1 holds the demodulated estimate and sample weight of the last
// frame after a restart and its guide (the distance as f32 bits); H2 this frame's estimate and weight, then the
// previously displayed colour (prepare copies it from dst, where combine left it) and its weight in samples, at most 8,
// plus 16 x prepare's mask of the bilinear taps to read it from. prepare reads H1 (hin) and writes H2 (hout); combine
// reads H2 (hin) and writes H1 (hout). Other passes bind 1 x 1 stand-ins.
@group(0) @binding(9) var hin:texture_2d<u32>;
@group(0) @binding(10) var hout:texture_storage_2d<rgba32uint,write>;
fn lum(c:vec3f)->f32 {return dot(c,vec3f(0.2126,0.7152,0.0722));}
// pack2x16float rounded to the nearest half: some GPUs truncate toward zero (measured on an RTX A6000: every value
// lower), which history stored every frame compounds into a darker image (1% over 32 frames).
fn packHalves(v:vec2f)->u32 {
 let b=pack2x16float(v);
 let up=abs(v)-abs(unpack2x16float(b))>abs(unpack2x16float(b+0x00010001u))-abs(v);
 return b+select(0u,1u,up.x)+select(0u,0x10000u,up.y);
}
fn ycocg(c:vec3f)->vec3f {return vec3f(dot(c,vec3f(0.25,0.5,0.25)),dot(c,vec3f(0.5,0.0,-0.5)),dot(c,vec3f(-0.25,0.5,-0.25)));}
fn fromYcocg(c:vec3f)->vec3f {return vec3f(c.x+c.y-c.z,c.x+c.z,c.x-c.y-c.z);}
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
// The camera ray's direction through tile pixel position (x, y).
fn viewDir(x:f32,y:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 return normalize(mix(mix(p.directions[0],p.directions[1],uv.x),mix(p.directions[2],p.directions[3],uv.x),uv.y).xyz);
}
// Where world point P (w 1; a direction with w 0) lay in the previous frame's image, in pixels; negative when behind it.
fn previousPixel(P:vec4f)->vec2f {
 let clip=p.prev*P;
 if(clip.w<=1e-6){return vec2f(-1.0);}
 return vec2f((clip.x/clip.w*0.5+0.5)*f32(p.size.x),(0.5-clip.y/clip.w*0.5)*f32(p.size.y));
}
// The same through the previous frame's corner rays.
fn prevHitPoint(x:f32,y:f32,t:f32)->vec3f {
 let uv=(vec2f(f32(p.tile.x),f32(p.tile.y))+vec2f(x,y))/vec2f(f32(p.tile.z),f32(p.tile.w));
 let o=mix(mix(p.prevOrigins[0],p.prevOrigins[1],uv.x),mix(p.prevOrigins[2],p.prevOrigins[3],uv.x),uv.y).xyz;
 let d=mix(mix(p.prevDirections[0],p.prevDirections[1],uv.x),mix(p.prevDirections[2],p.prevDirections[3],uv.x),uv.y).xyz;
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
   var lq=0.0;
   if(caustic||(p.size.w&2u)!=0u){lq=lum(caustics[q].xyz*k);}
   if(!caustic){lq=lum(accum[q].xyz*k)-lq;}
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
 var cc=vec3f(0.0);
 if(split){cc=caustics[i].xyz*k;}
 let c=accum[i].xyz*k-cc;let a=albedoAt(i);
 let la=max(lum(a),0.02);
 var e=c/a;var ev=variance(i,c,accum[i].w*k,false,g.xy)/(la*la);
 if(split){dst2[i]=vec4f(cc/a,variance(i,cc,caustics[i].w*k,true,g.xy)/(la*la));}
 let nn=normals[i].xyz;let len=length(nn);
 let inv=albedo[i].w*k;
 let t=select(0.0,1.0/inv,inv>0.0);
 let x=f32(g.x)+0.5;let y=f32(g.y)+0.5;
 let foot=select(0.0,length(hitPoint(x+1.0,y,t)-hitPoint(x,y,t)),t>0.0);
 // Features seen through glass or a mirror (most samples): no plane test, the first hit's plane is not theirs.
 let through=normals[i].w*k<0.5;
 let nrm=select(vec3f(0.0,0.0,1.0),nn/len,len>1e-6);
 // Viewport history (flag 8; 16: it is valid): where the history saw the same surface (position within two footprints,
 // normals within about 25 degrees) its estimate counts as up to 32 samples (8 seen through glass or a mirror, whose
 // reflections move otherwise), fading out by 64 samples of the present (32 while the camera holds still). It is kept
 // from the last restart (flag 64), so while the camera holds still the samples it adds are not counted twice.
 if((p.size.w&8u)!=0u){
  var nh=0.0;var mask=0u;
  if((p.size.w&16u)!=0u){
   let P=hitPoint(x,y,t);let q=select(previousPixel(vec4f(viewDir(x,y),0.0)),previousPixel(vec4f(P,1.0)),t>0.0);
   if(t>0.0&&len>1e-6&&all(q>=vec2f(0.0))&&q.x<f32(w)&&q.y<f32(h)){
    let pg=textureLoad(hin,vec2u(q),0);let tp=bitcast<f32>(pg.w);
    let onSurface=length(prevHitPoint(floor(q.x)+0.5,floor(q.y)+0.5,tp)-P)<2.0*foot+1e-3*t;
    if(tp>0.0&&onSurface&&dot(unoct(unpack2x16float(pg.z)),nrm)>0.9){
     let h0=unpack2x16float(pg.x);let h1=unpack2x16float(pg.y);
     nh=h1.y*max(0.0,1.0-n/select(32.0,64.0,(p.size.w&64u)!=0u));
     // The variance of the blend, and the luminance stop's widening for few samples (atrous) as for n + nh of them.
     let wide=(1.0+2.0/sqrt(n+nh))/(1.0+2.0/sqrt(n));
     e=(e*n+vec3f(h0,h1.x)*nh)/(n+nh);ev*=n/(n+nh)*wide*wide;
    }
   }
   // The displayed colour's taps (combine reads them bilinearly around q) that saw no occluder in front of this
   // pixel's first hit (or of the sky): a tap that did shows what the camera's move uncovered here, which would ghost.
   let b=floor(q-0.5);
   for(var k=0u;k<4u;k++){
    let at=b+vec2f(f32(k&1u),f32(k>>1u));
    if(at.x<0.0||at.y<0.0||at.x>=f32(w)||at.y>=f32(h)){continue;}
    let tp=bitcast<f32>(textureLoad(hin,vec2u(at),0).w);
    let d=length(P-prevHitPoint(at.x+0.5,at.y+0.5,0.0));
    if(tp<=0.0||(t>0.0&&tp>0.98*d-2.0*foot)){mask|=1u<<k;}
   }
  }
  let shown=dst[i];
  textureStore(hout,g.xy,vec4u(packHalves(e.xy),packHalves(vec2f(e.z,min(select(32.0,8.0,through),n+nh))),
   packHalves(shown.xy),packHalves(vec2f(shown.z,clamp(shown.w,0.0,8.0)+16.0*f32(mask)))));
 }
 dst[i]=vec4f(e,ev);
 guide[i]=vec4f(oct(nrm),t,select(foot,-1.0,through||(p.size.w&4u)!=0u));
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
  var wl=exp(-abs(lum(cq.xyz)-lp)/(sl*sqrt(vp+max(cq.w,0.0))+1e-6));
  // Wide levels (steps 4 and up, whose input is already smoothed): a neighbour several times brighter or darker is
  // another part of a steep gradient (a wall beside a light), not noise; averaging it in would flatten the peak. Not
  // in the caustic chain (flag 32), whose focused light is rare, strong samples that it must spread widely.
  if(st>=4&&(p.size.w&32u)==0u){let lr=log((lum(cq.xyz)+1e-3)/(lp+1e-3));wl*=exp(-lr*lr/(0.96*(1.0+4.0*sqrt(p.sigma.w))));}
  let wt=tap(x)*tap(y)*wn*wg*wl;
  sum+=cq.xyz*wt;vs+=cq.w*wt*wt;ws+=wt;
 }}
 var r=vec4f(sum/ws,vs/(ws*ws));
 // Last level: remodulated, with the variance of its luminance (combine weighs it against the raw mean's).
 if((p.size.w&1u)!=0u){let a=albedoAt(i);let la=max(lum(a),0.02);r=vec4f(r.xyz*a,r.w*la*la);}
 dst[i]=r;
}
// The filtered estimate of pixel q (both chains, remodulated) and the variance of its luminance.
fn filteredAt(q:u32,split:bool)->vec4f {var f=dst[q];if(split){f+=src[q];}return vec4f(f.xyz,max(f.w,0.0));}
// The raw mean of pixel q and the variance of its luminance (regular and caustic parts, as prepare estimates them).
fn rawAt(q:u32,split:bool,g:vec2u)->vec4f {
 let k=p.sigma.w;var cc=vec3f(0.0);var v=0.0;
 if(split){cc=caustics[q].xyz*k;v=variance(q,cc,caustics[q].w*k,true,g);}
 let r=accum[q].xyz*k;
 return vec4f(r,v+variance(q,r-cc,accum[q].w*k,false,g));
}
// Whether pixel i lies on an edge of the image's features: within one pixel of another surface (sky or geometry, a
// normal turned more than about 25 degrees, a first hit off its plane by more than two footprints), of a different
// albedo (a texture or material boundary) or of features seen through glass or a mirror on one side only.
fn edgeAt(i:u32,g:vec2u)->bool {
 let w=p.size.x;let h=p.size.y;let gp=guide[i];let np=unoct(gp.xy);let ap=albedoAt(i);
 let pp=hitPoint(f32(g.x)+0.5,f32(g.y)+0.5,gp.z);
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let qx=clamp(i32(g.x)+x,0,i32(w)-1);let qy=clamp(i32(g.y)+y,0,i32(h)-1);
  let q=u32(qy)*w+u32(qx);let gq=guide[q];
  if((gp.z>0.0)!=(gq.z>0.0)||(gp.w<0.0)!=(gq.w<0.0)){return true;}
  if(dot(np,unoct(gq.xy))<0.9){return true;}
  if(gp.z>0.0&&gp.w>0.0&&abs(dot(np,hitPoint(f32(qx)+0.5,f32(qy)+0.5,gq.z)-pp))>2.0*gp.w){return true;}
  let aq=albedoAt(q);
  if(length(aq-ap)>0.1*max(lum(ap),lum(aq))+0.02){return true;}
 }}
 return false;
}
// Per pixel at an edge, from 16 samples on, the raw mean and the filtered estimate weighed by their expected squared
// errors. The raw mean's is its variance (at least its neighbourhood's: a pixel whose samples missed a rare bright path
// looks quieter than it is); the filtered estimate's is its own variance plus its squared bias, the difference from the
// raw mean that noise does not explain. Two estimates of that bias over the 3x3 neighbourhood, the larger counts: the
// square of the mean signed difference less its variance (a filter that darkens a bright stretch or lightens a dark one
// errs the same way at every pixel there, which shows even where the raw mean is noisy), and the mean squared
// difference beyond two to four times the variances (more with fewer samples; detail blurred across an edge errs both
// ways, which shows where the raw mean is clean). Where filtering added more error than it removed the raw mean takes
// over; elsewhere the filtered estimate stands. Selecting among filters by estimated error per pixel follows Rousselle
// et al. 2012, "Adaptive Rendering with Non-Local Means Filtering". Away from edges, and below 16 samples (whose
// variances cannot tell bias from noise), the filtered estimate stands: smooth shading is what filtering is for.
fn weighed(i:u32,g:vec2u,split:bool)->vec3f {
 if(p.sigma.w>1.0/16.0||!edgeAt(i,g)){return filteredAt(i,split).xyz;}
 let w=p.size.x;let h=p.size.y;
 var d1=0.0;var d2=0.0;var vr=0.0;var vf=0.0;var ws=0.0;var ww=0.0;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let qx=u32(clamp(i32(g.x)+x,0,i32(w)-1));let qy=u32(clamp(i32(g.y)+y,0,i32(h)-1));
  let q=qy*w+qx;let f=filteredAt(q,split);let r=rawAt(q,split,vec2u(qx,qy));
  let wq=select(0.5,1.0,x==0)*select(0.5,1.0,y==0);
  let dl=lum(f.xyz)-lum(r.xyz);d1+=dl*wq;d2+=dl*dl*wq;vr+=r.w*wq;vf+=f.w*wq;ws+=wq;ww+=wq*wq;
 }}
 d1/=ws;d2/=ws;vr/=ws;vf/=ws;
 let f=filteredAt(i,split);let r=rawAt(i,split,g);
 // The mean difference's variance is the pixels' over the kernel's effective count (ws^2 / sum of squared weights).
 // The squared difference must exceed the variances by more where they come from few samples (and are unsure).
 let ef=f.w+max(0.0,max(d1*d1-(vr+vf)*ww/(ws*ws),d2-(2.0+8.0*p.sigma.w)*(vr+vf)));
 let er=max(r.w,vr);
 // Clamped: WGSL division may be off by 2.5 ulp, which pushes a weight just above 1 and a black pixel below 0.
 return mix(f.xyz,r.xyz,clamp(ef/(ef+er+1e-20),0.0,1.0));
}
// The filtered caustics (src) added to the filtered rest (dst), both remodulated. The viewport (flag 8) blends that with
// its previous displayed colour, reprojected and bilinearly read, into dst2: the frames' jittered samples average into
// antialiased edges. Where all four taps saw an occluder in front of this pixel's surface (prepare's mask; the camera's
// move uncovered it) the history is dropped; one clear tap is enough, which keeps both sides of an edge. After a restart
// (flag 64) the history is clamped to this frame's 3x3 neighbourhood (its mean and 1.25 standard deviations, in YCoCg),
// which limits what lags behind the move. The history counts as at most 8 samples against this frame's; while the
// camera holds still nothing moved, it is not clamped and fades out by 8 samples, whose jitter antialiases as well.
@compute @workgroup_size(8,8) fn combine(@builtin(global_invocation_id) g:vec3u) {
 let w=p.size.x;let h=p.size.y;
 if(g.x>=w||g.y>=h){return;}
 let i=g.y*w+g.x;
 // Flag 2: there is a caustic chain (src) to add.
 let split=(p.size.w&2u)!=0u;
 if((p.size.w&8u)==0u){
  dst2[i]=vec4f(weighed(i,g.xy,split),1.0);return;
 }
 let gi=guide[i];let n=1.0/p.sigma.w;
 // The denoiser's history for the next frame, from a restart or where there was none.
 let est=textureLoad(hin,g.xy,0);let mask=u32(unpack2x16float(est.w).y/16.0);
 if((p.size.w&64u)!=0u||(p.size.w&16u)==0u){
  textureStore(hout,g.xy,vec4u(est.x,est.y,pack2x16float(gi.xy),bitcast<u32>(gi.z)));
 }
 var c=weighed(i,g.xy,split);
 var nh=0.0;var hc=vec3f(0.0);
 if((p.size.w&16u)!=0u&&mask!=0u){
  let x=f32(g.x)+0.5;let y=f32(g.y)+0.5;
  let q=select(previousPixel(vec4f(viewDir(x,y),0.0)),previousPixel(vec4f(hitPoint(x,y,gi.z),1.0)),gi.z>0.0)-0.5;
  let b=floor(q);let fr=q-b;
  var s=vec4f(0.0);var sw=0.0;
  for(var k=0u;k<4u;k++){
   let at=b+vec2f(f32(k&1u),f32(k>>1u));
   if(at.x<0.0||at.y<0.0||at.x>=f32(w)||at.y>=f32(h)){continue;}
   let wk=select(1.0-fr.x,fr.x,(k&1u)!=0u)*select(1.0-fr.y,fr.y,(k>>1u)!=0u);
   let v=textureLoad(hin,vec2u(at),0);
   let b2=unpack2x16float(v.w);
   s+=vec4f(unpack2x16float(v.z),b2.x,b2.y-16.0*floor(b2.y/16.0))*wk;
   sw+=wk;
  }
  if(sw>0.01){
   hc=s.xyz/sw;
   if((p.size.w&64u)!=0u){
    var m1=vec3f(0.0);var m2=vec3f(0.0);
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
     let o=u32(clamp(i32(g.y)+y,0,i32(h)-1))*w+u32(clamp(i32(g.x)+x,0,i32(w)-1));
     var cq=dst[o].xyz;
     if(split){cq+=src[o].xyz;}
     cq=ycocg(cq);m1+=cq;m2+=cq*cq;
    }}
    m1/=9.0;let sd=1.25*sqrt(max(m2/9.0-m1*m1,vec3f(0.0)));
    hc=fromYcocg(clamp(ycocg(hc),m1-sd,m1+sd));
   }
   nh=min(s.w/sw,8.0)*max(0.0,1.0-n/select(8.0,64.0,(p.size.w&64u)!=0u));
  }
 }
 dst2[i]=vec4f(min((c*n+hc*nh)/(n+nh),vec3f(65000.0)),n+nh);
}
`;

/** Draws the accumulated (or denoised) image: bilinear upsampling, exposure, tone mapping, first-hit depth. */
export const DISPLAY: string = /* wgsl */ `${displayShader}
${agxShader}
struct View {matrix:mat4x4f,inverse:mat4x4f,size:vec4f,params:vec4f,encoding:vec4f}
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
${acesNarkowiczShader}// Display encoding: sRGB, or the power 1 / gamma when v.encoding.x is set.
fn encodeOut(c:vec3f)->vec3f {
 let x=clamp(c,vec3f(0.0),vec3f(1.0));
 return select(srgb(x),pow(x,vec3f(1.0/max(v.encoding.x,1.0))),v.encoding.x>0.0);
}
@fragment fn fs(i:VOut)->FOut {
 let tw=v.size.x;let th=v.size.y;let W=u32(tw);
 let q=i.pos.xy*vec2f(tw,th)/v.size.zw-0.5;
 let a=floor(q);let fr=q-a;
 let x0=u32(clamp(a.x,0.0,tw-1.0));let x1=u32(clamp(a.x+1.0,0.0,tw-1.0));
 let y0=u32(clamp(a.y,0.0,th-1.0));let y1=u32(clamp(a.y+1.0,0.0,th-1.0));
 var c=mix(mix(color[y0*W+x0].xyz,color[y0*W+x1].xyz,fr.x),mix(color[y1*W+x0].xyz,color[y1*W+x1].xyz,fr.x),fr.y)*v.params.x*v.params.y;
 // Vignette: 1 / (1 + t^2)^2, t = strength x distance from the centre / (0.2238 x height).
 if(v.encoding.y>0.0){let uv=i.pos.xy/v.size.zw-0.5;let t=v.encoding.y*length(vec2f(uv.x*v.size.z/v.size.w,uv.y))/0.2238;c/=(1.0+t*t)*(1.0+t*t);}
 var rgb=max(c,vec3f(0.0));
 let mode=u32(v.params.z);
 if((mode&1u)==0u){
  if((mode&2u)!=0u){rgb=encodeOut(rgb);}
  else if((mode&4u)!=0u){rgb=encodeOut(acesNarkowicz(rgb));}
  else if((mode&8u)!=0u){rgb=encodeOut(agx(rgb));}
  else if(v.encoding.x>0.0){rgb=encodeOut(pbrNeutral(rgb));}
  else{rgb=toDisplay(rgb);}
 }
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
