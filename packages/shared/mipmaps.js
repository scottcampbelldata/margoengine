// Mip chain generation for the textures gltf-pro, materials and the other packages upload: each level from the one
// above with a fullscreen triangle. Callers keep one pipeline per format and mode in their own `cache`.
// - Every level takes the area filter: each source texel weighted by its overlap with the destination footprint, as
//   alpha-mips.js does for MASK maps (the box filter of a non-power-of-two image, Williams 1983, "Pyramidal
//   Parametrics"; overlap weights as in NVIDIA's non-power-of-two mipmapping note, 2005). At even sizes that is the
//   2x2 box; one bilinear fetch would match it there, but at odd sizes the centre of a 2.5-texel footprint skips a
//   texel (a 5-wide level 0 kept only a quarter of its last column's share), so one path serves both.
// - `alpha: 'weighted'` (base colour maps of blended materials) averages colour weighted by alpha, so transparent texels
//   lend no colour to the edges of opaque ones (the dark fringes of a plain average; Castano, "Computing Alpha
//   Mipmaps", 2010; Glassner's premultiplied-alpha filtering notes). A block with no alpha keeps its plain average.

const mipShader = (weighted) => /* wgsl */ `
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);
}
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(@builtin(position) clip:vec4f)->@location(0) vec4f {
  let src=textureDimensions(image);
  let dst=max(src/2u,vec2u(1u));let g=vec2u(clip.xy);
  let a=vec2f(g*src)/vec2f(dst);let b=vec2f((g+1u)*src)/vec2f(dst);let end=min(src,((g+1u)*src+dst-1u)/dst);
  var sum=vec4f(0.0);var sc=vec3f(0.0);
  for(var y=g.y*src.y/dst.y;y<end.y;y++){
    let wy=min(b.y,f32(y+1u))-max(a.y,f32(y));
    for(var x=g.x*src.x/dst.x;x<end.x;x++){
      let w=(min(b.x,f32(x+1u))-max(a.x,f32(x)))*wy;let t=textureLoad(image,vec2u(x,y),0);
      sum+=w*t;sc+=(w*t.a)*t.rgb;
    }
  }
  let area=(b.x-a.x)*(b.y-a.y);
  ${weighted ? 'return vec4f(select(sum.rgb/area,sc/sum.a,sum.a>0.0),sum.a/area);' : 'return sum/area;'}
}
`;

/**
 * Fills mip levels 1 to `levels - 1` of each of the first `layers` (default 1) layers of 2D or array texture `texture`
 * from level 0, each level from the one above by an area filter. `alpha: 'weighted'` averages colour weighted by alpha
 * (blended base colour maps). The caller's `cache` keeps one pipeline per format and mode. The texture needs RENDER_ATTACHMENT
 * and TEXTURE_BINDING usage.
 */
export function generateMipmaps(device, texture, levels, cache, layers = 1, alpha = 'plain') {
  if (levels < 2) return;
  const format = texture.format,
    weighted = alpha === 'weighted',
    key = weighted ? format + ':weighted' : format;
  let pipeline = cache.get(key);
  if (!pipeline) {
    const module = device.createShaderModule({ code: mipShader(weighted) });
    cache.set(
      key,
      (pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
      })),
    );
  }
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
        entries: [{ binding: 0, resource: view(level - 1) }],
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
