/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import {
  Light2D,
  type Light2DOptions,
  type LightKind2D,
  type Lighting2DOptions,
  type Occluder2D,
  type Point2D,
  occluderEdges,
  lightAt,
} from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Options for one {@link SoftLight2D}: the plain light options plus its penumbra size and ray samples. */
export interface SoftLight2DOptions extends Light2DOptions {
  /** Light emitter radius in world units for penumbra softening; 0 is hard shadow. Default 4. */
  sourceRadius?: number;
  /** Filter ray samples across the penumbra on GPU and CPU. Default 16. */
  samples?: number;
}

/** One 2D light with soft penumbra properties. */
export class SoftLight2D extends Light2D {
  sourceRadius: number;
  samples: number;
  constructor(options: SoftLight2DOptions = {}) {
    super(options);
    this.sourceRadius = options.sourceRadius ?? 4;
    this.samples = options.samples ?? 16;
    checkSoftLight(this);
  }
}

const invalid = () => rangeError('Invalid light value', 'pixel-lighting');

function checkSoftLight(l: SoftLight2D): void {
  if (
    !Number.isFinite(l.sourceRadius) ||
    l.sourceRadius < 0 ||
    !Number.isFinite(l.samples) ||
    l.samples < 1 ||
    l.samples > 64
  ) {
    throw invalid();
  }
}

/** Where a directional light comes from, as a unit vector. */
const towards = (l: Light2D): [number, number, number] => [
  -Math.cos(l.angle) * Math.cos(l.elevation),
  -Math.sin(l.angle) * Math.cos(l.elevation),
  Math.sin(l.elevation),
];

/** Options for evaluating soft shadow factor. */
export interface SoftShadowOptions {
  /** Radius of the light emitter in world units; 0 yields hard shadows. Default 4. */
  sourceRadius?: number;
  /** Number of radial ray samples. Default 16. */
  samples?: number;
}

/**
 * Computes visibility in [0, 1] of `light` from point (x, y) taking occluder edges into account.
 * Penumbra edges soften with distance from the occluder.
 */
export function softShadowFactor(
  light: Light2D,
  edges: ArrayLike<number>,
  x: number,
  y: number,
  options?: SoftShadowOptions,
): number {
  if (!light.shadows || edges.length < 4) return 1;
  const radius = options?.sourceRadius ?? (light as SoftLight2D).sourceRadius ?? 4;
  const samples = Math.max(1, Math.min(64, Math.round(options?.samples ?? (light as SoftLight2D).samples ?? 16)));
  const isPoint = light.kind !== 'directional';
  let thetaL = 0;
  let dL = 0;

  if (isPoint) {
    const dx = light.x - x;
    const dy = light.y - y;
    dL = Math.hypot(dx, dy);
    if (radius > 0 && dL <= radius) return 1;
    thetaL = Math.atan2(dy, dx);
  } else {
    const from = towards(light);
    thetaL = Math.atan2(from[1], from[0]);
  }

  let alphaL = 0;
  if (isPoint) {
    if (radius > 0 && dL > radius) {
      alphaL = Math.asin(Math.min(0.9999, radius / dL));
    }
  } else {
    alphaL = Math.max(0.001, radius);
  }

  if (alphaL <= 0 || samples === 1) {
    // Single ray test (hard shadow limit)
    const rx = Math.cos(thetaL);
    const ry = Math.sin(thetaL);
    for (let i = 0; i + 3 < edges.length; i += 4) {
      const ax = edges[i] - x;
      const ay = edges[i + 1] - y;
      const ex = edges[i + 2] - edges[i];
      const ey = edges[i + 3] - edges[i + 1];
      const across = rx * ey - ry * ex;
      if (Math.abs(across) < 1e-6) continue;
      const t = (ax * ey - ay * ex) / across;
      const s = (ax * ry - ay * rx) / across;
      if (t >= 0 && (!isPoint || t <= dL) && s >= 0 && s <= 1) return 0;
    }
    return 1;
  }

  let unblocked = 0;
  for (let k = 0; k < samples; k++) {
    const frac = (k + 0.5) / samples;
    const angle = thetaL - alphaL + 2 * alphaL * frac;
    const rx = Math.cos(angle);
    const ry = Math.sin(angle);
    let hit = false;
    for (let i = 0; i + 3 < edges.length; i += 4) {
      const ax = edges[i] - x;
      const ay = edges[i + 1] - y;
      const ex = edges[i + 2] - edges[i];
      const ey = edges[i + 3] - edges[i + 1];
      const across = rx * ey - ry * ex;
      if (Math.abs(across) < 1e-6) continue;
      const t = (ax * ey - ay * ex) / across;
      const s = (ax * ry - ay * rx) / across;
      if (t >= 0 && (!isPoint || t <= dL) && s >= 0 && s <= 1) {
        hit = true;
        break;
      }
    }
    if (!hit) unblocked++;
  }
  return unblocked / samples;
}

