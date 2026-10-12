/**
 * SDF text shader. One instanced draw per text block: instance i draws glyph i % count in layer
 * i / count, and the layers run shadow, outline, fill so every glyph's fill covers every neighbour's outline.
 */
export const textShader: string = /* wgsl */ `
struct Frame { viewProj: mat4x4f, right: vec4f, up: vec4f, info: vec4f }
struct Block { model: mat4x4f, color: vec4f, outline: vec4f, shadow: vec4f, params: vec4f, info: vec4u, sdf: vec4f }
struct Glyph { rect: vec4f, uv: vec4f, info: vec4u }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var sdfAtlas: texture_2d_array<f32>;
@group(0) @binding(3) var colorAtlas: texture_2d_array<f32>;
@group(1) @binding(0) var<uniform> block: Block;
@group(1) @binding(1) var<storage, read> glyphs: array<Glyph>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) page: u32,
  @location(2) @interpolate(flat) kind: u32,
}

@vertex fn vertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let n = max(block.info.x, 1u);
  let layer = ii / n;
  let g = glyphs[ii % n];
  let kind = (block.info.z >> (2u * layer)) & 3u;
  // Two triangles: corners 0 (0,0), 1 (1,0), 2 (0,1), 3 (0,1), 4 (1,0), 5 (1,1).
  let c = vec2f(f32((0x32u >> vi) & 1u), f32((0x2cu >> vi) & 1u));
  var local = mix(g.rect.xy, g.rect.zw, c);
  if (kind == 0u) { local += block.params.zw; }
  var world: vec4f;
  if ((block.info.w & 1u) != 0u) {
    let sx = length(block.model[0].xyz);
    let sy = length(block.model[1].xyz);
    world = vec4f(block.model[3].xyz + frame.right.xyz * (local.x * sx) + frame.up.xyz * (local.y * sy), 1.0);
  } else {
    world = block.model * vec4f(local, 0.0, 1.0);
  }
  var o: Out;
  o.clip = frame.viewProj * world;
  o.uv = vec2f(mix(g.uv.x, g.uv.z, c.x), mix(g.uv.w, g.uv.y, c.y));
  o.page = g.info.x;
  o.kind = kind | (g.info.y << 2u);
  return o;
}

fn toLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

@fragment fn fragment(i: Out) -> @location(0) vec4f {
  // Screen-space derivatives first, in uniform control flow: texels of the SDF per screen pixel.
  let texels = i.uv * vec2f(textureDimensions(sdfAtlas).xy);
  let w = max(0.5 * (length(dpdx(texels)) + length(dpdy(texels))), 1e-3);
  let texel = textureSampleLevel(sdfAtlas, atlasSampler, i.uv, i.page, 0.0).r;
  var tint = textureSampleLevel(colorAtlas, atlasSampler, i.uv, i.page, 0.0);
  let kind = i.kind & 3u;
  // Signed distance in SDF texels, positive outside. Fade out where the field saturates so quad edges never show.
  let d = ((1.0 - texel) - block.sdf.y) * block.sdf.x;
  let field = clamp(texel * 127.5, 0.0, 1.0);
  var color: vec4f;
  if (kind == 2u) {
    color = vec4f(block.color.rgb, block.color.a * clamp(0.5 - d / w, 0.0, 1.0) * field);
  } else if (kind == 1u) {
    color = vec4f(block.outline.rgb, block.outline.a * clamp(0.5 - (d - block.params.x) / w, 0.0, 1.0) * field);
  } else {
    let soft = max(w, 2.0 * block.params.y);
    color = vec4f(block.shadow.rgb, block.shadow.a * smoothstep(0.0, 1.0, clamp(0.5 - (d - block.params.x) / soft, 0.0, 1.0)) * field);
  }
  if ((i.kind >> 2u) != 0u) {
    // Color glyph (emoji): premultiplied sRGB texels, no SDF. Outlines skip it; shadows use its alpha.
    if (frame.info.x > 0.5 && tint.a > 0.0) { tint = vec4f(toLinear(tint.rgb / tint.a) * tint.a, tint.a); }
    if (kind == 2u) { return tint * block.color.a; }
    if (kind == 1u) { return vec4f(0.0); }
    color = vec4f(block.shadow.rgb, block.shadow.a * tint.a);
  }
  return vec4f(color.rgb * color.a, color.a);
}
`;
