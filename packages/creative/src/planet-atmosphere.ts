/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { PlanetAtmosphere, planetWGSL } from '@margoengine/sky/planet';
import type { AtmosphereParameters } from '@margoengine/sky/planet';
import { fault, rangeError } from '../../shared/errors.js';
import { displayShader } from '../../shared/display.js';
import { applyView, viewRect, ViewStates } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** A physical planet in arbitrary world units; atmosphere distances and density scales are kilometres. */
export interface OrbitAtmosphereOptions {
  /** World-space planet centre. Default [0, 0, 0]. */
  center?: readonly [number, number, number];
  /** World-space ground radius. Default 1. */
  radius?: number;
  /** Unit direction toward the sun, normalized internally. Default [1, 0, 0]. */
  sun?: readonly [number, number, number];
  /** Hillaire medium. Defaults to Earth; groundAlbedo also defines the rendered ground. */
  atmosphere?: AtmosphereParameters;
  /** Solar illuminance. Default 20, range 0..1000000. */
  illuminance?: number;
  /** Exposure stops. Default 0, range -20..20. */
  exposure?: number;
}

const shader = `${planetWGSL}
${displayShader}
struct Frame { inverse:mat4x4f, eye:vec4f, rect:vec4f }
@group(0) @binding(0) var<uniform> frame:Frame;
override hdr:bool=false;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let uv=(p.xy-frame.rect.xy)/frame.rect.zw;
 let h=frame.inverse*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,0.0001,1);
 let linear=planetSky(h.xyz/h.w-frame.eye.xyz);
 if(hdr){return vec4f(linear,1);}
 return vec4f(toDisplay(linear),1);
}`;
let next = 0;

/** Full physical ground, terminator and atmospheric limb from orbit, using sky's shared Hillaire tables. */
export class OrbitAtmosphere implements EnginePlugin {
  readonly name = `creative:orbit-atmosphere:${next++}`;
  enabled = true;
  #engine?: Engine;
  #views = new ViewStates<{ transport: PlanetAtmosphere; buffer: GPUBuffer; group: GPUBindGroup }>(
    () => {
      const device = this.#engine!.gpu!,
        transport = new PlanetAtmosphere(device);
      const buffer = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const group = device.createBindGroup({ layout: this.#layout!, entries: [{ binding: 0, resource: { buffer } }] });
      return { transport, buffer, group };
    },
    (state) => {
      state.transport.dispose();
      state.buffer.destroy();
    },
  );
  #layout?: GPUBindGroupLayout;
  #empty?: GPUBindGroupLayout;
  #emptyGroup?: GPUBindGroup;
  #module?: GPUShaderModule;
  #pipelines = new Map<string, GPURenderPipeline>();
  #disposed = false;
  #inverse = new Float32Array(16);
  #workspace = new Float64Array(52);
  #frame = new Float32Array(24);

  constructor(readonly options: OrbitAtmosphereOptions = {}) {
    this.#validate();
  }
  /** Attach to a scene, drawing only at clear depth behind other geometry. */
  static attach(engine: EngineKernel, options: OrbitAtmosphereOptions = {}): OrbitAtmosphere {
    const effect = new OrbitAtmosphere(options);
    engine.use(effect);
    return effect;
  }
  #validate(): void {
    const o = this.options;
    for (const v of [o.center ?? [0, 0, 0], o.sun ?? [1, 0, 0]])
      if (v.length !== 3 || Array.from(v).some((x) => !Number.isFinite(Math.fround(x))))
        throw rangeError('Orbit atmosphere needs finite xyz vectors; supply three finite numbers', 'arguments');
    if (
      !(Math.hypot(...(o.sun ?? [1, 0, 0])) > 0) ||
      !Number.isFinite(Math.fround(o.radius ?? 1)) ||
      (o.radius ?? 1) <= 0
    )
      throw rangeError('Orbit atmosphere needs positive radius and nonzero sun; adjust the planet frame', 'arguments');
  }
  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'Orbit atmosphere is disposed; create a new instance');
    if (this.#engine) throw fault('attached', 'Orbit atmosphere is already attached; create another instance', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'Orbit atmosphere needs a GPU device; use WebGPU or the full WebGL2 layer');
    this.#engine = engine;
    const device = engine.gpu;
    this.#layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.#empty = device.createBindGroupLayout({ entries: [] });
    this.#emptyGroup = device.createBindGroup({ layout: this.#empty, entries: [] });
    this.#module = device.createShaderModule({ code: shader });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: 2, execute: this.#draw });
  }
  #draw = (c: PassContext): void => {
    if (!this.enabled) return;
    if (this.#disposed) throw fault('disposed', 'Orbit atmosphere is disposed; attach a new instance');
    if (c.backend !== 'webgpu')
      throw fault('unsupported', 'Orbit atmosphere needs a GPU device; use the full compatibility layer');
    this.#validate();
    if (!invertMatrixStable(c.camera.matrix, this.#inverse, this.#workspace))
      throw fault('state', 'Planet camera is singular; use an invertible projection');
    const o = this.options,
      center = o.center ?? [0, 0, 0],
      scale = (o.atmosphere?.bottomRadius ?? 6360) / (o.radius ?? 1);
    const matrix = new Float32Array([
      scale,
      0,
      0,
      0,
      0,
      scale,
      0,
      0,
      0,
      0,
      scale,
      0,
      -center[0] * scale,
      -center[1] * scale,
      -center[2] * scale,
      1,
    ]);
    const eye = Array.from(c.camera.position, (x, i) => (x - center[i]) * scale);
    const state = this.#views.get(c);
    state.transport.prepare(c.encoder, matrix, eye, o.sun ?? [1, 0, 0], o);
    const depthFormat = c.descriptor.depthStencil!.format,
      count = c.descriptor.multisample?.count ?? 1;
    const key = `${c.format}:${count}:${depthFormat}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = c.device.createRenderPipeline({
        layout: c.device.createPipelineLayout({
          bindGroupLayouts: [this.#layout!, this.#empty!, state.transport.layout],
        }),
        vertex: { module: this.#module!, entryPoint: 'vertex' },
        fragment: {
          module: this.#module!,
          entryPoint: 'fragment',
          constants: { hdr: +(c.format === 'rgba16float') },
          targets: [{ format: c.format }],
        },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        multisample: { count },
      });
      this.#pipelines.set(key, pipeline);
    }
    this.#frame.set(this.#inverse);
    this.#frame.set(c.camera.position, 16);
    this.#frame.set(viewRect(c) ?? [0, 0, c.width, c.height], 20);
    c.device.queue.writeBuffer(state.buffer, 0, this.#frame);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: c.depth,
        depthReadOnly: true,
        ...(depthFormat.includes('stencil') ? { stencilReadOnly: true } : {}),
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, state.group);
    pass.setBindGroup(1, this.#emptyGroup!);
    pass.setBindGroup(2, state.transport.group);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  };
  #release(): void {
    this.#views.clear();
    this.#pipelines.clear();
  }
  /** Remove expired per-view resources after a moving frame. */
  onPreUpdate(delta: number): void {
    if (delta > 0) this.#views.prune();
  }
  onDeviceRestored(engine: Engine): void {
    this.#release();
    this.#engine = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const engine = this.#engine;
    this.#engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.#release();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
