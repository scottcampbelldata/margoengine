// Mip chain generation by repeated linear downsampling with a fullscreen triangle, for the textures gltf-pro and
// materials upload. Callers keep one pipeline per format in their own `cache`.

const mipShader = /* wgsl */ `
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;
}
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var imageSampler:sampler;
@fragment fn fragment(i:Out)->@location(0) vec4f {return textureSample(image,imageSampler,i.uv);}
`;

/**
 * Fills mip levels 1 to `levels - 1` of each of the first `layers` (default 1) layers of 2D or array texture `texture`
 * from level 0, each level from the one above, read through the linear `sampler` (default: one kept as
 * `cache.sampler`). The caller's `cache` keeps one pipeline per format. The texture needs RENDER_ATTACHMENT and
 * TEXTURE_BINDING usage.
 */
export function generateMipmaps(device, texture, levels, cache, sampler, layers = 1) {
  if (levels < 2) return;
  const format = texture.format;
  let pipeline = cache.get(format);
  if (!pipeline) {
    const module = device.createShaderModule({ code: mipShader });
    cache.set(
      format,
      (pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
      })),
    );
  }
  sampler ??= cache.sampler ??= device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const encoder = device.createCommandEncoder();
  for (let layer = 0; layer < layers; layer++)
    for (let level = 1; level < levels; level++) {
      const view = (baseMipLevel) =>
        texture.createView(
          layers > 1
            ? { format, dimension: '2d', baseMipLevel, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }
            : { baseMipLevel, mipLevelCount: 1 },
        );
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: view(level - 1) },
          { binding: 1, resource: sampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: view(level), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
  device.queue.submit([encoder.finish()]);
}
