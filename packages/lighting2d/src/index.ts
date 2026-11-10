/// <reference lib="esnext.disposable" preserve="true" />
import { MaskData, maskShader } from './masks.js';
import { checkLight, checkCamera, checkLayer, checkNumber } from './validation.js';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { fault, rangeError, typeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; VERTEX: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** A point in world units. */
export type Point2D = readonly [number, number];
/** What a light is: from a point, from a point within a cone, or from far away. */
export type LightKind2D = 'point' | 'spot' | 'directional';

/** A geometric mask restricting or clipping where a light can illuminate. */
export type LightMask2D =
  | { kind: 'rect'; minX: number; minY: number; maxX: number; maxY: number; invert?: boolean }
  | { kind: 'circle'; radius: number; center?: Point2D; invert?: boolean }
  | { kind: 'polygon'; points: readonly Point2D[]; invert?: boolean };

/** Tests whether point (x, y) is inside the given light mask. */
export function inLightMask(mask: LightMask2D, x: number, y: number): boolean {
  let inside = false;
  if (mask.kind === 'rect') {
    inside = x >= mask.minX && x <= mask.maxX && y >= mask.minY && y <= mask.maxY;
  } else if (mask.kind === 'circle') {
    const cx = mask.center ? mask.center[0] : 0,
      cy = mask.center ? mask.center[1] : 0;
    inside = Math.hypot(x - cx, y - cy) <= mask.radius;
  } else if (mask.kind === 'polygon') {
    const pts = mask.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0],
        yi = pts[i][1],
        xj = pts[j][0],
        yj = pts[j][1],
        intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
  }
  return mask.invert ? !inside : inside;
}

/** Tests whether a light affects a target with the given layer bitmask. */
export function lightAffectsLayer(light: { layers?: number }, layerMask: number): boolean {
  return ((light.layers ?? 0xffffffff) & layerMask) !== 0;
}

/** The fields of a {@link Light2D}, each read each frame. Distances are in world units. */
export interface Light2DOptions {
  /** Default `'point'`. */
  kind?: LightKind2D;
  /** Position. Default 0. */
  x?: number;
  /** Position, down the screen. Default 0. */
  y?: number;
  /** `#rrggbb`. Default `#ffffff`. */
  color?: string;
  /** Multiplies the colour, 0 or more. Default 1. */
  intensity?: number;
  /** Point and spot: where the light reaches nothing. Default 64. */
  radius?: number;
  /** Point and spot: the power of `1 - distance / radius`, above 0. Default 2. */
  falloff?: number;
  /** Point and spot: how far in front of the picture it sits, 0 or more; a flat surface gets `height / length`. Default 32. */
  height?: number;
  /** Spot and directional: the way it shines, radians clockwise from +x. Default 0. */
  angle?: number;
  /** Spot: half the cone, radians, above 0. Default `Math.PI / 4`. */
  cone?: number;
  /** Spot: the outer part of the cone that fades, 0 (a hard edge) to 1. Default 0. */
  softness?: number;
  /** Directional: how far above the picture, radians; `Math.PI / 2` is straight on. Default `Math.PI / 4`. */
  elevation?: number;
  /** False lets it through occluders. Default true. */
  shadows?: boolean;
  /** Layer bitmask this light illuminates. Tested with bitwise AND against a target's layer. Default ~0 (all layers). */
  layers?: number;
  /** Geometric mask clipping the light. */
  mask?: LightMask2D;
}

/** One light. Make it with {@link Lighting2D.addLight}; change any field and the next frame shows it. */
export class Light2D implements Required<Omit<Light2DOptions, 'mask'>> {
  declare kind: LightKind2D;
  declare x: number;
  declare y: number;
  declare color: string;
  declare intensity: number;
  declare radius: number;
  declare falloff: number;
  declare height: number;
  declare angle: number;
  declare cone: number;
  declare softness: number;
  declare elevation: number;
  declare shadows: boolean;
  declare layers: number;
  declare mask?: LightMask2D;
  constructor(options: Light2DOptions = {}) {
    this.kind = options.kind ?? 'point';
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.color = options.color ?? '#ffffff';
    this.intensity = options.intensity ?? 1;
    this.radius = options.radius ?? 64;
    this.falloff = options.falloff ?? 2;
    this.height = options.height ?? 32;
    this.angle = options.angle ?? 0;
    this.cone = options.cone ?? Math.PI / 4;
    this.softness = options.softness ?? 0;
    this.elevation = options.elevation ?? Math.PI / 4;
    this.shadows = options.shadows ?? true;
    this.layers = options.layers ?? 0xffffffff;
    this.mask = options.mask;
    checkLight(this);
  }
}

