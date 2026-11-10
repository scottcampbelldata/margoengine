// Clean-room physical-time transport. References and scope: docs/clean-room.md, batch 171.
import { frameWGSL } from './render.js';

const config = /* wgsl */ `struct Flow {
  model: mat4x4f, low: vec4f, high: vec4f, grid: vec4u, info: vec4u, other: vec4u,
  time: vec4f, life: vec4f, colour: vec4f
}
@group(0) @binding(0) var<uniform> flow: Flow;
`;

/** @internal GPU integration operates in normalised grid coordinates, with physical time steps. */
export const flowCompute = /* wgsl */ `${config}
struct Particle { position: vec4f, generation: vec4u }
@group(0) @binding(1) var<storage, read> velocity: array<vec4f>;
@group(0) @binding(2) var<storage, read> seeds: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(4) var<storage, read_write> history: array<vec4f>;

fn spatial(p: vec3f, frameIndex: u32) -> vec4f {
  if (!all(p >= vec3f(0.0)) || !all(p <= vec3f(1.0))) { return vec4f(0.0); }
  if (flow.grid.z == 1u && p.z != 0.0) { return vec4f(0.0); }
  let coord = p * vec3f(flow.grid.xyz - vec3u(1u));
  let cell = min(vec3u(floor(coord)), flow.grid.xyz - min(flow.grid.xyz, vec3u(2u)));
  let fraction = coord - vec3f(cell);
  var result = vec3f(0.0);
  for (var z = 0u; z < min(flow.grid.z, 2u); z++) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) {
        let weight = select(1.0 - fraction.x, fraction.x, x == 1u) *
          select(1.0 - fraction.y, fraction.y, y == 1u) *
          select(select(1.0 - fraction.z, fraction.z, z == 1u), 1.0, flow.grid.z == 1u);
        if (weight > 0.0) {
          let index = frameIndex * flow.grid.w + ((cell.z + z) * flow.grid.y + cell.y + y) * flow.grid.x + cell.x + x;
          let value = velocity[index];
          if (value.w == 0.0) { return vec4f(0.0); }
          result += weight * value.xyz;
        }
      }
    }
  }
  return vec4f(result, 1.0);
}

fn sample(p: vec3f, weight: f32) -> vec4f {
  if (weight <= 0.0 || flow.info.w == flow.other.x) { return spatial(p, flow.info.w); }
  if (weight >= 1.0) { return spatial(p, flow.other.x); }
  let a = spatial(p, flow.info.w);
  let b = spatial(p, flow.other.x);
  return vec4f(mix(a.xyz, b.xyz, weight), a.w * b.w);
}

@compute @workgroup_size(64) fn initialize(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= flow.info.x) { return; }
  let p = seeds[i].xyz;
  let valid = sample(p, flow.time.x).w;
  particles[i].position = vec4f(p, 0.0);
  particles[i].generation = vec4u(1u, u32(valid), 0u, 0u);
  for (var j = 0u; j < flow.info.y; j++) {
    history[i * flow.info.y + j] = vec4f(p, select(0.0, valid, j == 0u));
  }
}

@compute @workgroup_size(64) fn advect(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= flow.info.x) { return; }
  var particle = particles[i];
  let p = particle.position.xyz;
  let h = flow.time.z;
  let mid = (flow.time.x + flow.time.y) * 0.5;
  let a = sample(p, flow.time.x);
  let b = sample(p + h * 0.5 * a.xyz, mid);
  let c = sample(p + h * 0.5 * b.xyz, mid);
  let d = sample(p + h * c.xyz, flow.time.y);
  let next = p + (h / 6.0) * (a.xyz + 2.0 * b.xyz + 2.0 * c.xyz + d.xyz);
  let valid = a.w * b.w * c.w * d.w * sample(next, flow.time.y).w;
  // Compare remaining lifetime before adding: even finite ages/steps can overflow their sum.
  let remaining = max(0.0, flow.life.x - particle.position.w);
  if (particle.generation.y == 1u && valid == 1.0 && h < remaining) {
    particle.position = vec4f(next, particle.position.w + h);
  } else {
    particle.generation.y = 0u;
    if (flow.other.y == 1u) {
      particle.position = vec4f(seeds[i].xyz, 0.0);
      particle.generation.x += 1u;
      particle.generation.y = u32(sample(seeds[i].xyz, flow.time.y).w);
    }
  }
  particles[i] = particle;
  history[i * flow.info.y + flow.info.z] = vec4f(particle.position.xyz,
    select(0.0, f32(particle.generation.x), particle.generation.y == 1u));
}
`;

