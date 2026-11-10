/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import type { Water } from './index.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/**
 * One lake, pool or river. Give `outline` for a closed shape at one level, or `path` for a river whose centreline,
 * width and level follow a Catmull-Rom spline through its points. Distances are metres, XZ is the ground plane.
 */
export interface WaterBody {
  /** Closed XZ outline of a lake or pool, 3 to 4096 points in either winding; the last point joins the first. */
  outline?: readonly (readonly [number, number])[];
  /** River centreline points [x, level, z], 2 to 4096; the level falls or rises with the spline. */
  path?: readonly (readonly [number, number, number])[];
  /** River width, 0.01 to 10000, one value or one per path point. Default 4. */
  width?: number | readonly number[];
  /** Surface height of an outline body, -1e6 to 1e6. Default 0. Paths carry their own levels. */
  level?: number;
  /** How much of Water's waves this body shows, 0 (a still pool) to 1. Default 1. */
  waves?: number;
  /** Linear RGB body colour, each 0 to 1. Default the Water's own colour. */
  color?: readonly [number, number, number];
}

/** Settings for {@link WaterBodies}; the bodies are copied and rasterized on construction and on `setBodies`. */
export interface WaterBodiesOptions {
  /** Live Water attached to the same engine. Its grid, centred on the world origin, must cover `bounds`. */
  surface: Water;
  /** 1 to 64 bodies. Where two overlap the later one covers the earlier one. */
  bodies: readonly WaterBody[];
  /** Body map texels along the longer side of the bounds, integer 16 to 2048. Default 256. */
  resolution?: number;
}

/** What the body map holds at one point; the same bilinear sample the GPU draws with. */
export interface WaterBodySample {
  /** Index of the nearest body in `bodies`. */
  readonly body: number;
  /** Signed distance to that body's edge in metres: positive inside, negative outside (water is not drawn there). */
  readonly distance: number;
  /** Still surface height of the body there, before waves. */
  readonly level: number;
  /** Wave scale there, 0 to 1. */
  readonly waves: number;
}

const MAX_BODIES = 64;
const SPAN_STEPS = 16;
// Texel visits times segments; past this the CPU rasterization takes seconds.
const MAX_WORK = 4e8;

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  // Half widths and levels at both ends; outlines use zero half width and one level.
  wa: number;
  wb: number;
  la: number;
  lb: number;
}
interface Flat {
  closed: boolean;
  segments: Segment[];
  waves: number;
  low: [number, number];
  high: [number, number];
}

const finite = (v: unknown, low: number, high: number, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < low || v > high)
    throw rangeError(`Invalid water body ${name}; pass a number in ${low}..${high}`, 'geometry');
  return v;
};

