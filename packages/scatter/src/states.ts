/// <reference lib="esnext.disposable" preserve="true" />
// Plant states for scatter: burnt and flooded plants that stay standing. A state map over a world rectangle holds, per
// cell, what fire and water did there; every posing vertex stage of a Scatter built with `states: map.plant({...})`
// reads its instance's root cell and treats the existing mesh (no new geometry):
// - fire: foliage below the crown scorch height turns the scorch colour (Van Wagner 1973), stems and bark below the
//   flame length char black (Byram 1959), a crown fire (fireline intensity past Van Wagner 1977's initiation
//   intensity for the plant's crown base height and foliar moisture) strips the crown to bare charred branches, and
//   ash settles on upward faces;
// - flood: below the high-water mark the plant is mud coated with a stain line above it, it lies flattened downstream
//   once the flow's shear velocity passed its stiffness's critical value (Kouwen and Li 1980), and debris catches on
//   its upstream faces where depth times velocity was high (the flood hazard rating of Ramsbottom et al. 2006);
// - a colour map tints instances (dust, drought, stain), painted from the CPU.
// The map composes itself once a frame from a FireFront's burn texture (`@margoengine/vfx`), a Flood's wetting record
// and current (`@margoengine/water`) and a GroundChange's plant covers (`@margoengine/terrain`), keeping each cell's
// worst fire and highest water, so a plant stays scorched or flattened after the front or the wave has passed.
// Sources and their formulas: docs/clean-room.md, "Plant states".
import type { EngineKernel } from '@margoengine/core';
import type { ScatterStateSource } from '@margoengine/scatter';
import { rangeError, typeError } from '../../shared/errors.js';
import { compute, group } from '../../shared/gpu.js';
import { checkSettings, colorSetting, numberSetting, settingIndex, type SettingRow } from '../../shared/settings.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; COPY_SRC: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

type Rect = readonly [number, number, number, number];
type Color = readonly [number, number, number];

/** A FireFront's burn texture (rgba32float per cell: caught time, burn-out time, fireline intensity MW/m, state). */
export interface FireStateSource {
  /** Read every frame; undefined skips the fire. */
  readonly texture: () => GPUTexture | undefined;
  /** World rectangle the texture covers, `[minX, minZ, maxX, maxZ]`. */
  readonly bounds: Rect;
}
/** A Flood's wetting record (deepest depth m, seconds since wet, wet flag) and current (u, v, speed m/s, depth m). */
export interface FloodStateSource {
  readonly wet: () => GPUTexture | undefined;
  /** Without it the water marks and wetness still show; nothing is flattened and no debris is caught. */
  readonly velocity?: () => GPUTexture | undefined;
  readonly bounds: Rect;
}
/** A GroundChange's plant covers (`plantCovers()`): rgba8 mud, ash, char and wetness. */
export interface GroundStateSource {
  readonly covers: () => GPUTexture | undefined;
  readonly bounds: Rect;
}

/** Settings of {@link PlantStates.attach}; the numbers are live (`set`, or `applyPlantStateSettings`). */
export interface PlantStatesOptions {
  /** World rectangle of the map, `[minX, minZ, maxX, maxZ]`. Instances whose root is outside it are untouched. */
  readonly bounds: Rect;
  /** Cells along x and z, integers from 1 to 1,024 (default 256 each); a number sets both. */
  readonly resolution?: number | readonly [number, number];
  readonly fire?: FireStateSource;
  readonly flood?: FloodStateSource;
  readonly ground?: GroundStateSource;
  /** Air temperature at the fire, deg C from -60 to 59 (default 25): hotter air scorches higher (Van Wagner 1973). */
  readonly ambient?: number;
  /** Midflame wind speed at the fire, m/s from 0 to 40 (default 2): wind tilts the plume and lowers the scorch. */
  readonly wind?: number;
  /** Manning's n of the flooded ground, 0.01 to 0.2 (default 0.035, grass and brush), for the shear velocity. */
  readonly manning?: number;
  /** Seconds for flood wetness to fall to 1/e once the water has gone, above 0 (default 3,600). */
  readonly dryTime?: number;
  /** Scorch height in m of a fully charred GroundChange burn cell, 0 to 100 (default 4). */
  readonly groundScorch?: number;
  /** Char height in m of a fully charred GroundChange burn cell, 0 to 100 (default 1). */
  readonly groundChar?: number;
  /** High-water mark in m of a full GroundChange mud cell, 0 to 100 (default 0.4). */
  readonly groundMud?: number;
}

/**
 * What past fires and floods left in a cell, for {@link PlantStates.mark}: each value raises the map's own (the map keeps
 * the worst fire and the highest water), so a burn scar or a flood line from history shows with no live source.
 */
export interface PlantMarks {
  /** Crown scorch height in m, 0 to 100 (default 0). `scorchHeight(kW/m)` gives Van Wagner's for a fireline intensity. */
  readonly scorch?: number;
  /** Char height on stems in m, 0 to 100 (default 0). `flameLength(kW/m)` gives Byram's. */
  readonly char?: number;
  /** Fireline intensity in MW/m, 0 to 1,000 (default 0): past a plant's crown initiation its crown is stripped. */
  readonly intensity?: number;
  /** Ash on upward faces, 0 to 1 (default 0). */
  readonly ash?: number;
  /** High-water mark in m, 0 to 100 (default 0): mud below it, the stain line above it. */
  readonly water?: number;
  /** Debris on upstream faces, 0 to 1 (default 0). */
  readonly debris?: number;
  /** Wetness of the flooded parts, 0 to 1 (default 0). */
  readonly wetness?: number;
}
const MARKS: Record<keyof PlantMarks, [number, number]> = {
  scorch: [0, 100],
  char: [0, 100],
  intensity: [0, 1000],
  ash: [0, 1],
  water: [0, 100],
  debris: [0, 1],
  wetness: [0, 1],
};

