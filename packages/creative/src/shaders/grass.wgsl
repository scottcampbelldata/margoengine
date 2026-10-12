@group(0) @binding(2) var<storage, read> visible: array<u32>;
struct Output {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec3f,
  @location(2) normal: vec3f,
  @location(3) variation: f32,
}

fn bladeVertex(position: vec3f, uv: vec2f, id: u32) -> Output {
  let b = blades[id];
  let root = vec3f(b.posX, b.posY, b.posZ);
  let height = frame.field.z * b.scale;
  let bend = clamp(frame.wind.w * (0.35 + 0.65 * gust(root.xz)) / b.stiffness, 0.0, 0.58);
  let sideways = vec3f(cos(b.rotationY), 0, sin(b.rotationY));
  let direction = vec3f(frame.wind.x, 0, frame.wind.y);
  var vertical = 0.0;
  var tangent = vec2f(0);
  // Each bent segment retains its original length; adjacent tangents give smooth normals.
  for (var segment = 0; segment < 3; segment++) {
    let start = f32(segment) / 3.0;
    let end = f32(segment + 1) / 3.0;
    let dx = bend * (pow(end, 1.8) - pow(start, 1.8));
    let dy = sqrt(1.0 / 9.0 - dx * dx);
    vertical += dy * clamp(uv.y * 3.0 - f32(segment), 0.0, 1.0);
    if (abs(uv.y - start) < 0.001 || abs(uv.y - end) < 0.001) { tangent += vec2f(dx, dy); }
  }
  let curve = direction * height * bend * pow(uv.y, 1.8) + vec3f(0, height * vertical, 0);
  let along = direction * tangent.x + vec3f(0, tangent.y, 0);
  var o: Output;
  o.world = root + curve + sideways * position.x * height * 0.075;
  o.clip = frame.camera * vec4f(o.world, 1);
  o.uv = uv;
  o.normal = normalize(cross(sideways, along));
  o.variation = fract(b.rotationY * 7.13);
  return o;
}
@vertex fn nearVertex(@location(0) position: vec3f, @location(1) uv: vec2f, @builtin(instance_index) instance: u32) -> Output {
  return bladeVertex(position, uv, visible[instance]);
}
@vertex fn farVertex(@location(0) position: vec3f, @location(1) uv: vec2f, @builtin(instance_index) instance: u32) -> Output {
  return bladeVertex(position, uv, visible[u32(frame.settings.y) + instance]);
}
@fragment fn fragment(i: Output, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = normalize(i.normal) * select(-1.0, 1.0, front);
  let lightDir = normalize(frame.light.xyz);
  let viewDir = normalize(frame.eye.xyz - i.world);
  // Interpolation can dip below zero; fractional powers would then poison bloom with NaNs.
  let height = clamp(i.uv.y, 0.0, 1.0);
  let wrap = max(dot(n, lightDir) + 0.45, 0.0) / 1.45;
  let sss = pow(max(dot(-lightDir, viewDir), 0.0), 2.0) * height * 0.4;
  let root = vec3f(0.025, 0.065, 0.012);
  let tip = mix(vec3f(0.25, 0.46, 0.045), vec3f(0.38, 0.57, 0.085), i.variation);
  let color = mix(root, tip, pow(height, 0.7));
  let light = frame.radiance.xyz * frame.light.w;
  let linear = color * (frame.radiance.w + wrap * light) + vec3f(0.34, 0.5, 0.09) * sss * light;
  return vec4f(displayColor(linear), 1);
}

struct SporeOutput { @builtin(position) clip: vec4f, @location(0) uv: vec2f }
fn random(seed: u32) -> f32 {
  var n = seed * 747796405u + 2891336453u;
  n = ((n >> ((n >> 28u) + 4u)) ^ n) * 277803737u;
  return f32((n >> 22u) ^ n) / 4294967296.0;
}
@vertex fn sporeVertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) id: u32) -> SporeOutput {
  let corners = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(1,1), vec2f(-1,-1), vec2f(1,1), vec2f(-1,1));
  let seed = vec2f(random(id * 3u), random(id * 3u + 1u));
  let phase = random(id * 3u + 2u);
  let drift = frame.wind.xy * frame.field.w * frame.wind.z * (0.25 + gust(seed * frame.field.xy) * 0.2);
  let xz = (fract(seed + drift / frame.field.xy) - 0.5) * frame.field.xy;
  let y = frame.field.z + phase * 4.0 + sin(frame.field.w * 0.6 + phase * 6.283) * 0.25;
  let q = corners[vertex];
  let world = vec3f(xz.x, y, xz.y) + (frame.right.xyz * q.x + frame.up.xyz * q.y) * (0.035 + phase * 0.025);
  var o: SporeOutput; o.clip = frame.camera * vec4f(world, 1); o.uv = q; return o;
}
@fragment fn sporeFragment(i: SporeOutput) -> @location(0) vec4f {
  let radius = length(i.uv);
  let spokes = pow(abs(cos(atan2(i.uv.y, i.uv.x) * 6.0)), 18.0);
  let alpha = (1.0 - smoothstep(0.0, 0.22, radius)) + spokes * (1.0 - smoothstep(0.25, 1.0, radius)) * 0.55;
  if (alpha < 0.015) { discard; }
  return vec4f(displayColor(vec3f(2.5, 2.4, 2.1)), min(alpha, 0.85));
}