// Uniform Catmull-Rom (E. Catmull and R. Rom, "A Class of Local Interpolating Splines", 1974) through the points,
// with the end points repeated so the curve starts and ends on them.
function catmullRom(points: readonly (readonly number[])[], steps: number): number[][] {
  const out: number[][] = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)],
      p1 = points[i],
      p2 = points[i + 1],
      p3 = points[Math.min(n - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps,
        t2 = t * t,
        t3 = t2 * t;
      out.push(
        p1.map(
          (_, k) =>
            0.5 *
            (2 * p1[k] +
              (p2[k] - p0[k]) * t +
              (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
              (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3),
        ),
      );
    }
  }
  out.push([...points[n - 1]]);
  return out;
}

function flatten(body: WaterBody, index: number): Flat {
  if (!body || typeof body !== 'object') throw rangeError(`Water body ${index} must be an object`, 'geometry');
  const { outline, path } = body;
  if ((outline === undefined) === (path === undefined))
    throw rangeError(`Water body ${index} needs exactly one of outline or path; pass one`, 'geometry');
  const waves = finite(body.waves ?? 1, 0, 1, 'waves');
  if (body.color !== undefined) {
    if (!Array.isArray(body.color) || body.color.length !== 3)
      throw rangeError(`Invalid water body ${index} color; pass linear [r, g, b]`, 'geometry');
    for (const c of body.color) finite(c, 0, 1, 'color');
  }
  const segments: Segment[] = [];
  if (outline) {
    if (body.width !== undefined)
      throw rangeError(`Water body ${index} width applies to a path; remove it from the outline`, 'geometry');
    const level = finite(body.level ?? 0, -1e6, 1e6, 'level');
    if (!Array.isArray(outline) || outline.length < 3 || outline.length > 4096)
      throw rangeError(`Water body ${index} outline needs 3 to 4096 [x, z] points`, 'geometry');
    let area = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i],
        b = outline[(i + 1) % outline.length];
      if (a?.length !== 2) throw rangeError(`Water body ${index} outline points must be [x, z] pairs`, 'geometry');
      finite(a[0], -1e7, 1e7, 'outline x');
      finite(a[1], -1e7, 1e7, 'outline z');
      area += a[0] * b[1] - b[0] * a[1];
      segments.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], wa: 0, wb: 0, la: level, lb: level });
    }
    if (!(Math.abs(area) > 1e-9))
      throw rangeError(`Water body ${index} outline has no area; pass points that enclose a shape`, 'geometry');
  } else {
    if (body.level !== undefined)
      throw rangeError(`Water body ${index} path carries levels in its points; remove level`, 'geometry');
    if (!Array.isArray(path) || path.length < 2 || path.length > 4096)
      throw rangeError(`Water body ${index} path needs 2 to 4096 [x, level, z] points`, 'geometry');
    const width = body.width ?? 4;
    const widths = typeof width === 'number' ? path.map(() => width) : width;
    if (!Array.isArray(widths) || widths.length !== path.length)
      throw rangeError(`Water body ${index} width needs one number or one per path point`, 'geometry');
    const points = path.map((p, i) => {
      if (p?.length !== 3) throw rangeError(`Water body ${index} path points must be [x, level, z]`, 'geometry');
      return [
        finite(p[0], -1e7, 1e7, 'path x'),
        finite(p[2], -1e7, 1e7, 'path z'),
        finite(p[1], -1e6, 1e6, 'path level'),
        finite(widths[i], 0.01, 10000, 'width') / 2,
      ];
    });
    const curve = catmullRom(points, SPAN_STEPS);
    for (let i = 0; i < curve.length - 1; i++) {
      const a = curve[i],
        b = curve[i + 1];
      // A spline overshoot cannot make a negative width.
      segments.push({
        ax: a[0],
        az: a[1],
        bx: b[0],
        bz: b[1],
        la: a[2],
        lb: b[2],
        wa: Math.max(0.005, a[3]),
        wb: Math.max(0.005, b[3]),
      });
    }
  }
  const low: [number, number] = [Infinity, Infinity],
    high: [number, number] = [-Infinity, -Infinity];
  for (const s of segments) {
    const w = Math.max(s.wa, s.wb);
    low[0] = Math.min(low[0], s.ax - w, s.bx - w);
    low[1] = Math.min(low[1], s.az - w, s.bz - w);
    high[0] = Math.max(high[0], s.ax + w, s.bx + w);
    high[1] = Math.max(high[1], s.az + w, s.bz + w);
  }
  return { closed: !!outline, segments, waves, low, high };
}

// Signed distance (positive inside) and level of one body at (x, z).
function measure(body: Flat, x: number, z: number): [number, number] {
  let best = -Infinity,
    level = 0,
    nearest = Infinity,
    inside = false;
  for (const s of body.segments) {
    const dx = s.bx - s.ax,
      dz = s.bz - s.az,
      length = dx * dx + dz * dz;
    const t = length > 0 ? Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / length)) : 0;
    const d = Math.hypot(x - s.ax - t * dx, z - s.az - t * dz);
    if (body.closed) {
      // Even-odd crossing test along +X (W. R. Franklin's point-in-polygon rule).
      if (s.az > z !== s.bz > z && x < s.ax + ((z - s.az) * dx) / dz) inside = !inside;
      if (d < nearest) {
        nearest = d;
        level = s.la;
      }
    } else {
      const sd = s.wa + (s.wb - s.wa) * t - d;
      if (sd > best) {
        best = sd;
        level = s.la + (s.lb - s.la) * t;
      }
    }
  }
  return body.closed ? [inside ? nearest : -nearest, level] : [best, level];
}

