/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import {
  Light2D,
  type Light2DOptions,
  type Occluder2D,
  type Point2D,
  occluderEdges,
} from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

const PI = Math.PI;
const TWO_PI = Math.PI * 2;
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
}

/** Parsed internal edge with bounds, normal, and albedo. */
interface GIEdge {
  readonly a: Point2D;
  readonly b: Point2D;
  readonly normal: Point2D;
  readonly albedo: number;
}

/** Parsed internal emitter. */
interface GIEmitter {
  readonly x: number;
  readonly y: number;
  readonly size: [number, number];
  readonly shape: number; // 0 = rect, 1 = circle
  readonly color: [number, number, number];
  readonly intensity: number;
}

function parseColor(c?: number | string | readonly [number, number, number]): [number, number, number] {
  if (c == null) return [1, 1, 1];
  if (typeof c === 'number') {
    const r = ((c >> 16) & 0xff) / 255;
    const g = ((c >> 8) & 0xff) / 255;
    const b = (c & 0xff) / 255;
    return [r, g, b];
  }
  if (typeof c === 'string') {
    const rgb = hexColor(c);
    if (!rgb) throw rangeError('Invalid hex color', 'pixel-lighting');
    return [rgb[0], rgb[1], rgb[2]];
  }
  if (Array.isArray(c)) {
    if (c.length < 3 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || !Number.isFinite(c[2])) {
      throw rangeError('Invalid RGB color array', 'pixel-lighting');
    }
    return [Math.max(0, c[0]), Math.max(0, c[1]), Math.max(0, c[2])];
  }
  throw rangeError('Invalid color', 'pixel-lighting');
}

function parseScene(scene: GIScene2D, defaultAlbedo: number): { edges: GIEdge[]; emitters: GIEmitter[]; lights: Light2D[] } {
  const edges: GIEdge[] = [];
  if (scene.occluders) {
    const raw = occluderEdges(scene.occluders);
    for (let i = 0; i < raw.length; i += 4) {
      const a: Point2D = [raw[i], raw[i + 1]];
      const b: Point2D = [raw[i + 2], raw[i + 3]];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const len = Math.hypot(vx, vy);
      if (len > 1e-6) {
        edges.push({
          a,
          b,
          normal: [-vy / len, vx / len],
          albedo: defaultAlbedo,
        });
      }
    }
  }

  const emitters: GIEmitter[] = [];
  if (scene.emitters) {
    for (const em of scene.emitters) {
      if (!Number.isFinite(em.x) || !Number.isFinite(em.y)) {
        throw rangeError('Emitter position must be finite numbers', 'pixel-lighting');
      }
      const isCircle = em.shape === 'circle' || (em.radius != null && em.shape !== 'rect');
      const color = parseColor(em.color);
      const intensity = em.intensity ?? 1.0;
      if (intensity < 0 || !Number.isFinite(intensity)) {
        throw rangeError('Emitter intensity must be nonnegative finite number', 'pixel-lighting');
      }
      if (isCircle) {
        const r = em.radius ?? em.width ?? 10;
        if (r <= 0 || !Number.isFinite(r)) throw rangeError('Emitter radius must be positive', 'pixel-lighting');
        emitters.push({
          x: em.x,
          y: em.y,
          size: [r, r],
          shape: 1,
          color,
          intensity,
        });
      } else {
        const w = em.width ?? 10;
        const h = em.height ?? 10;
        if (w <= 0 || h <= 0 || !Number.isFinite(w) || !Number.isFinite(h)) {
          throw rangeError('Emitter dimensions must be positive', 'pixel-lighting');
        }
        emitters.push({
          x: em.x,
          y: em.y,
          size: [w, h],
          shape: 0,
          color,
          intensity,
        });
      }
    }
  }

  const lights = scene.lights ? [...scene.lights] : [];
  return { edges, emitters, lights };
}

/**
 * Traces an interval along a ray, checking occluder edges and emitters.
 */
