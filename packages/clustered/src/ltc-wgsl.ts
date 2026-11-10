import { ltcSize } from './ltc.js';
/**
 * WGSL shared by the rectangle (`area`) and shaped (`shapes`) area lights: the LTC table lookup from `<p>Lights.lut`
 * and the horizon-clipped quad form factor, every function named with the prefix `p` so both can sit in one shader.
 */
export const ltcPolygonWgsl = (
  p: string,
): string => /* wgsl */ `fn ${p}LutCell(x:u32,y:u32,k:u32)->vec2f {return unpack2x16float(${p}Lights.lut[(y*${ltcSize}u+x)*3u+k]);}
fn ${p}Lut(st:vec2f,k:u32)->vec2f {let i=vec2u(st);let j=min(i+1u,vec2u(${ltcSize - 1}u));let f=st-vec2f(i);
  return mix(mix(${p}LutCell(i.x,i.y,k),${p}LutCell(j.x,i.y,k),f.x),mix(${p}LutCell(i.x,j.y,k),${p}LutCell(j.x,j.y,k),f.x),f.y);}
fn ${p}Unit(p:vec3f)->vec3f {return p*inverseSqrt(max(dot(p,p),1e-20));}
// One edge's share of the polygon's vector form factor (Lambert's formula, as Heitz et al. 2016 integrate it), z
// component: (a x b).z / |a x b| * angle(a, b) / (2 pi). The angle is atan2(|a x b|, a.b), which is well conditioned
// everywhere (acos loses digits near a.b = 1, asin near -1), and (a x b).z / |a x b| is a direction cosine in [-1, 1],
// so no factor grows without bound as the edge closes up (angle -> 0) or opens to pi. Both pieces are invariant to
// the scale of the cross product, so it is divided by its largest component first (no float32 underflow in |a x b|^2
// for nearly parallel edges). Rounding adds a few ulp to atan2's own error. A zero cross product (parallel or zero
// vectors, as the unclipped horizon chord) returns 0.
fn ${p}Edge(a:vec3f,b:vec3f)->f32 {let n=cross(a,b);let top=max(max(abs(n.x),abs(n.y)),abs(n.z));if(top<=0.0){return 0.0;}
  let k=n/top;let s=length(k);return k.z/s*atan2(top*s,dot(a,b))*0.15915494;}
// One edge clipped to z>=0; records where the quad leaves and re-enters the upper hemisphere.
fn ${p}Clip(s0:vec3f,e0:vec3f,leave:ptr<function,vec3f>,enter:ptr<function,vec3f>)->f32 {
  if(s0.z<0&&e0.z<0){return 0.0;}var s=s0;var e=e0;
  if(s0.z<0){s=mix(s0,e0,s0.z/(s0.z-e0.z));*enter=s;}else if(e0.z<0){e=mix(s0,e0,s0.z/(s0.z-e0.z));*leave=e;}
  return ${p}Edge(${p}Unit(s),${p}Unit(e));
}
// Cosine-weighted integral (form factor) of the quad seen through m, clipped to z>=0: its edges plus the horizon chord
// (zero when nothing was clipped: both points stay at the origin). Unrolled: no dynamically indexed private array.
// The two early returns are the clipped sum's own result when no edge crosses z=0: same operations in the same order,
// each corner made unit once where the edges would do it twice. On p-rect-area they cut the main pass by a fifth.
fn ${p}Integral(m:mat3x3f,a:vec3f,b:vec3f,c:vec3f,d:vec3f)->f32 {
  let p0=m*a;let p1=m*b;let p2=m*c;let p3=m*d;
  if(min(min(p0.z,p1.z),min(p2.z,p3.z))>=0.0){let u0=${p}Unit(p0);let u1=${p}Unit(p1);let u2=${p}Unit(p2);let u3=${p}Unit(p3);
    return ${p}Edge(u0,u1)+${p}Edge(u1,u2)+${p}Edge(u2,u3)+${p}Edge(u3,u0);}
  if(max(max(p0.z,p1.z),max(p2.z,p3.z))<0.0){return 0.0;}
  var leave=vec3f(0);var enter=vec3f(0);
  let sum=${p}Clip(p0,p1,&leave,&enter)+${p}Clip(p1,p2,&leave,&enter)+${p}Clip(p2,p3,&leave,&enter)+${p}Clip(p3,p0,&leave,&enter);
  return sum+${p}Edge(${p}Unit(leave),${p}Unit(enter));
}
`;
