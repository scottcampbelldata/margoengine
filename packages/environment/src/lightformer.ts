/// <reference lib="esnext.disposable" preserve="true" />
// Lightformer: an emissive card (rect, circle, ring) or box of constant radiance, drawn in a transform node's local
// frame. Its use is inside an environment capture (a CubeCamera feeding `Environment.create`), where it paints a
// studio softbox into the environment the scene is lit by (image-based lighting: P. Debevec, "Rendering Synthetic
// Objects into Real Scenes", SIGGRAPH 1998, https://doi.org/10.1145/280814.280864). It is unlit: its radiance is
// `color x intensity`, written linear on HDR targets (every capture) and through the display transform on a display
// target.
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { displayShader } from '../../shared/display.js';
import { applyView } from '../../shared/view-rect.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { linearHdr } from '../../shared/hdr-format.js';
import { beginScenePass } from '../../shared/scene-pass.js';
import { linearColor, type ColorInput } from './color.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** The shape of a Lightformer, in its node's local frame. */
export type LightformerForm = 'rect' | 'circle' | 'ring' | 'box';

/** Options of {@link Lightformer}; every option is optional. */
export interface LightformerOptions {
  /** Parent transform node: the form follows it. Default the scene root. */
  parent?: Mesh;
  /**
   * `'rect'` a 1 x 1 card, `'circle'` a disc 1 across, `'ring'` that disc with its inner half (0.25 radius) open, all in
   * the local XY plane and seen from both sides; `'box'` a 1 x 1 x 1 cube. Scale the node to size it. Default `'rect'`.
   */
  form?: LightformerForm;
  /** Colour: `'#rrggbb'`, `0xrrggbb` (sRGB) or linear `[r, g, b]`. Default white. */
  color?: ColorInput;
  /** Radiance multiplier, finite and >= 0: the form emits `color x intensity`. Default 1. */
  intensity?: number;
  /** Frame-graph order of the draw, after core's main pass. Default 1. */
  order?: number;
  /** Plugin and pass name. Default 'lightformer-N'. */
  name?: string;
}

const FORMS: readonly LightformerForm[] = ['rect', 'circle', 'ring', 'box'];
// Quad corners for the cards; the box's 36 corners index 8 cube corners, two triangles per face.
const SHADER = /* wgsl */ `
${displayShader}
struct U { viewProj:mat4x4f, model:mat4x4f, color:vec4f, flags:vec4f }
@group(0) @binding(0) var<uniform> u:U;
struct Out { @builtin(position) position:vec4f, @location(0) local:vec2f }
const quad=array<vec2f,6>(vec2f(-0.5,-0.5),vec2f(0.5,-0.5),vec2f(0.5,0.5),vec2f(-0.5,-0.5),vec2f(0.5,0.5),vec2f(-0.5,0.5));
const faces=array<u32,36>(1,5,7,1,7,3, 4,0,2,4,2,6, 2,3,7,2,7,6, 4,5,1,4,1,0, 5,4,6,5,6,7, 0,1,3,0,3,2);
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  var p:vec3f;var o:Out;
  if(u.flags.y>2.5){let c=faces[i];p=vec3f(f32(c&1u),f32((c>>1u)&1u),f32((c>>2u)&1u))-0.5;o.local=vec2f(0.0);}
  else{let q=quad[i%6u];p=vec3f(q,0.0);o.local=q;}
  o.position=u.viewProj*(u.model*vec4f(p,1.0));return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let r=length(i.local);
  if((u.flags.y>0.5&&r>0.5)||(u.flags.y>1.5&&u.flags.y<2.5&&r<0.25)){discard;}
  let c=u.color.rgb;
  if(u.flags.x>0.5){return vec4f(c,1.0);}
  return vec4f(toDisplay(c),1.0);
}`;

let count = 0;
const finite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new RangeError(`Lightformer ${label} ${String(value)} is invalid; pass a finite number of at least 0`);
  return value;
};
const formOf = (value: unknown): LightformerForm => {
  if (!FORMS.includes(value as LightformerForm))
    throw new RangeError(`Lightformer form ${String(value)} is invalid; pass 'rect', 'circle', 'ring' or 'box'`);
  return value as LightformerForm;
};

interface DeviceState {
  device: GPUDevice;
  uniform: GPUBuffer;
  pipelines: Map<string, GPURenderPipeline>;
  groups: WeakMap<GPURenderPipeline, GPUBindGroup>;
}

/**
 * An emissive form for environment captures (drei's Lightformer): attach it with `engine.use` (or under a scene), place
 * it with its `node`, and capture it with a CubeCamera into an `Environment`. WebGPU and the WebGL2 compatibility layer.
 */
export class Lightformer {
  readonly name: string;
  readonly order: number;
  private readonly parent?: Mesh;
  private formValue: LightformerForm;
  private colorValue: [number, number, number];
  private intensityValue: number;
  private engine?: EngineKernel;
  private nodeValue?: Mesh;
  private state?: DeviceState;
  private readonly values = new Float32Array(40);
  private readonly colorAttachment = { loadOp: 'load', storeOp: 'store' } as GPURenderPassColorAttachment;
  private readonly depthAttachment = {} as GPURenderPassDepthStencilAttachment;
  private disposed = false;

