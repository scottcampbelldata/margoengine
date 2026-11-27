// WGSL of GPULiquid (`@margoengine/water/liquid`): the five compute passes of one MLS-MPM substep and the debug view.
// The step is the CPU twin's (liquid-mpm-sim.ts) in f32, pass for pass. Buffers:
// - particles: per particle five vec4f, (x, y, z, density ratio), (vx, vy, vz, 0) and the rows of the APIC matrix C;
// - grid: per node four i32, the fixed-point mass and momentum while particles scatter, then the node's velocity and mass as
//   f32 bits after the grid update;
// - forces: per collider eight i32, the fixed-point impulse on the body and its moment about the centre;
// - sdf: the distance fields of the mesh colliders, one after another.
// Every scatter is an integer atomicAdd, so the sums and the whole step are the same on every run. A stage binds at most
// four storage buffers (WebGPU's default limit is eight). The build strips the comments inside the WGSL strings
// (docs/conventions.md, "Shader comments").

/** Floats of the simulation uniform: twelve vec4 of parameters, then six vec4 per collider. */
export const LIQUID_SIM_FLOATS = (12 + 6 * 8) * 4;
/** Floats of the debug view uniform. */
export const LIQUID_DEBUG_FLOATS = 28;

const HEADER = /* wgsl */ `
struct Particle {
  // position, density over rest density
  pos: vec4f,
  // velocity, unused
  vel: vec4f,
  // rows of the affine velocity matrix C, unused
  c0: vec4f,
  c1: vec4f,
  c2: vec4f,
}
struct Collider {
  // centre, kind (0 sphere, 1 box, 2 capsule, 3 plane, 4 mesh)
  center: vec4f,
  // sphere radius, box half size, capsule radius and half height, plane unit normal or mesh field half size; friction
  half: vec4f,
  // orientation quaternion
  rot: vec4f,
  // linear velocity, first sample of a mesh field in sdf
  vel: vec4f,
  // angular velocity, samples per axis of a mesh field
  ang: vec4f,
  // centre of a mesh field in the body's frame, unused
  local: vec4f,
}
struct Sim {
  // particles, grid nodes, colliders, pointer on
  counts: vec4u,
  // nodes per axis x, y, z, nodes per xy layer
  dims: vec4u,
  // cells per axis inside the container, unused
  cells: vec4u,
  // world position of node 0, substep dt
  origin: vec4f,
  // cell size per axis, speed limit
  cell: vec4f,
  // 1 / cell size per axis, rest density in particles per cell
  invCell: vec4f,
  // 4 / cell size^2 per axis (D^-1), pressure factor dt c^2 / gamma
  k4: vec4f,
  // container min, viscosity factor dt nu
  boxMin: vec4f,
  // container max, mean cell size
  boxMax: vec4f,
  // gravity, unused
  gravity: vec4f,
  // pointer position, radius
  pointer: vec4f,
  // pointer velocity, strength
  pointerVel: vec4f,
  colliders: array<Collider, 8>,
}
@group(0) @binding(0) var<uniform> sim: Sim;

const FIXED: f32 = 65536.0;
const FORCE_FIXED: f32 = 1024.0;
const GAMMA: f32 = 7.0;
const MAX_RATIO: f32 = 3.0;
const PAD: u32 = 2u;
const GHOST_REACH: f32 = 3.0;
const NONE: u32 = 0xffffffffu;

// One fixed-point term, clamped inside i32 and rounded half to even.
fn toFixed(v: f32, scale: f32) -> i32 {
  return i32(round(clamp(v * scale, -2e9, 2e9)));
}

// The quadratic B-spline stencil of a particle: its base node and the weights of the three nodes per axis.
struct Stencil {
  base: vec3u,
  f: vec3f,
  w0: vec3f,
  w1: vec3f,
  w2: vec3f,
}
fn stencil(x: vec3f) -> Stencil {
  let g = (x - sim.origin.xyz) * sim.invCell.xyz;
  let hi = vec3f(sim.dims.xyz) - 3.0;
  let b = clamp(floor(g - 0.5), vec3f(0.0), hi);
  let f = g - b;
  var s: Stencil;
  s.base = vec3u(b);
  s.f = f;
  s.w0 = 0.5 * (1.5 - f) * (1.5 - f);
  s.w1 = 0.75 - (f - 1.0) * (f - 1.0);
  s.w2 = 0.5 * (f - 0.5) * (f - 0.5);
  return s;
}
fn pick(s: Stencil, k: u32) -> vec3f {
  if (k == 0u) { return s.w0; }
  if (k == 1u) { return s.w1; }
  return s.w2;
}
fn index3(n: vec3u) -> u32 {
  return n.x + sim.dims.x * (n.y + sim.dims.y * n.z);
}
// Node index of the stencil node at offset o.
fn nodeOf(s: Stencil, o: vec3u) -> u32 {
  return index3(s.base + o);
}
// x_i - x_p of the stencil node at offset o, in world units.
fn offsetOf(s: Stencil, o: vec3u) -> vec3f {
  return (vec3f(o) - s.f) * sim.cell.xyz;
}
`;

