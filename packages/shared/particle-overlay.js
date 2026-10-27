// The draw shared by the particle overlays of rain, snow and hail (packages/sky and packages/weather).
import { overlayBlend, overlayPass } from './pass.js';
import { applyView } from './view-rect.js';

/**
 * A particle overlay drawn over the frame as one instanced draw of quads (6 vertices each): straight alpha blending
 * ({@link overlayBlend}), a read-only depth test against the scene (`greater-equal`, reversed depth) and one uniform
 * buffer at binding 0 of group 0. The pipeline is made again when the frame's colour format, sample count or depth
 * format changes. Rain, snow and hail use it.
 */
export class ParticleOverlay {
  presentation = overlayPass();
  pipeline = undefined;
  bind = undefined;
  key = '';

  /** Writes `values` to `uniform` and draws `count` instances of the shader `code` (entry points `vertex` and `fragment`). */
  draw(c, code, uniform, values, count) {
    const key = c.format + ':' + c.descriptor.multisample?.count + ':' + c.descriptor.depthStencil.format;
    if (this.key !== key) {
      const module = c.device.createShaderModule({ code });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend: overlayBlend }] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil.format,
          depthCompare: 'greater-equal',
          depthWriteEnabled: false,
        },
      });
      this.bind = c.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      });
      this.key = key;
    }
    c.device.queue.writeBuffer(uniform, 0, values);
    this.presentation.colorAttachments[0].view = c.color;
    this.presentation.depthStencilAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    applyView(pass, c);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(6, count);
    pass.end();
  }

  /** Forgets the pipeline and bind group (after the device is lost or the uniform buffer is replaced). */
  release() {
    this.pipeline = this.bind = undefined;
    this.key = '';
  }
}
