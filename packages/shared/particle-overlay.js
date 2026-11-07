// The draw shared by the particle overlays of rain, snow and hail (packages/sky and packages/weather).
import { overlayBlend, overlayPass } from './pass.js';
import { applyView } from './view-rect.js';

/**
 * A particle overlay drawn over the frame as one instanced draw of quads (6 vertices each): straight alpha blending
 * ({@link overlayBlend}), a read-only depth test against the scene (`greater-equal`, reversed depth) and one uniform
 * buffer at binding 0 of group 0, plus any `extra` entries of that group. The pipeline is made again when the shader
 * code or the frame's colour format, sample count or depth format changes, the bind group when `extra` is another
 * array. Rain, snow, hail and the rain effects use it.
 */
export class ParticleOverlay {
  presentation = overlayPass();
  pipeline = undefined;
  bind = undefined;
  key = '';
  code = '';
  extra = undefined;

  /**
   * Writes `values` to `uniform` and draws `count` instances of the shader `code` (entry points `vertex` and
   * `fragment`); `extra` are further entries of bind group 0, kept as the same array while they do not change.
   */
  draw(c, code, uniform, values, count, extra) {
    const key = c.format + ':' + c.descriptor.multisample?.count + ':' + c.descriptor.depthStencil.format;
    if (this.key !== key || this.code !== code) {
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
      this.bind = undefined;
      this.key = key;
      this.code = code;
    }
    if (!this.bind || this.extra !== extra) {
      this.bind = c.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }, ...(extra ?? [])],
      });
      this.extra = extra;
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
    this.pipeline = this.bind = this.extra = undefined;
    this.key = this.code = '';
  }
}
