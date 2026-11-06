struct NdUniforms {
  limit:i32,
}
@group(0) @binding(0) var<uniform> ndu:NdUniforms;
@group(0) @binding(1) var<storage, read_write> ndb1:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u) {
  if (gid.x >= 4u) { return; }
  var nd0:u32 = 0u;
  var nd1:u32 = 0u;
  let nd2 = ndu.limit;
  for (var nd3 = 0i; nd3 < nd2; nd3 += 1i) {
    if ((nd3 % 2i) == 1i) {
      continue;
    }
    if (nd0 > 10u) {
      break;
    }
    nd0 = nd0 + u32(nd3);
    nd1 = nd1 + 1u;
  }
  ndb1[gid.x] = nd0 + nd1;
}
