/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import {
  type Point2D,
  type LightKind2D,
  type Light2DOptions,
  Light2D,
  inLightMask,
  lightAffectsLayer,
} from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

let heightPluginCount = 0;

/** A 2.5D height occluder for top-down perspective and self-shadowing. */
export interface HeightOccluder2D {
  /** The 2D footprint shape of the occluder. */
  shape: 'box' | 'circle' | 'segment';
  /** Vertical height / extrusion of the occluder in world units (z-axis). Must be > 0. */
  height: number;
  /** Base elevation above the ground plane (z-axis). Default 0. */
  elevation?: number;
  /** Width in x for box occluders. Default 16. */
  width?: number;
  /** Depth in y for box occluders. Default 16. */
  depth?: number;
  /** 2D center offset [x, y] for box or circle, or start point for segment. Default [0, 0]. */
  offset?: Point2D;
  /** Rotation angle in radians for box occluders. Default 0. */
  rotation?: number;
  /** Radius for circle occluders. Default 8. */
  radius?: number;
  /** End point [x, y] for segment occluders. */
  to?: Point2D;
  /** Whether this occluder casts self-shadows on its own lower surfaces. Default true. */
  selfShadow?: boolean;
}

/** Validates a {@link HeightOccluder2D} object. Throws RangeError if invalid. */
export function checkHeightOccluder(o: HeightOccluder2D): void {
  if (o.shape !== 'box' && o.shape !== 'circle' && o.shape !== 'segment') {
    throw rangeError('Unknown occluder shape', 'pixel-lighting');
  }
  if (!Number.isFinite(o.height) || o.height <= 0) {
    throw rangeError('Invalid occluder height: must be positive finite number', 'pixel-lighting');
  }
  if (o.elevation !== undefined && !Number.isFinite(o.elevation)) {
    throw rangeError('Invalid occluder elevation', 'pixel-lighting');
  }
  if (o.offset && !o.offset.every(Number.isFinite)) {
    throw rangeError('Invalid occluder offset', 'pixel-lighting');
  }
  if (o.shape === 'box') {
    if ((o.width !== undefined && (!Number.isFinite(o.width) || o.width <= 0)) ||
        (o.depth !== undefined && (!Number.isFinite(o.depth) || o.depth <= 0))) {
      throw rangeError('Invalid box dimensions: width and depth must be positive', 'pixel-lighting');
    }
  } else if (o.shape === 'circle') {
    if (o.radius !== undefined && (!Number.isFinite(o.radius) || o.radius <= 0)) {
      throw rangeError('Invalid circle radius: must be positive', 'pixel-lighting');
    }
  } else if (o.shape === 'segment') {
    if (!o.offset || !o.to || !o.to.every(Number.isFinite)) {
      throw rangeError('Invalid segment endpoints: offset (from) and to must be valid Point2D', 'pixel-lighting');
    }
  }
}

/** Options for a {@link HeightLight2D}. */
export interface HeightLight2DOptions extends Light2DOptions {
  /** Light height (z-elevation) above the ground plane. Default 32. */
  height?: number;
  /** Directional light elevation angle above horizon in radians. Default Math.PI / 4. */
  elevation?: number;
}

/** One 2.5D height light for top-down games. */
export class HeightLight2D extends Light2D {
  constructor(options: HeightLight2DOptions = {}) {
    super(options);
  }
}

/** Helper factory to create a {@link HeightOccluder2D}. */
export function createHeightOccluder(options: HeightOccluder2D): HeightOccluder2D {
  checkHeightOccluder(options);
  return {
    shape: options.shape,
    height: options.height,
    elevation: options.elevation ?? 0,
    width: options.width ?? 16,
    depth: options.depth ?? 16,
    offset: options.offset ?? [0, 0],
    rotation: options.rotation ?? 0,
    radius: options.radius ?? 8,
    to: options.to ? [options.to[0], options.to[1]] : undefined,
    selfShadow: options.selfShadow ?? true,
  };
}

