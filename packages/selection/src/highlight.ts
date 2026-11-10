/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { Selection, type ModelLike, type PickingSource } from './index.js';
import { fullscreen, render, group, draw } from '../../shared/gpu.js';
import { applyView } from '../../shared/view-rect.js';
import { alphaBlend } from '../../shared/pass.js';
import { currentFrame, retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
import { MargoError } from '@margoengine/math/errors';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type RGB = readonly [number, number, number];
/** Mutable visible-surface highlight style, independent of the object's materials. */
export interface HighlightOptions {
  /** Unique plugin name. Default selection-highlight. */
  name?: string;
  /** Default orange [1, 0.5, 0] in linear RGB. */
  color?: RGB;
  /** Override the fill colour; defaults to color. */
  fillColor?: RGB;
  /** Override the halo colour; defaults to color. */
  glowColor?: RGB;
  /** Interior fill alpha, 0..1. Default 0.15. */
  fillOpacity?: number;
  /** Inner/outer glow alpha, 0..1. Default 0.85. */
  glowOpacity?: number;
  /** Gaussian support radius in drawing-buffer pixels, 1..64. Default 8 (sigma radius/3). */
  radius?: number;
  /** Glow just inside the silhouette. Default true. */
  innerGlow?: boolean;
  /** Halo outside visible selected pixels. Default true. */
  outerGlow?: boolean;
}
class MaskSelection extends Selection {
  protected override outlineVisible = false;
}
const blurCode =
  fullscreen +
  `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<uniform> u:array<vec4f,2>;
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=vec2i(i.position.xy);let radius=i32(ceil(u[0].z));let sigma=u[0].z/3.0;var value=0.0;var weight=0.0;
 for(var k=-radius;k<=radius;k++) {let w=exp(-0.5*f32(k*k)/(sigma*sigma));let q=p+vec2i(u[0].xy)*k;weight+=w;
 if(all(q>=vec2i(u[1].xy))&&all(q<vec2i(u[1].zw))){value+=textureLoad(source,q,0).r*w;}}
 return vec4f(value/weight,0,0,1);
}`;
const compositeCode =
  fullscreen +
  `
@group(0) @binding(0) var mask:texture_2d<f32>;
@group(0) @binding(1) var blurred:texture_2d<f32>;
@group(0) @binding(2) var<uniform> u:array<vec4f,3>;
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=vec2i(i.position.xy);let m=textureLoad(mask,p,0).r;let b=textureLoad(blurred,p,0).r;
 let f=m*u[0].w;let g=clamp(u[1].w*(m*(1.0-b)*u[2].x+(1.0-m)*b*u[2].y),0.0,1.0);
 let a=f+g-f*g;if(a<=0.0){discard;}return vec4f((u[0].rgb*f*(1.0-g)+u[1].rgb*g)/a,a);
}`;
/** Visible selection glow and translucent fill. Geometry, alpha masks and deformation are replayed by Selection. */
export class Highlight implements EnginePlugin {
  readonly name: string;
  private readonly selection: MaskSelection;
  private device?: GPUDevice;
  private textures: GPUTexture[] = [];
  private uniforms: GPUBuffer[] = [];
  private blur?: GPURenderPipeline;
  private composite?: GPURenderPipeline;
  private format = '';
  private samples = 0;
  private disposed = false;
  private views: GPUTextureView[] = [];
  private source?: GPUTextureView;
  private mask?: GPUTexture;
  private groups: { get(copy?: GPUBufferBinding): GPUBindGroup }[] = [];
  constructor(readonly options: HighlightOptions = {}) {
    this.name = options.name ?? 'selection-highlight';
    this.validate();
    this.selection = new MaskSelection({ name: this.name, algorithm: 'morphological' });
  }
  /** Attach an optional effect; separate named effects may style separate mesh groups. */
  static attach(engine: EngineKernel, options: HighlightOptions = {}): Highlight {
    const effect = new Highlight(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  /** Replace the selected meshes, models or loader nodes. Empty selection stops compositing. */
  set(meshes: Iterable<Mesh | ModelLike>): void {
    this.selection.set(meshes);
  }
  /** Register a caller-owned custom GPU source; returns its unregister function. */
  add(source: PickingSource): () => void {
    return this.selection.add(source);
  }
  /** Visible selected mask from the last frame, owned by the effect. */
  get maskTexture(): GPUTexture | undefined {
    return this.selection.maskTexture;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'Highlight is disposed; create a new effect.');
    this.selection.setup(engine);
    this.device = engine.gpu!;
    this.uniforms = [32, 32, 48].map((size) =>
      this.device!.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    );
    this.blur = render(this.device!, blurCode, 'r16float');
  }
  registerPasses(graph: FrameGraph): void {
    this.selection.registerPasses(graph);
    graph.add({
      name: this.name + ':glow-fill',
      order: 41,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private validate(): void {
    const o = this.options;
    for (const color of [o.color ?? [1, 0.5, 0], o.fillColor, o.glowColor])
      if (color && (color.length !== 3 || color.some((v) => !Number.isFinite(v) || v < 0 || v > 1)))
        throw new RangeError('Invalid highlight colour; use three finite linear RGB values from 0 to 1.');
    if (
      !Number.isFinite(o.radius ?? 8) ||
      (o.radius ?? 8) < 1 ||
      (o.radius ?? 8) > 64 ||
      ![o.fillOpacity ?? 0.15, o.glowOpacity ?? 0.85].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
      [o.innerGlow, o.outerGlow].some((v) => v !== undefined && typeof v !== 'boolean')
    )
      throw new RangeError('Invalid highlight style; use radius 1-64, opacity 0-1 and boolean glow toggles.');
  }
  private draw(c: Context): void {
    currentFrame(c.device, c.view ?? c);
    const mask = this.selection.maskTexture;
    if (!mask) return;
    this.validate();
    if (this.textures[0]?.width !== c.width || this.textures[0]?.height !== c.height) {
      for (const texture of this.textures) retire(this.device!, texture);
      this.textures = [0, 1].map(() =>
        c.device.createTexture({
          size: [c.width, c.height],
          format: 'r16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      );
      this.views = this.textures.map((t) => t.createView());
      this.groups = [];
    }
    if (!this.composite || this.format !== c.format || this.samples !== (c.descriptor.multisample?.count ?? 1)) {
      this.format = c.format;
      this.samples = c.descriptor.multisample?.count ?? 1;
      this.groups = [];
      const module = c.device.createShaderModule({ code: compositeCode });
      this.composite = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend: alphaBlend }] },
        multisample: c.descriptor.multisample,
      });
    }
    const view = c.view?.viewport ?? [0, 0, c.width, c.height],
      clip = c.view?.scissor ?? view;
    const bounds = [
      Math.max(0, view[0], clip[0]),
      Math.max(0, view[1], clip[1]),
      Math.min(c.width, view[0] + view[2], clip[0] + clip[2]),
      Math.min(c.height, view[1] + view[3], clip[1] + clip[3]),
    ];
    if (this.mask !== mask) {
      this.mask = mask;
      this.source = mask.createView();
      this.groups = [];
    }
    const views = this.views,
      source = this.source!;
    if (!this.groups.length) {
      this.groups = [0, 1].map((axis) =>
        uniformGroups(this.uniforms[axis], (uniform) =>
          group(c.device, this.blur!, [axis === 0 ? source : views[0], uniform]),
        ),
      );
      this.groups.push(
        uniformGroups(this.uniforms[2], (uniform) => group(c.device, this.composite!, [source, views[1], uniform])),
      );
    }
    for (let axis = 0; axis < 2; axis++) {
      const values = new Float32Array([axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, this.options.radius ?? 8, 0, ...bounds]);
      const slice = writeUniform(c.device, this.uniforms[axis], values, c.view ?? c),
        bind = this.groups[axis].get(slice);
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [
          { view: views[axis], clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(this.blur!);
      pass.setBindGroup(0, bind);
      applyView(pass, c);
      pass.draw(3);
      pass.end();
    }
    const o = this.options,
      color = o.color ?? [1, 0.5, 0];
    const values = new Float32Array([
      ...(o.fillColor ?? color),
      o.fillOpacity ?? 0.15,
      ...(o.glowColor ?? color),
      o.glowOpacity ?? 0.85,
      +(o.innerGlow ?? true),
      +(o.outerGlow ?? true),
      0,
      0,
    ]);
    const slice = writeUniform(c.device, this.uniforms[2], values, c.view ?? c);
    draw(c, this.composite!, this.groups[2].get(slice));
  }
  private release(): void {
    if (this.device) {
      for (const resource of [...this.textures, ...this.uniforms]) retire(this.device, resource);
    }
    this.textures = [];
    this.uniforms = [];
    this.views = [];
    this.groups = [];
    this.mask = this.source = undefined;
    this.blur = this.composite = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.selection.onDeviceRestored(engine);
    this.device = engine.gpu!;
    this.uniforms = [32, 32, 48].map((size) =>
      this.device!.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    );
    this.blur = render(this.device!, blurCode, 'r16float');
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selection.dispose();
    this.release();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
