/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { MaskData, maskShader } from './masks.js';
import { checkCamera, checkLayer, checkLight } from './validation.js';
import type { SDFScene2D } from './sdf.js';
import { sdfShader, paintedBounceShader } from './sdf-shader.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { type Light2D, type Occluder2D, type Point2D, occluderEdges, lightAt } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number; COMPUTE: number };

let giPluginCount = 0;

/** Shape of an emissive sprite. */
export type EmissiveShape2D = 'rect' | 'circle';

/** A 2D sprite or area that emits light into its surroundings. */
export interface EmissiveSprite2D {
  /** Center X position in world units. */
  readonly x: number;
  /** Center Y position in world units. */
  readonly y: number;
  /** Width of rectangular emitter in world units (default 10). */
  readonly width?: number;
  /** Height of rectangular emitter in world units (default 10). */
  readonly height?: number;
  /** Radius of circular emitter in world units. */
  readonly radius?: number;
  /** Geometry shape of the emitter ('rect' or 'circle', default 'rect'). */
  readonly shape?: EmissiveShape2D;
  /** Emissive color as a hex number (0xffffff), CSS hex string ('#ffffff'), or [r, g, b] (default 0xffffff). */
  readonly color?: number | string | readonly [number, number, number];
  /** Emissive intensity multiplier (>= 0, default 1.0). */
  readonly intensity?: number;
}

/** Options configuring 2D radiance cascade global illumination. */
export interface RadianceCascadeOptions2D {
  /** Number of cascade interval levels (1..8, default 4). */
  readonly cascades?: number;
  /** Base ray direction count at cascade 0 (1..32, default 4). */
  readonly baseRays?: number;
  /** Base interval distance in world units at cascade 0 (> 0, default 16). */
  readonly baseDistance?: number;
  /** Interval distance multiplier per cascade level (> 1, default 4). */
  readonly intervalRatio?: number;
  /** Angular direction branching ratio per cascade level (1..8, default 4). */
  readonly angularRatio?: number;
  /** Diffuse bounce reflection count (0..4, default 1). 0 disables indirect bounce. */
  readonly bounces?: number;
  /** Default diffuse surface albedo for bounce reflections (0..1, default 0.5). */
  readonly albedo?: number;
  /** Overall GI indirect intensity scale (>= 0, default 1.0). */
  readonly intensity?: number;
}

/** A 2D scene containing emitters, direct lights, and occluders. */
export interface GIScene2D {
  /** Emissive sprites lighting surroundings. */
  readonly emitters?: readonly EmissiveSprite2D[];
  /** Direct 2D lights. */
  readonly lights?: readonly Light2D[];
  /** Occluder obstacles blocking rays and reflecting bounce light. */
  readonly occluders?: readonly Occluder2D[];
  /** Direct-light layer mask. Default all bits. */
  readonly layer?: number;
}

type RGB = [number, number, number];
type Interval = [number, number, number, number]; // radiance RGB, transmittance
interface Patch {
  a: Point2D;
  b: Point2D;
  n: Point2D;
}
interface Emitter {
  p: Point2D;
  size: Point2D;
  color: RGB;
  circle: boolean;
}
interface Scene {
  patches: Patch[];
  emitters: Emitter[];
  lights: readonly Light2D[];
  layer: number;
}
const TAU = 2 * Math.PI;
const direction = (i: number, count: number): Point2D => [
  Math.cos((TAU * (i + 0.5)) / count),
  Math.sin((TAU * (i + 0.5)) / count),
];
const add = (p: Point2D, d: Point2D, t: number): Point2D => [p[0] + d[0] * t, p[1] + d[1] * t];
const color = (c: EmissiveSprite2D['color'] = 0xffffff): RGB => {
  if (Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0)) return [...c] as RGB;
  const rgb = hexColor(typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : (c as string));
  if (!rgb) throw rangeError('Invalid GI color', 'pixel-lighting');
  return [rgb[0], rgb[1], rgb[2]];
};
function parse(scene: GIScene2D, distance: number): Scene {
  const patches: Patch[] = [],
    raw = occluderEdges(scene.occluders ?? []);
  for (let i = 0; i < raw.length; i += 4) {
    const dx = raw[i + 2] - raw[i],
      dy = raw[i + 3] - raw[i + 1],
      length = Math.hypot(dx, dy);
    const count = Math.ceil(length / distance);
    if (patches.length + count > 65536) throw rangeError('GI surface patch limit (65536)', 'pixel-lighting');
    for (let k = 0; k < count; k++)
      patches.push({
        a: [raw[i] + (dx * k) / count, raw[i + 1] + (dy * k) / count],
        b: [raw[i] + (dx * (k + 1)) / count, raw[i + 1] + (dy * (k + 1)) / count],
        n: [-dy / length, dx / length],
      });
  }
  const emitters = (scene.emitters ?? []).map((em) => {
    const circle = em.shape === 'circle' || (em.shape === undefined && em.radius !== undefined);
    const size: Point2D = circle
      ? [em.radius ?? em.width ?? 10, em.radius ?? em.width ?? 10]
      : [em.width ?? 10, em.height ?? 10];
    const intensity = em.intensity ?? 1;
    if (
      ![em.x, em.y, ...size, intensity].every(Number.isFinite) ||
      size.some((v) => v <= 0) ||
      intensity < 0 ||
      (em.shape !== undefined && em.shape !== 'circle' && em.shape !== 'rect')
    )
      throw rangeError('Invalid GI emitter', 'pixel-lighting');
    return { p: [em.x, em.y] as Point2D, size, color: color(em.color).map((v) => v * intensity) as RGB, circle };
  });
  const layer = scene.layer ?? 0xffffffff,
    lights = scene.lights ?? [];
  checkLayer(layer);
  for (const light of lights) checkLight(light);
  return { patches, emitters, lights, layer };
}
// Opaque analytic intersections. An emitter owns its nearest hit, including when the ray starts inside it.
/**
 * Endpoint tolerance, as a fraction of the patch, for a ray meeting a surface patch. A ray through a
 * patch endpoint counts as a hit within this margin, so the CPU (f64) and the GPU (f32, where Metal may
 * land either side of an exact endpoint) agree on rays that pass exactly through a wall's end.
 */
