@group(0) @binding(2) var<storage, read_write> visible: array<u32>;
struct Draw { vertices: u32, instances: atomic<u32>, firstVertex: u32, firstInstance: u32 }
@group(0) @binding(3) var<storage, read_write> draws: array<Draw, 2>;

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) id: vec3u) {
  let count = u32(frame.settings.y);
  if (id.x >= count) { return; }
  let b = blades[id.x];
  let height = frame.field.z * b.scale;
  let root = vec3f(b.posX, b.posY, b.posZ);
  let center = root + vec3f(0, height * 0.5, 0);
  let radius = height * 0.95;
  let distance = length(center - frame.eye.xyz);
  if (distance - radius > frame.settings.x) { return; }
  for (var i = 0u; i < 6u; i++) {
    if (dot(frame.planes[i].xyz, center) + frame.planes[i].w < -radius) { return; }
  }
  let lod = select(0u, 1u, distance > frame.settings.x * 0.45);
  if (distance > frame.settings.x * 0.7 && id.x % 4u != 0u) { return; }
  let slot = atomicAdd(&draws[lod].instances, 1u);
  visible[lod * count + slot] = id.x;
}
