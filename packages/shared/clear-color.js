// One internal clear-color contract for the renderer and optional target owners.
export const defaultClear = [0.018, 0.023, 0.035, 1];

/**
 * A CSS `#rgb` or `#rrggbb` string as a 24-bit integer, or -1 for any other string. `#rgb` doubles each digit, as CSS
 * does (`#555` is `#555555`). Alpha forms (`#rgba`, `#rrggbbaa`) are refused: core colours have no alpha.
 */
export const hexColor = (color) =>
  /^#([\da-f]{3}){1,2}$/i.test(color) ? parseInt((color[4] ? color : color.replace(/\w/g, '$&$&')).slice(1), 16) : -1;

export function clearColorValue(color) {
  if (typeof color !== 'string') return defaultClear;
  const n = hexColor(color);
  if (n < 0) throw new RangeError('Invalid color; use #rrggbb');
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

/** Per device: the clear colour's bind group layout, its pipeline layout and a bind group per recent colour. */
const devices = new WeakMap();
function colourGroup(device, tint) {
  let state = devices.get(device);
  if (!state) {
    // 2 is GPUShaderStage.FRAGMENT.
    const group = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, buffer: {} }] });
    state = { group, layout: device.createPipelineLayout({ bindGroupLayouts: [group] }), groups: new Map() };
    devices.set(device, state);
  }
  const key = tint.join();
  let group = state.groups.get(key);
  if (!group) {
    // 72 is UNIFORM | COPY_DST. Each colour keeps a buffer of its own, so a clear of another colour recorded before the
    // same submit cannot change it. The 64 newest colours are kept (an animated background makes many).
    const buffer = device.createBuffer({ size: 16, usage: 72 });
    device.queue.writeBuffer(buffer, 0, new Float32Array(tint));
    group = device.createBindGroup({ layout: state.group, entries: [{ binding: 0, resource: { buffer } }] });
    if (state.groups.size > 63) state.groups.delete(state.groups.keys().next().value);
    state.groups.set(key, group);
  }
  return [state.layout, group];
}

/**
 * Clears inside the pass's viewport and scissor by drawing a triangle (an attachment clear always covers the whole
 * target): colour target 0 to `tint` (unless `writeColor` is false), further colour targets to their `values`, and
 * depth to 0 when `writeDepth`. The fragment shader writes `tint` from a uniform at full float precision with blending
 * off: a colour taken from the blend constant came out black at 4x MSAA on Intel Arc under D3D12 (bug 61). `formats`
 * lists the colour targets; `depthFormat` is the pass's depth attachment, if any. `cache` (a Map) keeps the pipelines
 * for one device: one per targets, depth and sample count, whatever the colour.
 */
export function clearDraw(
  device,
  cache,
  pass,
  { formats, values = [], depthFormat, writeDepth, samples = 1, writeColor = true, tint = defaultClear },
) {
  const key = [formats, values, depthFormat, +!!writeDepth, samples, +writeColor].join('|'),
    [layout, group] = colourGroup(device, tint);
  let pipeline = cache.get(key);
  if (!pipeline) {
    const fields = formats.map((_, i) => `@location(${i}) c${i}:vec4f`).join(','),
      module = device.createShaderModule({
        code: `@group(0) @binding(0) var<uniform> t:vec4f;
struct Out{${fields}}
@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn f()->Out{return Out(t${values.map((v) => `,vec4f(${v})`).join('')});}`,
      });
    pipeline = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'v' },
      fragment: {
        module,
        entryPoint: 'f',
        targets: formats.map((format, i) => (i ? { format } : { format, writeMask: writeColor ? 0xf : 0 })),
      },
      ...(depthFormat
        ? { depthStencil: { format: depthFormat, depthWriteEnabled: !!writeDepth, depthCompare: 'always' } }
        : {}),
      multisample: { count: samples },
    });
    cache.set(key, pipeline);
  }
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.draw(3);
}