const PATCH_END = 1e-4;
function trace(p: Point2D, d: Point2D, length: number, scene: Scene, surfaces: Float32Array): Interval {
  let nearest = length,
    side = -1,
    rgb: RGB = [0, 0, 0],
    hit = false;
  for (let i = 0; i < scene.patches.length; i++) {
    const e = scene.patches[i],
      vx = e.b[0] - e.a[0],
      vy = e.b[1] - e.a[1],
      den = d[0] * vy - d[1] * vx;
    if (Math.abs(den) < 1e-7) continue;
    const dx = e.a[0] - p[0],
      dy = e.a[1] - p[1],
      t = (dx * vy - dy * vx) / den,
      u = (dx * d[1] - dy * d[0]) / den;
    if (t > 1e-4 && t <= nearest && u >= -PATCH_END && u <= 1 + PATCH_END) {
      nearest = t;
      hit = true;
      side = i * 2 + (d[0] * e.n[0] + d[1] * e.n[1] > 0 ? 1 : 0);
    }
  }
  if (side >= 0) rgb = [surfaces[side * 4], surfaces[side * 4 + 1], surfaces[side * 4 + 2]];
  for (const e of scene.emitters) {
    const w: Point2D = [p[0] - e.p[0], p[1] - e.p[1]];
    let near = 0,
      far = length;
    if (e.circle) {
      const b = w[0] * d[0] + w[1] * d[1],
        disc = b * b - w[0] ** 2 - w[1] ** 2 + e.size[0] ** 2;
      if (disc < 0) continue;
      near = Math.max(0, -b - Math.sqrt(disc));
      far = Math.min(far, -b + Math.sqrt(disc));
    } else
      for (let j = 0; j < 2; j++) {
        if (Math.abs(d[j]) < 1e-7) {
          if (Math.abs(w[j]) > e.size[j] / 2) far = -1;
        } else {
          const a = (-e.size[j] / 2 - w[j]) / d[j],
            b = (e.size[j] / 2 - w[j]) / d[j];
          near = Math.max(near, Math.min(a, b));
          far = Math.min(far, Math.max(a, b));
        }
      }
    if (near <= far && near <= nearest) {
      nearest = near;
      hit = true;
      rgb = e.color;
    }
  }
  return [...rgb, hit ? 0 : 1];
}
// Finite-order two-sided diffuse radiosity, midpoint patches and 32 uniform angular samples.
// Every gather sees only the preceding order. No history from another frame is used.
function reflect(scene: Scene, rc: RadianceCascade2D): Float32Array {
  let values = new Float32Array(scene.patches.length * 8);
  const reach = rc.baseDistance * rc.intervalRatio ** (rc.cascades - 1);
  for (let bounce = 0; bounce < rc.bounces; bounce++) {
    const next = new Float32Array(values.length);
    scene.patches.forEach((patch, index) => {
      for (let side = 0; side < 2; side++) {
        const n: Point2D = [patch.n[0] * (side ? -1 : 1), patch.n[1] * (side ? -1 : 1)];
        const p = add([(patch.a[0] + patch.b[0]) / 2, (patch.a[1] + patch.b[1]) / 2], n, 0.001);
        const rgb: RGB = [0, 0, 0];
        let cosineSum = 0;
        for (let k = 0; k < 32; k++) {
          const d = direction(k, 32);
          cosineSum += Math.max(0, n[0] * d[0] + n[1] * d[1]);
        }
        for (let k = 0; k < 32; k++) {
          const d = direction(k, 32),
            weight = Math.max(0, n[0] * d[0] + n[1] * d[1]) / cosineSum;
          const ray = trace(p, d, reach, scene, values);
          for (let c = 0; c < 3; c++) rgb[c] += ray[c] * weight;
        }
        for (const light of scene.lights) {
          const d: Point2D =
            light.kind === 'directional'
              ? [-Math.cos(light.angle), -Math.sin(light.angle)]
              : [light.x - p[0], light.y - p[1]];
          const distance = Math.hypot(...d),
            unit: Point2D = distance ? [d[0] / distance, d[1] / distance] : [0, 0];
          if (
            light.shadows &&
            trace(p, unit, light.kind === 'directional' ? 1e10 : Math.max(0, distance - 0.001), scene, values)[3] === 0
          )
            continue;
          const direct = lightAt(light, p[0], p[1], [...n, 0], scene.layer);
          for (let c = 0; c < 3; c++) rgb[c] += direct[c] / 2;
        }
        next.set(
          rgb.map((v) => v * rc.albedo),
          (index * 2 + side) * 4,
        );
      }
    });
    values = next;
  }
  return values;
}
// Appendix A of Osborne/Sannikov: trace a distinct connector to each child interval start,
// compose L_near + T_near L_far BEFORE bilinear interpolation. Never share a parent visibility ray.
function field(scene: Scene, rc: RadianceCascade2D, surfaces: Float32Array) {
  const cache = new Map<string, Interval>();
  let work = 0;
  function sample(p: Point2D, level: number, angle: number): Interval {
    if (++work > 8_000_000) throw rangeError('GI CPU sample limit (8000000)', 'pixel-lighting');
    const count = rc.baseRays * rc.angularRatio ** level,
      d = direction(angle, count);
    const near = level ? rc.baseDistance * rc.intervalRatio ** (level - 1) : 0;
    const far = rc.baseDistance * rc.intervalRatio ** level,
      start = add(p, d, near);
    if (level === rc.cascades - 1) return trace(start, d, far - near, scene, surfaces);
    const scale = 2 ** (level + 1),
      gx = (p[0] - 0.5) / scale,
      gy = (p[1] - 0.5) / scale;
    const x = Math.floor(gx),
      y = Math.floor(gy),
      fx = gx - x,
      fy = gy - y;
    const sum: Interval = [0, 0, 0, 0];
    for (let child = 0; child < rc.angularRatio; child++) {
      const a = angle * rc.angularRatio + child,
        cd = direction(a, count * rc.angularRatio);
      const rays: Interval[] = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
      for (let j = 0; j < 4; j++) {
        const ix = x + (j & 1),
          iy = y + (j >> 1),
          weight = ((j & 1 ? fx : 1 - fx) * (j >> 1 ? fy : 1 - fy)) / rc.angularRatio;
        if (!weight) continue;
        const q: Point2D = [ix * scale + 0.5, iy * scale + 0.5],
          end = add(q, cd, far);
        const dx = end[0] - start[0],
          dy = end[1] - start[1],
          length = Math.hypot(dx, dy);
        const ray = trace(start, length ? [dx / length, dy / length] : cd, length, scene, surfaces);
        if (ray[3]) {
          const key = `${level + 1},${ix},${iy},${a}`;
          let upper = cache.get(key);
          if (!upper) {
            upper = sample(q, level + 1, a);
            cache.set(key, upper);
          }
          for (let c = 0; c < 3; c++) ray[c] += ray[3] * upper[c];
          ray[3] *= upper[3];
        }
        rays[j] = ray;
      }
      for (let c = 0; c < 4; c++) {
        const lo = rays[0][c] + (rays[1][c] - rays[0][c]) * fx;
        const hi = rays[2][c] + (rays[3][c] - rays[2][c]) * fx;
        const value = lo + (hi - lo) * fy;
        sum[c] += (value - sum[c]) / (child + 1);
      }
    }
    return sum;
  }
  return (p: Point2D, normal?: Point2D): RGB => {
    if (!p.every(Number.isFinite) || (normal && !normal.every(Number.isFinite)))
      throw rangeError('Invalid GI query', 'pixel-lighting');
    const rgb: RGB = [0, 0, 0],
      length = normal ? Math.hypot(...normal) : 0;
    for (let i = 0; i < rc.baseRays; i++) {
      const ray = sample(p, 0, i),
        d = direction(i, rc.baseRays);
      const weight =
        ((length ? (Math.PI * Math.max(0, d[0] * normal![0] + d[1] * normal![1])) / length : 1) * rc.intensity) /
        rc.baseRays;
      for (let c = 0; c < 3; c++) rgb[c] += ray[c] * weight;
    }
    return rgb;
  };
}
/** CPU spatial radiance-interval hierarchy with finite-order diffuse surface reflection. */
export class RadianceCascade2D {
  declare readonly cascades: number;
  declare readonly baseRays: number;
  declare readonly baseDistance: number;
  declare readonly intervalRatio: number;
  declare readonly angularRatio: number;
  declare readonly bounces: number;
  declare readonly albedo: number;
  declare readonly intensity: number;

