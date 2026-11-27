// One internal clear-color contract for the renderer and optional target owners.
export const defaultClear = [0.018, 0.023, 0.035, 1];

/**
 * A CSS `#rgb` or `#rrggbb` string as a 24-bit integer, or -1 for any other string. `#rgb` doubles each digit, as CSS
 * does (`#555` is `#555555`). Alpha forms (`#rgba`, `#rrggbbaa`) are refused: core colours have no alpha.
 */
export const hexColor = (color) =>
  /^#([\da-f]{3}){1,2}$/i.test(color) ? parseInt((color[4] ? color : color.replace(/\w/g, '$&$&')).slice(1), 16) : -1;

/**
 * The clear value of a `#rgb` or `#rrggbb` colour for a display-encoded target (the canvas, a preview, a tile): its
 * sRGB bytes as given, or core's clear colour for any other value.
 */
export function clearColorValue(color) {
  if (typeof color !== 'string') return defaultClear;
  const n = hexColor(color);
  if (n < 0) throw new RangeError('Invalid color; use #rrggbb');
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

/** An sRGB byte (0 to 255) as linear light, by the sRGB transfer function (IEC 61966-2-1). */
export const toLinear = (v) => ((v /= 255) > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);
const byte = (v) => v / 255,
  linear = /float$|srgb$/,
  // Core's clear colour as linear light: its display values decoded once, one array for every linear capture.
  linearClear = /* @__PURE__ */ defaultClear.map((v) => toLinear(v * 255));

/**
 * {@link clearColorValue} for a draw that may clear a capture's target. `capture` is the colour format of that target,
 * one a pass drew the scene into instead of the frame's own. A capture that holds linear light takes the colour
 * decoded with the sRGB transfer function (IEC 61966-2-1): a float format (a post effect's HDR capture), which the
 * display transform encodes later, and an `-srgb` format, whose clear value the device encodes on store (WebGPU,
 * GPURenderPassColorAttachment clearValue). Any other capture, and no capture (false or undefined: the frame's own
 * target, the canvas or a view's target), takes the bytes as given. Core's own clear colour (any other value of
 * `color`) takes the same path: display values as given, decoded for a linear capture, so an unset background shows as
 * a background of the same colour does (KB-CLEAR-DEFAULT1; before, it was the same numbers on every target, 5,6,9 on
 * the canvas and 7,20,38 under a tone map). Before KB-CLEAR-CAPTURE1 every target took the bytes, so a linear capture
 * encoded them twice (#808080 drew 181 under a tone map). A function of its own, so a bundle that never clears a
 * capture carries no decode.
 */
export function captureClearColor(color, capture) {
  const f = linear.test(capture) ? toLinear : byte;
  if (typeof color !== 'string') return f === byte ? defaultClear : linearClear;
  const n = hexColor(color);
  if (n < 0) throw new RangeError('Invalid color; use #rrggbb');
  return [f(n >> 16), f((n >> 8) & 255), f(n & 255), 1];
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
    group.b = buffer;
    if (state.groups.size > 63) {
      // A pass recorded earlier in this frame may still read the oldest buffer: free it once submitted work is done.
      const [old, spent] = state.groups.entries().next().value;
      state.groups.delete(old);
      device.queue.onSubmittedWorkDone().then(() => spent.b.destroy());
    }
    state.groups.set(key, group);
  }
  return [state.layout, group];
}

/**
 * Drops every colour bind group this copy of the module caches for `device` and returns their buffers, which the
 * caller destroys (with `retire`, so a pass recorded earlier in the frame still submits). Optional packages bundle a
 * copy of their own: post's material clears call this when an SSR or SSGI pass is released, and any other material
 * clear on the device makes its colour again on its next partial view. Core never calls it (its renderer lives as
 * long as the device), so core's bundle drops it.
 */
export function releaseClears(device) {
  const groups = devices.get(device)?.groups,
    buffers = groups ? [...groups.values()].map((group) => group.b) : [];
  groups?.clear();
  return buffers;
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