/** Where a directional light comes from, as a unit vector. */
const towards = (l: Light2D): [number, number, number] => [
  -Math.cos(l.angle) * Math.cos(l.elevation),
  -Math.sin(l.angle) * Math.cos(l.elevation),
  Math.sin(l.elevation),
];

/**
 * The CPU form of the pass, for tools and tests: what `light` adds at world point (x, y), as `[r, g, b]` from 0 up, before
 * shadows. `normal` is the surface direction, x right and y down the screen, as a sprite's normal target holds it.
 * If `layer` is specified, verifies `light.layers & layer !== 0`. If `light.mask` is set, verifies point is inside mask.
 */
export function lightAt(
  light: Light2D,
  x: number,
  y: number,
  normal: readonly number[] = [0, 0, 1],
  layer?: number,
): number[] {
  checkLight(light);
  if (layer !== undefined && (light.layers & layer) === 0) return [0, 0, 0];
  if (light.mask && !inLightMask(light.mask, x, y)) return [0, 0, 0];
  const size = Math.hypot(normal[0], normal[1], normal[2]),
    n = normal.map((v) => v / size),
    rgb = hexColor(light.color)!;
  let amount = 1,
    l: readonly number[];
  if (light.kind === 'directional') l = towards(light);
  else {
    const dx = light.x - x,
      dy = light.y - y,
      flat = Math.hypot(dx, dy),
      length = Math.hypot(flat, light.height);
    amount = Math.max(0, 1 - flat / light.radius) ** light.falloff;
    l = length ? [dx / length, dy / length, light.height / length] : n;
    if (light.kind === 'spot') {
      const along = flat ? -(dx * Math.cos(light.angle) + dy * Math.sin(light.angle)) / flat : 1,
        outer = Math.cos(light.cone),
        inner = Math.cos(light.cone * (1 - light.softness));
      amount *= inner > outer ? Math.min(1, Math.max(0, (along - outer) / (inner - outer))) : along >= outer ? 1 : 0;
    }
  }
  const shade = amount * Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) * light.intensity;
  return [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade];
}

/** Something that blocks light. The shapes of a `tileMapColliders` result from `@margoengine/physics2d` fit as they are. */
export type Occluder2D =
  | { shape: 'polygon'; points: readonly Point2D[] }
  | { shape: 'polyline'; points: readonly Point2D[] }
  | { shape: 'segment'; from: Point2D; to: Point2D }
  | { shape: 'box'; width: number; height: number; offset?: Point2D; rotation?: number }
  | { shape: 'circle'; radius: number; offset?: Point2D };

/** How many straight sides a circle occluder has. */
const CIRCLE_SIDES = 24;

/**
 * The edges occluders cast shadows from, `[ax, ay, bx, by]` each. A polygon closes itself; a polyline stays open; a circle
 * has 24 sides. @throws RangeError for another shape or a value that is not finite.
 */
export function occluderEdges(occluders: readonly Occluder2D[]): Float32Array {
  const out: number[] = [],
    chain = (points: readonly Point2D[], closed: boolean) => {
      for (let i = 0; i + 1 < points.length; i++) out.push(...points[i], ...points[i + 1]);
      if (closed && points.length > 2) out.push(...points[points.length - 1], ...points[0]);
    };
  for (const o of occluders) {
    if (o.shape === 'polygon') chain(o.points, true);
    else if (o.shape === 'polyline') chain(o.points, false);
    else if (o.shape === 'segment') out.push(...o.from, ...o.to);
    else if (o.shape === 'box' || o.shape === 'circle') {
      const [cx, cy] = o.offset ?? [0, 0],
        turn = o.shape === 'box' ? (o.rotation ?? 0) : 0,
        cos = Math.cos(turn),
        sin = Math.sin(turn),
        place = (x: number, y: number): Point2D => [cx + x * cos - y * sin, cy + x * sin + y * cos];
      if (o.shape === 'box') {
        const w = o.width / 2,
          h = o.height / 2;
        chain([place(-w, -h), place(w, -h), place(w, h), place(-w, h)], true);
      } else
        chain(
          Array.from({ length: CIRCLE_SIDES }, (_, i) => {
            const t = (i / CIRCLE_SIDES) * Math.PI * 2;
            return place(o.radius * Math.cos(t), o.radius * Math.sin(t));
          }),
          true,
        );
    } else throw rangeError('Unknown occluder shape', 'pixel-lighting');
  }
  if (!out.every(Number.isFinite)) throw rangeError('Invalid occluder value', 'pixel-lighting');
  return Float32Array.from(out);
}