/**
 * Collider distance shared by the stress, grid update and G2P passes; `binding` is where the pass binds the mesh fields.
 */
const collideWGSL = (binding: number) => /* wgsl */ `
// Every mesh collider's distance field, one after another.
@group(0) @binding(${binding}) var<storage, read> sdf: array<f32>;
// Rotates v by the unit quaternion q.
fn rotateQ(q: vec4f, v: vec3f) -> vec3f {
  let t = cross(q.xyz, v) + q.w * v;
  return v + 2.0 * cross(q.xyz, t);
}
// A mesh field of collider c at the point l of the body's frame: the trilinear sample at l clamped into the field's box,
// plus the distance from l to that box.
fn meshSample(c: Collider, l: vec3f) -> f32 {
  let n = u32(c.ang.w);
  let first = u32(c.vel.w);
  let h = c.half.xyz;
  let p = l - c.local.xyz;
  let q = clamp(p, -h, h);
  let g = (q + h) / (2.0 * h) * f32(n - 1u);
  let i0 = min(vec3u(floor(g)), vec3u(n - 2u));
  let f = g - vec3f(i0);
  var v = 0.0;
  for (var k = 0u; k < 2u; k++) {
    for (var j = 0u; j < 2u; j++) {
      for (var i = 0u; i < 2u; i++) {
        let w = select(1.0 - f.x, f.x, i == 1u) * select(1.0 - f.y, f.y, j == 1u) * select(1.0 - f.z, f.z, k == 1u);
        v += w * sdf[first + i0.x + i + n * (i0.y + j + n * (i0.z + k))];
      }
    }
  }
  return v + length(p - q);
}
// Signed distance from x to collider k (negative inside), with the outward normal in .xyz.
fn collide(k: u32, x: vec3f) -> vec4f {
  let c = sim.colliders[k];
  let d = x - c.center.xyz;
  let kind = u32(c.center.w + 0.5);
  if (kind == 0u) {
    let l = length(d);
    var n = vec3f(0.0, 1.0, 0.0);
    if (l > 0.0) { n = d / l; }
    return vec4f(n, l - c.half.x);
  }
  if (kind == 3u) {
    return vec4f(c.half.xyz, dot(d, c.half.xyz));
  }
  let local = rotateQ(vec4f(-c.rot.xyz, c.rot.w), d);
  if (kind == 2u) {
    // The capsule: distance to its axis segment less its radius.
    let p = local - vec3f(0.0, clamp(local.y, -c.half.y, c.half.y), 0.0);
    let l = length(p);
    var n = vec3f(1.0, 0.0, 0.0);
    if (l > 0.0) { n = p / l; }
    return vec4f(rotateQ(c.rot, n), l - c.half.x);
  }
  if (kind == 4u) {
    // The mesh: its field, and the normal by central differences half a sample apart.
    let e = c.half.xyz / (c.ang.w - 1.0);
    let g = vec3f(
      meshSample(c, local + vec3f(e.x, 0.0, 0.0)) - meshSample(c, local - vec3f(e.x, 0.0, 0.0)),
      meshSample(c, local + vec3f(0.0, e.y, 0.0)) - meshSample(c, local - vec3f(0.0, e.y, 0.0)),
      meshSample(c, local + vec3f(0.0, 0.0, e.z)) - meshSample(c, local - vec3f(0.0, 0.0, e.z)));
    let l = length(g);
    var n = vec3f(0.0, 1.0, 0.0);
    if (l > 0.0) { n = g / l; }
    return vec4f(rotateQ(c.rot, n), meshSample(c, local));
  }
  let q = abs(local) - c.half.xyz;
  let sg = select(vec3f(1.0), vec3f(-1.0), local < vec3f(0.0));
  let o = max(q, vec3f(0.0));
  let outside = length(o);
  var n: vec3f;
  if (outside > 0.0) {
    n = o * sg / outside;
  } else if (q.x >= q.y && q.x >= q.z) {
    n = vec3f(sg.x, 0.0, 0.0);
  } else if (q.y >= q.z) {
    n = vec3f(0.0, sg.y, 0.0);
  } else {
    n = vec3f(0.0, 0.0, sg.z);
  }
  return vec4f(rotateQ(c.rot, n), outside + min(max(q.x, max(q.y, q.z)), 0.0));
}
// The distance alone, without a mesh's six extra samples for its normal.
fn distanceTo(k: u32, x: vec3f) -> f32 {
  let c = sim.colliders[k];
  if (u32(c.center.w + 0.5) == 4u) { return meshSample(c, rotateQ(vec4f(-c.rot.xyz, c.rot.w), x - c.center.xyz)); }
  return collide(k, x).w;
}
// The velocity of collider k's surface at x.
fn bodyVelocity(k: u32, x: vec3f) -> vec3f {
  let c = sim.colliders[k];
  return c.vel.xyz + cross(c.ang.xyz, x - c.center.xyz);
}
`;

