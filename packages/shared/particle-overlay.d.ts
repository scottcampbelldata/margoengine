/** A particle overlay drawn over the frame: one instanced draw of quads with straight alpha blending and a read-only depth test. */
export class ParticleOverlay {
  /** Writes `values` to `uniform` and draws `count` instances of the shader `code` (entry points `vertex` and `fragment`). */
  draw(
    c: {
      device: GPUDevice;
      format: GPUTextureFormat;
      color: GPUTextureView;
      depth: GPUTextureView;
      encoder: GPUCommandEncoder;
      descriptor: { multisample?: GPUMultisampleState; depthStencil?: { format: GPUTextureFormat } };
    },
    code: string,
    uniform: GPUBuffer,
    values: Float32Array<ArrayBuffer>,
    count: number,
  ): void;
  /** Forgets the pipeline and bind group (after the device is lost or the uniform buffer is replaced). */
  release(): void;
}