  constructor(options: LightformerOptions = {}) {
    this.name = options.name ?? `lightformer-${count++}`;
    this.order = options.order ?? 1;
    if (!Number.isFinite(this.order)) throw new RangeError('Lightformer order must be a finite number; pass a frame-graph order such as 1');
    this.parent = options.parent;
    this.formValue = formOf(options.form ?? 'rect');
    this.colorValue = linearColor(options.color ?? '#ffffff');
    this.intensityValue = finite(options.intensity ?? 1, 'intensity');
  }
  /** Creates a Lightformer and attaches it to `engine`. */
  static attach(engine: EngineKernel, options?: LightformerOptions): Lightformer {
    const value = new Lightformer(options);
    engine.use(value as unknown as Parameters<EngineKernel['use']>[0]);
    return value;
  }
  /** The form's transform node (created on attach): position, rotate and scale it, or hide it. */
  get node(): Mesh {
    if (!this.nodeValue) throw new MargoError('state', `${this.name} is not attached; pass it to engine.use first`);
    return this.nodeValue;
  }
  /** The shape. Live. */
  get form(): LightformerForm {
    return this.formValue;
  }
  set form(value: LightformerForm) {
    this.formValue = formOf(value);
  }
  /** Linear colour. Live. */
  get color(): readonly [number, number, number] {
    return this.colorValue;
  }
  set color(value: ColorInput) {
    this.colorValue = linearColor(value);
  }
  /** Radiance multiplier. Live. */
  get intensity(): number {
    return this.intensityValue;
  }
  set intensity(value: number) {
    this.intensityValue = finite(value, 'intensity');
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', `${this.name} is disposed; create a new one`);
    if (engine.backend !== 'webgpu')
      throw new MargoError(
        'unsupported',
        `${this.name} requires WebGPU or the WebGL2 compatibility layer; select one of those backends; see https://margoengine.com/errors#unsupported`,
      );
    if (this.engine) throw new MargoError('attached', `${this.name} is attached to an engine; create another Lightformer`);
    this.engine = engine;
    this.nodeValue = engine.createMesh(this.parent);
    this.nodeValue.name = this.name;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onDeviceRestored(): void {
    this.releaseState();
  }

  private draw(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    const node = this.nodeValue,
      engine = this.engine;
    if (this.disposed || !node || !engine || this.intensityValue === 0) return;
    if (hiddenInTree(engineRuntime(engine).store, meshRuntime(node).id)) return;
    const state = this.stateFor(c.device),
      samples = c.descriptor.multisample?.count ?? 1,
      depthFormat = c.descriptor.depthStencil!.format,
      key = `${c.format}:${samples}:${depthFormat}`;
    let pipeline = state.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ label: 'lightformer', code: SHADER });
      pipeline = c.device.createRenderPipeline({
        label: 'lightformer',
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        primitive: { cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater-equal' },
        multisample: { count: samples },
      });
      state.pipelines.set(key, pipeline);
    }
    let group = state.groups.get(pipeline);
    if (!group) {
      group = c.device.createBindGroup({
        label: 'lightformer',
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: state.uniform } }],
      });
      state.groups.set(pipeline, group);
    }
    const v = this.values,
      k = this.intensityValue,
      form = FORMS.indexOf(this.formValue);
    v.set(c.camera.matrix, 0);
    v.set(meshRuntime(node).matrix, 16);
    v[32] = this.colorValue[0] * k;
    v[33] = this.colorValue[1] * k;
    v[34] = this.colorValue[2] * k;
    v[35] = 1;
    v[36] = linearHdr(c.format) ? 1 : 0;
    v[37] = form;
    v[38] = v[39] = 0;
    // One uniform per Lightformer: a capture draws it once per face, each face in its own encoder pass, so the write
    // lands before that pass in queue order.
    c.device.queue.writeBuffer(state.uniform, 0, v);
    const pass = beginScenePass(c, this.colorAttachment, this.depthAttachment);
    applyView(pass, c);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(form === 3 ? 36 : 6);
    pass.end();
  }
  private stateFor(device: GPUDevice): DeviceState {
    if (this.state?.device === device) return this.state;
    this.releaseState();
    this.state = {
      device,
      uniform: device.createBuffer({ label: 'lightformer', size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      pipelines: new Map(),
      groups: new WeakMap(),
    };
    return this.state;
  }
  private releaseState(): void {
    this.state?.uniform.destroy();
    this.state = undefined;
  }
  /** Releases the GPU resources and the transform node and detaches from the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseState();
    const engine = this.engine;
    this.engine = undefined;
    if (engine && !engine.disposed) {
      const node = this.nodeValue;
      if (node && engineRuntime(engine).meshes.get(meshRuntime(node).id) === meshRuntime(node)) node.dispose();
      engineRuntime(engine).sceneOf(this)?.removePlugin(this.name);
    }
    this.nodeValue = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