/** The rasterized body map: corner-sampled texels from `origin`, `cell` metres apart, four floats each. */
export interface WaterBodyMap {
  readonly origin: readonly [number, number];
  readonly cell: number;
  readonly width: number;
  readonly height: number;
  /** Per texel: signed distance, level, wave scale, body index. */
  readonly data: Float32Array;
}

/** Rasterize bodies into the map WaterBodies draws from. Pure CPU; exported for tools and tests. */
export function rasterizeWaterBodies(bodies: readonly WaterBody[], resolution = 256): WaterBodyMap {
  if (!Array.isArray(bodies) || bodies.length < 1 || bodies.length > MAX_BODIES)
    throw rangeError(
      `Water bodies need 1 to ${MAX_BODIES} bodies; split larger sets across Water surfaces`,
      'geometry',
    );
  finite(resolution, 16, 2048, 'resolution');
  if (!Number.isInteger(resolution)) throw rangeError('Water body resolution must be an integer 16..2048', 'geometry');
  const flats = bodies.map(flatten);
  const low = [Math.min(...flats.map((f) => f.low[0])), Math.min(...flats.map((f) => f.low[1]))];
  const high = [Math.max(...flats.map((f) => f.high[0])), Math.max(...flats.map((f) => f.high[1]))];
  // Two texels of margin on every side keep the shoreline (distance zero) inside the map.
  const cell = Math.max(high[0] - low[0], high[1] - low[1]) / (resolution - 5);
  const origin: [number, number] = [low[0] - 2 * cell, low[1] - 2 * cell];
  const width = Math.min(resolution, Math.ceil((high[0] - low[0]) / cell) + 5),
    height = Math.min(resolution, Math.ceil((high[1] - low[1]) / cell) + 5);
  const work = width * height * flats.reduce((n, f) => n + f.segments.length, 0);
  if (work > MAX_WORK)
    throw rangeError(
      'Water bodies are too detailed to rasterize; lower resolution or use fewer outline and path points',
      'geometry',
    );
  const data = new Float32Array(width * height * 4);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const x = origin[0] + i * cell,
        z = origin[1] + j * cell;
      let best = -Infinity,
        level = 0,
        index = 0;
      for (let b = 0; b < flats.length; b++) {
        const f = flats[b];
        // A body can only win where its distance bound beats the best so far.
        const gap = Math.hypot(Math.max(0, f.low[0] - x, x - f.high[0]), Math.max(0, f.low[1] - z, z - f.high[1]));
        if (gap > 0 && -gap <= best) continue;
        const [sd, l] = measure(f, x, z);
        // Inside, a later body covers earlier ones (a pool in a lake); outside all, the nearest edge decides.
        if (sd > best || sd > 0) {
          best = sd;
          level = l;
          index = b;
        }
      }
      data.set([best, level, flats[index].waves, index], (j * width + i) * 4);
    }
  return Object.freeze({ origin: Object.freeze(origin), cell, width, height, data });
}

/** Bilinear sample of a body map, clamped to its edge texels, as the WGSL `bodySample` reads it. */
export function sampleWaterBodies(map: WaterBodyMap, x: number, z: number): WaterBodySample {
  const px = Math.min(map.width - 1, Math.max(0, (x - map.origin[0]) / map.cell)),
    pz = Math.min(map.height - 1, Math.max(0, (z - map.origin[1]) / map.cell));
  const i = Math.floor(px),
    j = Math.floor(pz),
    tx = px - i,
    tz = pz - j;
  const at = (a: number, b: number, k: number) =>
    map.data[(Math.min(map.height - 1, b) * map.width + Math.min(map.width - 1, a)) * 4 + k];
  const lerp = (k: number) =>
    (at(i, j, k) * (1 - tx) + at(i + 1, j, k) * tx) * (1 - tz) +
    (at(i, j + 1, k) * (1 - tx) + at(i + 1, j + 1, k) * tx) * tz;
  return Object.freeze({
    body: at(Math.round(px), Math.round(pz), 3),
    distance: lerp(0),
    level: lerp(1),
    waves: lerp(2),
  });
}

