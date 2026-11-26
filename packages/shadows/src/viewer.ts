/// <reference lib="esnext.disposable" preserve="true" />
// ShadowMapViewer: a debug overlay that draws one shadow map layer as a screen-space quad, depth turned into light
// distance from 0 (black, the light's near plane) to 1 (white, its far plane). Orthographic maps store distance
// linearly; perspective maps store it as a hyperbola (Williams 1978, "Casting curved shadows on curved surfaces"),
// which reversed depth (near 1, far 0; Reed 2015, "Depth Precision Visualized") stores mirrored, so a reversed value
// is mirrored back before d = near * far / (far - z (far - near)) gives the distance. The cascades of `Shadows` come
// from `cascadeMap`; point, spot, directional and area maps of `LocalShadows` from its `shadowMap` method.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { requireWebGPU } from '../../shared/require-webgpu.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
const LINK = '; see https://margoengine.com/errors#shadow-map-viewer';

/** One shadow map layer to show. `LocalShadows.shadowMap` and {@link cascadeMap} return this shape. */
export interface ShadowMapLayer {
  /** A `depth32float` (or other depth) texture, one layer or an array. */
  readonly texture: GPUTexture;
  /** Array layer. Default 0. */
  readonly layer?: number;
  /** How depth was stored: 'orthographic' (linear) or 'perspective' (hyperbolic, needs `near` and `far`). */
  readonly projection: 'orthographic' | 'perspective';
  /** True when the near plane is stored as 1 and the far plane as 0 (the engine's reversed depth). */
  readonly reversed: boolean;
  /** Perspective near and far distances, above 0 with far above near. */
  readonly near?: number;
  readonly far?: number;
  /** Texels shown: x, y, width, height. Default the whole layer. */
  readonly rect?: readonly [number, number, number, number];
}
/** What a {@link ShadowMapViewer} shows: a layer, or a function called each frame (null draws nothing). */
export type ShadowMapSource = ShadowMapLayer | (() => ShadowMapLayer | null | undefined);
/** Options for {@link ShadowMapViewer}. Position and size are read every frame. */
export interface ShadowMapViewerOptions {
  /** The map to show. */
  source: ShadowMapSource;
  /** Left and top edge in drawing-buffer pixels. Default 8, 8. */
  x?: number;
  y?: number;
  /** Width in drawing-buffer pixels; the height follows the map's aspect. Default 256. */
  size?: number;
  /** Plugin and pass name. Default 'shadow-map-viewer'. */
  name?: string;
  /** Frame graph order. Default 1000: over the finished frame, with the other overlays. */
  order?: number;
}

/** The layer of cascade `cascade` of a `Shadows` (its `depthTexture`), or null before its first frame or past its cascades. */
export function cascadeMap(shadows: { readonly depthTexture?: GPUTexture }, cascade = 0): ShadowMapLayer | null {
  const texture = shadows?.depthTexture;
  if (!texture || !Number.isInteger(cascade) || cascade < 0 || cascade >= texture.depthOrArrayLayers) return null;
  return { texture, layer: cascade, projection: 'orthographic', reversed: false };
}

/** Linear 0..1 distance of stored depth `z` (`ShadowMapViewer`'s shader, on the CPU for tests and readbacks). */
export function shadowDepthToLinear(
  z: number,
  map: Pick<ShadowMapLayer, 'projection' | 'reversed' | 'near' | 'far'>,
): number {
  const standard = map.reversed ? 1 - z : z;
  if (map.projection === 'orthographic') return Math.min(1, Math.max(0, standard));
  const n = map.near!,
    f = map.far!,
    distance = (n * f) / (f - standard * (f - n));
  return Math.min(1, Math.max(0, (distance - n) / (f - n)));
}

const shader = (array: boolean) => `
struct U {rect:vec4f, view:vec4f, lens:vec4f}
@group(0) @binding(0) var map:${array ? 'texture_depth_2d_array' : 'texture_depth_2d'};
@group(0) @binding(1) var<uniform> u:U;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  return vec4f(vec2f(f32((i<<1u)&2u), f32(i&2u))*2.0-1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
  let uv = clamp((p.xy - u.view.xy) / u.view.zw, vec2f(0.0), vec2f(0.99999));
  let t = vec2i(u.rect.xy + uv * u.rect.zw);
  let d = textureLoad(map, t, ${array ? 'i32(u.lens.w), ' : ''}0);
  // lens.x: 1 reversed (mirror to near 0), 2 perspective (hyperbola to linear distance), 3 both.
  let mode = u32(u.lens.x);
  var z = select(d, 1.0 - d, (mode & 1u) != 0u);
  if ((mode & 2u) != 0u) {
    let n = u.lens.y; let f = u.lens.z;
    z = (n * f / (f - z * (f - n)) - n) / (f - n);
  }
  return vec4f(vec3f(clamp(z, 0.0, 1.0)), 1.0);
}`;

/**
 * Draws one shadow map layer in a corner of the frame, as grey from the light's near plane (black) to its far plane
 * (white): a cascade of `Shadows` (`cascadeMap(shadows, k)`), or a point light's cube face, a spot light's map, a
 * directional cascade or an area face of `LocalShadows` (`shadows.shadowMap('point', index, face)`). Perspective maps
 * are linearised with their near and far planes, reversed depth mirrored first, so the grey is proportional to
 * distance. WebGPU and the WebGL2 compatibility layer.
 */