/** One kind of plant's response, set per Scatter (`plant()`); every field is live (`PlantStateSource.set`). */
export interface PlantResponse {
  /** Crown base height in m, 0 to 100 (default 0: the whole plant is crown, as grass and low shrubs). */
  readonly crownBase?: number;
  /** Foliar moisture content in percent, 50 to 300 (default 100). */
  readonly foliarMoisture?: number;
  /** Stem radius in mesh units, 0 to 1,000 (default 0.1): vertices nearer the axis are trunk, the rest crown. */
  readonly trunkRadius?: number;
  /** Flexural rigidity MEI of a stem in N m^2, above 0 (default 0.05, grass; shrubs about 5, trees 1e5 and up). */
  readonly stiffness?: number;
  /** Turn of a fully flattened plant about its root, in radians, 0 to pi / 2 (default 1.4). */
  readonly flatten?: number;
  /** Share of its reach a fully consumed crown loses toward the stem, 0 to 1 (default 0.85). */
  readonly bareShrink?: number;
  /** Albedo of fully wet parts below the water mark, 0 to 1 (default 0.55, as GroundChange's wet ground). */
  readonly wetDarkening?: number;
  /** Height in m of the darker stain line above the water mark, 0 to 10 (default 0.06). */
  readonly stainBand?: number;
  /** Soft edge in m of the scorch and char lines, 0.001 to 10 (default 0.12). */
  readonly edge?: number;
  /** Linear RGB colours, each 0 to 1. */
  readonly scorch?: Color;
  readonly char?: Color;
  readonly ash?: Color;
  readonly mud?: Color;
  readonly debris?: Color;
}

const RESPONSE = {
  crownBase: 0,
  foliarMoisture: 100,
  trunkRadius: 0.1,
  stiffness: 0.05,
  flatten: 1.4,
  bareShrink: 0.85,
  wetDarkening: 0.55,
  stainBand: 0.06,
  edge: 0.12,
  scorch: [0.42, 0.24, 0.1] as Color,
  char: [0.025, 0.022, 0.02] as Color,
  ash: [0.5, 0.49, 0.47] as Color,
  mud: [0.24, 0.2, 0.15] as Color,
  debris: [0.16, 0.13, 0.09] as Color,
};
/** Ranges of the plant numbers: [min, max, min exclusive]. */
const RESPONSE_RANGE: Record<string, [number, number, boolean?]> = {
  crownBase: [0, 100],
  foliarMoisture: [50, 300],
  trunkRadius: [0, 1000],
  stiffness: [0, 1e9, true],
  flatten: [0, Math.PI / 2],
  bareShrink: [0, 1],
  wetDarkening: [0, 1],
  stainBand: [0, 10],
  edge: [0.001, 10],
};
const MAP_RANGE: Record<string, [number, number, boolean?]> = {
  ambient: [-60, 59],
  wind: [0, 40],
  manning: [0.01, 0.2],
  dryTime: [0, 1e9, true],
  groundScorch: [0, 100],
  groundChar: [0, 100],
  groundMud: [0, 100],
};
const MAP_DEFAULTS = {
  ambient: 25,
  wind: 2,
  manning: 0.035,
  dryTime: 3600,
  groundScorch: 4,
  groundChar: 1,
  groundMud: 0.4,
};
type MapNumbers = typeof MAP_DEFAULTS;
const COLORS = ['scorch', 'char', 'ash', 'mud', 'debris'] as const;

function checkNumber(name: string, v: unknown, [lo, hi, open]: [number, number, boolean?], what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v > hi || (open ? v <= lo : v < lo))
    throw rangeError(
      `${what} ${name} must be a number ${open ? 'above' : 'from'} ${lo}${hi < 1e9 ? ` ${open ? 'and at most' : 'to'} ${hi}` : ''}`,
      'scatter',
    );
  return v;
}
function checkColor(name: string, v: unknown): Color {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => typeof c === 'number' && c >= 0 && c <= 1))
    throw rangeError(`Plant state colour ${name} must be three numbers from 0 to 1 (linear RGB)`, 'scatter');
  return [v[0], v[1], v[2]];
}
function checkMarks(marks: unknown): Partial<Record<keyof PlantMarks, number>> {
  if (!marks || typeof marks !== 'object')
    throw typeError('Plant marks must be an object such as { scorch: 3, ash: 1 }', 'scatter');
  const out: Partial<Record<keyof PlantMarks, number>> = {};
  for (const [key, value] of Object.entries(marks)) {
    if (value === undefined) continue;
    if (!(key in MARKS)) throw typeError(`Unknown plant mark ${key}`, 'scatter');
    out[key as keyof PlantMarks] = checkNumber(key, value, MARKS[key as keyof PlantMarks], 'Plant mark');
  }
  return out;
}
function checkRect(name: string, b: unknown): Rect {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1])
    throw rangeError(
      `Plant states ${name} must be a world rectangle [minX, minZ, maxX, maxZ] with max above min`,
      'scatter',
    );
  return [b[0], b[1], b[2], b[3]];
}

/** Words of the map before its cells: (minX, minZ, cells per unit x, z), (cells x, cells z, 0, 0). */
const HEAD = 2;
/** Layers: 0 fire, 1 water, 2 flow direction, 3 colour, 4 fire marks, 5 water marks (3 to 5 written from the CPU). */
const LAYERS = 6;

/**
 * WGSL of the compose pass, which only reads the map's header (the CPU writes it) and stores each cell after its last read,
 * so the WebGL2 compatibility layer runs it as a GPU draw and never on its CPU tier (the formulas: Van Wagner 1973 scorch height from fireline intensity I kW/m, midflame wind U
 * m/s and air T deg C; Byram 1959 flame length as the char height; Manning shear velocity u* = n V sqrt(g) / h^(1/6),
 * Chow 1959; debris from the hazard rating d (v + 0.5) between 0.75 and 2, Ramsbottom et al. 2006): one thread a map cell, reading each source at the cell's centre (nearest texel) and keeping
 * the worst fire and the highest water, and the marks of layers 4 and 5 once when they change. Layer 0: crown scorch height m, char height m, fireline intensity MW/m, ash 0-1.
 * Layer 1: high-water mark m, peak shear velocity m/s, debris 0-1, wetness 0-1. Layer 2: flow direction at the peak.
 */