function bodyShader(code: string, binding: number): string {
  const marks = ['if(inCoast(xz)){', 'if(dry){discard;}', 'frame.color.rgb*(vec3f(1)-transmission)'];
  for (const mark of marks)
    if (code.split(mark).length !== 2)
      throw fault('failed', 'Water bodies cannot find the Water surface shader; use matching water package versions');
  const prefix = `
struct BodyFrame {region:vec4f,colors:array<vec4f,${MAX_BODIES}>}
@group(0) @binding(${binding}) var<uniform> bodyFrame:BodyFrame;
@group(0) @binding(${binding + 1}) var bodyMap:texture_2d<f32>;
fn bodyTexel(p:vec2i)->vec4f {return textureLoad(bodyMap,clamp(p,vec2i(0),vec2i(textureDimensions(bodyMap))-1),0);}
fn bodyPoint(xz:vec2f)->vec2f {return clamp((xz-bodyFrame.region.xy)/bodyFrame.region.z,vec2f(0),vec2f(textureDimensions(bodyMap)-1u));}
// (signed distance, level, wave scale, body index), bilinear between corner-sampled texels.
fn bodySample(xz:vec2f)->vec4f {
 let p=bodyPoint(xz);let lo=vec2i(floor(p));let t=p-floor(p);
 return mix(mix(bodyTexel(lo),bodyTexel(lo+vec2i(1,0)),t.x),mix(bodyTexel(lo+vec2i(0,1)),bodyTexel(lo+vec2i(1,1)),t.x),t.y);
}
fn bodyTint(xz:vec2f)->vec3f {let c=bodyFrame.colors[u32(bodyTexel(vec2i(round(bodyPoint(xz)))).w)];return select(frame.color.rgb,c.rgb,c.w>0.5);}
`;
  return (
    prefix +
    code
      .replace(
        'if(inCoast(xz)){',
        // Each body lifts the grid to its own level, scales Water's waves by its own share and tilts the normal by the
        // level's slope (central differences one texel apart), before any coastal blending.
        `{let b=bodySample(xz);let e=bodyFrame.region.z;let base=vec3f(xz.x,frame.settings.y,xz.y);
 let gx=(bodySample(xz+vec2f(e,0)).y-bodySample(xz-vec2f(e,0)).y)/(2.0*e);let gz=(bodySample(xz+vec2f(0,e)).y-bodySample(xz-vec2f(0,e)).y)/(2.0*e);
 p=vec3f(xz.x,b.y,xz.y)+(p-base)*b.z;tangent=vec3f(1,gx,0)+(tangent-vec3f(1,0,0))*b.z;binormal=vec3f(0,gz,1)+(binormal-vec3f(0,0,1))*b.z;crest*=b.z;}
 if(inCoast(xz)){`,
      )
      .replace('if(dry){discard;}', 'if(dry||bodySample(i.xz).x<0.0){discard;}')
      .replace('frame.color.rgb*(vec3f(1)-transmission)', 'bodyTint(i.xz)*(vec3f(1)-transmission)')
  );
}

let sequence = 0;

/**
 * Lakes, pools and rivers on one Water: each body has its own outline or spline, level, wave share and colour, and
 * water is drawn only inside them. Geometry and WaveQuery heights include the bodies.
 */
export class WaterBodies implements EnginePlugin {
  readonly name = `water:bodies-${sequence++}`;
  private readonly surface: Water;
  private readonly resolution: number;
  private list: readonly WaterBody[] = [];
  private map!: WaterBodyMap;
  private readonly values = new Float32Array(4 + MAX_BODIES * 4);
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private texture?: GPUTexture;
  private resources: GPUBindingResource[] = [];
  private uploaded = false;
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;