  constructor(options: RadianceCascadeOptions2D = {}) {
    const {
      cascades = 4,
      baseRays = 4,
      baseDistance = 16,
      intervalRatio = 4,
      angularRatio = 4,
      bounces = 1,
      albedo = 0.5,
      intensity = 1.0,
    } = options;

    if (!Number.isInteger(cascades) || cascades < 1 || cascades > 8) {
      throw rangeError('cascades must be an integer from 1 to 8', 'pixel-lighting');
    }
    if (!Number.isInteger(baseRays) || baseRays < 1 || baseRays > 32) {
      throw rangeError('baseRays must be an integer from 1 to 32', 'pixel-lighting');
    }
    if (!Number.isFinite(baseDistance) || baseDistance <= 0) {
      throw rangeError('baseDistance must be a positive number', 'pixel-lighting');
    }
    if (!Number.isFinite(intervalRatio) || intervalRatio <= 1) {
      throw rangeError('intervalRatio must be greater than 1', 'pixel-lighting');
    }
    if (!Number.isInteger(angularRatio) || angularRatio < 1 || angularRatio > 8) {
      throw rangeError('angularRatio must be an integer from 1 to 8', 'pixel-lighting');
    }
    if (!Number.isInteger(bounces) || bounces < 0 || bounces > 4) {
      throw rangeError('bounces must be an integer from 0 to 4', 'pixel-lighting');
    }
    if (!Number.isFinite(albedo) || albedo < 0 || albedo > 1) {
      throw rangeError('albedo must be from 0 to 1', 'pixel-lighting');
    }
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw rangeError('intensity must be a nonnegative number', 'pixel-lighting');
    }

