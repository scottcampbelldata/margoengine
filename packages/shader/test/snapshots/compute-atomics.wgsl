@group(0) @binding(0) var<storage, read_write> ndb0:array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> ndb1:array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> ndb2:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u) {
  if (gid.x >= 256u) { return; }
  let nd0 = atomicMax(&ndb0[1u], gid.x);
  let nd1 = atomicMin(&ndb0[2u], gid.x);
  let nd2 = atomicAdd(&ndb1[0u], -1i);
  let nd3 = (gid.x % 2u) == 0u;
  let nd4 = atomicAdd(&ndb0[0u], select(0u, 1u, nd3));
  let nd5 = atomicLoad(&ndb0[0u]);
  ndb2[select(255u, nd4, nd3)] = gid.x;
  atomicStore(&ndb0[3u], nd5);
}
