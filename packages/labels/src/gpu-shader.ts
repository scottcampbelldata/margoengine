export const gpuLabelShader = /* wgsl */ `
struct Frame { matrix: mat4x4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var atlas: texture_2d_array<f32>;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) glyphInfo: vec4f,
}
@vertex fn vertex(@builtin(vertex_index) vi: u32,
  @location(0) anchor: vec4f, @location(1) rect: vec4f,
  @location(2) uv: vec4f, @location(3) color: vec4f, @location(4) glyphInfo: vec4f) -> Out {
  let c = vec2f(f32((0x32u >> vi) & 1u), f32((0x2cu >> vi) & 1u));
  let offset = mix(rect.xy, rect.zw, c);
  var o: Out;
  o.position = frame.matrix * vec4f(anchor.xyz, 1.0);
  o.position.x += offset.x * 2.0 / frame.viewport.x * o.position.w;
  o.position.y -= offset.y * 2.0 / frame.viewport.y * o.position.w;
  o.uv = mix(uv.xy, uv.zw, c);
  o.color = color;
  o.glyphInfo = glyphInfo;
  return o;
}
@fragment fn fragment(i: Out) -> @location(0) vec4f {
  let field = textureSampleLevel(atlas, atlasSampler, i.uv, i32(i.glyphInfo.x), 0.0);
  let w = max(fwidth(field.r), 0.0001);
  let coverage = smoothstep(1.0 - i.glyphInfo.w - w * 0.5, 1.0 - i.glyphInfo.w + w * 0.5, field.r);
  if (i.glyphInfo.y > 0.5) { return field * i.color.a; }
  let a = coverage * i.color.a;
  return vec4f(i.color.rgb * a, a);
}
`;

export const glLabelVertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 anchor;
layout(location=1) in vec4 rect;
layout(location=2) in vec4 texcoord;
layout(location=3) in vec4 tint;
layout(location=4) in vec4 info;
uniform mat4 matrix;
uniform vec2 viewport;
out vec2 uv;
out vec4 color;
flat out vec4 glyphInfo;
void main() {
  vec2 c = vec2(float((0x32u >> uint(gl_VertexID)) & 1u), float((0x2cu >> uint(gl_VertexID)) & 1u));
  vec2 offset = mix(rect.xy, rect.zw, c);
  gl_Position = matrix * vec4(anchor.xyz, 1.0);
  gl_Position.xy += offset * vec2(2.0, -2.0) / viewport * gl_Position.w;
  uv = mix(texcoord.xy, texcoord.zw, c); color = tint; glyphInfo = info;
}`;

export const glLabelFragment = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray atlas;
in vec2 uv;
in vec4 color;
flat in vec4 glyphInfo;
out vec4 outputColor;
void main() {
  vec4 field = texture(atlas, vec3(uv, glyphInfo.x));
  float w = max(fwidth(field.r), 0.0001);
  float a = smoothstep(1.0-glyphInfo.w-w*0.5, 1.0-glyphInfo.w+w*0.5, field.r) * color.a;
  outputColor = glyphInfo.y > 0.5 ? field * color.a : vec4(color.rgb * a, a);
}`;