/** The CPU form of the shadow: whether `edges` (see {@link occluderEdges}) keep `light` from world point (x, y). */
export function inShadow(light: Light2D, edges: ArrayLike<number>, x: number, y: number): boolean {
  if (!light.shadows) return false;
  const point = light.kind !== 'directional',
    from = towards(light),
    // The ray from the point to the light: to the light's position, or on forever along where a far light comes from.
    rx = point ? light.x - x : from[0],
    ry = point ? light.y - y : from[1];
  for (let i = 0; i + 3 < edges.length; i += 4) {
    const ax = edges[i] - x,
      ay = edges[i + 1] - y,
      ex = edges[i + 2] - edges[i],
      ey = edges[i + 3] - edges[i + 1],
      across = rx * ey - ry * ex;
    if (!across) continue;
    const t = (ax * ey - ay * ex) / across,
      s = (ax * ry - ay * rx) / across;
    if (t >= 0 && (!point || t <= 1) && s >= 0 && s <= 1) return true;
  }
  return false;
}

const shader = /* wgsl */ `
struct L{view:vec4f,size:vec4f,at:vec4f,way:vec4f,color:vec4f,mask_bounds:vec4f,mask_info:vec4f}
@group(0) @binding(0) var<uniform> u:L;
@group(0) @binding(1) var bumps:texture_2d<f32>;
@group(0) @binding(2) var sum:texture_2d_array<f32>;
@vertex fn wide(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}
fn clip(d:vec2f)->vec2f{return d*u.view.z/u.size.xy*vec2f(2,-2);}
@vertex fn edge(@builtin(vertex_index) i:u32,@location(0) e:vec4f)->@builtin(position) vec4f{
var p=e.xy;
if((i&1u)==1u){p=e.zw;}
if(i<2u){return vec4f(clip(p-u.view.xy)+vec2f(-1,1),0,1);}
return vec4f(clip(p*u.at.w-u.at.xy),0,0);
}
@fragment fn none()->@location(0) vec4f{return vec4f(0);}
@fragment fn show(@builtin(position) f:vec4f)->@location(0) vec4f{let p=vec2i(f.xy);return vec4f(textureLoad(sum,p,0,0).rgb+textureLoad(sum,p,1,0).rgb+textureLoad(sum,p,2,0).rgb+textureLoad(sum,p,3,0).rgb,1);}
@fragment fn lit(@builtin(position) f:vec4f)->@location(0) vec4f{
let world=u.view.xy+f.xy/u.view.z;
if(!maskVisible(world,u.mask_bounds,u.mask_info)){return vec4f(0);}
var n=vec3f(0,0,1);
if(u.size.z>0){
let s=textureLoad(bumps,vec2i(f.xy),0);
if(s.a>0){n=normalize(s.xyz*2-1);}
}
var l=u.at.xyz;
var a=1.0;
if(u.at.w>0){
let d=u.at.xy-world;
let far=length(d);
a=pow(max(0,1-far/u.color.w),u.way.w);
let v=vec3f(d,u.at.z);
l=n;
if(dot(v,v)>0){l=normalize(v);}
if(u.size.w>0){
var c=1.0;
if(far>0){c=-dot(d,u.way.xy)/far;}
if(u.way.z>u.view.w){a*=clamp((c-u.view.w)/(u.way.z-u.view.w),0,1);}
else if(c<u.view.w){a=0;}
}
}
return vec4f(u.color.rgb*a*max(0,dot(n,l)),0);
}`;

/** Bytes per light in the uniform buffer: the largest `minUniformBufferOffsetAlignment` WebGPU allows. */
const STRIDE = 256;
const SUM_FORMAT = 'rgba16float';
/**
 * Layers the lights are shared out over, added up once in the show pass. Each additive blend into half floats rounds,
 * and an Apple M6 always rounds toward zero (99% of 65,536 sums of 43 fit that exactly, none fit round to nearest; an
 * RTX A6000 rounds to nearest): 1.66 levels too dark on average after 43 lights. The rounding step scales with the
 * sum, so four sums of a quarter of the light lose a quarter as much.
 */