/** Whether a point is completely in shadow (visibility is 0). */
export function softInShadow(
  light: Light2D,
  edges: ArrayLike<number>,
  x: number,
  y: number,
  options?: SoftShadowOptions,
): boolean {
  return softShadowFactor(light, edges, x, y, options) === 0;
}

/** Computes what `light` adds at world point (x, y) with soft penumbra shadows applied. */
export function softLightAt(
  light: Light2D,
  x: number,
  y: number,
  edges: ArrayLike<number>,
  normal: readonly number[] = [0, 0, 1],
  options?: SoftShadowOptions,
): number[] {
  const base = lightAt(light, x, y, normal);
  const factor = softShadowFactor(light, edges, x, y, options);
  return [base[0] * factor, base[1] * factor, base[2] * factor];
}

const shader = /* wgsl */ `
struct L {
  view: vec4f,
  size: vec4f,
  at: vec4f,
  way: vec4f,
  color: vec4f,
  soft: vec4f,
}
@group(0) @binding(0) var<uniform> u: L;
@group(0) @binding(1) var bumps: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> edges: array<vec4f>;
@group(0) @binding(3) var sum: texture_2d_array<f32>;

@vertex fn wide(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}

@fragment fn show(@builtin(position) f: vec4f) -> @location(0) vec4f {
  let p = vec2i(f.xy);
  return vec4f(
    textureLoad(sum, p, 0, 0).rgb +
    textureLoad(sum, p, 1, 0).rgb +
    textureLoad(sum, p, 2, 0).rgb +
    textureLoad(sum, p, 3, 0).rgb,
    1.0
  );
}

@fragment fn lit(@builtin(position) f: vec4f) -> @location(0) vec4f {
  let world = u.view.xy + f.xy / u.view.z;
  var n = vec3f(0.0, 0.0, 1.0);
  if (u.size.z > 0.0) {
    let s = textureLoad(bumps, vec2i(f.xy), 0);
    if (s.a > 0.0) { n = normalize(s.xyz * 2.0 - 1.0); }
  }
  var l = u.at.xyz;
  var a = 1.0;
  let isPoint = u.at.w > 0.0;
  var dL = 0.0;
  var thetaL = 0.0;
  if (isPoint) {
    let d = u.at.xy - world;
    dL = length(d);
    a = pow(max(0.0, 1.0 - dL / u.color.w), u.way.w);
    let v = vec3f(d, u.at.z);
    l = n;
    if (dot(v, v) > 0.0) { l = normalize(v); }
    if (u.size.w > 0.0) {
      var c = 1.0;
      if (dL > 0.0) { c = -dot(d, u.way.xy) / dL; }
      if (u.way.z > u.view.w) { a *= clamp((c - u.view.w) / (u.way.z - u.view.w), 0.0, 1.0); }
      else if (c < u.view.w) { a = 0.0; }
    }
    thetaL = atan2(d.y, d.x);
  } else {
    thetaL = atan2(u.at.y, u.at.x);
  }

  var vis = 1.0;
  let hasShadows = u.soft.w > 0.5;
  let edgeCount = u32(u.soft.y);
  if (hasShadows && edgeCount > 0u && a > 0.0) {
    let sourceRadius = u.soft.x;
    let samples = max(1u, min(64u, u32(u.soft.z)));
    var alphaL = 0.0;
    if (isPoint) {
      if (dL > sourceRadius && sourceRadius > 0.0) {
        alphaL = asin(clamp(sourceRadius / dL, 0.0, 0.9999));
      }
    } else {
      alphaL = max(0.001, sourceRadius);
    }

    if (alphaL > 0.0 && samples > 1u) {
      var unblocked = 0u;
      for (var k = 0u; k < samples; k++) {
        let frac = (f32(k) + 0.5) / f32(samples);
        let angle = thetaL - alphaL + 2.0 * alphaL * frac;
        let rx = cos(angle);
        let ry = sin(angle);
        var hit = false;
        for (var e = 0u; e < edgeCount; e++) {
          let seg = edges[e];
          let ax = seg.x - world.x;
          let ay = seg.y - world.y;
          let ex = seg.z - seg.x;
          let ey = seg.w - seg.y;
          let across = rx * ey - ry * ex;
          if (abs(across) > 1e-6) {
            let t = (ax * ey - ay * ex) / across;
            let s = (ax * ry - ay * rx) / across;
            if (t >= 0.0 && (!isPoint || t <= dL) && s >= 0.0 && s <= 1.0) {
              hit = true;
              break;
            }
          }
        }
        if (!hit) { unblocked++; }
      }
      vis = f32(unblocked) / f32(samples);
    } else {
      let rx = cos(thetaL);
      let ry = sin(thetaL);
      var hit = false;
      for (var e = 0u; e < edgeCount; e++) {
        let seg = edges[e];
        let ax = seg.x - world.x;
        let ay = seg.y - world.y;
        let ex = seg.z - seg.x;
        let ey = seg.w - seg.y;
        let across = rx * ey - ry * ex;
        if (abs(across) > 1e-6) {
          let t = (ax * ey - ay * ex) / across;
          let s = (ax * ry - ay * rx) / across;
          if (t >= 0.0 && (!isPoint || t <= dL) && s >= 0.0 && s <= 1.0) {
            hit = true;
            break;
          }
        }
      }
      if (hit) { vis = 0.0; }
    }
  }

  let shade = a * vis * max(0.0, dot(n, l));
  return vec4f(u.color.rgb * shade, 0.0);
}
`;

