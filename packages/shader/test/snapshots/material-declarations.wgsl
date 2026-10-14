struct NdUniforms {
  tint:vec3f,
  time:f32,
}
@group(2) @binding(48) var<uniform> ndu:NdUniforms;,
  @location(8) ndv0:vec3f