export const composeShader = /* wgsl */ `
struct Compose {map:vec4f,size:vec4u,fire:vec4f,fireLook:vec4f,flood:vec4f,floodLook:vec4f,ground:vec4f,groundLook:vec4f}
@group(0) @binding(0) var<uniform> u:Compose;
@group(0) @binding(1) var<storage,read_write> map:array<vec4f>;
@group(0) @binding(2) var fire:texture_2d<f32>;
@group(0) @binding(3) var wet:texture_2d<f32>;
@group(0) @binding(4) var flow:texture_2d<f32>;
@group(0) @binding(5) var covers:texture_2d<f32>;
fn texel(t:texture_2d<f32>,b:vec4f,w:vec2f,ok:ptr<function,bool>)->vec4f {
 let size=vec2i(textureDimensions(t));let c=vec2i(floor((w-b.xy)/(b.zw-b.xy)*vec2f(size)));
 *ok=all(c>=vec2i(0))&&all(c<size);if(!*ok){return vec4f(0);}return textureLoad(t,c,0);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let nx=u.size.x;let nz=u.size.y;if(id.x>=nx||id.y>=nz){return;}
 let n=nx*nz;let cell=id.y*nx+id.x;
 let w=u.map.xy+(vec2f(id.xy)+0.5)/vec2f(f32(nx),f32(nz))*(u.map.zw-u.map.xy);
 var burn=map[${HEAD}u+cell];var water=map[${HEAD}u+n+cell];var dir=map[${HEAD}u+2u*n+cell];
 var ok=false;var wetness=-1.0;
 if((u.size.z&1u)!=0u){
  let f=texel(fire,u.fire,w,&ok);
  if(ok&&f.w>=0.5&&f.w<2.5&&f.z>0.0){
   let i=f.z*1000.0;let wind=u.fireLook.y;
   let scorch=4.665*pow(i,7.0/6.0)/((60.0-u.fireLook.x)*sqrt(i+38.7*wind*wind*wind));
   burn=max(burn,vec4f(scorch,0.0775*pow(i,0.46),f.z,select(0.0,1.0,f.w>=1.5)));
  }
 }
 if((u.size.z&2u)!=0u){
  let r=texel(wet,u.flood,w,&ok);
  if(ok&&r.z>0.0){water.x=max(water.x,r.x);wetness=exp(-r.y/u.floodLook.y);}
  if((u.size.z&4u)!=0u){
   let v=texel(flow,u.flood,w,&ok);
   if(ok&&v.w>0.01){
    let shear=u.floodLook.x*v.z*3.1320919/pow(v.w,1.0/6.0);
    if(shear>water.y&&length(v.xy)>0.0){dir=vec4f(normalize(v.xy),0,0);water.y=shear;}
    water.z=max(water.z,clamp((v.w*(v.z+0.5)-0.75)/1.25,0.0,1.0));
   }
  }
 }
 if((u.size.z&8u)!=0u){
  let g=texel(covers,u.ground,w,&ok);
  if(ok){
   burn=max(burn,vec4f(g.z*u.groundLook.x,g.z*u.groundLook.y,0.0,g.y));
   water.x=max(water.x,g.x*u.groundLook.z);wetness=max(wetness,g.w);
  }
 }
 if((u.size.z&16u)!=0u){
  burn=max(burn,map[${HEAD}u+4u*n+cell]);let m=map[${HEAD}u+5u*n+cell];
  water=vec4f(max(water.x,m.x),water.y,max(water.z,m.z),water.w);if(m.w>0.0){wetness=max(wetness,m.w);}
 }
 if(wetness>=0.0){water.w=wetness;}
 map[${HEAD}u+cell]=burn;map[${HEAD}u+n+cell]=water;map[${HEAD}u+2u*n+cell]=dir;
}`;

/**
 * WGSL of the map read and the plant response (`plantGone`: the consumed crown, 0 below Van Wagner's 1977 initiation
 * intensity (0.010 CBH (460 + 25.9 FMC))^1.5 kW/m and all of it at twice that, the whole plant at any intensity without a
 * crown base; `plantFlat`: 0 below Kouwen and Li's 1980 critical shear velocity, all of it at twice it) for a posing vertex stage: `plantMap` and `plant` at `binding` and
 * `binding + 1` of `group`. `plant`: 0 scorch rgb + crown base, 1 char rgb + foliar moisture, 2 ash rgb + trunk radius,
 * 3 mud rgb + stiffness, 4 debris rgb + flatten, 5 (bare shrink, wet albedo, stain band, edge).
 */
export function plantStateCode(group: number, binding: number): string {
  return `
@group(${group}) @binding(${binding}) var<storage,read> plantMap:array<vec4f>;
@group(${group}) @binding(${binding + 1}) var<uniform> plant:array<vec4f,6>;
fn plantCell(root:vec2f)->i32 {
 let h=plantMap[0];let n=vec2i(plantMap[1].xy);let c=vec2i(floor((root-h.xy)*h.zw));
 if(any(c<vec2i(0))||any(c>=n)){return -1;}return c.y*n.x+c.x;
}
fn plantLayer(cell:i32,layer:i32)->vec4f {if(cell<0){return vec4f(0);}return plantMap[${HEAD}+layer*i32(plantMap[1].x*plantMap[1].y)+cell];}
fn plantGone(intensity:f32)->f32 {
 let i0=pow(0.010*plant[0].w*(460.0+25.9*plant[1].w),1.5);
 if(intensity<=0.0){return 0.0;}if(i0<=0.0){return 1.0;}return clamp((intensity*1000.0-i0)/i0,0.0,1.0);
}
fn plantFlat(shear:f32)->f32 {let m=plant[3].w;let crit=min(0.028+6.33*m*m,0.23*pow(m,0.106));return clamp((shear-crit)/crit,0.0,1.0);}
fn plantTurn(v:vec3f,k:vec3f,a:f32)->vec3f {if(a<=0.0){return v;}return v*cos(a)+cross(k,v)*sin(a)+k*dot(k,v)*(1.0-cos(a));}
fn plantColor(base:vec3f,p:vec3f,position:vec4f,n:vec3f)->vec3f {
 let cell=plantCell(position.xz);if(cell<0){return base;}
 let b=plantLayer(cell,0);let f=plantLayer(cell,1);let tint=plantLayer(cell,3);
 var c=mix(base,tint.rgb,clamp(tint.a,0.0,1.0));
 let h=p.y*position.w;let crown=length(p.xz)>plant[2].w&&h>=plant[0].w;let e=plant[5].w;
 if(crown&&b.x>0.0){c=mix(c,plant[0].rgb,1.0-smoothstep(b.x-e,b.x,h));}
 if(crown){c=mix(c,plant[1].rgb,plantGone(b.z));}
 if(b.y>0.0){c=mix(c,plant[1].rgb,1.0-smoothstep(b.y-e,b.y,h));}
 c=mix(c,plant[2].rgb,clamp(b.w,0.0,1.0)*clamp(n.y,0.0,1.0)*0.8);
 if(f.x>0.0){
  let below=1.0-smoothstep(f.x-0.02,f.x,h);let stain=(1.0-below)*(1.0-smoothstep(f.x,f.x+plant[5].z,h));
  let d=plantLayer(cell,2).xy;let facing=select(0.0,clamp(-dot(n.xz,normalize(d)),0.0,1.0),dot(d,d)>0.0);
  c=mix(c,plant[3].rgb,below*0.85);c=mix(c,plant[4].rgb,clamp(f.z,0.0,1.0)*facing*below);
  c*=mix(1.0,plant[5].y,clamp(f.w,0.0,1.0)*below)*(1.0-0.45*stain);
 }
 return c;
}
`;
}

