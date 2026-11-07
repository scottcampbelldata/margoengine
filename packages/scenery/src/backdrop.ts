/// <reference lib="esnext.disposable" preserve="true" />
// The draw shared by the scenery's sky layers (the Milky Way, the aurora): one full-screen quad at the far plane (0 in
// reversed depth), so only the sky where nothing was drawn shows it, its light added to the frame's (colour one plus
// one, alpha kept). Additive, not straight alpha, so a faint layer keeps its value on a half-float target, where a
// tiny alpha would fall into half precision's subnormals. One uniform buffer at binding 0 of group 0. The pipeline is
// made again when the shader code or the frame's colour format, sample count or depth format changes. `SkyLayer` is
// the plugin around it: the uniform buffer, the camera's inverse, the pass and the lifetime.
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { overlayPass } from '../../shared/pass.js';
import { applyView, viewSize } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** The WebGPU pass context a sky layer draws in. */
export type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** WGSL of the quad's vertex stage: entry `vertex`, output `O` with the NDC position at location 0. */
export const backdropVertex = `struct O {@builtin(position) position:vec4f,@location(0) ndc:vec2f}
@vertex fn vertex(@builtin(vertex_index) v:u32)->O {
 let corners=array(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(-1.0,1.0),vec2f(-1.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0));
 var o:O;o.position=vec4f(corners[v],0.0,1.0);o.ndc=corners[v];return o;
}
`;

const additive: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

class Backdrop {
  private readonly presentation = overlayPass();
  private pipeline?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private key = '';
  private code = '';

  /** Writes `values` to `uniform` and draws the quad with `code` (entry points `vertex` and `fragment`). */
  draw(c: Context, code: string, uniform: GPUBuffer, values: Float32Array<ArrayBuffer>): void {
    const key = c.format + ':' + c.descriptor.multisample?.count + ':' + c.descriptor.depthStencil?.format;
    if (this.key !== key || this.code !== code) {
      const module = c.device.createShaderModule({ code });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend: additive }] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthCompare: 'greater-equal',
          depthWriteEnabled: false,
        },
      });
      this.bind = undefined;
      this.key = key;
      this.code = code;
    }
    this.bind ??= c.device.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
    c.device.queue.writeBuffer(uniform, 0, values);
    this.presentation.colorAttachments[0].view = c.color;
    this.presentation.depthStencilAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    applyView(pass, c);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bind);
    pass.draw(6, 1);
    pass.end();
  }

  /** Forgets the pipeline and bind group (after the device is lost or the uniform buffer is replaced). */
  release(): void {
    this.pipeline = this.bind = undefined;
    this.key = this.code = '';
  }
}

/**
 * A sky layer plugin: each frame `frame` fills its uniform values (or returns false to draw nothing), then the layer
 * writes the camera's inverse view-projection at float 0 and one pixel in NDC (2 / width, 2 / height) in the last two
 * floats, and draws its shader's quad. WebGPU only.
 */
export abstract class SkyLayer implements EnginePlugin {
  abstract readonly name: string;
  private readonly backdrop = new Backdrop();
  private readonly scratch = new Float64Array(52);
  private readonly inverse = new Float32Array(16);
  private uniform?: GPUBuffer;
  private engine?: Engine;
  private disposed = false;

  protected constructor(
    private readonly label: string,
    private readonly order: number,
    protected readonly values: Float32Array<ArrayBuffer>,
    private readonly code: string,
  ) {}

  /** Fills this frame's uniform values; false draws nothing. */
  protected abstract frame(c: Context): boolean;

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', `${this.label} is disposed; attach a new ${this.label}`);
    const gpu = engine.gpu;
    if (!gpu)
      throw new MargoError('unsupported', `${this.label} draws with WebGPU; it does not run on the WebGL2 fallback`);
    this.engine = engine;
    this.uniform = gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
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

  private draw(c: Context): void {
    if (!this.frame(c)) return;
    if (!invertMatrixStable(c.camera.matrix, this.inverse, this.scratch))
      throw new MargoError('state', `Invalid ${this.label} camera; give the camera a finite, invertible projection`);
    const v = this.values,
      [width, tall] = viewSize(c) as [number, number];
    v.set(this.inverse, 0);
    v[v.length - 2] = 2 / width;
    v[v.length - 1] = 2 / tall;
    this.backdrop.draw(c, this.code, this.uniform!, v);
  }

  private release(): void {
    this.uniform?.destroy();
    this.uniform = undefined;
    this.backdrop.release();
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
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
