import type {TraceVec3} from '@margoengine/voxel-pathtracer';
import type {TraceIESProfile} from './mesh-ies.js';

/** Point-source spot light in world units. Intensities use candela. */
export interface TraceSpotLight {
  /** World-space light position. */
  position: TraceVec3;
  /** Forward direction, normalized during preparation. Default [0,-1,0]. */
  direction?: TraceVec3;
  /** Azimuth 90-degree reference, projected perpendicular to direction. Default stable world up. */
  up?: TraceVec3;
  /** Linear RGB multiplier. Default [1,1,1]. */
  color?: TraceVec3;
  /** Candela without a profile, or multiplier of absolute IES candela. Default 1. */
  intensity?: number;
  /** Inner cone angle in radians. Default 0. */
  innerConeAngle?: number;
  /** Outer cone angle in radians, at most pi/2. Default pi/4, or no cone envelope with IES. */
  outerConeAngle?: number;
  /** Smooth finite range in world units. Default infinite. */
  range?: number;
  /** Type C photometry. Default uniform intensity within the spot cone. */
  ies?: TraceIESProfile;
  /** Angle used to interpolate the profile's lamp tilt multipliers. Default 0 degrees. */
  tiltDegrees?: number;
}
function value(n:number,name:string,low=0,high=1e8):number {
  if(!Number.isFinite(n)||n<low||n>high)throw new RangeError(`Mesh light ${name} must be finite in [${low}, ${high}]`);return n;
}
function vector(v:readonly number[],name:string,low=-1e8,high=1e8):number[] {
  if(!v||v.length!==3)throw new TypeError(`Mesh light ${name} needs three components`);return Array.from(v,n=>value(n,name,low,high));
}
function unit(v:number[],name:string):number[] {const n=Math.hypot(...v);if(n===0)throw new RangeError(`Mesh light ${name} must be nonzero`);return v.map(x=>x/n);}
function cross(a:number[],b:number[]):number[]{return [a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];}
function validateProfile(p:TraceIESProfile):void {
  for(const [name,a,maximum] of [['verticalAngles',p.verticalAngles,180],['horizontalAngles',p.horizontalAngles,360],['tiltAngles',p.tiltAngles,180]] as const){
    if(a===undefined&&name==='tiltAngles')continue;
    if(!(a instanceof Float32Array)||!a.length||a.length>1_000_000||a.some((v,i)=>!Number.isFinite(v)||v<0||v>maximum||(i>0&&v<=a[i-1]!)))
      throw new TypeError(`Mesh IES ${name} needs strictly increasing Float32 angles`);
  }
  const h=p.horizontalAngles;
  if(h.length>1&&(h[0]!==0||![90,180,360].includes(h[h.length-1]!)))throw new RangeError('Mesh IES planes must cover 90, 180 or 360 degrees');
  if(!(p.candela instanceof Float32Array)||p.candela.length!==p.verticalAngles.length*h.length||p.candela.length>1_000_000||p.candela.some(v=>!Number.isFinite(v)||v<0||v>1e16))
    throw new TypeError('Mesh IES needs finite nonnegative horizontal-major candela');
  if((p.tiltAngles===undefined)!==(p.tiltMultipliers===undefined)||p.tiltAngles&&(!(p.tiltMultipliers instanceof Float32Array)||p.tiltMultipliers.length!==p.tiltAngles.length||p.tiltMultipliers.some(v=>!Number.isFinite(v)||v<0||v>1e8)))
    throw new TypeError('Mesh IES tilt angles need matching finite nonnegative multipliers');
}
function tilt(profile:TraceIESProfile,angle:number):number {
  const a=profile.tiltAngles,m=profile.tiltMultipliers;if(!a||!m)return 1;
  if(angle<=a[0]!)return m[0]!;for(let i=1;i<a.length;i++)if(angle<=a[i]!){const t=(angle-a[i-1]!)/(a[i]!-a[i-1]!);return m[i-1]!*(1-t)+m[i]!*t;}return m[m.length-1]!;
}
/** Validates and snapshots before a geometry build can await. */
export function snapshotSpots(input:readonly TraceSpotLight[]|undefined):TraceSpotLight[] {
  if(input===undefined)return [];
  if(!Array.isArray(input)||input.length>4096)throw new TypeError('Mesh spotLights needs at most 4096 spot lights');
  const owned=structuredClone(input);
  for(const light of owned){
    vector(light.position,'position');unit(vector(light.direction??[0,-1,0],'direction'),'direction');
    if(light.up)unit(cross(unit(vector(light.direction??[0,-1,0],'direction'),'direction'),vector(light.up,'up')),'up perpendicular to direction');vector(light.color??[1,1,1],'color',0,1e8);value(light.intensity??1,'intensity');
    const outer=value(light.outerConeAngle??Math.PI/4,'outerConeAngle',0,Math.PI/2);value(light.innerConeAngle??0,'innerConeAngle',0,outer);
    if(outer===0||(light.innerConeAngle??0)===outer)throw new RangeError('Mesh spot inner cone must be smaller than its positive outer cone');
    if(light.range!==undefined)value(light.range,'range',Number.MIN_VALUE);value(light.tiltDegrees??0,'tiltDegrees',0,180);
    if(light.ies)validateProfile(light.ies);
  }
  return owned;
}
/** Append bounded spot metadata; the triangle/world-area scan stays in Rust. */
export function appendSpots(geometry:Uint32Array,spots:TraceSpotLight[]):Uint32Array {
  if(!spots.length)return geometry;
  let size=geometry.length+spots.length*32;const profiles=new Map<TraceIESProfile,number>();
  for(const light of spots)if(light.ies&&!profiles.has(light.ies)){profiles.set(light.ies,size);size+=light.ies.verticalAngles.length+light.ies.horizontalAngles.length+light.ies.candela.length;}
  if(size>(128<<20)/4)throw new RangeError('Mesh light packet exceeds 128 MiB; pass fewer profiles or mesh instances');
  const out=new Uint32Array(size),f=new Float32Array(out.buffer);out.set(geometry);const header=out[12]!;out[header+2]=spots.length;out[header+3]=geometry.length;
  for(const [profile,at] of profiles){f.set(profile.verticalAngles,at);f.set(profile.horizontalAngles,at+profile.verticalAngles.length);f.set(profile.candela,at+profile.verticalAngles.length+profile.horizontalAngles.length);}
  spots.forEach((light,i)=>{
    const at=geometry.length+i*32,d=unit(vector(light.direction??[0,-1,0],'direction'),'direction');
    const up=vector(light.up??(Math.abs(d[1]!)<.99?[0,1,0]:[0,0,1]),'up'),right=unit(cross(d,up),'up perpendicular to direction'),u=cross(right,d);
    const color=vector(light.color??[1,1,1],'color',0),intensity=light.intensity??1;
    f.set(light.position,at);f.set(d,at+4);f[at+7]=light.ies&&light.outerConeAngle===undefined&&light.innerConeAngle===undefined?-2:Math.cos(light.innerConeAngle??0);
    f.set(right,at+8);f[at+11]=light.ies&&light.outerConeAngle===undefined&&light.innerConeAngle===undefined?-3:Math.cos(light.outerConeAngle??Math.PI/4);f.set(u,at+12);f[at+15]=light.range??0;
    f.set(color.map(v=>v*intensity),at+16);
    const profile=light.ies;if(profile){out[at+20]=profiles.get(profile)!;out[at+21]=profile.verticalAngles.length;out[at+22]=profile.horizontalAngles.length;f[at+23]=tilt(profile,light.tiltDegrees??0);}
  });return out;
}