const POSED = 'var world=scatterTurn(vec3f(p.x*wide,p.y,p.z*wide),c,s,up)*position.w+position.xyz;';
const RETURN = /return ScatterPose\(world,([^;]*)\);/;
// After the instance's turn and scale, before the wind: a consumed crown pulls its reach toward the stem, and a
// flattened plant turns about its root toward the flow, its normals with it (a turn keeps every vertex's distance from
// the root, so the cull radii hold).
const SHAPE =
  'let plantC=plantCell(position.xz);var plantK=vec3f(0);var plantA=0.0;' +
  '{let gone=plantGone(plantLayer(plantC,0).z)*plant[5].x;let o=world-position.xyz;let a=dot(o,up);let rad=o-up*a;' +
  'let r=length(rad)/max(position.w,1e-20);' +
  'if(gone>0.0&&r>plant[2].w&&a>=plant[0].w){world=position.xyz+up*a+rad*mix(1.0,plant[2].w/r,gone);}}' +
  '{let d=plantLayer(plantC,2).xy;plantA=plantFlat(plantLayer(plantC,1).y)*plant[4].w;' +
  'if(plantA>0.0&&dot(d,d)>0.0){let dn=normalize(d);plantK=vec3f(dn.y,0,-dn.x);world=position.xyz+plantTurn(world-position.xyz,plantK,plantA);}else{plantA=0.0;}}';

/**
 * A posing vertex stage `code` with the plant states: the shape in the pose and, in a lit colour stage, the colour.
 * @throws TypeError when `code` holds no scatter pose.
 */
export function plantStatePoseCode(code: string, group: number, binding: number): string {
  const at = code.indexOf('struct ScatterPose ');
  if (at < 0 || code.split(POSED).length !== 2 || !RETURN.test(code))
    throw typeError('plantStatePoseCode takes a scatter vertex stage', 'scatter');
  let out =
    code.slice(0, at) +
    plantStateCode(group, binding) +
    code
      .slice(at)
      .replace(POSED, POSED + SHAPE)
      .replace(
        RETURN,
        'var plantOut=ScatterPose(world,$1);plantOut.normal=plantTurn(plantOut.normal,plantK,plantA);return plantOut;',
      );
  if (out.includes('o.color=')) {
    if (!/o\.color=[^;]+;/.test(out) || !out.includes('let data=instances['))
      throw typeError('plantStatePoseCode takes a scatter vertex stage', 'scatter');
    // The mesh-space vertex height times the instance scale is its height above the root, before any turn.
    out = out.replace(/o\.color=([^;]+);/, 'o.color=plantColor($1,p,data.position,o.normal);');
  }
  return out;
}

/** Fireline-intensity scorch height (m): Van Wagner 1973 in SI units. CPU twin of the compose pass. */
export function scorchHeight(intensity: number, ambient = 25, wind = 2): number {
  return (4.665 * intensity ** (7 / 6)) / ((60 - ambient) * Math.sqrt(intensity + 38.7 * wind ** 3));
}
/** Flame length (m) of a fireline intensity in kW/m: Byram 1959. */
export function flameLength(intensity: number): number {
  return 0.0775 * intensity ** 0.46;
}
/** Crown fire initiation intensity (kW/m) for a crown base height (m) and foliar moisture (%): Van Wagner 1977. */
export function crownInitiation(crownBase: number, foliarMoisture = 100): number {
  return (0.01 * crownBase * (460 + 25.9 * foliarMoisture)) ** 1.5;
}
/** Critical shear velocity (m/s) that flattens a stem of flexural rigidity MEI (N m^2): Kouwen and Li 1980. */
export function flatteningShear(stiffness: number): number {
  return Math.min(0.028 + 6.33 * stiffness * stiffness, 0.23 * stiffness ** 0.106);
}
/** Shear velocity (m/s) of a flow of depth (m) and speed (m/s) over ground of Manning's n: Chow 1959. */
export function shearVelocity(depth: number, speed: number, manning = 0.035): number {
  return (manning * speed * Math.sqrt(9.81)) / depth ** (1 / 6);
}