    if (!Number.isFinite(Math.fround(baseDistance * intervalRatio ** (cascades - 1))))
      throw rangeError('Cascade reach overflows', 'pixel-lighting');
    this.cascades = cascades;
    this.baseRays = baseRays;
    this.baseDistance = baseDistance;
    this.intervalRatio = intervalRatio;
    this.angularRatio = angularRatio;
    this.bounces = bounces;
    this.albedo = albedo;
    this.intensity = intensity;
  }

  /** Evaluate the hierarchy at a world point. Upper probes use a fixed world lattice centred at .5. */
  evaluateAt(point: Point2D, normal?: Point2D, scene: GIScene2D = {}): RGB {
    const parsed = parse(scene, this.baseDistance);
    return field(parsed, this, reflect(parsed, this))(point, normal);
  }

  /** Compute world-space queries starting at zero, separated by spacing (default 1). */
  computeGrid(width: number, height: number, scene: GIScene2D = {}, spacing = 1): Float32Array {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw rangeError('Grid dimensions must be positive integers', 'pixel-lighting');
    }
    if (!Number.isFinite(spacing) || spacing <= 0) throw rangeError('Invalid GI spacing', 'pixel-lighting');
    const parsed = parse(scene, this.baseDistance),
      evaluate = field(parsed, this, reflect(parsed, this));
    const grid = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) grid.set(evaluate([x * spacing, y * spacing]), (y * width + x) * 3);
    return grid;
  }
}
/** Evaluate diffuse 2D GI using the same hierarchy as the WebGPU entry. */
export function evaluate2DGI(
  point: Point2D,
  normal?: Point2D,
  scene: GIScene2D = {},
  options?: RadianceCascadeOptions2D,
): RGB {
  return new RadianceCascade2D(options).evaluateAt(point, normal, scene);
}
/** Options for GILighting2D WebGPU engine plugin. */
export interface GILighting2DOptions {
  /** Reuse identical world-probe and surface intervals between frames. Default true; changes invalidate immediately. */
  readonly temporal?: boolean;
  /** Borrowed painted alpha/albedo/emission scene. Encoded every frame before the GI passes. */
  readonly painted?: SDFScene2D;
  /** Target texture receiving GI irradiance. */
  /** Direct-light layer mask. Default all bits. */
  readonly layer?: number;
  readonly target: GPUTexture | (() => GPUTexture);
  /** Render pass execution order (default 20). */
  readonly order?: number;
  /** Active camera with x, y, and zoom. */
  readonly camera?: { x: number; y: number; zoom: number };
  /** Radiance cascade options. */
  readonly cascades?: RadianceCascadeOptions2D;
  /** Emissive sprites in the scene. */
  readonly emitters?: readonly EmissiveSprite2D[];
  /** Direct lights in the scene. */
  readonly lights?: readonly Light2D[];
  /** Occluders casting shadows and reflecting bounce light. */
  readonly occluders?: readonly Occluder2D[];
  /** Ambient light color (default 0x000000). */
  readonly ambient?: number | string;
  /** Unique plugin name. */
  readonly name?: string;
}