  constructor(options: WaterBodiesOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function')
      throw fault('state', 'Water bodies need a Water surface; pass options.surface');
    this.surface = options.surface;
    this.resolution = options.resolution ?? 256;
    this.setBodies(options.bodies);
  }
  /** Attach after the Water surface. */
  static attach(engine: EngineKernel, options: WaterBodiesOptions): WaterBodies {
    const value = new WaterBodies(options);
    engineRuntime(engine).use(value);
    return value;
  }
  /** The bodies in use (copies). */
  get bodies(): readonly WaterBody[] {
    return this.list;
  }
  /** World XZ rectangle the body map covers; Water's origin-centred grid should reach it. */
  get bounds(): { readonly origin: readonly [number, number]; readonly size: readonly [number, number] } {
    const m = this.map;
    return { origin: m.origin, size: [(m.width - 1) * m.cell, (m.height - 1) * m.cell] };
  }
  /** Replace every body; validates and rasterizes on the CPU, uploads on the next draw. */
  setBodies(bodies: readonly WaterBody[]): this {
    this.live();
    const map = rasterizeWaterBodies(bodies, this.resolution);
    this.list = Object.freeze(
      bodies.map((b) =>
        Object.freeze({
          ...b,
          outline: b.outline?.map((p) => [p[0], p[1]] as const),
          path: b.path?.map((p) => [p[0], p[1], p[2]] as const),
          width: Array.isArray(b.width) ? [...b.width] : b.width,
          color: b.color ? ([...b.color] as [number, number, number]) : undefined,
        }),
      ),
    );
    this.map = map;
    this.values.fill(0);
    this.values.set([map.origin[0], map.origin[1], map.cell, 0]);
    bodies.forEach((b, i) => b.color && this.values.set([...b.color, 1], 4 + i * 4));
    this.uploaded = false;
    return this;
  }
  /** The body map at a world point, as the GPU samples it. */
  sample(x: number, z: number): WaterBodySample {
    this.live();
    finite(x, -1e7, 1e7, 'x');
    finite(z, -1e7, 1e7, 'z');
    return sampleWaterBodies(this.map, x, z);
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Water bodies already attached; create another WaterBodies', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'Water bodies need WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(this.surface.name))
      throw fault('state', 'Attach the Water surface to this engine before WaterBodies');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'bodies'))
      throw fault('attached', 'Water already has bodies; dispose them or call setBodies on the attached one', 'state');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uploaded = false;
    this.remove = addSurfaceEffect(this.surface, {
      key: 'bodies',
      vertex: true,
      count: 2,
      // Wave velocity follows each body's wave share; levels are still.
      velocity: 'waveVelocity(base,width)*(bodySample(base).z-1.0)',
      shader: bodyShader,
      prepare: (c) => this.prepare(c),
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
  }
  private prepare(c: Context): readonly GPUBindingResource[] {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'Water bodies and Water must use the same engine; attach both to one engine');
    if (!this.uploaded) {
      const m = this.map;
      if (this.texture?.width !== m.width || this.texture.height !== m.height) {
        this.texture?.destroy();
        this.texture = c.device.createTexture({
          size: [m.width, m.height],
          format: 'rgba32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.resources = [{ buffer: this.uniform! }, this.texture.createView()];
      }
      c.device.queue.writeTexture({ texture: this.texture }, m.data, { bytesPerRow: m.width * 16 }, [
        m.width,
        m.height,
      ]);
      c.device.queue.writeBuffer(this.uniform!, 0, this.values);
      this.uploaded = true;
    }
    return this.resources;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Water bodies disposed; create another WaterBodies');
  }
  private release(): void {
    this.remove?.();
    this.removeDispose?.();
    this.remove = this.removeDispose = undefined;
    this.uniform?.destroy();
    this.texture?.destroy();
    this.uniform = this.texture = undefined;
    this.resources = [];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