const STRIDE = 256;
const SUM_FORMAT = 'rgba16float';
const SUM_LAYERS = 4;
const FLOATS = STRIDE / 4;

/** Options for {@link SoftLighting2D}: the plain lighting options plus the default penumbra size and ray samples. */
export interface SoftLighting2DOptions extends Lighting2DOptions {
  /** Default light emitter radius in world units for penumbra softening. Default 4. */
  sourceRadius?: number;
  /** Number of radial ray samples on GPU and CPU. Default 16. */
  samples?: number;
}

let count = 0;

/**
 * 2D lighting with soft penumbra shadows that soften with distance from the occluder.
 * WebGPU only.
 */
export class SoftLighting2D implements EnginePlugin {
  readonly name: string;
  ambient: string;
  camera: { readonly x: number; readonly y: number; readonly zoom: number };
  sourceRadius: number;
  samples: number;
  readonly lights: SoftLight2D[] = [];
  readonly #target: GPUTexture | (() => GPUTexture);
  readonly #normals?: GPUTexture | (() => GPUTexture);
  readonly #order: number;
  #edges: Float32Array = new Float32Array();
  #edgesWritten = false;
  #engine?: Engine;
  #device?: GPUDevice;
  #module?: GPUShaderModule;
  #layout?: GPUBindGroupLayout;
  #showLayout?: GPUBindGroupLayout;
  #pipelines?: GPUPipelineLayout;
  #format?: GPUTextureFormat;
  #light?: GPURenderPipeline;
  #show?: GPURenderPipeline;
  #showGroup?: GPUBindGroup;
  #sum?: GPUTexture;
  #sumView?: GPUTextureView;
  #sumLayers: GPUTextureView[] = [];
  #uniform?: GPUBuffer;
  #values: Float32Array<ArrayBuffer> = new Float32Array(0);
  #edgeBuffer?: GPUBuffer;
  #flat?: GPUTexture;
  #group?: GPUBindGroup;
  #groupBump?: GPUTexture;
  #disposed = false;

  constructor(options: SoftLighting2DOptions) {
    if (!options?.target) throw typeError('Lighting2D needs a target', 'pixel-lighting');
    const order = options.order ?? 20;
    if (!Number.isFinite(order)) throw invalid();
    this.#target = options.target;
    this.#normals = options.normals;
    this.#order = order;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.ambient = options.ambient ?? '#000000';
    this.sourceRadius = options.sourceRadius ?? 4;
    this.samples = options.samples ?? 16;
    this.name = options.name ?? `soft-lighting2d-${++count}`;
    if (options.occluders) this.setOccluders(options.occluders);
  }

  static attach(instance: EngineKernel, options: SoftLighting2DOptions): SoftLighting2D {
    const lighting = new SoftLighting2D(options);
    engineRuntime(instance).use(lighting);
    return lighting;
  }

  addLight(options?: SoftLight2DOptions): SoftLight2D {
    const light = new SoftLight2D({
      sourceRadius: this.sourceRadius,
      samples: this.samples,
      ...options,
    });
    this.lights.push(light);
    return light;
  }