/** Helper for 2D ray against an occluder footprint. Returns [tEnter, tExit] along ray, or null if no hit. */
function rayOccluderFootprint(
  px: number,
  py: number,
  vx: number,
  vy: number,
  maxDist: number,
  o: HeightOccluder2D,
): [number, number] | null {
  const [ox, oy] = o.offset ?? [0, 0];
  if (o.shape === 'box') {
    const hw = (o.width ?? 16) / 2,
      hd = (o.depth ?? 16) / 2,
      rot = o.rotation ?? 0,
      cosR = Math.cos(-rot),
      sinR = Math.sin(-rot),
      dx = px - ox,
      dy = py - oy,
      plx = dx * cosR - dy * sinR,
      ply = dx * sinR + dy * cosR,
      vlx = vx * cosR - vy * sinR,
      vly = vx * sinR + vy * cosR;

    let tMin = -Infinity,
      tMax = Infinity;

    if (Math.abs(vlx) > 1e-7) {
      const t1 = (-hw - plx) / vlx,
        t2 = (hw - plx) / vlx;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (Math.abs(plx) > hw) {
      return null;
    }

    if (Math.abs(vly) > 1e-7) {
      const t1 = (-hd - ply) / vly,
        t2 = (hd - ply) / vly;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (Math.abs(ply) > hd) {
      return null;
    }

    if (tMin > tMax || tMax < 1e-4 || tMin > maxDist) return null;
    return [Math.max(0, tMin), Math.min(maxDist, tMax)];
  } else if (o.shape === 'circle') {
    const rad = o.radius ?? 8,
      dx = px - ox,
      dy = py - oy,
      b = dx * vx + dy * vy,
      c = dx * dx + dy * dy - rad * rad,
      disc = b * b - c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc),
      t1 = -b - s,
      t2 = -b + s,
      tMin = Math.min(t1, t2),
      tMax = Math.max(t1, t2);
    if (tMax < 1e-4 || tMin > maxDist) return null;
    return [Math.max(0, tMin), Math.min(maxDist, tMax)];
  } else if (o.shape === 'segment') {
    const to = o.to ?? [ox, oy],
      sx = to[0] - ox,
      sy = to[1] - oy,
      cross = vx * sy - vy * sx;
    if (Math.abs(cross) < 1e-7) return null;
    const dx = ox - px,
      dy = oy - py,
      t = (dx * sy - dy * sx) / cross,
      u = (dx * vy - dy * vx) / cross;
    if (t >= 1e-4 && t <= maxDist && u >= 0 && u <= 1) {
      return [t - 1e-3, t + 1e-3];
    }
    return null;
  }
  return null;
}

/**
 * Tests whether world point (x, y) at receiver elevation z is in shadow from `light`
 * due to any height occluder.
 */
export function inHeightShadow(
  light: Light2D,
  occluders: readonly HeightOccluder2D[],
  x: number,
  y: number,
  receiverElevation: number = 0,
): boolean {
  if (!light.shadows) return false;

  let vx = 0,
    vy = 0,
    maxDist = Infinity,
    tanElev = 1;

  if (light.kind === 'directional') {
    const elev = Math.max(0.01, Math.min(Math.PI / 2 - 0.01, light.elevation));
    tanElev = Math.tan(elev);
    vx = -Math.cos(light.angle);
    vy = -Math.sin(light.angle);
    maxDist = 10000;
  } else {
    const dx = light.x - x,
      dy = light.y - y;
    maxDist = Math.hypot(dx, dy);
    if (maxDist < 1e-5) return false;
    vx = dx / maxDist;
    vy = dy / maxDist;
    if (maxDist > light.radius) return false;
  }

  const getRayZ = (t: number): number => {
    if (light.kind === 'directional') {
      return receiverElevation + t * tanElev;
    }
    return receiverElevation + (t / maxDist) * (light.height - receiverElevation);
  };

  for (const o of occluders) {
    const baseZ = o.elevation ?? 0,
      topZ = baseZ + o.height,
      selfShadow = o.selfShadow ?? true;

    const hit = rayOccluderFootprint(x, y, vx, vy, maxDist, o);
    if (!hit) continue;

    const [t0, t1] = hit;

    if (t0 <= 1e-4) {
      if (receiverElevation >= topZ - 1e-3) {
        continue;
      }
      if (!selfShadow) continue;
      const exitZ = getRayZ(t1);
      if (exitZ <= topZ && exitZ >= baseZ) {
        return true;
      }
      if (receiverElevation >= baseZ && receiverElevation <= topZ) {
        return true;
      }
    } else {
      const z0 = getRayZ(t0),
        z1 = getRayZ(t1),
        minRayZ = Math.min(z0, z1),
        maxRayZ = Math.max(z0, z1);

      if (maxRayZ >= baseZ && minRayZ <= topZ) {
        return true;
      }
    }
  }

  return false;
}

/** Computes the shadow visibility factor (0: full shadow, 1: fully lit) for a height light. */
export function heightShadowFactor(
  light: Light2D,
  occluders: readonly HeightOccluder2D[],
  x: number,
  y: number,
  receiverElevation: number = 0,
): number {
  return inHeightShadow(light, occluders, x, y, receiverElevation) ? 0 : 1;
}

/**
 * Computes illuminated [r, g, b] at world point (x, y) with elevation z,
 * factoring in 2.5D height shadowing and self-shadowing.
 */
export function heightLightAt(
  light: Light2D,
  occluders: readonly HeightOccluder2D[],
  x: number,
  y: number,
  receiverElevation: number = 0,
  normal: readonly number[] = [0, 0, 1],
  layer?: number,
): number[] {
  if (layer !== undefined && !lightAffectsLayer(light, layer)) return [0, 0, 0];
  if (light.mask && !inLightMask(light.mask, x, y)) return [0, 0, 0];

  const vis = heightShadowFactor(light, occluders, x, y, receiverElevation);
  if (vis <= 0) return [0, 0, 0];

  const normLen = Math.hypot(normal[0], normal[1], normal[2]),
    n = [normal[0] / normLen, normal[1] / normLen, normal[2] / normLen],
    rgb = hexColor(light.color)!;

  let amount = 1,
    l: number[];

  if (light.kind === 'directional') {
    const elev = light.elevation,
      ang = light.angle;
    l = [-Math.cos(ang) * Math.cos(elev), -Math.sin(ang) * Math.cos(elev), Math.sin(elev)];
  } else {
    const dx = light.x - x,
      dy = light.y - y,
      dz = light.height - receiverElevation,
      flat = Math.hypot(dx, dy),
      length = Math.hypot(flat, dz);

    amount = Math.max(0, 1 - flat / light.radius) ** light.falloff;
    l = length > 0 ? [dx / length, dy / length, dz / length] : n;

    if (light.kind === 'spot') {
      const along = flat ? -(dx * Math.cos(light.angle) + dy * Math.sin(light.angle)) / flat : 1,
        outer = Math.cos(light.cone),
        inner = Math.cos(light.cone * (1 - light.softness));
      amount *= inner > outer ? Math.min(1, Math.max(0, (along - outer) / (inner - outer))) : along >= outer ? 1 : 0;
    }
  }

  const shade = amount * vis * Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) * light.intensity;
  return [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade];
}

