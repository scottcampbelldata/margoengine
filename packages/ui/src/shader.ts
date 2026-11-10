/**
 * Shader of the UI renderer. Rectangles are signed-distance rounded boxes with an optional outline and soft edge;
 * glyphs are quads sampling the text package's signed distance atlases. Both are instanced draws that read their
 * data from storage buffers by `instance_index` (the draw's first instance selects the run), in device pixels.
 */
export const uiShader: string = /* wgsl */ `
struct Frame { size: vec2f, linear: f32, pad: f32, sdf: vec2f, pad2: vec2f }
struct Rect { box: vec4f, fill: vec4f, border: vec4f, params: vec4f }
struct Glyph { box: vec4f, uv: vec4f, color: vec4f, info: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var sdfAtlas: texture_2d_array<f32>;
@group(0) @binding(3) var colorAtlas: texture_2d_array<f32>;
@group(0) @binding(4) var<storage, read> rects: array<Rect>;
@group(0) @binding(5) var<storage, read> glyphs: array<Glyph>;

// Two triangles: corners 0 (0,0), 1 (1,0), 2 (0,1), 3 (0,1), 4 (1,0), 5 (1,1).
fn corner(vi: u32) -> vec2f {
  return vec2f(f32((0x32u >> vi) & 1u), f32((0x2cu >> vi) & 1u));
}
fn ndc(p: vec2f) -> vec4f {
  return vec4f(p.x / frame.size.x * 2.0 - 1.0, 1.0 - p.y / frame.size.y * 2.0, 0.0, 1.0);
}
fn toLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}
// Straight sRGB colour to premultiplied colour in the target's space.
fn prep(c: vec4f) -> vec4f {
  let rgb = select(c.rgb, toLinear(c.rgb), frame.linear > 0.5);
  return vec4f(rgb * c.a, c.a);
}

struct RectOut {
  @builtin(position) clip: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) index: u32,
}
@vertex fn rectVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RectOut {
  let r = rects[ii];
  let pad = r.params.z * 2.0 + 2.0;
  let p = mix(r.box.xy - vec2f(pad), r.box.xy + r.box.zw + vec2f(pad), corner(vi));
  var o: RectOut;
  o.clip = ndc(p);
  o.local = p - (r.box.xy + r.box.zw * 0.5);
  o.index = ii;
  return o;
}
@fragment fn rectFragment(i: RectOut) -> @location(0) vec4f {
  let r = rects[i.index];
  let ext = r.box.zw * 0.5;
  let radius = min(r.params.x, min(ext.x, ext.y));
  let q = abs(i.local) - ext + vec2f(radius);
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  var cover = clamp(0.5 - d, 0.0, 1.0);
  if (r.params.z > 0.0) { cover = 1.0 - smoothstep(-r.params.z, r.params.z, d); }
  var inner = 1.0;
  if (r.params.y > 0.0) { inner = clamp(0.5 - (d + r.params.y), 0.0, 1.0); }
  return mix(prep(r.border), prep(r.fill), inner) * cover;
}

struct GlyphOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) page: u32,
  @location(2) @interpolate(flat) index: u32,
}
@vertex fn glyphVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GlyphOut {
  let g = glyphs[ii];
  let c = corner(vi);
  var o: GlyphOut;
  o.clip = ndc(mix(g.box.xy, g.box.zw, c));
  o.uv = vec2f(mix(g.uv.x, g.uv.z, c.x), mix(g.uv.y, g.uv.w, c.y));
  o.page = u32(g.info.x);
  o.index = ii;
  return o;
}
@fragment fn glyphFragment(i: GlyphOut) -> @location(0) vec4f {
  let g = glyphs[i.index];
  // Screen-space derivatives first, in uniform control flow: texels of the field per screen pixel.
  let texels = i.uv * vec2f(textureDimensions(sdfAtlas).xy);
  let w = max(0.5 * (length(dpdx(texels)) + length(dpdy(texels))), 1e-3);
  let texel = textureSampleLevel(sdfAtlas, atlasSampler, i.uv, i.page, 0.0).r;
  var tint = textureSampleLevel(colorAtlas, atlasSampler, i.uv, i.page, 0.0);
  if (g.info.y > 0.5) {
    // Colour glyph (emoji): premultiplied sRGB texels, no field.
    if (frame.linear > 0.5 && tint.a > 0.0) { tint = vec4f(toLinear(tint.rgb / tint.a) * tint.a, tint.a); }
    if (g.info.y > 1.5) {
      var color = g.color.rgb;
      if (frame.linear > 0.5) { color = toLinear(color); }
      return vec4f(tint.rgb * color, tint.a) * g.color.a;
    }
    return tint * g.color.a;
  }
  // Signed distance in texels, positive outside; the outline grows it by info.z screen pixels.
  let d = ((1.0 - texel) - frame.sdf.y) * frame.sdf.x;
  let field = clamp(texel * 127.5, 0.0, 1.0);
  let cover = clamp(0.5 - (d - g.info.z * w) / w, 0.0, 1.0) * field;
  return prep(vec4f(g.color.rgb, g.color.a * cover));
}
`;