const SUM_LAYERS = 4;
const FLOATS = STRIDE / 4;

/** Settings of {@link Lighting2D}. */
export interface Lighting2DOptions {
  /** Where the light goes, such as a pixel layer's `target` with `blend: 'multiply'`. Texture or function. Required. */
  target: GPUTexture | (() => GPUTexture);
  /** Surface directions, the size of the target, such as a sprite layer's `normals.target`. Default flat. */
  normals?: GPUTexture | (() => GPUTexture);
  /** World units to pixels, read each frame, such as a pixel layer's `camera`. Default `{x: 0, y: 0, zoom: 1}`. */
  camera?: { readonly x: number; readonly y: number; readonly zoom: number };
  /** The light everything gets, `#rrggbb`, read each frame through {@link Lighting2D.ambient}. Default `#000000`. */
  ambient?: string;
  /** What blocks light. Default none. */
  occluders?: readonly Occluder2D[];
  /** Frame-graph order. Runs after sprites and maps (10), before a compositor (30). Default 20. */
  order?: number;
  /** Plugin name, unique per scene. Default `lighting2d-1`, `lighting2d-2`, ... */
  name?: string;
  /** Layer bitmask this pass illuminates. Lights must share at least one bit with this layer. Default ~0 (all layers). */
  layer?: number;
}

let count = 0;

/**
 * 2D lights for a pixel picture: point, spot and directional lights with normal-mapped shading and hard shadows from
 * occluder edges. Each frame the lights add up at 16 bits per channel, so many dim ones lose nothing to rounding, and the
 * sum goes to one light target. Show it by multiplying: a pixel layer with `blend: 'multiply'`.
 * WebGPU only.
 * @throws TypeError / RangeError on invalid options or, each frame, an invalid light.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when normals differ in size.
 */
export class Lighting2D implements EnginePlugin {
  declare readonly name: string;
  /** The light everything gets, `#rrggbb`, read each frame. */
  declare ambient: string;
  /** World units to pixels, read each frame. */
  declare camera: { readonly x: number; readonly y: number; readonly zoom: number };
  /** Layer bitmask of this lighting pass. */
  declare layer: number;
  /** The lights, in the order added. Use {@link addLight} and {@link removeLight} to change the list. */
  readonly lights: Light2D[] = [];
  readonly #target: GPUTexture | (() => GPUTexture);
  readonly #normals?: GPUTexture | (() => GPUTexture);
  readonly #order: number;
  #edges: Float32Array = new Float32Array();
  #edgesWritten = false;
  #engine?: Engine;
  #device?: GPUDevice;
  #module?: GPUShaderModule;
  #layout?: GPUBindGroupLayout;
  #pipelines?: GPUPipelineLayout;
  #format?: GPUTextureFormat;
  #light?: GPURenderPipeline;
  #shadow?: GPURenderPipeline;
  #show?: GPURenderPipeline;
  #showGroup?: GPUBindGroup;
  #sum?: GPUTexture;
  #sumView?: GPUTextureView;
  #sumLayers: GPUTextureView[] = [];
  #uniform?: GPUBuffer;
  #values: Float32Array<ArrayBuffer> = new Float32Array(0);
  #edgeBuffer?: GPUBuffer;
  #stencil?: GPUTexture;
  #stencilView?: GPUTextureView;
  #flat?: GPUTexture;
  #group?: GPUBindGroup;
  #masks = new MaskData();
  #disposed = false;