/** Options for the {@link HeightLighting2D} plugin. */
export interface HeightLighting2DOptions {
  /** Target texture or function returning target texture. */
  target?: any;
  /** Receiver ground elevation. Default 0. */
  elevation?: number;
  /** Active height occluders. */
  occluders?: readonly HeightOccluder2D[];
  /** Initial lights. */
  lights?: readonly HeightLight2D[];
  /** Camera configuration. Default { x: 0, y: 0, zoom: 1 }. */
  camera?: { x: number; y: number; zoom: number };
  /** Pass name. */
  name?: string;
  /** Pass order in frameGraph. Default 15. */
  order?: number;
  /** Layer mask for filtering lights. Default ~0. */
  layer?: number;
}

const HEIGHT_LIGHTING_WGSL = /* wgsl */ `
struct LightData {
  posRadius: vec4<f32>,       // pos.x, pos.y, radius, falloff
  colorIntensity: vec4<f32>,  // color.r, color.g, color.b, intensity
  geomParams: vec4<f32>,      // height, angle, cone, softness
  miscParams: vec4<f32>,      // elevation, receiverElevation, camX, camY
  camScaleTarget: vec4<f32>,  // camZoom, targetW, targetH, 0.0
  flags: vec4<u32>,           // kind, shadows, occluderCount, layer
  layerMasks: vec4<u32>,      // lightLayers, 0, 0, 0
}

struct OccluderData {
  offset: vec2<f32>,
  size: vec2<f32>,
  rotElevH: vec4<f32>,       // rot, elev, height, pad
  flags: vec4<u32>,          // shape, selfShadow, 0, 0
}

@group(0) @binding(0) var<uniform> light: LightData;
@group(0) @binding(1) var<storage, read> occluders: array<OccluderData>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  out.position = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2<f32>(x, y);
  return out;
}

fn rayOccluderFootprint(px: f32, py: f32, vx: f32, vy: f32, maxDist: f32, idx: u32) -> vec2<f32> {
  let occ = occluders[idx];
  let shape = occ.flags.x;
  if (shape == 0u) {
    let cosR = cos(-occ.rotElevH.x);
    let sinR = sin(-occ.rotElevH.x);
    let dx = px - occ.offset.x;
    let dy = py - occ.offset.y;
    let plx = dx * cosR - dy * sinR;
    let ply = dx * sinR + dy * cosR;
    let vlx = vx * cosR - vy * sinR;
    let vly = vx * sinR + vy * cosR;

    var tMin = -1e9;
    var tMax = 1e9;

    if (abs(vlx) > 1e-6) {
      let t1 = (-occ.size.x - plx) / vlx;
      let t2 = (occ.size.x - plx) / vlx;
      tMin = max(tMin, min(t1, t2));
      tMax = min(tMax, max(t1, t2));
    } else if (abs(plx) > occ.size.x) {
      return vec2<f32>(-1.0, -1.0);
    }

    if (abs(vly) > 1e-6) {
      let t1 = (-occ.size.y - ply) / vly;
      let t2 = (occ.size.y - ply) / vly;
      tMin = max(tMin, min(t1, t2));
      tMax = min(tMax, max(t1, t2));
    } else if (abs(ply) > occ.size.y) {
      return vec2<f32>(-1.0, -1.0);
    }

    if (tMin > tMax || tMax < 1e-4 || tMin > maxDist) {
      return vec2<f32>(-1.0, -1.0);
    }
    return vec2<f32>(max(0.0, tMin), min(maxDist, tMax));
  } else if (shape == 1u) {
    let dx = px - occ.offset.x;
    let dy = py - occ.offset.y;
    let b = dx * vx + dy * vy;
    let c = dx * dx + dy * dy - occ.size.x * occ.size.x;
    let disc = b * b - c;
    if (disc < 0.0) {
      return vec2<f32>(-1.0, -1.0);
    }
    let s = sqrt(disc);
    let t1 = -b - s;
    let t2 = -b + s;
    let tMin = min(t1, t2);
    let tMax = max(t1, t2);
    if (tMax < 1e-4 || tMin > maxDist) {
      return vec2<f32>(-1.0, -1.0);
    }
    return vec2<f32>(max(0.0, tMin), min(maxDist, tMax));
  } else if (shape == 2u) {
    let sx = occ.size.x - occ.offset.x;
    let sy = occ.size.y - occ.offset.y;
    let cross = vx * sy - vy * sx;
    if (abs(cross) < 1e-6) {
      return vec2<f32>(-1.0, -1.0);
    }
    let dx = occ.offset.x - px;
    let dy = occ.offset.y - py;
    let t = (dx * sy - dy * sx) / cross;
    let u = (dx * vy - dy * vx) / cross;
    if (t >= 1e-4 && t <= maxDist && u >= 0.0 && u <= 1.0) {
      return vec2<f32>(t - 1e-3, t + 1e-3);
    }
  }
  return vec2<f32>(-1.0, -1.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  if ((light.layerMasks.x & light.flags.w) == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let camX = light.miscParams.z;
  let camY = light.miscParams.w;
  let camZoom = light.camScaleTarget.x;
  let screenPos = in.position.xy;
  let worldPos = vec2<f32>(
    camX + screenPos.x / camZoom,
    camY + screenPos.y / camZoom
  );

  let rcvElev = light.miscParams.y;
  let kind = light.flags.x;
  let lightPos = light.posRadius.xy;
  let lightRadius = light.posRadius.z;
  let lightFalloff = light.posRadius.w;
  let lightColor = light.colorIntensity.xyz;
  let lightIntensity = light.colorIntensity.w;
  let lightH = light.geomParams.x;
  let lightAngle = light.geomParams.y;
  let lightCone = light.geomParams.z;
  let lightSoftness = light.geomParams.w;
  let lightElev = light.miscParams.x;

  var vx = 0.0;
  var vy = 0.0;
  var maxDist = 10000.0;
  var tanElev = 1.0;

  if (kind == 2u) {
    let elev = max(0.01, min(1.56, lightElev));
    tanElev = tan(elev);
    vx = -cos(lightAngle);
    vy = -sin(lightAngle);
  } else {
    let dx = lightPos.x - worldPos.x;
    let dy = lightPos.y - worldPos.y;
    maxDist = hypot(dx, dy);
    if (maxDist < 1e-5) {
      return vec4<f32>(lightColor * lightIntensity, 1.0);
    }
    vx = dx / maxDist;
    vy = dy / maxDist;
    if (maxDist > lightRadius) {
      return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
  }

  var inShadow = false;
  let shadowsEnabled = light.flags.y;
  let occCount = light.flags.z;

  if (shadowsEnabled == 1u) {
    for (var i = 0u; i < occCount; i = i + 1u) {
      let occ = occluders[i];
      let baseZ = occ.rotElevH.y;
      let topZ = baseZ + occ.rotElevH.z;
      let selfShadow = occ.flags.y;

      let hit = rayOccluderFootprint(worldPos.x, worldPos.y, vx, vy, maxDist, i);
      if (hit.x < 0.0) {
        continue;
      }

      let t0 = hit.x;
      let t1 = hit.y;

      var z0 = 0.0;
      var z1 = 0.0;
      if (kind == 2u) {
        z0 = rcvElev + t0 * tanElev;
        z1 = rcvElev + t1 * tanElev;
      } else {
        z0 = rcvElev + (t0 / maxDist) * (lightH - rcvElev);
        z1 = rcvElev + (t1 / maxDist) * (lightH - rcvElev);
      }

      if (t0 <= 1e-4) {
        if (rcvElev >= topZ - 1e-3) {
          continue;
        }
        if (selfShadow == 1u) {
          if (z1 <= topZ && z1 >= baseZ) {
            inShadow = true;
            break;
          }
          if (rcvElev >= baseZ && rcvElev <= topZ) {
            inShadow = true;
            break;
          }
        }
      } else {
        let minRayZ = min(z0, z1);
        let maxRayZ = max(z0, z1);
        if (maxRayZ >= baseZ && minRayZ <= topZ) {
          inShadow = true;
          break;
        }
      }
    }
  }

  if (inShadow) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  var amount = 1.0;
  var l = vec3<f32>(0.0, 0.0, 1.0);

  if (kind == 2u) {
    l = vec3<f32>(-cos(lightAngle) * cos(lightElev), -sin(lightAngle) * cos(lightElev), sin(lightElev));
  } else {
    let dx = lightPos.x - worldPos.x;
    let dy = lightPos.y - worldPos.y;
    let dz = lightH - rcvElev;
    let flat = hypot(dx, dy);
    let len = sqrt(flat * flat + dz * dz);
    amount = pow(max(0.0, 1.0 - flat / lightRadius), lightFalloff);
    if (len > 0.0) {
      l = vec3<f32>(dx / len, dy / len, dz / len);
    }
    if (kind == 1u) {
      var along = 1.0;
      if (flat > 0.0) {
        along = -(dx * cos(lightAngle) + dy * sin(lightAngle)) / flat;
      }
      let outer = cos(lightCone);
      let inner = cos(lightCone * (1.0 - lightSoftness));
      if (inner > outer) {
        amount = amount * clamp((along - outer) / (inner - outer), 0.0, 1.0);
      } else if (along < outer) {
        amount = 0.0;
      }
    }
  }

  let n = vec3<f32>(0.0, 0.0, 1.0);
  let diffuse = max(0.0, dot(n, l));
  let finalRgb = lightColor * lightIntensity * amount * diffuse;
  return vec4<f32>(finalRgb, 1.0);
}

fn hypot(x: f32, y: f32) -> f32 {
  return sqrt(x * x + y * y);
}
`;