/** Zeroes the grid's fixed-point sums. */
export const LIQUID_CLEAR_WGSL = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read_write> grid: array<vec4i>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sim.counts.y) { return; }
  grid[id.x] = vec4i(0);
}
`;

/** P2G, mass and APIC momentum: m_i += w, (m v)_i += w (v + C d). */
export const LIQUID_P2G_WGSL = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sim.counts.x) { return; }
  let p = particles[id.x];
  let s = stencil(p.pos.xyz);
  for (var c = 0u; c < 3u; c++) {
    for (var b = 0u; b < 3u; b++) {
      for (var a = 0u; a < 3u; a++) {
        let o = vec3u(a, b, c);
        let weight = pick(s, a).x * pick(s, b).y * pick(s, c).z;
        let d = offsetOf(s, o);
        let q = p.vel.xyz + vec3f(dot(p.c0.xyz, d), dot(p.c1.xyz, d), dot(p.c2.xyz, d));
        let n = nodeOf(s, o) * 4u;
        atomicAdd(&grid[n], toFixed(weight, FIXED));
        atomicAdd(&grid[n + 1u], toFixed(weight * q.x, FIXED));
        atomicAdd(&grid[n + 2u], toFixed(weight * q.y, FIXED));
        atomicAdd(&grid[n + 3u], toFixed(weight * q.z, FIXED));
      }
    }
  }
}
`;

/**
 * P2G, stress: density from the grid's mass, with the walls mirrored and the colliders read as liquid at rest, Tait
 * pressure (zero below rest density) and the viscous stress, scattered as -dt vol sigma D^-1 d.
 */
