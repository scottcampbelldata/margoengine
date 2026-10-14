@group(0) @binding(0) var<storage, read_write> ndb0:array<vec4f>;
struct NdUniforms {
  speed:f32,
  deltaTime:f32,
}
@group(0) @binding(1) var<uniform> ndu:NdUniforms;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u) {
  if (gid.x >= 256u) { return; }
  ndb0[gid.x] = ndb0[gid.x] + vec4f(0.0, ndu.speed * ndu.deltaTime, 0.0, 0.0);
}