export class ShadowMapViewer implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  source: ShadowMapSource;
  x: number;
  y: number;
  size: number;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  private readonly data = new Float32Array(12);
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private group?: GPUBindGroup;
  private bound?: GPUTexture;
  private boundPipeline?: GPURenderPipeline;
  private readonly pass = {
    colorAttachments: [
      { view: undefined as unknown as GPUTextureView, loadOp: 'load' as const, storeOp: 'store' as const },
    ],
  };

  constructor(options: ShadowMapViewerOptions) {
    if (!options || (typeof options.source !== 'function' && !(options.source && typeof options.source === 'object')))
      throw new TypeError(`ShadowMapViewer needs a source: a shadow map layer or a function returning one${LINK}`);
    this.source = options.source;
    this.x = options.x ?? 8;
    this.y = options.y ?? 8;
    this.size = options.size ?? 256;
    this.name = options.name ?? 'shadow-map-viewer';
    this.order = options.order ?? 1000;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw new TypeError(`ShadowMapViewer needs a non-empty name and a finite order${LINK}`);
    this.check();
  }

  /** Makes a viewer and adds it to `engine`. */
  static attach(engine: EngineKernel, options: ShadowMapViewerOptions): ShadowMapViewer {
    const viewer = new ShadowMapViewer(options);
    engine.use(viewer);
    return viewer;
  }

  private check(): void {
    if (![this.x, this.y].every((v) => Number.isFinite(v) && v >= 0) || !(this.size > 0 && Number.isFinite(this.size)))
      throw new RangeError(`ShadowMapViewer x and y must be 0 or more and size above 0${LINK}`);
  }

  setup(engine: Engine): void {
    requireWebGPU(engine, 'ShadowMapViewer');
    this.engine = engine;
    this.device = engine.gpu;
    this.buffer = this.device.createBuffer({
      size: this.data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  private readonly execute = (context: PassContext): void => {
    if (context.backend !== 'webgpu' || !this.device || context.device !== this.device) return;
    this.check();
    const map = typeof this.source === 'function' ? this.source() : this.source;
    if (!map) return;
    const texture = map.texture,
      layer = map.layer ?? 0,
      rect = map.rect ?? [0, 0, texture.width, texture.height],
      perspective = map.projection === 'perspective';
    if (!Number.isInteger(layer) || layer < 0 || layer >= texture.depthOrArrayLayers)
      throw new RangeError(
        `ShadowMapViewer layer ${layer} is outside the texture's ${texture.depthOrArrayLayers} layers${LINK}`,
      );
    if (perspective && !(map.near! > 0 && map.far! > map.near! && Number.isFinite(map.far)))
      throw new RangeError(`ShadowMapViewer perspective maps need near above 0 and a finite far above near${LINK}`);
    // Clipped to the frame: a viewport may not leave its attachment.
    const x = Math.floor(this.x),
      y = Math.floor(this.y),
      width = Math.min(Math.round(this.size), context.width - x),
      height = Math.min(Math.round((this.size * rect[3]) / rect[2]), context.height - y);
    if (width < 1 || height < 1) return;
    const { device } = context,
      // A compatibility-level device binds a texture only as the view dimension it was made for: '2d' for one layer
      // unless it asked for '2d-array'.
      array =
        texture.depthOrArrayLayers > 1 ||
        (texture as GPUTexture & { textureBindingViewDimension?: string }).textureBindingViewDimension === '2d-array',
      count = context.descriptor.multisample?.count ?? 1,
      key = `${context.format} ${count} ${array}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: shader(array) });
      pipeline = device.createRenderPipeline({
        label: 'shadow map viewer',
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: context.format }] },
        primitive: { topology: 'triangle-list' },
        multisample: { count },
      });
      this.pipelines.set(key, pipeline);
    }
    // An auto layout belongs to its pipeline, so a new pipeline or texture needs a new group.
    if (this.bound !== texture || this.boundPipeline !== pipeline) {
      this.group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ dimension: array ? '2d-array' : '2d', aspect: 'depth-only' }) },
          { binding: 1, resource: { buffer: this.buffer! } },
        ],
      });
      this.bound = texture;
      this.boundPipeline = pipeline;
    }
    this.data.set([rect[0], rect[1], rect[2], rect[3], x, y, width, height]);
    this.data.set([(map.reversed ? 1 : 0) | (perspective ? 2 : 0), map.near ?? 0, map.far ?? 1, layer], 8);
    device.queue.writeBuffer(this.buffer!, 0, this.data);
    this.pass.colorAttachments[0].view = context.color;
    const pass = context.encoder.beginRenderPass(this.pass);
    pass.setViewport(x, y, width, height, 0, 1);
    pass.setScissorRect(x, y, width, height);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group!);
    pass.draw(3);
    pass.end();
  };

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  private release(): void {
    this.buffer?.destroy();
    this.buffer = this.group = this.bound = this.boundPipeline = this.device = undefined;
    this.pipelines.clear();
  }

  /** Leaves its engine and frees its GPU buffer. Safe to call twice. */
  dispose(): void {
    this.engine?.sceneOf?.(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