export const LIQUID_STRESS_WGSL = /* wgsl */ `${HEADER}${collideWGSL(3)}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
// The node on one axis that mirrors node i across a wall within two cells of it, or NONE. A node on a wall is its own
// mirror, so it counts twice.
fn mirror(axis: u32, i: u32) -> u32 {
  let lo = i32(PAD);
  let hi = i32(PAD + sim.cells[axis]);
  let k = i32(i);
  var m = -1;
  if (k >= lo - 2 && k <= lo + 2) { m = 2 * lo - k; } else if (k >= hi - 2 && k <= hi + 2) { m = 2 * hi - k; }
  if (m < 0 || m >= i32(sim.dims[axis])) { return NONE; }
  return u32(m);
}
// The grid's mass at node n plus its mirrors across the walls, in particles.
fn wallMass(n: vec3u) -> f32 {
  let m = vec3u(mirror(0u, n.x), mirror(1u, n.y), mirror(2u, n.z));
  var sum = 0;
  for (var z = 0u; z < 2u; z++) {
    if (z == 1u && m.z == NONE) { continue; }
    for (var y = 0u; y < 2u; y++) {
      if (y == 1u && m.y == NONE) { continue; }
      for (var x = 0u; x < 2u; x++) {
        if (x == 1u && m.x == NONE) { continue; }
        let at = vec3u(select(n.x, m.x, x == 1u), select(n.y, m.y, y == 1u), select(n.z, m.z, z == 1u));
        sum += atomicLoad(&grid[index3(at) * 4u]);
      }
    }
  }
  return f32(sum) / FIXED;
}
// The share of a rest-liquid node's mass on the far side of a flat face t cells away (the B-spline integral up to t).
fn splineCover(t: f32) -> f32 {
  if (t <= -1.5) { return 0.0; }
  if (t >= 1.5) { return 1.0; }
  if (t < -0.5) { return pow(t + 1.5, 3.0) / 6.0; }
  if (t <= 0.5) { return 1.0 / 6.0 + 0.75 * (t + 0.5) - (t * t * t + 0.125) / 3.0; }
  return 1.0 - pow(1.5 - t, 3.0) / 6.0;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sim.counts.x) { return; }
  let p = particles[id.x];
  let s = stencil(p.pos.xyz);
  let hc = sim.boxMax.w;
  var near = 0u;
  for (var k = 0u; k < sim.counts.z; k++) {
    if (distanceTo(k, p.pos.xyz) < GHOST_REACH * hc) { near |= 1u << k; }
  }
  // The particle's density: the grid's mass interpolated back, in particles per cell.
  var rho = 0.0;
  for (var c = 0u; c < 3u; c++) {
    for (var b = 0u; b < 3u; b++) {
      for (var a = 0u; a < 3u; a++) {
        let o = vec3u(a, b, c);
        var m = wallMass(s.base + o);
        if (near != 0u) {
          let x = sim.origin.xyz + vec3f(s.base + o) * sim.cell.xyz;
          var ghost = 0.0;
          for (var k = 0u; k < sim.counts.z; k++) {
            if ((near & (1u << k)) != 0u) { ghost += splineCover(-distanceTo(k, x) / hc); }
          }
          m += ghost * sim.invCell.w;
        }
        rho += pick(s, a).x * pick(s, b).y * pick(s, c).z * m;
      }
    }
  }
  let ratio = rho / sim.invCell.w;
  particles[id.x].pos.w = ratio;
  let capped = min(ratio, MAX_RATIO);
  // Tait: vol * p = c^2 / gamma * (r^gamma - 1) / r, times dt in k4.w; no pressure below rest density.
  var pc = 0.0;
  if (capped > 1.0) { pc = sim.k4.w * (pow(capped, GAMMA) - 1.0) / capped; }
  let kv = sim.boxMin.w;
  for (var c = 0u; c < 3u; c++) {
    for (var b = 0u; b < 3u; b++) {
      for (var a = 0u; a < 3u; a++) {
        let o = vec3u(a, b, c);
        let weight = pick(s, a).x * pick(s, b).y * pick(s, c).z;
        let kd = offsetOf(s, o) * sim.k4.xyz;
        // (C + C^T) kd: the rows of C dotted with kd, plus the columns of C weighted by kd.
        let cd = vec3f(dot(p.c0.xyz, kd), dot(p.c1.xyz, kd), dot(p.c2.xyz, kd));
        let ctd = p.c0.xyz * kd.x + p.c1.xyz * kd.y + p.c2.xyz * kd.z;
        let m = weight * (pc * kd - kv * (cd + ctd));
        let n = nodeOf(s, o) * 4u;
        atomicAdd(&grid[n + 1u], toFixed(m.x, FIXED));
        atomicAdd(&grid[n + 2u], toFixed(m.y, FIXED));
        atomicAdd(&grid[n + 3u], toFixed(m.z, FIXED));
      }
    }
  }
}
`;

/** Adds one impulse on collider k and its moment about the centre to the fixed-point sums. */
const ADD_IMPULSE = /* wgsl */ `
fn addImpulse(k: u32, r: vec3f, j: vec3f) {
  let mo = cross(r, j);
  let o = k * 8u;
  atomicAdd(&forces[o], toFixed(j.x, FORCE_FIXED));
  atomicAdd(&forces[o + 1u], toFixed(j.y, FORCE_FIXED));
  atomicAdd(&forces[o + 2u], toFixed(j.z, FORCE_FIXED));
  atomicAdd(&forces[o + 3u], toFixed(mo.x, FORCE_FIXED));
  atomicAdd(&forces[o + 4u], toFixed(mo.y, FORCE_FIXED));
  atomicAdd(&forces[o + 5u], toFixed(mo.z, FORCE_FIXED));
}
`;