function traceRayInterval(
  origin: Point2D,
  dir: Point2D,
  minT: number,
  maxT: number,
  edges: readonly GIEdge[],
  emitters: readonly GIEmitter[],
  lights: readonly Light2D[],
  evalBounce: boolean,
  defaultAlbedo: number,
): { hit: boolean; hitT: number; hitPoint: Point2D | null; hitNormal: Point2D; hitAlbedo: number; radiance: [number, number, number] } {
  let hit = false;
  let hitT = maxT;
  let hitPoint: Point2D | null = null;
  let hitNormal: Point2D = [0, 1];
  let hitAlbedo = defaultAlbedo;
  const radiance: [number, number, number] = [0, 0, 0];

  for (const edge of edges) {
    const vx = edge.b[0] - edge.a[0];
    const vy = edge.b[1] - edge.a[1];
    const denom = dir[0] * vy - dir[1] * vx;
    if (Math.abs(denom) > 1e-7) {
      const diffX = edge.a[0] - origin[0];
      const diffY = edge.a[1] - origin[1];
      const t = (diffX * vy - diffY * vx) / denom;
      const u = (diffX * dir[1] - diffY * dir[0]) / denom;
      if (t >= minT && t <= hitT && u >= 0.0 && u <= 1.0) {
        hit = true;
        hitT = t;
        hitPoint = [origin[0] + t * dir[0], origin[1] + t * dir[1]];
        let n = edge.normal;
        if (dir[0] * n[0] + dir[1] * n[1] > 0) n = [-n[0], -n[1]];
        hitNormal = n;
        hitAlbedo = edge.albedo;
      }
    }
  }

  for (const em of emitters) {
    if (em.shape === 1) {
      // Circle
      const r = em.size[0];
      const wx = origin[0] - em.x;
      const wy = origin[1] - em.y;
      const b = dir[0] * wx + dir[1] * wy;
      const c = wx * wx + wy * wy - r * r;
      const disc = b * b - c;
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        const t1 = -b - root;
        const t2 = -b + root;
        const tEnter = Math.max(t1, minT);
        const tExit = Math.min(t2, maxT);
        if (tEnter <= tExit && tEnter < hitT) {
          radiance[0] += em.color[0] * em.intensity;
          radiance[1] += em.color[1] * em.intensity;
          radiance[2] += em.color[2] * em.intensity;
        }
      }
    } else {
      // Rect
      const halfW = em.size[0] * 0.5;
      const halfH = em.size[1] * 0.5;
      const minX = em.x - halfW;
      const maxX = em.x + halfW;
      const minY = em.y - halfH;
      const maxY = em.y + halfH;
      let tNear = minT;
      let tFar = maxT;
      let hitBox = true;
      if (Math.abs(dir[0]) > 1e-7) {
        let tx1 = (minX - origin[0]) / dir[0];
        let tx2 = (maxX - origin[0]) / dir[0];
        if (tx1 > tx2) [tx1, tx2] = [tx2, tx1];
        tNear = Math.max(tNear, tx1);
        tFar = Math.min(tFar, tx2);
        if (tNear > tFar) hitBox = false;
      } else if (origin[0] < minX || origin[0] > maxX) {
        hitBox = false;
      }
      if (Math.abs(dir[1]) > 1e-7) {
        let ty1 = (minY - origin[1]) / dir[1];
        let ty2 = (maxY - origin[1]) / dir[1];
        if (ty1 > ty2) [ty1, ty2] = [ty2, ty1];
        tNear = Math.max(tNear, ty1);
        tFar = Math.min(tFar, ty2);
        if (tNear > tFar) hitBox = false;
      } else if (origin[1] < minY || origin[1] > maxY) {
        hitBox = false;
      }
      if (hitBox && tNear <= maxT && tNear < hitT) {
        radiance[0] += em.color[0] * em.intensity;
        radiance[1] += em.color[1] * em.intensity;
        radiance[2] += em.color[2] * em.intensity;
      }
    }
  }

  if (hit && evalBounce && hitPoint) {
    let directR = 0, directG = 0, directB = 0;
    for (const em of emitters) {
      const toX = em.x - hitPoint[0];
      const toY = em.y - hitPoint[1];
      const dist = Math.hypot(toX, toY);
      if (dist > 1e-4) {
        const lx = toX / dist;
        const ly = toY / dist;
        const nDotL = Math.max(0, hitNormal[0] * lx + hitNormal[1] * ly);
        const atten = 1 / (1 + dist / 32);
        const intens = em.intensity * nDotL * atten;
        directR += em.color[0] * intens;
        directG += em.color[1] * intens;
        directB += em.color[2] * intens;
      }
    }
    for (const lt of lights) {
      const toX = lt.x - hitPoint[0];
      const toY = lt.y - hitPoint[1];
      const dist = Math.hypot(toX, toY);
      if (dist < lt.radius && dist > 1e-4) {
        const lx = toX / dist;
        const ly = toY / dist;
        const nDotL = Math.max(0, hitNormal[0] * lx + hitNormal[1] * ly);
        const atten = Math.pow(Math.max(0, 1 - dist / lt.radius), lt.falloff);
        const col = parseColor(lt.color);
        const intens = lt.intensity * nDotL * atten;
        directR += col[0] * intens;
        directG += col[1] * intens;
        directB += col[2] * intens;
      }
    }
    const factor = hitAlbedo / PI;
    radiance[0] += factor * directR;
    radiance[1] += factor * directG;
    radiance[2] += factor * directB;
  }

  return { hit, hitT, hitPoint, hitNormal, hitAlbedo, radiance };
}