  constructor(options: Lighting2DOptions) {
    if (!options?.target) throw typeError('Lighting2D needs a target', 'pixel-lighting');
    const order = options.order ?? 20;
    checkNumber(order, 'order');
    this.#target = options.target;
    this.#normals = options.normals;
    this.#order = order;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.ambient = options.ambient ?? '#000000';
    this.layer = options.layer ?? 0xffffffff;
    this.name = options.name ?? `lighting2d-${++count}`;
    if (options.occluders) this.setOccluders(options.occluders);
  }
  /** Creates the lighting and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: Lighting2DOptions): Lighting2D {
    const lighting = new Lighting2D(options);
    engineRuntime(instance).use(lighting);
    return lighting;
  }
  /** Adds a light. Change its fields at any time. */
  addLight(options?: Light2DOptions): Light2D {
    const light = new Light2D(options);
    this.lights.push(light);
    return light;
  }
  /** Removes a light; one that is not here is ignored. */
  removeLight(light: Light2D): void {
    const at = this.lights.indexOf(light);
    if (at >= 0) this.lights.splice(at, 1);
  }
  /** Replaces what blocks light, from the next frame. */
  setOccluders(occluders: readonly Occluder2D[]): void {
    this.#edges = occluderEdges(occluders);
    this.#edgesWritten = false;
  }
  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'Lighting2D disposed; create a new one');
    if (engine.backend !== 'webgpu') throw fault('unsupported', 'Lighting2D needs WebGPU', 'webgpu');
    this.#engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.#order,
      execute: (c) => {
        if (c.backend === 'webgpu' && !c.view?.index) this.#run(c);
      },
    });
  }
  onDeviceRestored(): void {
    this.#release();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#engine?.sceneOf(this)?.removePlugin(this.name);
    this.#engine = undefined;
    this.#release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  #release(): void {
    this.#masks.dispose();
    this.#uniform?.destroy();
    this.#edgeBuffer?.destroy();
    this.#stencil?.destroy();
    this.#flat?.destroy();
    this.#sum?.destroy();
    this.#uniform = this.#edgeBuffer = this.#stencil = this.#stencilView = this.#flat = undefined;
    this.#module = this.#layout = this.#pipelines = this.#format = this.#light = this.#shadow = undefined;
    this.#show = this.#showGroup = this.#sum = this.#sumView = undefined;
    this.#sumLayers = [];
    this.#group = this.#device = undefined;
    this.#edgesWritten = false;
  }
  #prepare(device: GPUDevice, target: GPUTextureFormat): void {
    if (this.#device !== device) {
      if (this.#device) this.#release();
      this.#device = device;
    }
    if (!this.#module) {
      this.#module = device.createShaderModule({ label: 'lighting2d', code: maskShader(3) + shader });
      this.#layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 112 },
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ],
      });
      this.#pipelines = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
      this.#flat = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    if (!this.#light) {
      const module = this.#module!,
        layout = this.#pipelines!,
        format = SUM_FORMAT,
        stencil = (compare: GPUCompareFunction, passOp: GPUStencilOperation) => ({
          format: 'stencil8' as const,
          stencilFront: { compare, passOp },
          stencilBack: { compare, passOp },
        });
      this.#light = device.createRenderPipeline({
        label: 'lighting2d light',
        layout,
        vertex: { module, entryPoint: 'wide' },
        fragment: {
          module,
          entryPoint: 'lit',
          targets: [
            {
              format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one' },
                alpha: { srcFactor: 'zero', dstFactor: 'one' },
              },
            },
          ],
        },
        depthStencil: stencil('equal', 'keep'),
      });
      this.#shadow = device.createRenderPipeline({
        label: 'lighting2d shadow',
        layout,
        vertex: {
          module,
          entryPoint: 'edge',
          buffers: [
            {
              arrayStride: 16,
              stepMode: 'instance',
              attributes: [{ format: 'float32x4', offset: 0, shaderLocation: 0 }],
            },
          ],
        },
        fragment: { module, entryPoint: 'none', targets: [{ format, writeMask: 0 }] },
        primitive: { topology: 'triangle-strip' },
        depthStencil: stencil('always', 'replace'),
      });
    }
    if (target !== this.#format) {
      this.#format = target;
      this.#show = device.createRenderPipeline({
        label: 'lighting2d show',
        layout: 'auto',
        vertex: { module: this.#module!, entryPoint: 'wide' },
        fragment: { module: this.#module!, entryPoint: 'show', targets: [{ format: target }] },
      });
      this.#showGroup = undefined;
    }
  }
  #run(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    const device = c.device,
      pick = (texture: GPUTexture | (() => GPUTexture)) => (typeof texture === 'function' ? texture() : texture),
      target = pick(this.#target),
      bump = this.#normals && pick(this.#normals),
      camera = this.camera,
      ambient = hexColor(this.ambient),
      lights = this.lights;
    checkCamera(camera);
    checkLayer(this.layer);
    if (!ambient) throw rangeError('Invalid ambient color: use a hex color such as #rrggbb', 'pixel-lighting');
    if (bump && (bump.width !== target.width || bump.height !== target.height))
      throw fault('state', 'Lighting2D normals differ in size from the target', 'pixel-lighting');
    lights.forEach(checkLight);
    this.#prepare(device, target.format);
    const activeLights = lights.filter((l) => (l.layers & this.layer) !== 0);
    this.#masks.upload(device, activeLights);
    const wanted = Math.max(1, activeLights.length) * FLOATS;
    if (!this.#uniform || this.#values.length < wanted) {
      this.#uniform?.destroy();
      this.#values = new Float32Array(wanted * 2);
      this.#uniform = device.createBuffer({
        label: 'lighting2d',
        size: this.#values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    const shown = bump ?? this.#flat!;
    this.#group = device.createBindGroup({
      layout: this.#layout!,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform, size: 112 } },
        { binding: 1, resource: shown.createView() },
        { binding: 3, resource: { buffer: this.#masks.buffer! } },
      ],
    });
    if (!this.#stencil || this.#stencil.width !== target.width || this.#stencil.height !== target.height) {
      this.#stencil?.destroy();
      this.#sum?.destroy();
      const size = [target.width, target.height];
      this.#stencil = device.createTexture({
        label: 'lighting2d stencil',
        size,
        format: 'stencil8',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.#stencilView = this.#stencil.createView();
      this.#sum = device.createTexture({
        label: 'lighting2d sum',
        size: [size[0], size[1], SUM_LAYERS],
        format: SUM_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.#sumView = this.#sum.createView({ dimension: '2d-array' });
      this.#sumLayers = Array.from({ length: SUM_LAYERS }, (_, baseArrayLayer) =>
        this.#sum!.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 }),
      );
      this.#showGroup = undefined;
    }
    this.#showGroup ??= device.createBindGroup({
      layout: this.#show!.getBindGroupLayout(0),
      entries: [{ binding: 2, resource: this.#sumView! }],
    });
    const edges = this.#edges,
      edgeCount = edges.length / 4;
    if (!this.#edgesWritten) {
      if (edges.length && (!this.#edgeBuffer || this.#edgeBuffer.size < edges.byteLength)) {
        this.#edgeBuffer?.destroy();
        this.#edgeBuffer = device.createBuffer({
          label: 'lighting2d edges',
          size: edges.byteLength * 2,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }
      if (edges.length) device.queue.writeBuffer(this.#edgeBuffer!, 0, edges as Float32Array<ArrayBuffer>);
      this.#edgesWritten = true;
    }
    const values = this.#values;
    activeLights.forEach((l, i) => {
      const rgb = hexColor(l.color)!,
        far = l.kind === 'directional',
        from = far ? towards(l) : [l.x, l.y, l.height];
      values.set(
        [
          camera.x,
          camera.y,
          camera.zoom,
          Math.cos(l.cone),
          target.width,
          target.height,
          bump ? 1 : 0,
          l.kind === 'spot' ? 1 : 0,
          from[0],
          from[1],
          from[2],
          far ? 0 : 1,
          Math.cos(l.angle),
          Math.sin(l.angle),
          Math.cos(l.cone * (1 - l.softness)),
          l.falloff,
          rgb[0] * l.intensity,
          rgb[1] * l.intensity,
          rgb[2] * l.intensity,
          l.radius,
          ...this.#masks.fields[i],
        ],
        i * FLOATS,
      );
    });
    device.queue.writeBuffer(this.#uniform, 0, values);
    this.#sumLayers.forEach((view, layer) =>
      c.encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view,
              loadOp: 'clear',
              clearValue: layer ? [0, 0, 0, 1] : [ambient[0], ambient[1], ambient[2], 1],
              storeOp: 'store',
            },
          ],
        })
        .end(),
    );
    activeLights.forEach((l, i) => {
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: this.#sumLayers[i % SUM_LAYERS]!, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          view: this.#stencilView!,
          stencilLoadOp: 'clear',
          stencilClearValue: 0,
          stencilStoreOp: 'discard',
        },
      });
      pass.setBindGroup(0, this.#group!, [i * STRIDE]);
      if (l.shadows && edgeCount) {
        pass.setPipeline(this.#shadow!);
        pass.setStencilReference(1);
        pass.setVertexBuffer(0, this.#edgeBuffer!);
        pass.draw(4, edgeCount);
      }
      pass.setPipeline(this.#light!);
      pass.setStencilReference(0);
      pass.draw(3);
      pass.end();
    });
    const show = c.encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
    });
    show.setPipeline(this.#show!);
    show.setBindGroup(0, this.#showGroup);
    show.draw(3);
    show.end();
  }
}
