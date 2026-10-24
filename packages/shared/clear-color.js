// One internal clear-color contract for the renderer and optional target owners.
export const defaultClear = [0.018, 0.023, 0.035, 1];

export function clearColorValue(color) {
  if (typeof color !== 'string') return defaultClear;
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new RangeError('Invalid color; use #rrggbb');
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

const constant = { srcFactor: 'constant', dstFactor: 'zero' };
/**
 * Clears inside the pass's viewport and scissor by drawing a triangle (an attachment clear always covers the whole
 * target): colour target 0 to the blend constant `tint` (unless `writeColor` is false), further colour targets to their
 * `values`, and depth to 0 when `writeDepth`. `formats` lists the colour targets; `depthFormat` is the pass's depth
 * attachment, if any. `cache` (a Map) keeps the pipelines for one device.
 */
export function clearDraw(
  device,
  cache,
  pass,
  { formats, values = [], depthFormat, writeDepth, samples = 1, writeColor = true, tint },
) {
  const key = [formats, values, depthFormat, +!!writeDepth, samples, +writeColor].join('|');
  let pipeline = cache.get(key);
  if (!pipeline) {
    const fields = formats.map((_, i) => `@location(${i}) c${i}:vec4f`).join(','),
      module = device.createShaderModule({
        code: `struct Out{${fields}}
@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn f()->Out{return Out(vec4f(1)${values.map((v) => `,vec4f(${v})`).join('')});}`,
      });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'v' },
      fragment: {
        module,
        entryPoint: 'f',
        targets: formats.map((format, i) =>
          i ? { format } : { format, writeMask: writeColor ? 0xf : 0, blend: { color: constant, alpha: constant } },
        ),
      },
      ...(depthFormat
        ? { depthStencil: { format: depthFormat, depthWriteEnabled: !!writeDepth, depthCompare: 'always' } }
        : {}),
      multisample: { count: samples },
    });
    cache.set(key, pipeline);
  }
  if (writeColor) pass.setBlendConstant(tint);
  pass.setPipeline(pipeline);
  pass.draw(3);
}