/**
 * 2D radiance cascade global illumination evaluator.
 * Hierarchically partitions the spatial and angular domain into cascades
 * and merges them to compute bounce light and emissive illumination.
 */
export class RadianceCascade2D {
  readonly cascades: number;
  readonly baseRays: number;
  readonly baseDistance: number;
  readonly intervalRatio: number;
  readonly angularRatio: number;
  readonly bounces: number;
  readonly albedo: number;
  readonly intensity: number;

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

    this.cascades = cascades;
    this.baseRays = baseRays;
    this.baseDistance = baseDistance;
    this.intervalRatio = intervalRatio;
    this.angularRatio = angularRatio;
    this.bounces = bounces;
    this.albedo = albedo;
    this.intensity = intensity;
  }

  /**
   * Evaluates the diffuse GI irradiance at a 2D query point, optionally cosine-weighted by surface normal.
   */
  evaluateAt(point: Point2D, normal?: Point2D, scene: GIScene2D = {}): [number, number, number] {
    const { edges, emitters, lights } = parseScene(scene, this.albedo);
    const cascades = this.cascades;
    const baseRays = this.baseRays;
    const baseDist = this.baseDistance;
    const intervalRatio = this.intervalRatio;
    const angRatio = this.angularRatio;
    const hasBounce = this.bounces > 0;
    const defaultAlbedo = this.albedo;
    const intensity = this.intensity;

    let norm: Point2D | null = null;
    if (normal) {
      const len = Math.hypot(normal[0], normal[1]);
      if (len > 1e-6) norm = [normal[0] / len, normal[1] / len];
    }

    let totalR = 0, totalG = 0, totalB = 0;
    const r0Min = 0.0;
    const r0Max = baseDist;

    for (let k0 = 0; k0 < baseRays; k0++) {
      const theta0 = TWO_PI * (k0 + 0.5) / baseRays;
      const dir0: Point2D = [Math.cos(theta0), Math.sin(theta0)];
      const res0 = traceRayInterval(point, dir0, r0Min, r0Max, edges, emitters, lights, hasBounce, defaultAlbedo);

      let rad0R = res0.radiance[0];
      let rad0G = res0.radiance[1];
      let rad0B = res0.radiance[2];

      if (!res0.hit && cascades > 1) {
        const r1Min = r0Max;
        const r1Max = r0Max * intervalRatio;
        const totalC1 = baseRays * angRatio;
        let c1R = 0, c1G = 0, c1B = 0;

        for (let j1 = 0; j1 < angRatio; j1++) {
          const k1 = k0 * angRatio + j1;
          const theta1 = TWO_PI * (k1 + 0.5) / totalC1;
          const dir1: Point2D = [Math.cos(theta1), Math.sin(theta1)];
          const res1 = traceRayInterval(point, dir1, r1Min, r1Max, edges, emitters, lights, hasBounce, defaultAlbedo);

          let rad1R = res1.radiance[0];
          let rad1G = res1.radiance[1];
          let rad1B = res1.radiance[2];

          if (!res1.hit && cascades > 2) {
            const r2Min = r1Max;
            const r2Max = r1Max * intervalRatio;
            const totalC2 = totalC1 * angRatio;
            let c2R = 0, c2G = 0, c2B = 0;

            for (let j2 = 0; j2 < angRatio; j2++) {
              const k2 = k1 * angRatio + j2;
              const theta2 = TWO_PI * (k2 + 0.5) / totalC2;
              const dir2: Point2D = [Math.cos(theta2), Math.sin(theta2)];
              const res2 = traceRayInterval(point, dir2, r2Min, r2Max, edges, emitters, lights, hasBounce, defaultAlbedo);

              c2R += res2.radiance[0];
              c2G += res2.radiance[1];
              c2B += res2.radiance[2];
            }
            rad1R += c2R / angRatio;
            rad1G += c2G / angRatio;
            rad1B += c2B / angRatio;
          }

          c1R += rad1R;
          c1G += rad1G;
          c1B += rad1B;
        }

        rad0R += c1R / angRatio;
        rad0G += c1G / angRatio;
        rad0B += c1B / angRatio;
      }

      if (norm) {
        const weight = Math.max(0, dir0[0] * norm[0] + dir0[1] * norm[1]) * PI;
        totalR += rad0R * weight;
        totalG += rad0G * weight;
        totalB += rad0B * weight;
      } else {
        totalR += rad0R;
        totalG += rad0G;
        totalB += rad0B;
      }
    }

    return [
      (totalR / baseRays) * intensity,
      (totalG / baseRays) * intensity,
      (totalB / baseRays) * intensity,
    ];
  }

  /**
   * Computes a 2D grid of RGB irradiance values across width by height query probes.
   */
  computeGrid(width: number, height: number, scene: GIScene2D = {}, spacing = 1): Float32Array {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw rangeError('Grid dimensions must be positive integers', 'pixel-lighting');
    }
    const grid = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pt: Point2D = [x * spacing, y * spacing];
        const irr = this.evaluateAt(pt, undefined, scene);
        const idx = (y * width + x) * 3;
        grid[idx] = irr[0];
        grid[idx + 1] = irr[1];
        grid[idx + 2] = irr[2];
      }
    }
    return grid;
  }
}