  removeLight(light: SoftLight2D): void {
    const at = this.lights.indexOf(light);
    if (at >= 0) this.lights.splice(at, 1);
  }

  setOccluders(occluders: readonly Occluder2D[]): void {
    this.#edges = occluderEdges(occluders);
    this.#edgesWritten = false;
  }

  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'SoftLighting2D disposed; create a new one');
    if (engine.backend !== 'webgpu') throw fault('unsupported', 'SoftLighting2D needs WebGPU', 'webgpu');
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
    this.#engine?.removePlugin(this.name);
    this.#engine = undefined;
    this.#release();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  #release(): void {
    this.#uniform?.destroy();
    this.#edgeBuffer?.destroy();
    this.#flat?.destroy();
    this.#sum?.destroy();
    this.#uniform = this.#edgeBuffer = this.#flat = undefined;
    this.#module = this.#layout = this.#pipelines = this.#format = this.#light = undefined;
    this.#show = this.#showGroup = this.#sum = this.#sumView = undefined;
    this.#sumLayers = [];
    this.#group = this.#groupBump = this.#device = undefined;
    this.#edgesWritten = false;
  }

  #prepare(device: GPUDevice, target: GPUTextureFormat): void {
    if (this.#device !== device) {
      if (this.#device) this.#release();
      this.#device = device;
    }
    if (!this.#module) {
      this.#module = device.createShaderModule({ label: 'soft-lighting2d', code: shader });
      this.#layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 },
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
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
        format = SUM_FORMAT;
      this.#light = device.createRenderPipeline({
        label: 'soft-lighting2d light',
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
      });
    }
    if (target !== this.#format) {
      this.#format = target;
      this.#show = device.createRenderPipeline({
        label: 'soft-lighting2d show',
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
    if (!ambient || !(camera.zoom > 0) || !Number.isFinite(camera.x) || !Number.isFinite(camera.y)) throw invalid();
    if (bump && (bump.width !== target.width || bump.height !== target.height))
      throw fault('state', 'Lighting2D normals differ in size from the target', 'pixel-lighting');
    lights.forEach(checkSoftLight);
    this.#prepare(device, target.format);

    const wanted = Math.max(1, lights.length) * FLOATS;
    if (!this.#uniform || this.#values.length < wanted) {
      this.#uniform?.destroy();
      this.#values = new Float32Array(wanted * 2);
      this.#uniform = device.createBuffer({
        label: 'soft-lighting2d',
        size: this.#values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.#group = undefined;
    }

    const edges = this.#edges;
    const edgeCount = edges.length / 4;
    const edgeBytes = Math.max(16, edges.byteLength);
    if (!this.#edgeBuffer || this.#edgeBuffer.size < edgeBytes) {
      this.#edgeBuffer?.destroy();
      this.#edgeBuffer = device.createBuffer({
        label: 'soft-lighting2d edges',
        size: edgeBytes * 2,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#edgesWritten = false;
      this.#group = undefined;
    }
    if (!this.#edgesWritten) {
      if (edges.length) {
        device.queue.writeBuffer(this.#edgeBuffer!, 0, edges as Float32Array<ArrayBuffer>);
      } else {
        device.queue.writeBuffer(this.#edgeBuffer!, 0, new Float32Array(4));
      }
      this.#edgesWritten = true;
    }

    const shown = bump ?? this.#flat!;
    if (!this.#group || this.#groupBump !== shown) {
      this.#group = device.createBindGroup({
        layout: this.#layout!,
        entries: [
          { binding: 0, resource: { buffer: this.#uniform, size: 96 } },
          { binding: 1, resource: shown.createView() },
          { binding: 2, resource: { buffer: this.#edgeBuffer! } },
        ],
      });
      this.#groupBump = shown;
    }

    if (!this.#sum || this.#sum.width !== target.width || this.#sum.height !== target.height) {
      this.#sum?.destroy();
      const size = [target.width, target.height];
      this.#sum = device.createTexture({
        label: 'soft-lighting2d sum',
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
      entries: [{ binding: 3, resource: this.#sumView! }],
    });

    const values = this.#values;
    lights.forEach((l, i) => {
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
          l.sourceRadius,
          edgeCount,
          l.samples,
          l.shadows ? 1 : 0,
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

    lights.forEach((_l, i) => {
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: this.#sumLayers[i % SUM_LAYERS]!, loadOp: 'load', storeOp: 'store' }],
      });
      pass.setBindGroup(0, this.#group!, [i * STRIDE]);
      pass.setPipeline(this.#light!);
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

export { SoftLighting2D as SoftShadows2D };