/** Grid update: velocity, gravity, the pointer, the speed limit, the colliders (and their impulses), the walls. */
export const LIQUID_GRID_WGSL = /* wgsl */ `${HEADER}${collideWGSL(3)}
@group(0) @binding(1) var<storage, read_write> grid: array<vec4i>;
@group(0) @binding(2) var<storage, read_write> forces: array<atomic<i32>>;
${ADD_IMPULSE}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= sim.counts.y) { return; }
  let raw = grid[node];
  if (raw.x <= 0) {
    grid[node] = vec4i(0);
    return;
  }
  let dt = sim.origin.w;
  let m = f32(raw.x) / FIXED;
  var v = vec3f(raw.yzw) / FIXED / m + sim.gravity.xyz * dt;
  let i = vec3u(node % sim.dims.x, (node / sim.dims.x) % sim.dims.y, node / sim.dims.w);
  let x = sim.origin.xyz + vec3f(i) * sim.cell.xyz;
  // The pointer: nodes within its radius take on its velocity at a rate falling to zero at the edge.
  if (sim.counts.w != 0u) {
    let e = x - sim.pointer.xyz;
    let q = dot(e, e) / (sim.pointer.w * sim.pointer.w);
    if (q < 1.0) {
      let k = 1.0 - exp(-sim.pointerVel.w * (1.0 - q) * (1.0 - q) * dt);
      v += (sim.pointerVel.xyz - v) * k;
    }
  }
  // No node moves more than one cell in a substep.
  let speed = length(v);
  let vmax = sim.cell.w;
  if (speed > vmax) { v *= vmax / speed; }
  // Colliders: a node inside one moving into it keeps the body's normal velocity and its own tangential velocity less
  // Coulomb friction; the body takes the opposite of that change of momentum.
  for (var k = 0u; k < sim.counts.z; k++) {
    let hit = collide(k, x);
    if (hit.w >= 0.0) { continue; }
    let vb = bodyVelocity(k, x);
    var t = v - vb;
    let vn = dot(t, hit.xyz);
    if (vn >= 0.0) { continue; }
    t -= vn * hit.xyz;
    let lt = length(t);
    var keep = 0.0;
    if (lt > 1e-9) { keep = max(0.0, 1.0 - sim.colliders[k].half.w * -vn / lt); }
    let nv = vb + t * keep;
    addImpulse(k, x - sim.colliders[k].center.xyz, -m * (nv - v));
    v = nv;
  }
  // Container walls, free slip: no node on or past a wall moves further out.
  let lo = i <= vec3u(PAD);
  let hi = i >= vec3u(PAD) + sim.cells.xyz;
  v = select(v, vec3f(0.0), (lo & (v < vec3f(0.0))) | (hi & (v > vec3f(0.0))));
  grid[node] = bitcast<vec4i>(vec4f(v, m));
}
`;

/** G2P: velocity and APIC C = sum w v (D^-1 d)^T, advection, out of the colliders (counted), inside the walls. */
export const LIQUID_G2P_WGSL = /* wgsl */ `${HEADER}${collideWGSL(4)}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> grid: array<vec4i>;
@group(0) @binding(3) var<storage, read_write> forces: array<atomic<i32>>;
${ADD_IMPULSE}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sim.counts.x) { return; }
  var p = particles[id.x];
  let s = stencil(p.pos.xyz);
  var v = vec3f(0.0);
  var b0 = vec3f(0.0);
  var b1 = vec3f(0.0);
  var b2 = vec3f(0.0);
  for (var c = 0u; c < 3u; c++) {
    for (var b = 0u; b < 3u; b++) {
      for (var a = 0u; a < 3u; a++) {
        let o = vec3u(a, b, c);
        let weight = pick(s, a).x * pick(s, b).y * pick(s, c).z;
        let kd = offsetOf(s, o) * sim.k4.xyz;
        let gv = bitcast<vec4f>(grid[nodeOf(s, o)]).xyz;
        v += weight * gv;
        b0 += weight * gv.x * kd;
        b1 += weight * gv.y * kd;
        b2 += weight * gv.z * kd;
      }
    }
  }
  var x = p.pos.xyz + v * sim.origin.w;
  // A particle that entered a collider goes back to its surface and loses its speed into it; the body takes that.
  for (var k = 0u; k < sim.counts.z; k++) {
    let hit = collide(k, x);
    if (hit.w >= 0.0) { continue; }
    x -= hit.w * hit.xyz;
    let vn = dot(v - bodyVelocity(k, x), hit.xyz);
    if (vn >= 0.0) { continue; }
    v -= vn * hit.xyz;
    addImpulse(k, x - sim.colliders[k].center.xyz, vn * hit.xyz);
  }
  // Inside the walls; a particle held at a wall keeps no velocity into it.
  let lo = x < sim.boxMin.xyz;
  let hi = x > sim.boxMax.xyz;
  x = clamp(x, sim.boxMin.xyz, sim.boxMax.xyz);
  v = select(v, vec3f(0.0), (lo & (v < vec3f(0.0))) | (hi & (v > vec3f(0.0))));
  p.pos = vec4f(x, p.pos.w);
  p.vel = vec4f(v, 0.0);
  p.c0 = vec4f(b0, 0.0);
  p.c1 = vec4f(b1, 0.0);
  p.c2 = vec4f(b2, 0.0);
  particles[id.x] = p;
}
`;