/** Evaluates diffuse 2D global illumination irradiance at a query point. */
export function evaluate2DGI(
  point: Point2D,
  normal?: Point2D,
  scene: GIScene2D = {},
  options?: RadianceCascadeOptions2D,
): [number, number, number] {
  const rc = new RadianceCascade2D(options);
  return rc.evaluateAt(point, normal, scene);
}

/** Options for GILighting2D WebGPU engine plugin. */
export interface GILighting2DOptions {
  /** Target texture receiving GI irradiance. */
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
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn wide(@builtin(vertex_index) index: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  out.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

struct GIUniforms {
  camera: vec4f,          // x, y, zoom, pad
  ambient: vec4f,         // r, g, b, pad
  cascades_config: vec4f, // cascades, base_rays, base_distance, interval_ratio
  gi_config: vec4f,       // angular_ratio, bounces, albedo, intensity
  counts: vec4u,          // emitter_count, edge_count, light_count, pad
  viewport: vec4f,        // width, height, pad, pad
};

@group(0) @binding(0) var<uniform> uniforms: GIUniforms;

struct Emitter {
  pos: vec2f,
  size: vec2f,
  color: vec3f,
  intensity: f32,
  shape: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};
@group(0) @binding(1) var<storage, read> emitters: array<Emitter>;

struct Edge {
  a: vec2f,
  b: vec2f,
  normal: vec2f,
  albedo: f32,
  pad: f32,
};
@group(0) @binding(2) var<storage, read> edges: array<Edge>;

struct Light {
  pos: vec2f,
  color: vec3f,
  radius: f32,
  intensity: f32,
  falloff: f32,
  kind: u32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};
@group(0) @binding(3) var<storage, read> lights: array<Light>;

struct TraceResult {
  hit: bool,
  hit_t: f32,
  hit_point: vec2f,
  hit_normal: vec2f,
  hit_albedo: f32,
  radiance: vec3f,
};

fn trace_interval(origin: vec2f, dir: vec2f, min_t: f32, max_t: f32, eval_bounce: bool) -> TraceResult {
  var res: TraceResult;
  res.hit = false;
  res.hit_t = max_t;
  res.radiance = vec3f(0.0);
  res.hit_normal = vec2f(0.0, 1.0);
  res.hit_albedo = uniforms.gi_config.z;

  let edge_count = uniforms.counts.y;
  for (var i: u32 = 0u; i < edge_count; i++) {
    let edge = edges[i];
    let v = edge.b - edge.a;
    let denom = dir.x * v.y - dir.y * v.x;
    if (abs(denom) > 1e-7) {
      let diff = edge.a - origin;
      let t = (diff.x * v.y - diff.y * v.x) / denom;
      let u = (diff.x * dir.y - diff.y * dir.x) / denom;
      if (t >= min_t && t <= res.hit_t && u >= 0.0 && u <= 1.0) {
        res.hit = true;
        res.hit_t = t;
        res.hit_point = origin + t * dir;
        var n = edge.normal;
        if (dot(dir, n) > 0.0) {
          n = -n;
        }
        res.hit_normal = n;
        res.hit_albedo = edge.albedo;
      }
    }
  }

  let emitter_count = uniforms.counts.x;
  for (var i: u32 = 0u; i < emitter_count; i++) {
    let em = emitters[i];
    if (em.shape == 1u) {
      // Circle
      let w = origin - em.pos;
      let b = dot(dir, w);
      let r = em.size.x;
      let c = dot(w, w) - r * r;
      let disc = b * b - c;
      if (disc >= 0.0) {
        let root = sqrt(disc);
        let t1 = -b - root;
        let t2 = -b + root;
        let t_enter = max(t1, min_t);
        let t_exit = min(t2, max_t);
        if (t_enter <= t_exit && t_enter < res.hit_t) {
          res.radiance += em.color * em.intensity;
        }
      }
    } else {
      // Rect
      let half = em.size * 0.5;
      let p_min = em.pos - half;
      let p_max = em.pos + half;
      var t_near = min_t;
      var t_far = max_t;
      var hit_box = true;
      if (abs(dir.x) > 1e-7) {
        var tx1 = (p_min.x - origin.x) / dir.x;
        var tx2 = (p_max.x - origin.x) / dir.x;
        if (tx1 > tx2) { let tmp = tx1; tx1 = tx2; tx2 = tmp; }
        t_near = max(t_near, tx1);
        t_far = min(t_far, tx2);
        if (t_near > t_far) { hit_box = false; }
      } else if (origin.x < p_min.x || origin.x > p_max.x) {
        hit_box = false;
      }
      if (abs(dir.y) > 1e-7) {
        var ty1 = (p_min.y - origin.y) / dir.y;
        var ty2 = (p_max.y - origin.y) / dir.y;
        if (ty1 > ty2) { let tmp = ty1; ty1 = ty2; ty2 = tmp; }
        t_near = max(t_near, ty1);
        t_far = min(t_far, ty2);
        if (t_near > t_far) { hit_box = false; }
      } else if (origin.y < p_min.y || origin.y > p_max.y) {
        hit_box = false;
      }
      if (hit_box && t_near <= max_t && t_near < res.hit_t) {
        res.radiance += em.color * em.intensity;
      }
    }
  }

  if (res.hit && eval_bounce) {
    var direct_irradiance = vec3f(0.0);
    let hp = res.hit_point;
    let hn = res.hit_normal;
    for (var i: u32 = 0u; i < emitter_count; i++) {
      let em = emitters[i];
      let to_em = em.pos - hp;
      let dist = length(to_em);
      if (dist > 1e-4) {
        let l_dir = to_em / dist;
        let n_dot_l = max(0.0, dot(hn, l_dir));
        let atten = 1.0 / (1.0 + dist / 32.0);
        direct_irradiance += em.color * (em.intensity * n_dot_l * atten);
      }
    }
    let light_count = uniforms.counts.z;
    for (var i: u32 = 0u; i < light_count; i++) {
      let lt = lights[i];
      let to_lt = lt.pos - hp;
      let dist = length(to_lt);
      if (dist < lt.radius && dist > 1e-4) {
        let l_dir = to_lt / dist;
        let n_dot_l = max(0.0, dot(hn, l_dir));
        let atten = pow(max(0.0, 1.0 - dist / lt.radius), lt.falloff);
        direct_irradiance += lt.color * (lt.intensity * n_dot_l * atten);
      }
    }
    res.radiance += (res.hit_albedo / 3.14159265359) * direct_irradiance;
  }

  return res;
}

@fragment
fn evaluate_gi(in: VertexOutput) -> @location(0) vec4f {
  let screen_pos = in.position.xy;
  let cam = uniforms.camera;
  let world_pos = vec2f(
    cam.x + (screen_pos.x - uniforms.viewport.x * 0.5) / cam.z,
    cam.y + (screen_pos.y - uniforms.viewport.y * 0.5) / cam.z
  );

  let num_cascades = u32(uniforms.cascades_config.x);
  let base_rays = u32(uniforms.cascades_config.y);
  let base_dist = uniforms.cascades_config.z;
  let interval_ratio = uniforms.cascades_config.w;
  let ang_ratio = u32(uniforms.gi_config.x);
  let has_bounce = uniforms.gi_config.y > 0.0;
  let intensity = uniforms.gi_config.w;

  var total_irradiance = vec3f(0.0);
  let r0_min = 0.0;
  let r0_max = base_dist;

  for (var k0: u32 = 0u; k0 < base_rays; k0++) {
    let theta0 = 6.28318530718 * (f32(k0) + 0.5) / f32(base_rays);
    let dir0 = vec2f(cos(theta0), sin(theta0));
    let res0 = trace_interval(world_pos, dir0, r0_min, r0_max, has_bounce);

    var rad0 = res0.radiance;

    if (!res0.hit && num_cascades > 1u) {
      let r1_min = r0_max;
      let r1_max = r0_max * interval_ratio;
      let total_c1 = base_rays * ang_ratio;
      var c1_rad = vec3f(0.0);

      for (var j1: u32 = 0u; j1 < ang_ratio; j1++) {
        let k1 = k0 * ang_ratio + j1;
        let theta1 = 6.28318530718 * (f32(k1) + 0.5) / f32(total_c1);
        let dir1 = vec2f(cos(theta1), sin(theta1));
        let res1 = trace_interval(world_pos, dir1, r1_min, r1_max, has_bounce);

        var rad1 = res1.radiance;

        if (!res1.hit && num_cascades > 2u) {
          let r2_min = r1_max;
          let r2_max = r1_max * interval_ratio;
          let total_c2 = total_c1 * ang_ratio;
          var c2_rad = vec3f(0.0);

          for (var j2: u32 = 0u; j2 < ang_ratio; j2++) {
            let k2 = k1 * ang_ratio + j2;
            let theta2 = 6.28318530718 * (f32(k2) + 0.5) / f32(total_c2);
            let dir2 = vec2f(cos(theta2), sin(theta2));
            let res2 = trace_interval(world_pos, dir2, r2_min, r2_max, has_bounce);
            c2_rad += res2.radiance;
          }
          rad1 += c2_rad / f32(ang_ratio);
        }

        c1_rad += rad1;
      }
      rad0 += c1_rad / f32(ang_ratio);
    }

    total_irradiance += rad0;
  }

  total_irradiance = (total_irradiance / f32(base_rays)) * intensity;
  let final_color = uniforms.ambient.rgb + total_irradiance;
  return vec4f(final_color, 1.0);
}
`;

/**
 * WebGPU 2D global illumination plugin.
 * Computes indirect bounce light and emissive sprite illumination in a screen pass.
 */
export class GILighting2D implements EnginePlugin, Disposable {
  name: string;
  order: number;

  #engine?: Engine;
  #disposed = false;
  #device?: GPUDevice;
  #module?: GPUShaderModule;
  #layout?: GPUBindGroupLayout;
  #pipeline?: GPURenderPipeline;
  #uniformBuffer?: GPUBuffer;
  #emitterBuffer?: GPUBuffer;
  #edgeBuffer?: GPUBuffer;
  #lightBuffer?: GPUBuffer;
  #bindGroup?: GPUBindGroup;
  #format?: GPUTextureFormat;
  #target: GPUTexture | (() => GPUTexture);

  readonly cascades: RadianceCascade2D;
  camera: { x: number; y: number; zoom: number };
  ambient: number | string;
  emitters: EmissiveSprite2D[];
  lights: Light2D[];
  occluders: Occluder2D[];

  constructor(options: GILighting2DOptions) {
    if (!options?.target) throw typeError('target is required for GILighting2D', 'pixel-lighting');
    this.#target = options.target;
    this.name = options.name ?? `gi-lighting2d-${++giPluginCount}`;
    this.order = options.order ?? 20;
    this.cascades = new RadianceCascade2D(options.cascades);
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.ambient = options.ambient ?? 0x000000;
    this.emitters = options.emitters ? [...options.emitters] : [];
    this.lights = options.lights ? [...options.lights] : [];
    this.occluders = options.occluders ? [...options.occluders] : [];
  }

  static attach(instance: EngineKernel, options: GILighting2DOptions): GILighting2D {
    const lighting = new GILighting2D(options);
    engineRuntime(instance).use(lighting);
    return lighting;
  }

  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'GILighting2D disposed; create a new one');
    if (engine.backend !== 'webgpu') throw fault('unsupported', 'GILighting2D needs WebGPU', 'webgpu');
    this.#engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu' && !c.view?.index) this.#run(c);
      },
    });
  }

  #release(): void {
    this.#bindGroup = undefined;
    this.#uniformBuffer?.destroy();
    this.#uniformBuffer = undefined;
    this.#emitterBuffer?.destroy();
    this.#emitterBuffer = undefined;
    this.#edgeBuffer?.destroy();
    this.#edgeBuffer = undefined;
    this.#lightBuffer?.destroy();
    this.#lightBuffer = undefined;
    this.#pipeline = undefined;
    this.#layout = undefined;
    this.#module = undefined;
    this.#device = undefined;
    this.#format = undefined;
  }

  #prepare(device: GPUDevice, targetFormat: GPUTextureFormat): void {
    if (this.#device !== device) {
      if (this.#device) this.#release();
      this.#device = device;
    }
    if (!this.#module) {
      this.#module = device.createShaderModule({ label: 'gi-lighting2d', code: giShader });
      this.#layout = device.createBindGroupLayout({
        label: 'gi-lighting2d layout',
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', minBindingSize: 96 },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'read-only-storage' },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'read-only-storage' },
          },
          {
            binding: 3,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'read-only-storage' },
          },
        ],
      });
    }
    if (targetFormat !== this.#format || !this.#pipeline) {
      this.#format = targetFormat;
      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [this.#layout!],
      });
      this.#pipeline = device.createRenderPipeline({
        label: 'gi-lighting2d pipeline',
        layout: pipelineLayout,
        vertex: { module: this.#module!, entryPoint: 'wide' },
        fragment: {
          module: this.#module!,
          entryPoint: 'evaluate_gi',
          targets: [
            {
              format: targetFormat,
            },
          ],
        },
      });
    }
  }

  #run(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    const device = c.device;
    const pick = (texture: GPUTexture | (() => GPUTexture)) => (typeof texture === 'function' ? texture() : texture);
    const target = pick(this.#target);
    if (!target) return;

    this.#prepare(device, target.format);

    const { edges, emitters, lights } = parseScene(
      { occluders: this.occluders, emitters: this.emitters, lights: this.lights },
      this.cascades.albedo,
    );

    const amb = parseColor(this.ambient);
    const rc = this.cascades;
    const cam = this.camera;
    const width = target.width;
    const height = target.height;

    // Uniform buffer (96 bytes: 6 x vec4)
    const uniformData = new Float32Array(24);
    // camera
    uniformData[0] = cam.x;
    uniformData[1] = cam.y;
    uniformData[2] = cam.zoom;
    uniformData[3] = 0;
    // ambient
    uniformData[4] = amb[0];
    uniformData[5] = amb[1];
    uniformData[6] = amb[2];
    uniformData[7] = 0;
    // cascades_config
    uniformData[8] = rc.cascades;
    uniformData[9] = rc.baseRays;
    uniformData[10] = rc.baseDistance;
    uniformData[11] = rc.intervalRatio;
    // gi_config
    uniformData[12] = rc.angularRatio;
    uniformData[13] = rc.bounces;
    uniformData[14] = rc.albedo;
    uniformData[15] = rc.intensity;
    // counts (cast as u32)
    const countsView = new Uint32Array(uniformData.buffer, 16 * 4, 4);
    countsView[0] = emitters.length;
    countsView[1] = edges.length;
    countsView[2] = lights.length;
    countsView[3] = 0;
    // viewport
    uniformData[20] = width;
    uniformData[21] = height;
    uniformData[22] = 0;
    uniformData[23] = 0;

    if (!this.#uniformBuffer) {
      this.#uniformBuffer = device.createBuffer({
        label: 'gi-uniforms',
        size: 96,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.#uniformBuffer, 0, uniformData);

    // Emitters buffer: 12 floats (48 bytes) per emitter
    const emitterStrideFloats = 12;
    const emitterCount = Math.max(1, emitters.length);
    const emitterData = new Float32Array(emitterCount * emitterStrideFloats);
    const emitterU32 = new Uint32Array(emitterData.buffer);
    for (let i = 0; i < emitters.length; i++) {
      const em = emitters[i];
      const base = i * emitterStrideFloats;
      emitterData[base] = em.x;
      emitterData[base + 1] = em.y;
      emitterData[base + 2] = em.size[0];
      emitterData[base + 3] = em.size[1];
      emitterData[base + 4] = em.color[0];
      emitterData[base + 5] = em.color[1];
      emitterData[base + 6] = em.color[2];
      emitterData[base + 7] = em.intensity;
      emitterU32[base + 8] = em.shape;
    }
    if (!this.#emitterBuffer || this.#emitterBuffer.size < emitterData.byteLength) {
      this.#emitterBuffer?.destroy();
      this.#emitterBuffer = device.createBuffer({
        label: 'gi-emitters',
        size: Math.max(128, emitterData.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.#emitterBuffer, 0, emitterData);

    // Edges buffer: 8 floats (32 bytes) per edge
    const edgeStrideFloats = 8;
    const edgeCount = Math.max(1, edges.length);
    const edgeData = new Float32Array(edgeCount * edgeStrideFloats);
    for (let i = 0; i < edges.length; i++) {
      const ed = edges[i];
      const base = i * edgeStrideFloats;
      edgeData[base] = ed.a[0];
      edgeData[base + 1] = ed.a[1];
      edgeData[base + 2] = ed.b[0];
      edgeData[base + 3] = ed.b[1];
      edgeData[base + 4] = ed.normal[0];
      edgeData[base + 5] = ed.normal[1];
      edgeData[base + 6] = ed.albedo;
      edgeData[base + 7] = 0;
    }
    if (!this.#edgeBuffer || this.#edgeBuffer.size < edgeData.byteLength) {
      this.#edgeBuffer?.destroy();
      this.#edgeBuffer = device.createBuffer({
        label: 'gi-edges',
        size: Math.max(128, edgeData.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.#edgeBuffer, 0, edgeData);

    // Lights buffer: 12 floats (48 bytes) per light
    const lightStrideFloats = 12;
    const lightCount = Math.max(1, lights.length);
    const lightData = new Float32Array(lightCount * lightStrideFloats);
    const lightU32 = new Uint32Array(lightData.buffer);
    for (let i = 0; i < lights.length; i++) {
      const lt = lights[i];
      const base = i * lightStrideFloats;
      const col = parseColor(lt.color);
      lightData[base] = lt.x;
      lightData[base + 1] = lt.y;
      lightData[base + 2] = col[0];
      lightData[base + 3] = col[1];
      lightData[base + 4] = col[2];
      lightData[base + 5] = lt.radius;
      lightData[base + 6] = lt.intensity;
      lightData[base + 7] = lt.falloff;
      lightU32[base + 8] = lt.kind === 'point' ? 0 : lt.kind === 'spot' ? 1 : 2;
    }
    if (!this.#lightBuffer || this.#lightBuffer.size < lightData.byteLength) {
      this.#lightBuffer?.destroy();
      this.#lightBuffer = device.createBuffer({
        label: 'gi-lights',
        size: Math.max(128, lightData.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.#lightBuffer, 0, lightData);

    this.#bindGroup = device.createBindGroup({
      label: 'gi-lighting2d bind group',
      layout: this.#layout!,
      entries: [
        { binding: 0, resource: { buffer: this.#uniformBuffer } },
        { binding: 1, resource: { buffer: this.#emitterBuffer } },
        { binding: 2, resource: { buffer: this.#edgeBuffer } },
        { binding: 3, resource: { buffer: this.#lightBuffer } },
      ],
    });

    const pass = c.encoder.beginRenderPass({
      label: 'gi-lighting2d pass',
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.#pipeline!);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
    pass.end();
  }

  onDeviceRestored(): void {
    this.#release();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release();
    this.#engine?.removePlugin(this.name);
    this.#engine = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