/** What a FireFront exposes for its burn texture (`@margoengine/vfx`). */
interface FireLike {
  readonly texture?: GPUTexture;
  readonly origin: readonly [number, number];
  readonly cell: number;
  readonly width: number;
  readonly height: number;
}
/** The plant state source of a FireFront: its burn texture over its grid. */
export function fireSource(fire: FireLike): FireStateSource {
  const [x, z] = fire.origin;
  return { texture: () => fire.texture, bounds: [x, z, x + fire.width * fire.cell, z + fire.height * fire.cell] };
}
/** What a Flood exposes for its records (`@margoengine/water`). */
interface FloodLike {
  readonly wetTexture?: GPUTexture;
  readonly velocityTexture?: GPUTexture;
  readonly options: {
    readonly surface: {
      readonly options: { readonly terrain?: { origin: readonly number[]; size: readonly number[] } };
    };
  };
}
/** The plant state source of a Flood: its wetting record and current over its terrain. */
export function floodSource(flood: FloodLike): FloodStateSource {
  const t = flood.options.surface.options.terrain;
  if (!t) throw typeError('floodSource needs a Flood over a terrain', 'scatter');
  return {
    wet: () => flood.wetTexture,
    velocity: () => flood.velocityTexture,
    bounds: [t.origin[0], t.origin[1], t.origin[0] + t.size[0], t.origin[1] + t.size[1]],
  };
}

/**
 * Per-instance burnt and flooded states for scatter plants: a state map over a world rectangle, composed each frame from
 * a fire, a flood and changed ground, and painted with colours from the CPU. Give each Scatter (any `Scatter`,
 * `ScatterTiles`, `GrassScatter` or `TrampledScatter`) its plant's response with `states: map.plant({...})`. WebGPU and
 * the WebGL2 compatibility layer.
 * @example
 * const states = PlantStates.attach(engine, { bounds: [-50, -50, 50, 50], fire: fireSource(fire), flood: floodSource(flood) });
 * Scatter.attach(engine, pine, { material, states: states.plant({ crownBase: 4, trunkRadius: 0.15, stiffness: 2e5 }) });
 */
export class PlantStates implements Disposable {
  readonly bounds: Rect;
  readonly resolution: readonly [number, number];
  readonly #engine: EngineKernel;
  readonly #numbers: MapNumbers;
  #sources: { fire?: FireStateSource; flood?: FloodStateSource; ground?: GroundStateSource };
  readonly #colors: Float32Array;
  readonly #plants = new Set<PlantStateSource>();
  #device?: GPUDevice;
  #map?: GPUBuffer;
  #uniform?: GPUBuffer;
  #kernel?: GPUComputePipeline;
  #blank?: GPUTexture;
  #groups = new Map<string, GPUBindGroup>();
  #encoder?: GPUCommandEncoder;
  #colorsDirty = true;
  #marksDirty = false;
  #hasMarks = false;
  #clear = true;
  #disposed = false;
  readonly #words = new ArrayBuffer(128);

  /** Builds a state map on the engine. @throws RangeError / TypeError for invalid options. */
  static attach(engine: EngineKernel, options: PlantStatesOptions): PlantStates {
    return new PlantStates(engine, options);
  }
  /** @deprecated The same as {@link PlantStates.attach}, the name every engine feature uses. */
  static create(engine: EngineKernel, options: PlantStatesOptions): PlantStates {
    return PlantStates.attach(engine, options);
  }
  constructor(engine: EngineKernel, options: PlantStatesOptions) {
    if (!engine || typeof engine !== 'object') throw typeError('PlantStates needs an engine', 'scatter');
    if (!options || typeof options !== 'object')
      throw typeError('PlantStates options must be an object with bounds', 'scatter');
    this.bounds = checkRect('bounds', options.bounds);
    const r = options.resolution ?? 256,
      res = typeof r === 'number' ? [r, r] : r;
    if (!Array.isArray(res) || res.length !== 2 || !res.every((v) => Number.isInteger(v) && v >= 1 && v <= 1024))
      throw rangeError('PlantStates resolution must be cells from 1 to 1024, one number or [x, z]', 'scatter');
    this.resolution = [res[0], res[1]];
    this.#engine = engine;
    this.#numbers = { ...MAP_DEFAULTS };
    this.set(options);
    this.#sources = {};
    this.setSources(options);
    this.#colors = new Float32Array(res[0] * res[1] * 4 * 3);
  }