const DEBUG_HEADER = /* wgsl */ `
struct View {
  // view projection
  matrix: mat4x4f,
  // camera right, sprite radius
  right: vec4f,
  // camera up, mode (1 speed, 2 density)
  up: vec4f,
  // speed at the top of the ramp, unused, sRGB encode, unused
  params: vec4f,
}
@group(0) @binding(0) var<uniform> view: View;
// Linear to sRGB for an 8-bit target that does not encode.
fn encode(c: vec3f) -> vec3f {
  if (view.params.z < 0.5) { return c; }
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
`;

/** Debug view: every particle as a shaded sprite, coloured by speed or by density over rest density. */
export const LIQUID_DEBUG_PARTICLES_WGSL = /* wgsl */ `${DEBUG_HEADER}
struct Particle {
  pos: vec4f,
  vel: vec4f,
  c0: vec4f,
  c1: vec4f,
  c2: vec4f,
}
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
}
// A blue, cyan, green, yellow, red ramp over t in 0..1.
fn ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  return clamp(vec3f(1.5 - abs(4.0 * x - 3.0), 1.5 - abs(4.0 * x - 2.0), 1.5 - abs(4.0 * x - 1.0)), vec3f(0.0), vec3f(1.0));
}
@vertex
fn vertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let uv = corners[vi];
  let p = particles[ii];
  let world = p.pos.xyz + (view.right.xyz * uv.x + view.up.xyz * uv.y) * view.right.w;
  var t = 0.0;
  if (view.up.w < 1.5) {
    t = length(p.vel.xyz) / view.params.x;
  } else {
    // Density over rest density: 0.8 at the bottom of the ramp, 1.2 at the top.
    t = (p.pos.w - 0.8) / 0.4;
  }
  var o: Out;
  o.clip = view.matrix * vec4f(world, 1.0);
  o.uv = uv;
  o.color = ramp(t);
  return o;
}
@fragment
fn fragment(i: Out) -> @location(0) vec4f {
  let r2 = dot(i.uv, i.uv);
  if (r2 > 1.0) { discard; }
  let shade = 0.55 + 0.45 * sqrt(1.0 - r2);
  return vec4f(encode(i.color * shade), 1.0);
}
`;

/** Debug view: the container, the grid on its floor and back wall, the colliders and the pointer, as lines. */
export const LIQUID_DEBUG_LINES_WGSL = /* wgsl */ `${DEBUG_HEADER}
// Line end points: position, colour index.
@group(0) @binding(1) var<storage, read> points: array<vec4f>;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
}
@vertex
fn vertex(@builtin(vertex_index) vi: u32) -> Out {
  let p = points[vi];
  // container, grid, collider, pointer
  var colors = array<vec3f, 4>(vec3f(0.85, 0.9, 1.0), vec3f(0.25, 0.32, 0.42), vec3f(1.0, 0.55, 0.15), vec3f(1.0, 0.2, 0.6));
  var o: Out;
  o.clip = view.matrix * vec4f(p.xyz, 1.0);
  o.color = colors[min(u32(p.w), 3u)];
  return o;
}
@fragment
fn fragment(i: Out) -> @location(0) vec4f {
  return vec4f(encode(i.color), 1.0);
}
`;