/** @internal Screen-width trail segments. A generation mismatch cuts the trail at respawn. */
export const flowDraw = /* wgsl */ `${frameWGSL}
${config.replace('@group(0)', '@group(1)')}
@group(1) @binding(1) var<storage, read> history: array<vec4f>;
FLOW_PROJECT
FLOW_APPEARANCE
struct Out { @builtin(position) clip: vec4f, @location(0) alpha: f32, @location(1) world: vec3f }
@vertex fn vertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> Out {
  let segment = instance % flow.info.y;
  let particle = instance / flow.info.y;
  let end = (flow.info.z + flow.info.y - segment) % flow.info.y;
  let start = (end + flow.info.y - 1u) % flow.info.y;
  let a = history[particle * flow.info.y + start];
  let b = history[particle * flow.info.y + end];
  let dataA = mix(flow.low.xyz, flow.high.xyz, a.xyz);
  let dataB = mix(flow.low.xyz, flow.high.xyz, b.xyz);
  let clipA = frame.clip * flow.model * vec4f(flowProject(dataA), 1.0);
  let clipB = frame.clip * flow.model * vec4f(flowProject(dataB), 1.0);
  var out: Out;
  out.clip = vec4f(2.0, 2.0, 2.0, 1.0);
  out.alpha = 0.0;
  out.world = vec3f(0.0);
  if (segment == flow.info.y - 1u) {
    let head = history[particle * flow.info.y + flow.info.z];
    let world = flow.model * vec4f(flowProject(mix(flow.low.xyz, flow.high.xyz, head.xyz)), 1.0);
    let clip = frame.clip * world;
    out.world = world.xyz;
    if (head.w == 0.0 || clip.w <= 0.0) { return out; }
    let x = select(-1.0, 1.0, vertexIndex == 1u || vertexIndex == 2u || vertexIndex == 4u);
    let y = select(-1.0, 1.0, vertexIndex == 2u || vertexIndex == 4u || vertexIndex == 5u);
    out.clip = vec4f(clip.xy + vec2f(x, y) * flow.life.y * clip.w / frame.viewport.xy, clip.zw);
    out.alpha = flow.life.z;
    return out;
  }
  if (a.w == 0.0 || a.w != b.w || clipA.w <= 0.0 || clipB.w <= 0.0) { return out; }
  let delta = (clipB.xy / clipB.w - clipA.xy / clipA.w) * frame.viewport.xy;
  let length = length(delta);
  if (length < 0.000001) { return out; }
  let side = vec2f(-delta.y, delta.x) / length;
  let atEnd = vertexIndex == 1u || vertexIndex == 2u || vertexIndex == 4u;
  let positive = vertexIndex == 2u || vertexIndex == 4u || vertexIndex == 5u;
  let clip = select(clipA, clipB, atEnd);
  out.world = (flow.model * vec4f(flowProject(select(dataA, dataB, atEnd)), 1.0)).xyz;
  let offset = side * select(-1.0, 1.0, positive) * flow.life.y / frame.viewport.xy;
  out.clip = vec4f(clip.xy + offset * clip.w, clip.zw);
  let age = f32(segment) + select(1.0, 0.0, atEnd);
  out.alpha = flow.life.z * pow(1.0 - age / f32(flow.info.y - 1u), 2.0);
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  return vec4f(toOutput(FLOW_COLOUR), in.alpha);
}
`;