  /** Changes the live numbers (`ambient`, `wind`, `manning`, `dryTime`, `groundScorch`, `groundChar`, `groundMud`). */
  set(numbers: Partial<MapNumbers>): this {
    const next = { ...this.#numbers };
    for (const key of Object.keys(MAP_DEFAULTS) as (keyof MapNumbers)[])
      if (numbers[key] !== undefined) next[key] = checkNumber(key, numbers[key], MAP_RANGE[key], 'PlantStates');
    Object.assign(this.#numbers, next);
    return this;
  }
  /** The live numbers. */
  get numbers(): Readonly<MapNumbers> {
    return { ...this.#numbers };
  }
  /** Replaces the fire, flood and ground sources (a key left out removes that source). */
  setSources(sources: Pick<PlantStatesOptions, 'fire' | 'flood' | 'ground'>): this {
    const { fire, flood, ground } = sources;
    if (fire !== undefined && typeof fire?.texture !== 'function')
      throw typeError('PlantStates fire needs texture: () => GPUTexture', 'scatter');
    if (flood !== undefined && typeof flood?.wet !== 'function')
      throw typeError('PlantStates flood needs wet: () => GPUTexture', 'scatter');
    if (flood?.velocity !== undefined && typeof flood.velocity !== 'function')
      throw typeError('PlantStates flood velocity must be a function', 'scatter');
    if (ground !== undefined && typeof ground?.covers !== 'function')
      throw typeError('PlantStates ground needs covers: () => GPUTexture', 'scatter');
    if (fire) checkRect('fire.bounds', fire.bounds);
    if (flood) checkRect('flood.bounds', flood.bounds);
    if (ground) checkRect('ground.bounds', ground.bounds);
    this.#sources = { fire, flood, ground };
    return this;
  }

  /**
   * Tints the instances rooted in a world rectangle toward `color` by `amount` (0 to 1; 0 removes the tint): dust,
   * drought, a burnt-orange stain. Cells keep their latest paint.
   */
  paint(rect: Rect, color: Color, amount = 1): this {
    this.#live();
    const [x0, z0, x1, z1] = checkRect('paint rectangle', rect),
      c = checkColor('paint', color);
    checkNumber('amount', amount, [0, 1], 'PlantStates paint');
    const [nx, nz] = this.resolution,
      [bx, bz, bX, bZ] = this.bounds;
    for (let j = 0; j < nz; j++) {
      const z = bz + ((j + 0.5) / nz) * (bZ - bz);
      if (z < z0 || z > z1) continue;
      for (let i = 0; i < nx; i++) {
        const x = bx + ((i + 0.5) / nx) * (bX - bx);
        if (x >= x0 && x <= x1) this.#colors.set([c[0], c[1], c[2], amount], (j * nx + i) * 4);
      }
    }
    this.#colorsDirty = true;
    return this;
  }
  /**
   * Marks the cells whose centres lie in a world rectangle with what a past fire or flood left there (burn scars, flood
   * lines), as {@link PlantMarks}; a value left out keeps that cell's mark. The map takes each mark as it takes a source:
   * it raises the cell's fire and water and never lowers them (`reset` forgets them).
   */
  mark(rect: Rect, marks: PlantMarks): this {
    this.#live();
    const [x0, z0, x1, z1] = checkRect('mark rectangle', rect),
      v = checkMarks(marks),
      [nx, nz] = this.resolution,
      [bx, bz, bX, bZ] = this.bounds;
    for (let j = 0; j < nz; j++) {
      const z = bz + ((j + 0.5) / nz) * (bZ - bz);
      if (z < z0 || z > z1) continue;
      for (let i = 0; i < nx; i++) {
        const x = bx + ((i + 0.5) / nx) * (bX - bx);
        if (x >= x0 && x <= x1) this.#markCell(j * nx + i, v);
      }
    }
    return this;
  }
  /**
   * Marks every cell from a function of its centre (`(x, z) => PlantMarks | undefined`), as {@link mark}; undefined
   * leaves the cell as it is. One call for a whole history (`disturbanceStates` of `@margoengine/biomes/disturbance`).
   */
  markEach(at: (x: number, z: number) => PlantMarks | undefined): this {
    this.#live();
    if (typeof at !== 'function') throw typeError('PlantStates markEach needs a function (x, z) => marks', 'scatter');
    const [nx, nz] = this.resolution,
      [bx, bz, bX, bZ] = this.bounds;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const m = at(bx + ((i + 0.5) / nx) * (bX - bx), bz + ((j + 0.5) / nz) * (bZ - bz));
        if (m !== undefined) this.#markCell(j * nx + i, checkMarks(m));
      }
    return this;
  }
  #markCell(cell: number, v: Partial<Record<keyof PlantMarks, number>>): void {
    const n = this.resolution[0] * this.resolution[1],
      fire = (n + cell) * 4,
      water = (2 * n + cell) * 4,
      c = this.#colors;
    const put = (at: number, value: number | undefined) => {
      if (value !== undefined) c[at] = value;
    };
    put(fire, v.scorch);
    put(fire + 1, v.char);
    put(fire + 2, v.intensity);
    put(fire + 3, v.ash);
    put(water, v.water);
    put(water + 2, v.debris);
    put(water + 3, v.wetness);
    this.#colorsDirty = this.#marksDirty = this.#hasMarks = true;
  }
  /** Forgets every fire, water, mark and paint the map holds (the sources compose again from the next frame). */
  reset(): this {
    this.#live();
    this.#colors.fill(0);
    this.#colorsDirty = this.#clear = true;
    this.#marksDirty = this.#hasMarks = false;
    return this;
  }

  /** The response of one kind of plant, for `ScatterOptions.states`. Several scatters may share one. */
  plant(response: PlantResponse = {}): PlantStateSource {
    this.#live();
    const source = new PlantStateSource(this, response);
    this.#plants.add(source);
    return source;
  }

  /** The map (storage buffer of vec4f; see `composeShader`), made on first use on the engine's device. */
  get map(): GPUBuffer | undefined {
    return this.#map;
  }
  /** @internal The map on `device`, made (and every plant's group dropped) after a device change. */
  mapOn(device: GPUDevice): GPUBuffer {
    this.#live();
    if (this.#device !== device || !this.#map) {
      this.#release();
      this.#device = device;
      const [nx, nz] = this.resolution;
      this.#map = device.createBuffer({
        size: (HEAD + LAYERS * nx * nz) * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      const [x0, z0, x1, z1] = this.bounds;
      device.queue.writeBuffer(this.#map, 0, new Float32Array([x0, z0, nx / (x1 - x0), nz / (z1 - z0), nx, nz, 0, 0]));
      this.#colorsDirty = true;
    }
    return this.#map;
  }

  /** @internal Composes the map once per command encoder (every Scatter sharing it calls this in its frame). */
  compose(c: { device: GPUDevice; encoder: GPUCommandEncoder }): void {
    if (this.#disposed || this.#encoder === c.encoder) return;
    this.#encoder = c.encoder;
    const d = c.device,
      map = this.mapOn(d),
      [nx, nz] = this.resolution,
      n = nx * nz;
    if (this.#clear) {
      c.encoder.clearBuffer(map, HEAD * 16, 3 * n * 16);
      this.#clear = false;
      this.#marksDirty = this.#hasMarks;
    }
    if (this.#colorsDirty) {
      d.queue.writeBuffer(map, (HEAD + 3 * n) * 16, this.#colors as Float32Array<ArrayBuffer>);
      this.#colorsDirty = false;
    }
    // The compose pass raises the cells to the marks once (and again after a clear); the map keeps them as it keeps a
    // passed fire.
    const marks = this.#marksDirty ? 16 : 0;
    this.#marksDirty = false;
    const s = this.#sources,
      fire = s.fire?.texture(),
      wet = s.flood?.wet(),
      flow = wet ? s.flood?.velocity?.() : undefined,
      covers = s.ground?.covers(),
      flags = (fire ? 1 : 0) | (wet ? 2 : 0) | (flow ? 4 : 0) | (covers ? 8 : 0) | marks,
      f = new Float32Array(this.#words),
      w = new Uint32Array(this.#words),
      v = this.#numbers;
    for (const p of this.#plants) p.upload(d);
    if (!flags) return;
    f.set(this.bounds, 0);
    w.set([nx, nz, flags, 0], 4);
    f.set(s.fire?.bounds ?? [0, 0, 1, 1], 8);
    f.set([v.ambient, v.wind, 0, 0], 12);
    f.set(s.flood?.bounds ?? [0, 0, 1, 1], 16);
    f.set([v.manning, v.dryTime, 0, 0], 20);
    f.set(s.ground?.bounds ?? [0, 0, 1, 1], 24);
    f.set([v.groundScorch, v.groundChar, v.groundMud, 0], 28);
    this.#uniform ??= d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.#uniform, 0, this.#words);
    this.#kernel ??= compute(d, composeShader);
    this.#blank ??= d.createTexture({
      size: [1, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const textures = [fire, wet, flow, covers].map((t) => t ?? this.#blank!),
      key = textures.map(idOf).join('|');
    let bind = this.#groups.get(key);
    if (!bind) {
      if (this.#groups.size > 16) this.#groups.clear();
      bind = group(d, this.#kernel, [
        { buffer: this.#uniform },
        { buffer: map },
        ...textures.map((t) => t.createView()),
      ]);
      this.#groups.set(key, bind);
    }
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.#kernel);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(nx / 8), Math.ceil(nz / 8));
    pass.end();
  }

  /** @internal */
  forget(plant: PlantStateSource): void {
    this.#plants.delete(plant);
  }
  get disposed(): boolean {
    return this.#disposed;
  }
  #live(): void {
    if (this.#disposed) throw typeError('PlantStates was disposed; create another', 'scatter');
  }
  #release(): void {
    for (const b of [this.#map, this.#uniform]) b?.destroy();
    this.#blank?.destroy();
    this.#map = this.#uniform = this.#blank = undefined;
    this.#kernel = undefined;
    this.#groups.clear();
    this.#encoder = undefined;
    this.#clear = true;
    for (const p of this.#plants) p.drop();
  }
  /** Frees the map. Dispose the scatters that read it first. */
  dispose(): void {
    if (this.#disposed) return;
    this.#release();
    this.#disposed = true;
    this.#plants.clear();
    void this.#engine;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(o: object): number {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return id;
}

/** One kind of plant's response to a {@link PlantStates} map: pass it as `ScatterOptions.states`. */
export class PlantStateSource implements ScatterStateSource, Disposable {
  readonly states: PlantStates;
  #response: Required<PlantResponse>;
  #uniform?: GPUBuffer;
  #device?: GPUDevice;
  #dirty = true;
  constructor(states: PlantStates, response: PlantResponse) {
    this.states = states;
    this.#response = { ...RESPONSE };
    this.set(response);
  }
  /** Changes the response; read from the next frame. */
  set(response: PlantResponse): this {
    if (!response || typeof response !== 'object') throw typeError('A plant response must be an object', 'scatter');
    const next = { ...this.#response } as Record<string, unknown>;
    for (const [key, value] of Object.entries(response)) {
      if (value === undefined) continue;
      if ((COLORS as readonly string[]).includes(key)) next[key] = checkColor(key, value);
      else if (key in RESPONSE_RANGE) next[key] = checkNumber(key, value, RESPONSE_RANGE[key], 'Plant response');
      else throw typeError(`Unknown plant response ${key}`, 'scatter');
    }
    this.#response = next as Required<PlantResponse>;
    this.#dirty = true;
    return this;
  }
  get response(): Readonly<Required<PlantResponse>> {
    return { ...this.#response };
  }
  poseCode(code: string, group: number, binding: number): string {
    return plantStatePoseCode(code, group, binding);
  }
  entries(device: GPUDevice): { buffer: GPUBuffer }[] {
    const map = this.states.mapOn(device);
    if (this.#device !== device || !this.#uniform) {
      this.#uniform?.destroy();
      this.#device = device;
      this.#uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#dirty = true;
      this.upload(device);
    }
    return [{ buffer: map }, { buffer: this.#uniform }];
  }
  update(c: { device: GPUDevice; encoder: GPUCommandEncoder }): void {
    this.states.compose(c);
    this.upload(c.device);
  }
  /** @internal Writes the response uniform when it changed. */
  upload(device: GPUDevice): void {
    if (!this.#dirty || !this.#uniform || this.#device !== device) return;
    const r = this.#response;
    device.queue.writeBuffer(
      this.#uniform,
      0,
      new Float32Array([
        ...r.scorch,
        r.crownBase,
        ...r.char,
        r.foliarMoisture,
        ...r.ash,
        r.trunkRadius,
        ...r.mud,
        r.stiffness,
        ...r.debris,
        r.flatten,
        r.bareShrink,
        r.wetDarkening,
        r.stainBand,
        r.edge,
      ]),
    );
    this.#dirty = false;
  }
  /** @internal The device's buffers are gone. */
  drop(): void {
    this.#uniform?.destroy();
    this.#uniform = this.#device = undefined;
  }
  /** Frees this response's uniform; the map stays. */
  dispose(): void {
    this.drop();
    this.states.forget(this);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** The panel a plant state setting sits in. */
export type PlantStateSettingGroup = 'fire' | 'flood' | 'ground' | 'plant' | 'colors';
/** One plant state control: the shared slider row shape with the plant state groups. */
export interface PlantStateSetting extends SettingRow {
  readonly group: PlantStateSettingGroup;
  readonly default: number | Color;
}
const num = (
  name: string,
  group: PlantStateSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
) => numberSetting(name, group, value, min, max, step, unit, about) as PlantStateSetting;
/**
 * The plant state controls on the shared slider row shape, all live (read from the next frame). The `fire`, `flood` and
 * `ground` rows set a {@link PlantStates} map; the `plant` and `colors` rows a {@link PlantStateSource}.
 */
export const PLANT_STATE_SETTINGS: readonly PlantStateSetting[] = [
  num(
    'fire.ambient',
    'fire',
    25,
    -40,
    59,
    1,
    'deg C',
    'Air temperature at the fire: hotter air leaves less heat needed to kill foliage, so it scorches higher (Van Wagner 1973).',
  ),
  num(
    'fire.wind',
    'fire',
    2,
    0,
    40,
    0.1,
    'm/s',
    'Midflame wind: it bends and cools the plume, so the scorch is lower.',
  ),
  num(
    'flood.manning',
    'flood',
    0.035,
    0.01,
    0.2,
    0.001,
    '',
    "Manning's n of the flooded ground: rougher ground puts more shear on the plants at one speed.",
  ),
  num(
    'flood.dryTime',
    'flood',
    3600,
    1,
    864000,
    1,
    's',
    'Seconds for flood wetness to fall to 1/e once the water has gone.',
  ),
  num('ground.scorch', 'ground', 4, 0, 100, 0.1, 'm', 'Scorch height of a fully charred GroundChange burn cell.'),
  num('ground.char', 'ground', 1, 0, 100, 0.05, 'm', 'Char height of a fully charred GroundChange burn cell.'),
  num('ground.mud', 'ground', 0.4, 0, 100, 0.01, 'm', 'High-water mark of a full GroundChange mud cell.'),
  num(
    'plant.crownBase',
    'plant',
    0,
    0,
    100,
    0.1,
    'm',
    'Crown base height: a crown fire needs (0.010 CBH (460 + 25.9 FMC))^1.5 kW/m (Van Wagner 1977). 0 burns the whole plant.',
  ),
  num(
    'plant.foliarMoisture',
    'plant',
    100,
    50,
    300,
    1,
    '%',
    'Foliar moisture: wetter needles need a hotter fire to crown.',
  ),
  num(
    'plant.trunkRadius',
    'plant',
    0.1,
    0,
    1000,
    0.01,
    'mesh units',
    'Vertices this near the axis are stem (charred, never stripped); the rest is crown.',
  ),
  num(
    'plant.stiffness',
    'plant',
    0.05,
    0.0001,
    1e7,
    0.0001,
    'N m^2',
    'Flexural rigidity MEI: the flow flattens the plant past the critical shear velocity of Kouwen and Li 1980.',
  ),
  num('plant.flatten', 'plant', 1.4, 0, Math.PI / 2, 0.01, 'rad', 'Turn of a fully flattened plant about its root.'),
  num(
    'plant.bareShrink',
    'plant',
    0.85,
    0,
    1,
    0.01,
    '',
    'Share of its reach a fully consumed crown loses toward the stem (bare branches).',
  ),
  num(
    'plant.wetDarkening',
    'plant',
    0.55,
    0,
    1,
    0.01,
    '',
    'Albedo of fully wet parts below the water mark (1 is no darkening).',
  ),
  num('plant.stainBand', 'plant', 0.06, 0, 10, 0.01, 'm', 'Height of the darker stain line above the water mark.'),
  num('plant.edge', 'plant', 0.12, 0.001, 10, 0.01, 'm', 'Soft edge of the scorch and char lines.'),
  ...COLORS.map(
    (name) =>
      colorSetting(
        `colors.${name}`,
        'colors',
        RESPONSE[name],
        0,
        1,
        {
          scorch: 'Heat-killed foliage (red-brown dead needles and leaves).',
          char: 'Charred bark and stripped crowns (albedo about 0.02 to 0.04).',
          ash: 'Ash settled on upward faces.',
          mud: 'Flood mud below the water mark.',
          debris: 'Debris caught on upstream faces.',
        }[name],
      ) as PlantStateSetting,
  ),
];
const BY_NAME = settingIndex(PLANT_STATE_SETTINGS) as Map<string, PlantStateSetting>;
const MAP_KEYS: Record<string, keyof MapNumbers> = {
  'fire.ambient': 'ambient',
  'fire.wind': 'wind',
  'flood.manning': 'manning',
  'flood.dryTime': 'dryTime',
  'ground.scorch': 'groundScorch',
  'ground.char': 'groundChar',
  'ground.mud': 'groundMud',
};
/** Named looks, each only values of {@link PLANT_STATE_SETTINGS}. */
export const PLANT_STATE_LOOKS = {
  /** Today's defaults. */
  natural: {},
  /** Old-growth conifers: high crown base, wet needles, stiff trunks (a surface fire scorches, it seldom crowns). */
  conifer: {
    'plant.crownBase': 6,
    'plant.foliarMoisture': 110,
    'plant.trunkRadius': 0.15,
    'plant.stiffness': 2e5,
    'plant.flatten': 1.2,
  },
  /** Chaparral and sage scrub: crown to the ground, dry foliage, bendable stems. */
  chaparral: { 'plant.crownBase': 0, 'plant.foliarMoisture': 70, 'plant.trunkRadius': 0.04, 'plant.stiffness': 5 },
  /** Grass and reeds: whole plant burns, lies flat in a modest flow. */
  grass: { 'plant.crownBase': 0, 'plant.trunkRadius': 0, 'plant.stiffness': 0.02, 'plant.flatten': 1.5 },
  /** A hot dry afternoon in a gale. */
  hotGale: { 'fire.ambient': 38, 'fire.wind': 12 },
} as const;
/**
 * Writes `values` (a name left out takes its default): the `fire`, `flood` and `ground` rows onto `states`, the
 * `plant` and `colors` rows onto `plant` when given.
 * @throws TypeError for a name not in {@link PLANT_STATE_SETTINGS}; RangeError for a value outside its row's range.
 */
export function applyPlantStateSettings(
  states: PlantStates | undefined,
  plant: PlantStateSource | undefined,
  values: Readonly<Record<string, number | Color>> = {},
): void {
  checkSettings(BY_NAME, values, 'scatter', 'PLANT_STATE_SETTINGS in @margoengine/scatter/states');
  const v = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default);
  if (states) {
    const numbers: Partial<MapNumbers> = {};
    for (const [name, key] of Object.entries(MAP_KEYS)) numbers[key] = v(name) as number;
    states.set(numbers);
  }
  if (plant) {
    const r: Record<string, number | Color> = {};
    for (const row of PLANT_STATE_SETTINGS)
      if (row.group === 'plant' || row.group === 'colors')
        r[row.name.slice(row.name.indexOf('.') + 1)] = v(row.name) as number | Color;
    plant.set(r as PlantResponse);
  }
}