/**
 * 2.5D Height & Self Shadowing Engine plugin for top-down games.
 * Supports height-based ray occlusion, ground projection, and self-shadowing.
 */
export class HeightLighting2D implements EnginePlugin, Disposable {
  readonly name: string;
  readonly order: number;
  private readonly lights = new Set<HeightLight2D>();
  private occluders: HeightOccluder2D[] = [];
  private engine: Engine | null = null;
  private pipeline: any = null;
  private uniformBuffer: any = null;
  private storageBuffer: any = null;
  private bindGroupLayout: any = null;
  private disposed = false;
  private target: any;
  receiverElevation: number;
  layer: number;
  camera: { x: number; y: number; zoom: number };

  constructor(options: HeightLighting2DOptions = {}) {
    this.name = options.name ?? `height-lighting2d-${++heightPluginCount}`;
    this.order = options.order ?? 15;
    this.target = options.target;
    this.receiverElevation = options.elevation ?? 0;
    this.layer = options.layer ?? 0xffffffff;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    if (options.occluders) {
      this.setOccluders(options.occluders);
    }
    if (options.lights) {
      for (const l of options.lights) this.lights.add(l);
    }
  }

  static attach(instance: EngineKernel, options: HeightLighting2DOptions = {}): HeightLighting2D {
    const lighting = new HeightLighting2D(options);
    const runtime = engineRuntime(instance);
    if (!runtime.gpu || typeof runtime.gpu.createShaderModule !== 'function') {
      throw rangeError('WebGL2 is not supported for @margoengine/lighting2d/height; use WebGPU', 'pixel-lighting');
    }
    runtime.use(lighting);
    return lighting;
  }

  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'HeightLighting2D disposed; create a new one');
    if (engine.backend !== 'webgpu' || !engine.gpu) {
      throw rangeError('WebGL2 is not supported for @margoengine/lighting2d/height; use WebGPU', 'pixel-lighting');
    }
    this.engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.order,
      execute: (c: PassContext) => {
        if (c.backend === 'webgpu') this.render(this.target ?? (c as any).target);
      },
    });
  }

  /** Adds a light to the height lighting pass. */
  addLight(options: HeightLight2DOptions = {}): HeightLight2D {
    if (this.disposed) throw typeError('HeightLighting2D has been disposed', 'pixel-lighting');
    const light = new HeightLight2D(options);
    this.lights.add(light);
    return light;
  }

  /** Removes a light. */
  removeLight(light: HeightLight2D): boolean {
    return this.lights.delete(light);
  }

  /** Sets the active height occluders. */
  setOccluders(occluders: readonly HeightOccluder2D[]): void {
    if (this.disposed) throw typeError('HeightLighting2D has been disposed', 'pixel-lighting');
    for (const o of occluders) checkHeightOccluder(o);
    this.occluders = occluders.map(createHeightOccluder);
  }

  /** Renders the height lighting pass onto target. */
  render(targetTexture: any, commandEncoder?: any): void {
    if (!this.engine || !this.engine.gpu || this.disposed) return;
    const device = this.engine.gpu;
    const target = typeof targetTexture === 'function' ? targetTexture() : targetTexture;
    if (!target) return;

    if (!this.pipeline) {
      const module = device.createShaderModule({ code: HEIGHT_LIGHTING_WGSL });
      this.bindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 112 } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ],
      });
      this.pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [{
            format: target.format ?? 'rgba8unorm',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            },
          }],
        },
      });
    }

    const MAX_OCCLUDERS = 64;
    const occluderBufferSize = Math.max(256, MAX_OCCLUDERS * 48);
    if (!this.storageBuffer) {
      this.storageBuffer = device.createBuffer({
        size: occluderBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }

    const occFloats = new Float32Array(MAX_OCCLUDERS * 12);
    const occU32 = new Uint32Array(occFloats.buffer);
    const count = Math.min(this.occluders.length, MAX_OCCLUDERS);

    for (let i = 0; i < count; i++) {
      const o = this.occluders[i];
      const base = i * 12;
      occFloats[base + 0] = o.offset ? o.offset[0] : 0;
      occFloats[base + 1] = o.offset ? o.offset[1] : 0;

      if (o.shape === 'box') {
        occFloats[base + 2] = (o.width ?? 16) / 2;
        occFloats[base + 3] = (o.depth ?? 16) / 2;
      } else if (o.shape === 'circle') {
        occFloats[base + 2] = o.radius ?? 8;
        occFloats[base + 3] = 0;
      } else if (o.shape === 'segment') {
        occFloats[base + 2] = o.to ? o.to[0] : 0;
        occFloats[base + 3] = o.to ? o.to[1] : 0;
      }

      occFloats[base + 4] = o.rotation ?? 0;
      occFloats[base + 5] = o.elevation ?? 0;
      occFloats[base + 6] = o.height;
      occFloats[base + 7] = 0;

      let shapeCode = 0;
      if (o.shape === 'circle') shapeCode = 1;
      else if (o.shape === 'segment') shapeCode = 2;
      occU32[base + 8] = shapeCode;
      occU32[base + 9] = o.selfShadow !== false ? 1 : 0;
      occU32[base + 10] = 0;
      occU32[base + 11] = 0;
    }

    device.queue.writeBuffer(this.storageBuffer, 0, occFloats);

    if (!this.uniformBuffer) {
      this.uniformBuffer = device.createBuffer({
        size: 112,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    const encoder = commandEncoder ?? device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView ? target.createView() : target,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);

    const uniformFloats = new Float32Array(28);
    const uniformU32 = new Uint32Array(uniformFloats.buffer);

    for (const light of this.lights) {
      if ((light.layers & this.layer) === 0) continue;

      const rgb = hexColor(light.color) ?? [1, 1, 1];
      uniformFloats[0] = light.x;
      uniformFloats[1] = light.y;
      uniformFloats[2] = light.radius;
      uniformFloats[3] = light.falloff;

      uniformFloats[4] = rgb[0];
      uniformFloats[5] = rgb[1];
      uniformFloats[6] = rgb[2];
      uniformFloats[7] = light.intensity;

      uniformFloats[8] = light.height;
      uniformFloats[9] = light.angle;
      uniformFloats[10] = light.cone;
      uniformFloats[11] = light.softness;

      uniformFloats[12] = light.elevation;
      uniformFloats[13] = this.receiverElevation;
      uniformFloats[14] = this.camera.x;
      uniformFloats[15] = this.camera.y;

      uniformFloats[16] = this.camera.zoom;
      uniformFloats[17] = target.width ?? 32;
      uniformFloats[18] = target.height ?? 16;
      uniformFloats[19] = 0;

      let kindCode = 0;
      if (light.kind === 'spot') kindCode = 1;
      else if (light.kind === 'directional') kindCode = 2;

      uniformU32[20] = kindCode;
      uniformU32[21] = light.shadows ? 1 : 0;
      uniformU32[22] = count;
      uniformU32[23] = this.layer;

      uniformU32[24] = light.layers;
      uniformU32[25] = 0;
      uniformU32[26] = 0;
      uniformU32[27] = 0;

      device.queue.writeBuffer(this.uniformBuffer, 0, uniformFloats);

      const bindGroup = device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.storageBuffer } },
        ],
      });

      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
    }

    pass.end();
    if (!commandEncoder) {
      device.queue.submit([encoder.finish()]);
    }
  }

  dispose(): void {
    this[Symbol.dispose]();
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lights.clear();
    this.occluders = [];
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy?.();
      this.uniformBuffer = null;
    }
    if (this.storageBuffer) {
      this.storageBuffer.destroy?.();
      this.storageBuffer = null;
    }
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.engine = null;
  }
}