const giShader = /* wgsl */ `
struct Params {
 camera:vec4f, ambient:vec4f, config:vec4f, material:vec4f, counts:vec4u,
 grid:vec4f, upper:vec4f, misc:vec4f,
}
struct Patch { a:vec2f,b:vec2f,n:vec2f,pad:vec2f }
struct Emitter { p:vec2f,size:vec2f,color:vec3f,circle:f32 }
struct Light { pos:vec4f,color:vec4f,geo:vec4f,flags:vec4u,bounds:vec4f,mask:vec4f }
@group(0)@binding(0)var<uniform>u:Params;
@group(0)@binding(1)var<storage,read>patches:array<Patch>;
@group(0)@binding(2)var<storage,read>emitters:array<Emitter>;
@group(0)@binding(3)var<storage,read>lights:array<Light>;
@group(1)@binding(0)var<storage,read>upper:array<vec4f>;
@group(1)@binding(1)var<storage,read>surfaces:array<vec4f>;
@group(2)@binding(0)var<storage,read_write>output:array<vec4f>;
fn rayCount(level:u32)->u32 {
 var count=u32(u.config.y);for(var i=0u;i<level;i++){count*=u32(u.config.w);}return count;
}
fn direction(i:u32,count:u32)->vec2f {
 let a=6.28318530718*(f32(i)+.5)/f32(count);return vec2f(cos(a),sin(a));
}
fn trace(p:vec2f,d:vec2f,length:f32)->vec4f {
 var nearest=length;var rgb=vec3f(0);var hit=false;
 for(var i=0u;i<u.counts.x;i++){
  let e=patches[i];let v=e.b-e.a;let den=d.x*v.y-d.y*v.x;
  if(abs(den)<1e-7){continue;}
  let w=e.a-p;let t=(w.x*v.y-w.y*v.x)/den;let s=(w.x*d.y-w.y*d.x)/den;
  if(t>1e-4&&t<=nearest&&s>=-1e-4&&s<=1.0001){nearest=t;hit=true;rgb=surfaces[i*2u+select(0u,1u,dot(d,e.n)>0)].rgb;}
 }
 for(var i=0u;i<u.counts.y;i++){
  let e=emitters[i];let w=p-e.p;var near=0.0;var far=length;
  if(e.circle>0){
   let b=dot(w,d);let disc=b*b-dot(w,w)+e.size.x*e.size.x;
   if(disc<0){continue;}
   near=max(0,-b-sqrt(disc));far=min(far,-b+sqrt(disc));
  }else{
   for(var j=0u;j<2u;j++){
    if(abs(d[j])<1e-7){if(abs(w[j])>e.size[j]*.5){far=-1;}}
    else{let a=(-e.size[j]*.5-w[j])/d[j];let b=(e.size[j]*.5-w[j])/d[j];near=max(near,min(a,b));far=min(far,max(a,b));}
   }
  }
  if(near<=far&&near<=nearest){nearest=near;hit=true;rgb=e.color;}
 }
 return vec4f(rgb,select(1.0,0.0,hit));
}
fn direct(p:vec2f,n:vec2f)->vec3f {
 var sum=vec3f(0);
 for(var i=0u;i<u.counts.z;i++){
  let l=lights[i];if((l.flags.y&u.counts.w)==0u||!maskVisible(p,l.bounds,l.mask)){continue;}
  var d=l.pos.xy-p;var distance=length(d);var shade=1.0;var cosine=1.0;
  if(l.flags.x==2u){
   d=-vec2f(cos(l.geo.y),sin(l.geo.y));distance=1e10;cosine=max(0,dot(n,d)*cos(l.geo.x));
  }else{
   shade=pow(max(0,1-distance/l.pos.z),l.pos.w);
   let len=sqrt(distance*distance+l.geo.x*l.geo.x);
   cosine=select(1.0,max(0,dot(n,d)/max(len,1e-20)),len>0);
   if(l.flags.x==1u){
    var along=1.0;if(distance>0){along=-dot(d,vec2f(cos(l.geo.y),sin(l.geo.y)))/distance;}
    let outer=cos(l.geo.z);let inner=cos(l.geo.z*(1-l.geo.w));
    if(inner>outer){shade*=clamp((along-outer)/(inner-outer),0,1);}else if(along<outer){shade=0;}
   }
   if(distance>0){d/=distance;}
  }
  if(l.flags.z>0u&&trace(p,d,max(0,distance-.001)).w==0){continue;}
  sum+=l.color.rgb*(l.color.w*shade*cosine*.5);
 }
 return sum;
}
@compute @workgroup_size(64)fn bounce(@builtin(global_invocation_id)id:vec3u){
 let i=id.x;if(i>=u.counts.x*2u){return;}
 let e=patches[i/2u];let n=e.n*select(1.0,-1.0,i%2u==1u);let p=(e.a+e.b)*.5+n*.001;
 var rgb=direct(p,n);var cosineSum=0.0;
 for(var k=0u;k<32u;k++){cosineSum+=max(0,dot(n,direction(k,32u)));}
 for(var k=0u;k<32u;k++){
  let d=direction(k,32u);rgb+=trace(p,d,u.misc.w).rgb*(max(0,dot(n,d))/cosineSum);
 }
 output[i]=vec4f(rgb*u.material.x,0);
}
// Each child has its own visible connector. Composition precedes interpolation (RASTI appendix A).
fn merge(p:vec2f,angle:u32)->vec4f{
 let level=u.misc.x;let count=rayCount(u32(level));let d=direction(angle,count);
 var near=0.0;if(level>0){near=u.config.z*pow(u.material.z,level-1);}
 let far=u.config.z*pow(u.material.z,level);let start=p+d*near;
 if(level==u.config.x-1){return trace(start,d,far-near);}
 let scale=f32(1u<<(u32(level)+1u));let g=(p-vec2f(.5))/scale;let cell=floor(g);let f=fract(g);
 let branch=u32(u.config.w);let upperCount=count*branch;var sum=vec4f(0);
 for(var child=0u;child<branch;child++){
  let a=angle*branch+child;let cd=direction(a,upperCount);var rays:array<vec4f,4>;
  for(var j=0u;j<4u;j++){
   let offset=vec2f(f32(j&1u),f32(j>>1u));let xy=cell+offset;let q=xy*scale+vec2f(.5);
   let delta=q+cd*far-start;let length=length(delta);
   var ray=trace(start,delta/max(length,1e-20),length);
   let index=vec2u(xy-u.upper.xy);let sample=upper[(index.y*u32(u.upper.z)+index.x)*upperCount+a];
   ray=vec4f(ray.rgb+ray.w*sample.rgb,ray.w*sample.w);
   rays[j]=ray;
  }
  let lo=rays[0]+(rays[1]-rays[0])*f.x;let hi=rays[2]+(rays[3]-rays[2])*f.x;
  let value=lo+(hi-lo)*f.y;sum+=(value-sum)/f32(child+1u);
 }
 return sum;
}
@compute @workgroup_size(64)fn cascade(@builtin(global_invocation_id)id:vec3u){
 let count=rayCount(u32(u.misc.x));let total=u32(u.grid.z*u.grid.w)*count;
 let i=id.x;if(i>=total){return;}
 let probe=i/count;let xy=vec2f(f32(probe%u32(u.grid.z)),f32(probe/u32(u.grid.z)))+u.grid.xy;
 output[i]=merge(xy*f32(1u<<u32(u.misc.x))+vec2f(.5),i%count);
}
@vertex fn wide(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
 let xy=vec2f(f32((i<<1u)&2u),f32(i&2u));return vec4f(xy*vec2f(2,-2)+vec2f(-1,1),0,1);
}
@fragment fn show(@builtin(position)p:vec4f)->@location(0)vec4f{
 let world=u.camera.xy+p.xy/u.camera.z;var rgb=vec3f(0);
 for(var i=0u;i<u32(u.config.y);i++){rgb+=merge(world,i).rgb;}
 return vec4f(u.ambient.rgb+rgb*(u.material.y/u.config.y),1);
}
`;
/** WebGPU spatial radiance intervals, with finite-order diffuse surface gathers. */
export class GILighting2D implements EnginePlugin, Disposable {
  /** Exact interval reuse when inputs match the preceding frame. Default true. */
  declare temporal: boolean;
  /** Borrowed painted scene; dispose it separately after all consumers. */
  declare painted?: SDFScene2D;
  declare name: string;
  declare order: number;
  declare readonly cascades: RadianceCascade2D;
  declare camera: { x: number; y: number; zoom: number };
  declare ambient: number | string;
  declare layer: number;
  declare emitters: EmissiveSprite2D[];
  declare lights: Light2D[];
  declare occluders: Occluder2D[];
  #engine?: Engine;
  #disposed = false;
  #device?: GPUDevice;
  #module?: GPUShaderModule;
  #sceneLayout?: GPUBindGroupLayout;
  #inputLayout?: GPUBindGroupLayout;
  #outputLayout?: GPUBindGroupLayout;
  #paintLayout?: GPUBindGroupLayout;
  #renderGap?: GPUBindGroup;
  #hasPaint = false;
  #snapshot?: string;
  #lastPaint?: SDFScene2D;
  #cascade?: GPUComputePipeline;
  #bounce?: GPUComputePipeline;
  #show?: GPURenderPipeline;
  #format?: GPUTextureFormat;
  #buffers = new Map<string, GPUBuffer>();
  #masks = new MaskData();
  #target: GPUTexture | (() => GPUTexture);
  constructor(options: GILighting2DOptions) {
    if (!options?.target) throw typeError('target is required for GILighting2D', 'pixel-lighting');
    this.#target = options.target;
    this.painted = options.painted;
    this.temporal = options.temporal ?? true;
    if (typeof this.temporal !== 'boolean') throw typeError('temporal must be true or false', 'pixel-lighting');
    this.name = options.name ?? `gi-lighting2d-${++giPluginCount}`;
    this.order = options.order ?? 20;
    this.cascades = new RadianceCascade2D(options.cascades);
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.ambient = options.ambient ?? 0;
    this.layer = options.layer ?? 0xffffffff;
    this.emitters = [...(options.emitters ?? [])];
    this.lights = [...(options.lights ?? [])];
    this.occluders = [...(options.occluders ?? [])];
  }
  static attach(instance: EngineKernel, options: GILighting2DOptions): GILighting2D {
    const pass = new GILighting2D(options);
    engineRuntime(instance).use(pass);
    return pass;
  }
  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'GILighting2D disposed; create a new one');
    if (engine.backend !== 'webgpu' || !engine.gpu) throw fault('unsupported', 'GILighting2D needs WebGPU', 'webgpu');
    this.#engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu' && !c.view?.index) this.#run(c);
      },
    });
  }
  #buffer(key: string, size: number, uniform = false): GPUBuffer {
    const device = this.#device!;
    size = Math.max(16, size);
    if (
      !Number.isSafeInteger(size) ||
      size > (uniform ? device.limits.maxBufferSize : device.limits.maxStorageBufferBindingSize)
    ) {
      throw rangeError('GI buffer exceeds device limit', 'pixel-lighting');
    }
    let buffer = this.#buffers.get(key);
    if (!buffer || buffer.size < size) {
      buffer?.destroy();
      buffer = device.createBuffer({
        label: `gi ${key}`,
        size,
        usage: (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_DST,
      });
      this.#buffers.set(key, buffer);
    }
    return buffer;
  }
  #prepare(device: GPUDevice, format: GPUTextureFormat): void {
    if (this.#device !== device || this.#hasPaint !== !!this.painted) {
      this.#release();
      this.#device = device;
      this.#hasPaint = !!this.painted;
    }
    const visibility = GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT;
    if (!this.#module) {
      let shader = this.painted ? giShader.replace('return vec4f(rgb,select(1.0,0.0,hit));', `
        let paintedHit=tracePaint(p,d,nearest);
        if(paintedHit.w>=0){rgb=paintedHit.rgb;hit=true;}
        return vec4f(rgb,select(1.0,0.0,hit));`)
        .replace('let i=id.x;if(i>=u.counts.x*2u){return;}',
          'let i=id.x;if(reuseIntervals()){return;}if(i>=u.counts.x*2u){bouncePaint(i-u.counts.x*2u);return;}')
        + sdfShader + paintedBounceShader : giShader.replace('let i=id.x;if(i>=u.counts.x*2u){return;}',
          'let i=id.x;if(reuseIntervals()||i>=u.counts.x*2u){return;}');
      shader = shader.replace('let count=rayCount(u32(u.misc.x));let total=',
        'if(reuseIntervals()){return;}let count=rayCount(u32(u.misc.x));let total=');
      shader += `\nfn reuseIntervals()->bool {return u.misc.y>0${this.painted ? '&&paintChanged[0]==0u' : ''};}\n`;
      this.#module = device.createShaderModule({ label: 'radiance cascades', code: maskShader(4) + shader });
      this.#sceneLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 128 } },
          ...[1, 2, 3, 4].map((binding) => ({ binding, visibility, buffer: { type: 'read-only-storage' as const } })),
        ],
      });
      this.#inputLayout = device.createBindGroupLayout({
        entries: [0, 1].map((binding) => ({ binding, visibility, buffer: { type: 'read-only-storage' as const } })),
      });
      this.#outputLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }],
      });
      if (this.painted) this.#paintLayout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility, buffer: { type: 'uniform' } },
        ...[1, 2, 3].map(binding => ({ binding, visibility, texture: { sampleType: 'unfilterable-float' as const } })),
        { binding: 4, visibility, buffer: { type: 'read-only-storage' } },
      ] });
      const layout = device.createPipelineLayout({
        bindGroupLayouts: [this.#sceneLayout, this.#inputLayout, this.#outputLayout, ...(this.#paintLayout ? [this.#paintLayout] : [])],
      });
      this.#cascade = device.createComputePipeline({
        layout,
        compute: { module: this.#module, entryPoint: 'cascade' },
      });
      this.#bounce = device.createComputePipeline({ layout, compute: { module: this.#module, entryPoint: 'bounce' } });
    }
    if (format !== this.#format) {
      this.#format = format;
      const gap = device.createBindGroupLayout({ entries: [] });
      this.#renderGap = device.createBindGroup({ layout: gap, entries: [] });
      this.#show = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: this.#paintLayout
          ? [this.#sceneLayout!, this.#inputLayout!, gap, this.#paintLayout]
          : [this.#sceneLayout!, this.#inputLayout!] }),
        vertex: { module: this.#module!, entryPoint: 'wide' },
        fragment: { module: this.#module!, entryPoint: 'show', targets: [{ format }] },
      });
    }
  }
  #run(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    const target = typeof this.#target === 'function' ? this.#target() : this.#target;
    checkCamera(this.camera);
    checkLayer(this.layer);
    if (typeof this.temporal !== 'boolean') throw typeError('temporal must be true or false', 'pixel-lighting');
    const rc = this.cascades,
      scene = parse(
        { emitters: this.emitters, lights: this.lights, occluders: this.occluders, layer: this.layer },
        rc.baseDistance,
      );
    const ambient = color(this.ambient),
      device = c.device;
    this.#prepare(device, target.format);
    this.painted?.encode(device, c.encoder);
    const paintGroup = this.painted?.bindGroup(device, this.#paintLayout!);
    const snapshot = JSON.stringify([this.camera, target.width, target.height, this.cascades,
      this.emitters, this.lights, this.occluders, this.layer]);
    const reuse = this.temporal && this.#snapshot === snapshot && this.#lastPaint === this.painted;
    this.#masks.upload(device, this.lights);
    const patchData = new Float32Array(Math.max(8, scene.patches.length * 8));
    scene.patches.forEach((p, i) => patchData.set([...p.a, ...p.b, ...p.n], i * 8));
    const emitterData = new Float32Array(Math.max(8, scene.emitters.length * 8));
    scene.emitters.forEach((e, i) => emitterData.set([...e.p, ...e.size, ...e.color, e.circle ? 1 : 0], i * 8));
    const lightData = new Float32Array(Math.max(24, this.lights.length * 24)),
      flags = new Uint32Array(lightData.buffer);
    this.lights.forEach((l, i) => {
      const base = i * 24;
      lightData.set(
        [
          l.x,
          l.y,
          l.radius,
          l.falloff,
          ...color(l.color),
          l.intensity,
          l.kind === 'directional' ? l.elevation : l.height,
          l.angle,
          l.cone,
          l.softness,
        ],
        base,
      );
      flags.set([l.kind === 'directional' ? 2 : l.kind === 'spot' ? 1 : 0, l.layers, l.shadows ? 1 : 0, 0], base + 12);
      lightData.set(this.#masks.fields[i], base + 16);
    });
    const data = [patchData, emitterData, lightData],
      buffers = data.map((a, i) => this.#buffer(`scene${i}`, a.byteLength));
    data.forEach((a, i) => device.queue.writeBuffer(buffers[i], 0, a));
    const surfaceCount = scene.patches.length * 2 + (this.painted
      ? this.painted.distanceTexture!.width * this.painted.distanceTexture!.height * 4 : 0);
    const surfaces = [
      this.#buffer('surface0', surfaceCount * 16),
      this.#buffer('surface1', surfaceCount * 16),
    ];
    const empty = this.#buffer('empty', 16);
    // Dedicated immutable zero-order input. Reused outputs must never be cleared before their validity is known.
    const zero = this.#buffer('zero', surfaceCount * 16);
    const stride = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
    const values = new Float32Array(((rc.bounces + rc.cascades) * stride) / 4);
    const uniforms = this.#buffer('uniforms', values.byteLength, true);
    const sceneGroup = device.createBindGroup({
      layout: this.#sceneLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniforms, size: 128 } },
        ...buffers.map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
        { binding: 4, resource: { buffer: this.#masks.buffer! } },
      ],
    });
    const input = (upper: GPUBuffer, surface: GPUBuffer) =>
      device.createBindGroup({
        layout: this.#inputLayout!,
        entries: [
          { binding: 0, resource: { buffer: upper } },
          { binding: 1, resource: { buffer: surface } },
        ],
      });
    // Expand every upper grid to include all four neighbours required by the grid beneath it.
    const grids: number[][] = [[0, 0, 0, 0]];
    let min = [this.camera.x + 0.5 / this.camera.zoom, this.camera.y + 0.5 / this.camera.zoom];
    let max = [
      this.camera.x + (target.width - 0.5) / this.camera.zoom,
      this.camera.y + (target.height - 0.5) / this.camera.zoom,
    ];
    for (let level = 1; level < rc.cascades; level++) {
      const scale = 2 ** level,
        lo = min.map((v) => Math.floor((v - 0.5) / scale)),
        hi = max.map((v) => Math.floor((v - 0.5) / scale) + 1);
      grids.push([lo[0], lo[1], hi[0] - lo[0] + 1, hi[1] - lo[1] + 1]);
      min = lo.map((v) => v * scale + 0.5);
      max = hi.map((v) => v * scale + 0.5);
    }
    let slot = 0;
    const config = (level: number): number => {
      const offset = slot++ * stride,
        f = new Float32Array(values.buffer, offset, 32),
        u = new Uint32Array(values.buffer, offset, 32);
      f.set([
        this.camera.x,
        this.camera.y,
        this.camera.zoom,
        0,
        ...ambient,
        0,
        rc.cascades,
        rc.baseRays,
        rc.baseDistance,
        rc.angularRatio,
        rc.albedo,
        rc.intensity,
        rc.intervalRatio,
        0,
      ]);
      u.set([scene.patches.length, scene.emitters.length, this.lights.length, this.layer], 16);
      f.set(grids[level], 20);
      f.set(grids[level + 1] ?? [0, 0, 1, 1], 24);
      f.set([level, reuse ? 1 : 0, 0, rc.baseDistance * rc.intervalRatio ** (rc.cascades - 1)], 28);
      return offset;
    };
    const dispatch = (
      pipeline: GPUComputePipeline,
      count: number,
      offset: number,
      sources: GPUBindGroup,
      output: GPUBuffer,
    ): void => {
      const groups = Math.ceil(count / 64);
      if (groups > device.limits.maxComputeWorkgroupsPerDimension)
        throw rangeError('GI dispatch exceeds device limit', 'pixel-lighting');
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, sceneGroup, [offset]);
      pass.setBindGroup(1, sources);
      if (paintGroup) pass.setBindGroup(3, paintGroup);
      pass.setBindGroup(
        2,
        device.createBindGroup({
          layout: this.#outputLayout!,
          entries: [{ binding: 0, resource: { buffer: output } }],
        }),
      );
      pass.dispatchWorkgroups(groups);
      pass.end();
    };
    let surface = zero;
    for (let bounce = 0; bounce < rc.bounces; bounce++) {
      const output = surfaces[(bounce + 1) % 2];
      dispatch(this.#bounce!, surfaceCount, config(0), input(empty, surface), output);
      surface = output;
    }
    let upper = empty;
    for (let level = rc.cascades - 1; level >= 1; level--) {
      const grid = grids[level],
        count = grid[2] * grid[3] * rc.baseRays * rc.angularRatio ** level;
      const output = this.#buffer(`cascade${level}`, count * 16);
      dispatch(this.#cascade!, count, config(level), input(upper, surface), output);
      upper = output;
    }
    const offset = config(0);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
    });
    pass.setPipeline(this.#show!);
    pass.setBindGroup(0, sceneGroup, [offset]);
    pass.setBindGroup(1, input(upper, surface));
    if (paintGroup) { pass.setBindGroup(2, this.#renderGap!); pass.setBindGroup(3, paintGroup); }
    pass.draw(3);
    pass.end();
    device.queue.writeBuffer(uniforms, 0, values);
    this.#snapshot = snapshot; this.#lastPaint = this.painted;
  }
  /** Force the next frame to rebuild all surface and probe intervals. */
  resetHistory(): void { this.#snapshot = undefined; }
  onDeviceRestored(): void {
    this.#release();
  }
  #release(): void {
    this.#snapshot = undefined; this.#lastPaint = undefined;
    for (const buffer of this.#buffers.values()) buffer.destroy();
    this.#buffers.clear();
    this.#masks.dispose();
    this.#device =
      this.#module =
      this.#sceneLayout =
      this.#inputLayout =
      this.#outputLayout =
      this.#paintLayout =
      this.#renderGap =
      this.#cascade =
      this.#bounce =
      this.#show =
      this.#format =
        undefined;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release();
    const owner = this.#engine?.sceneOf?.(this);
    if (owner) owner.removePlugin(this.name);
    else if (this.#engine && !this.#engine.sceneOf) this.#engine.removePlugin(this.name);
    this.#engine = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
