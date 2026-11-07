// The draw shared by the scenery's sky layers (the Milky Way, the aurora): one full-screen quad at the far plane (0 in
// reversed depth), so only the sky where nothing was drawn shows it, its light added to the frame's (colour one plus
// one, alpha kept). Additive, not straight alpha, so a faint layer keeps its value on a half-float target, where a
// tiny alpha would fall into half precision's subnormals. One uniform buffer at binding 0 of group 0. The pipeline is
// made again when the shader code or the frame's colour format, sample count or depth format changes.
import type { PassContext } from '@margoengine/core/extension';
import { overlayPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;

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

export class Backdrop {
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
