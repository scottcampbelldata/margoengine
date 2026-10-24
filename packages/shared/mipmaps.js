// Mip chain generation by repeated linear downsampling with a fullscreen triangle, for the textures gltf-pro and
// materials upload. Pipelines (one per format) and the sampler are cached per device.

const mipShader = /* wgsl */ `
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;
}
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var imageSampler:sampler;
@fragment fn fragment(i:Out)->@location(0) vec4f {return textureSample(image,imageSampler,i.uv);}
`;
const states = new WeakMap();

/**
 * Fills mip levels 1 to `levels - 1` (default all) of `texture` from level 0, each from the one above; array and cube
 * layers each get their own chain, read through the linear `sampler` (default: one cached per device). The texture
 * needs RENDER_ATTACHMENT and TEXTURE_BINDING usage.
 */
export function generateMipmaps(device, texture, levels = texture.mipLevelCount, sampler) {
  if (levels < 2) return;
  let state = states.get(device);
  if (!state) states.set(device, (state = { pipelines: new Map(), sampler: undefined }));
  const format = texture.format;
  let pipeline = state.pipelines.get(format);
  if (!pipeline) {
    const module = device.createShaderModule({ code: mipShader });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    });
    state.pipelines.set(format, pipeline);
  }
  if (!sampler) sampler = state.sampler ??= device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  // Array and cube layers each get their own chain (2D views of one layer); a single-layer texture keeps plain views.
  const layers = texture.dimension === '2d' ? (texture.depthOrArrayLayers ?? 1) : 1,
    encoder = device.createCommandEncoder();
  for (let layer = 0; layer < layers; layer++) {
    const level = (baseMipLevel) =>
      layers > 1
        ? texture.createView({
            format,
            dimension: '2d',
            baseMipLevel,
            mipLevelCount: 1,
            baseArrayLayer: layer,
            arrayLayerCount: 1,
          })
        : texture.createView({ baseMipLevel, mipLevelCount: 1 });
    for (let i = 1; i < levels; i++) {
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: level(i - 1) },
          { binding: 1, resource: sampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: level(i), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
  }
  device.queue.submit([encoder.finish()]);
}
