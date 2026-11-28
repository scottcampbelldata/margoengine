// WGSL of GPULiquid (`@margoengine/water/liquid`): the five compute passes of one MLS-MPM substep, the accurate profile's
// pressure projection and the debug view.
// The step is the CPU twin's (liquid-mpm-sim.ts) in f32, pass for pass. Buffers:
// - particles: per particle five vec4f, (x, y, z, density ratio), (vx, vy, vz, liquid), the APIC matrix C row by row in
//   the next nine floats and the particle's colour in the last three;
// - grid: per node two vec4i, the fixed-point weight, mass, momentum and colour sums while particles scatter, then the
//   node's velocity, mass and weight as f32 bits after the grid update (the colour sums kept);
// - forces: per collider eight i32, the fixed-point impulse on the body and its moment about the centre;
// - sdf: the distance fields of the mesh colliders, one after another;
// - tally: the live particle count (word 0); every particle pass skips the slots past it and the drained particles
//   (density ratio below zero) before them.
// Every scatter is an integer atomicAdd, so the sums and the whole step are the same on every run. A stage binds at most
// five storage buffers (WebGPU's default limit is eight). The build strips the comments inside the WGSL strings
// (docs/conventions.md, "Shader comments").

/** Floats of the simulation uniform: thirteen vec4 of parameters, four of the liquids, eight of the drains, then six vec4 per collider. */
export const LIQUID_SIM_FLOATS = (26 + 6 * 8) * 4;
/** Floats of the emit pass's uniform: two vec4 of the frame, then six vec4 per emitter. */
export const LIQUID_EMIT_FLOATS = (2 + 6 * 4) * 4;
/** Floats of the debug view uniform. */
export const LIQUID_DEBUG_FLOATS = 28;

const HEADER = /* wgsl */ `
struct Particle {
  // position, density over rest density
  pos: vec4f,
  // velocity, liquid index
  vel: vec4f,
  // the affine velocity matrix C row by row (c0.xyz, c0.w c1.xy, c1.zw c2.x), then the colour (c2.yzw)
  c0: vec4f,
  c1: vec4f,
  c2: vec4f,
}
fn row0(p: Particle) -> vec3f { return p.c0.xyz; }
fn row1(p: Particle) -> vec3f { return vec3f(p.c0.w, p.c1.xy); }
fn row2(p: Particle) -> vec3f { return vec3f(p.c1.zw, p.c2.x); }
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
  // surface tension factor dt sigma / rho0, adhesion in m/s^2, adhesion reach, colour mixing factor of a substep
  surface: vec4f,
  // per liquid: mass over particleMass, its viscous factor dt nu * mass, unused, unused
  kinds: array<vec4f, 4>,
  // per drain: centre and kind (0 box, 1 sphere, -1 off), half size or radius; cells.w drains
  drains: array<vec4f, 8>,
  colliders: array<Collider, 8>,
  // per axis 1 when its two walls are smooth (the wall function), 0 when free slip; kinematic viscosity
  walls: vec4f,
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
// Node i one step along axis a up (or down), held inside the grid.
fn step3(i: vec3u, a: u32, up: bool) -> vec3u {
  var o = i;
  if (up) { o[a] = min(i[a] + 1u, sim.dims[a] - 1u); } else { o[a] = select(0u, i[a] - 1u, i[a] > 0u); }
  return o;
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

/** The share of a rest-liquid node's mass on the far side of a flat face t cells away (the B-spline integral up to t). */
const SPLINE_COVER = /* wgsl */ `
fn splineCover(t: f32) -> f32 {
  if (t <= -1.5) { return 0.0; }
  if (t >= 1.5) { return 1.0; }
  if (t < -0.5) { return pow(t + 1.5, 3.0) / 6.0; }
  if (t <= 0.5) { return 1.0 / 6.0 + 0.75 * (t + 0.5) - (t * t * t + 0.125) / 3.0; }
  return 1.0 - pow(1.5 - t, 3.0) / 6.0;
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
// The adhesion profile: 1 within half the reach of a surface, a cubic Hermite step down to 0 at the reach.
fn adhesionKernel(d: f32, reach: f32) -> f32 {
  if (d >= reach) { return 0.0; }
  if (d <= 0.5 * reach) { return 1.0; }
  let t = (d - 0.5 * reach) / (0.5 * reach);
  return (1.0 - t) * (1.0 - t) * (1.0 + 2.0 * t);
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
  grid[2u * id.x] = vec4i(0);
  grid[2u * id.x + 1u] = vec4i(0);
}
`;

/** P2G: weight n_i += w, mass m_i += w m_p, APIC momentum (m v)_i += w m_p (v + C d), and the colour sums when mixing. */
export const LIQUID_P2G_WGSL = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read> tally: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= tally[0]) { return; }
  let p = particles[id.x];
  if (p.pos.w < 0.0) { return; }
  let s = stencil(p.pos.xyz);
  let mr = sim.kinds[min(u32(p.vel.w), 3u)].x;
  for (var c = 0u; c < 3u; c++) {
    for (var b = 0u; b < 3u; b++) {
      for (var a = 0u; a < 3u; a++) {
        let o = vec3u(a, b, c);
        let weight = pick(s, a).x * pick(s, b).y * pick(s, c).z;
        let d = offsetOf(s, o);
        let q = mr * (p.vel.xyz + vec3f(dot(row0(p), d), dot(row1(p), d), dot(row2(p), d)));
        let n = nodeOf(s, o) * 8u;
        atomicAdd(&grid[n], toFixed(weight, FIXED));
        atomicAdd(&grid[n + 1u], toFixed(weight * mr, FIXED));
        atomicAdd(&grid[n + 2u], toFixed(weight * q.x, FIXED));
        atomicAdd(&grid[n + 3u], toFixed(weight * q.y, FIXED));
        atomicAdd(&grid[n + 4u], toFixed(weight * q.z, FIXED));
        if (sim.surface.w > 0.0) {
          atomicAdd(&grid[n + 5u], toFixed(weight * p.c2.y, FIXED));
          atomicAdd(&grid[n + 6u], toFixed(weight * p.c2.z, FIXED));
          atomicAdd(&grid[n + 7u], toFixed(weight * p.c2.w, FIXED));
        }
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
@group(0) @binding(4) var<storage, read> tally: array<u32>;
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
        sum += atomicLoad(&grid[index3(at) * 8u]);
      }
    }
  }
  return f32(sum) / FIXED;
}
${SPLINE_COVER}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= tally[0]) { return; }
  let p = particles[id.x];
  if (p.pos.w < 0.0) { return; }
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
  // Each liquid's Tait pressure on the shared number density (Solenthaler and Pajarola 2008) and its own viscosity.
  let kind = sim.kinds[min(u32(p.vel.w), 3u)];
  if (capped > 1.0) { pc = kind.x * sim.k4.w * (pow(capped, GAMMA) - 1.0) / capped; }
  let kv = kind.y;
  for (var c = 0u; c < 3u; c++) {
    for (var b = 0u; b < 3u; b++) {
      for (var a = 0u; a < 3u; a++) {
        let o = vec3u(a, b, c);
        let weight = pick(s, a).x * pick(s, b).y * pick(s, c).z;
        let kd = offsetOf(s, o) * sim.k4.xyz;
        // (C + C^T) kd: the rows of C dotted with kd, plus the columns of C weighted by kd.
        let cd = vec3f(dot(row0(p), kd), dot(row1(p), kd), dot(row2(p), kd));
        let ctd = row0(p) * kd.x + row1(p) * kd.y + row2(p) * kd.z;
        let m = weight * (pc * kd - kv * (cd + ctd));
        let n = nodeOf(s, o) * 8u;
        atomicAdd(&grid[n + 2u], toFixed(m.x, FIXED));
        atomicAdd(&grid[n + 3u], toFixed(m.y, FIXED));
        atomicAdd(&grid[n + 4u], toFixed(m.z, FIXED));
      }
    }
  }
}
`;

/**
 * The gradient of c for the surface tension (run only when it is on): per node the gradient of c, its density over rest
 * density with the walls mirrored and the colliders read as liquid at rest, by central differences, and its length.
 */
export const LIQUID_NORMALS_WGSL = /* wgsl */ `${HEADER}${collideWGSL(3)}
@group(0) @binding(1) var<storage, read> grid: array<vec4i>;
@group(0) @binding(2) var<storage, read_write> surf: array<vec4f>;
// c at node n: its mass with the wall mirrors, plus the colliders' cover, over the rest density.
fn color(n: vec3u) -> f32 {
  let m = vec3u(mirror(0u, n.x), mirror(1u, n.y), mirror(2u, n.z));
  var sum = 0;
  for (var z = 0u; z < 2u; z++) {
    if (z == 1u && m.z == NONE) { continue; }
    for (var y = 0u; y < 2u; y++) {
      if (y == 1u && m.y == NONE) { continue; }
      for (var x = 0u; x < 2u; x++) {
        if (x == 1u && m.x == NONE) { continue; }
        let at = vec3u(select(n.x, m.x, x == 1u), select(n.y, m.y, y == 1u), select(n.z, m.z, z == 1u));
        sum += grid[2u * index3(at)].x;
      }
    }
  }
  var ghost = 0.0;
  let p = sim.origin.xyz + vec3f(n) * sim.cell.xyz;
  for (var k = 0u; k < sim.counts.z; k++) { ghost += splineCover(-distanceTo(k, p) / sim.boxMax.w); }
  return f32(sum) / FIXED / sim.invCell.w + ghost;
}
${SPLINE_COVER}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= sim.counts.y) { return; }
  let i = vec3u(node % sim.dims.x, (node / sim.dims.x) % sim.dims.y, node / sim.dims.w);
  var g = vec3f(0.0);
  for (var a = 0u; a < 3u; a++) {
    let u = step3(i, a, true);
    let d = step3(i, a, false);
    g[a] = (color(u) - color(d)) / (f32(u[a] - d[a]) * sim.cell[a]);
  }
  surf[node] = vec4f(g, length(g));
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
export const LIQUID_GRID_WGSL = /* wgsl */ `${HEADER}${collideWGSL(3)}${SPLINE_COVER}
@group(0) @binding(1) var<storage, read_write> grid: array<vec4i>;
@group(0) @binding(2) var<storage, read_write> forces: array<atomic<i32>>;
// The normals pass's grad c and |grad c| per node.
@group(0) @binding(4) var<storage, read> surf: array<vec4f>;
${ADD_IMPULSE}
// Launder and Spalding's (1974) wall function: the friction velocity of a smooth wall under liquid whose node on the
// wall slides at u, for cells h across it: the larger of the viscous sublayer's (at 13/32 h, the B-spline weights' mean
// distance) and the log law's u / u* = ln(E y u* / nu) / kappa (at 0.2751 h, their geometric mean), the log law's y+
// by Newton's method from the crossover y+ = 11.225 (the CPU twin's wallFrictionVelocity).
fn wallFrictionVelocity(u: f32, h: f32, nu: f32) -> f32 {
  let yl = ${13 / 32} * h;
  let yg = ${Math.exp((9 / 8) * Math.log(3) - Math.log(2) - 11 / 6)} * h;
  let laminar = sqrt(u * nu / yl);
  let re = u * yg / nu;
  if (re <= ${11.225 * 11.225}) { return laminar; }
  var yp = 11.225;
  for (var k = 0u; k < 10u; k++) {
    let l = log(9.793 * yp);
    yp -= (yp * l - 0.4187 * re) / (l + 1.0);
  }
  return max(laminar, yp * nu / yg);
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= sim.counts.y) { return; }
  let raw = grid[2u * node];
  let more = grid[2u * node + 1u];
  if (raw.y <= 0) {
    grid[2u * node] = vec4i(0);
    grid[2u * node + 1u] = vec4i(0);
    return;
  }
  let dt = sim.origin.w;
  let weight = f32(raw.x) / FIXED;
  let m = f32(raw.y) / FIXED;
  var v = vec3f(f32(raw.z), f32(raw.w), f32(more.x)) / FIXED / m + sim.gravity.xyz * dt;
  let i = vec3u(node % sim.dims.x, (node / sim.dims.x) % sim.dims.y, node / sim.dims.w);
  let x = sim.origin.xyz + vec3f(i) * sim.cell.xyz;
  // Surface tension, the continuum surface force in its conservative form (Lafaurie et al. 1994): f = div T with
  // T = sigma (|grad c| I - grad c grad c^T / |grad c|) by central differences of the neighbours' T (Brackbill et al.
  // 1992's sigma kappa grad c without a unit normal), as the acceleration f / rho at the node, with rho at least a
  // quarter of rest density so the near-empty edge nodes are not flung.
  if (sim.surface.x > 0.0) {
    var f = vec3f(0.0);
    for (var j = 0u; j < 3u; j++) {
      let u = step3(i, j, true);
      let d = step3(i, j, false);
      let span = f32(u[j] - d[j]) * sim.cell[j];
      let su = surf[index3(u)];
      let sd = surf[index3(d)];
      var e = vec3f(0.0);
      e[j] = 1.0;
      if (su.w > 0.0) { f += (su.w * e - su.xyz * (su[j] / su.w)) / span; }
      if (sd.w > 0.0) { f -= (sd.w * e - sd.xyz * (sd[j] / sd.w)) / span; }
    }
    v += sim.surface.x * f / (max(weight / sim.invCell.w, 0.25) * (m / max(weight, 1e-30)));
  }
  // The pointer: nodes within its radius take on its velocity at a rate falling to zero at the edge.
  if (sim.counts.w != 0u) {
    let e = x - sim.pointer.xyz;
    let q = dot(e, e) / (sim.pointer.w * sim.pointer.w);
    if (q < 1.0) {
      let k = 1.0 - exp(-sim.pointerVel.w * (1.0 - q) * (1.0 - q) * dt);
      v += (sim.pointerVel.xyz - v) * k;
    }
  }
  // Adhesion: liquid one to two cells from a wall is pulled towards it.
  let adh = sim.surface.y;
  let reach = sim.surface.z;
  if (adh > 0.0) {
    for (var a = 0u; a < 3u; a++) {
      v[a] -= adh * dt * (adhesionKernel(x[a] - sim.boxMin[a], reach) - adhesionKernel(sim.boxMax[a] - x[a], reach));
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
    if (adh > 0.0 && hit.w > 0.0) {
      // Adhesion to the collider: the liquid is pulled in along -n, and the body takes the opposite pull.
      let pull = adh * dt * adhesionKernel(hit.w, reach);
      if (pull > 0.0) {
        v -= pull * hit.xyz;
        addImpulse(k, x - sim.colliders[k].center.xyz, m * pull * hit.xyz);
      }
    }
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
  // Smooth walls: a node in a wall's three layers (outside it, on it, inside it) takes that wall's share 1/8, 3/4, 1/8
  // of the wall function's shear over the B-spline's integral of the wall inside the container, over its own mass (the
  // MPM traction boundary condition), never reversing its motion along the wall.
  let volume = weight / sim.invCell.w * sim.cell.x * sim.cell.y * sim.cell.z;
  for (var a = 0u; a < 3u; a++) {
    if (sim.walls[a] == 0.0 || volume <= 0.0) { continue; }
    let below = i32(i[a]) - i32(PAD) + 1;
    let above = i32(PAD + sim.cells[a]) + 1 - i32(i[a]);
    var layer = -1;
    if (below >= 0 && below <= 2) { layer = below; } else if (above >= 0 && above <= 2) { layer = above; }
    if (layer < 0) { continue; }
    let b = (a + 1u) % 3u;
    let c = (a + 2u) % 3u;
    let ut = length(vec2f(v[b], v[c]));
    if (ut <= 0.0) { continue; }
    let us = wallFrictionVelocity(ut, sim.cell[a], sim.walls.w);
    var area = select(0.125, 0.75, layer == 1);
    for (var k = 0u; k < 2u; k++) {
      let e = select(c, b, k == 0u);
      area *= sim.cell[e] * (splineCover(f32(i32(PAD + sim.cells[e]) - i32(i[e]))) - splineCover(f32(i32(PAD) - i32(i[e]))));
    }
    let slow = min(ut, us * us * area * dt / volume);
    v[b] *= 1.0 - slow / ut;
    v[c] *= 1.0 - slow / ut;
  }
  grid[2u * node] = bitcast<vec4i>(vec4f(v, m));
  grid[2u * node + 1u] = vec4i(bitcast<i32>(weight), more.yzw);
}
`;

/** G2P: velocity and APIC C = sum w v (D^-1 d)^T, advection, out of the colliders (counted), inside the walls. */
export const LIQUID_G2P_WGSL = /* wgsl */ `${HEADER}${collideWGSL(4)}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> grid: array<vec4i>;
@group(0) @binding(3) var<storage, read_write> forces: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read> tally: array<u32>;
${ADD_IMPULSE}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= tally[0]) { return; }
  var p = particles[id.x];
  if (p.pos.w < 0.0) { return; }
  let s = stencil(p.pos.xyz);
  var v = vec3f(0.0);
  var b0 = vec3f(0.0);
  var b1 = vec3f(0.0);
  var b2 = vec3f(0.0);
  var tint = vec3f(0.0);
  var around = 0.0;
  for (var c = 0u; c < 3u; c++) {
    for (var b = 0u; b < 3u; b++) {
      for (var a = 0u; a < 3u; a++) {
        let o = vec3u(a, b, c);
        let weight = pick(s, a).x * pick(s, b).y * pick(s, c).z;
        let kd = offsetOf(s, o) * sim.k4.xyz;
        let gv = bitcast<vec4f>(grid[2u * nodeOf(s, o)]).xyz;
        if (sim.surface.w > 0.0) {
          let more = grid[2u * nodeOf(s, o) + 1u];
          around += weight * bitcast<f32>(more.x);
          tint += weight * vec3f(more.yzw) / FIXED;
        }
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
    addImpulse(k, x - sim.colliders[k].center.xyz, sim.kinds[min(u32(p.vel.w), 3u)].x * vn * hit.xyz);
  }
  // Inside the walls; a particle held at a wall keeps no velocity into it.
  let lo = x < sim.boxMin.xyz;
  let hi = x > sim.boxMax.xyz;
  x = clamp(x, sim.boxMin.xyz, sim.boxMax.xyz);
  v = select(v, vec3f(0.0), (lo & (v < vec3f(0.0))) | (hi & (v > vec3f(0.0))));
  p.pos = vec4f(x, p.pos.w);
  // Mixing: the colour relaxes towards the weighted mean colour of the liquid round it.
  var color = p.c2.yzw;
  if (sim.surface.w > 0.0 && around > 0.0) { color += (tint / around - color) * sim.surface.w; }
  p.vel = vec4f(v, p.vel.w);
  p.c0 = vec4f(b0, b1.x);
  p.c1 = vec4f(b1.yz, b2.xy);
  p.c2 = vec4f(b2.z, color);
  // A particle that entered a drain is gone: a density ratio below zero marks it until the frame's compaction.
  for (var k = 0u; k < sim.cells.w; k++) {
    let at = sim.drains[2u * k];
    let half = sim.drains[2u * k + 1u].xyz;
    let d = x - at.xyz;
    if (at.w > 0.5 && dot(d, d) < half.x * half.x) { p.pos.w = -1.0; }
    if (at.w > -0.5 && at.w < 0.5 && all(abs(d) < half)) { p.pos.w = -1.0; }
  }
  particles[id.x] = p;
}
`;

// The accurate profile's pressure projection (the twin's `project` in liquid-mpm-sim.ts), on the grid after its update:
// - nodes: per node two vec4f, (the cell density's share: mirrored weight over rest plus the colliders' cover, unused,
//   unused, W) from the nodes pass, its xyz then reused for P W P^T D^T of the solve's direction; and (the holding
//   collider's normal, code): code bits 0-3 the holding collider + 1, bit 4 inside a collider, bits 5-7 the velocity is
//   set (projected, then each extrapolation layer);
// - cells: per cell two vec4f, (x, r, d, q) of the conjugate gradient solve and (1 / diagonal, density over rest, type
//   0 none or solid, 1 liquid, 2 air, unused);
// - solve: rz, alpha, beta, goal, iterations, done (1 once converged or at the cap), then the partial sums of each
//   workgroup of 256 cells;
// - args: the indirect dispatch sizes of the iteration passes (nodes, cells, one), zeroed once the solve converges.
// Every sum is in a fixed order (a workgroup's tree, then one workgroup over the partials), so the solve repeats exactly.

/** The projection's shared declarations: the cell grid and the node and cell records. */
const PROJECT = /* wgsl */ `
// tolerance squared, volume rate over dt, most iterations, the liquid share of a cell
@group(0) @binding(7) var<uniform> proj: vec4f;
fn cellDims() -> vec3u { return sim.dims.xyz - vec3u(1u); }
fn cellCount() -> u32 { let d = cellDims(); return d.x * d.y * d.z; }
fn cellAt(c: vec3u) -> u32 { let d = cellDims(); return c.x + d.x * (c.y + d.y * c.z); }
fn cellCoord(c: u32) -> vec3u { let d = cellDims(); return vec3u(c % d.x, (c / d.x) % d.y, c / (d.x * d.y)); }
fn nodeCoord(n: u32) -> vec3u { return vec3u(n % sim.dims.x, (n / sim.dims.x) % sim.dims.y, n / sim.dims.w); }
// A node on or past a wall keeps its velocity along that wall's normal.
fn onWall(i: vec3u, a: u32) -> bool { return i[a] <= PAD || i[a] >= PAD + sim.cells[a]; }
// 1 / (4 h) per axis: the weight of one corner in a cell's divergence.
fn quarter() -> vec3f { return 0.25 * sim.invCell.xyz; }
// P W P^T g at node n with its record b: the walls' and the holding collider's normal parts out, times W, out again.
fn applyP(i: vec3u, b: vec4f, w: f32, g0: vec3f) -> vec3f {
  var g = g0;
  for (var a = 0u; a < 3u; a++) { if (onWall(i, a)) { g[a] = 0.0; } }
  let held = (u32(b.w) & 15u) != 0u;
  if (held) { g -= dot(g, b.xyz) * b.xyz; }
  g *= w;
  if (held) { g -= dot(g, b.xyz) * b.xyz; }
  for (var a = 0u; a < 3u; a++) { if (onWall(i, a)) { g[a] = 0.0; } }
  return g;
}
`;

/** One workgroup's sum of 256 values in a fixed tree. */
const GROUP_SUM = /* wgsl */ `
var<workgroup> acc: array<f32, 256>;
fn groupSum(lid: u32, v: f32) -> f32 {
  acc[lid] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid < s) { acc[lid] += acc[lid + s]; }
    workgroupBarrier();
  }
  return acc[0];
}
`;

/** Per node: W, the holding collider and its normal, inside a collider or not, and the density share for the cells. */
export const LIQUID_PROJECT_NODES_WGSL = /* wgsl */ `${HEADER}${collideWGSL(3)}${PROJECT}
@group(0) @binding(1) var<storage, read> grid: array<vec4i>;
@group(0) @binding(2) var<storage, read_write> nodes: array<vec4f>;
${SPLINE_COVER}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= sim.counts.y) { return; }
  let i = nodeCoord(node);
  let rest = sim.invCell.w;
  let m = bitcast<vec4f>(grid[2u * node]).w;
  let weight = bitcast<f32>(grid[2u * node + 1u].x);
  var w = 0.0;
  if (m > 0.0) { w = rest / max(m, 0.25 * rest * (m / max(weight, 1e-30))); }
  // The node's weight with its mirrors across the walls.
  let mi = vec3u(mirror(0u, i.x), mirror(1u, i.y), mirror(2u, i.z));
  var mirrored = 0.0;
  for (var z = 0u; z < 2u; z++) {
    if (z == 1u && mi.z == NONE) { continue; }
    for (var y = 0u; y < 2u; y++) {
      if (y == 1u && mi.y == NONE) { continue; }
      for (var x = 0u; x < 2u; x++) {
        if (x == 1u && mi.x == NONE) { continue; }
        let at = vec3u(select(i.x, mi.x, x == 1u), select(i.y, mi.y, y == 1u), select(i.z, mi.z, z == 1u));
        mirrored += bitcast<f32>(grid[2u * index3(at) + 1u].x);
      }
    }
  }
  let p = sim.origin.xyz + vec3f(i) * sim.cell.xyz;
  var cover = 0.0;
  var deepest = 0.0;
  var normal = vec3f(0.0);
  var code = 0u;
  for (var k = 0u; k < sim.counts.z; k++) {
    let hit = collide(k, p);
    cover += splineCover(-hit.w / sim.boxMax.w);
    if (hit.w < 0.0) { code |= 16u; }
    if (hit.w < deepest) {
      deepest = hit.w;
      normal = hit.xyz;
      code = (code & ~15u) | (k + 1u);
    }
  }
  nodes[2u * node] = vec4f(mirrored / rest + cover, 0.0, 0.0, w);
  nodes[2u * node + 1u] = vec4f(normal, f32(code));
}
`;

/**
 * Per cell: its type (liquid when inside the container, not solid and at least the liquid share of rest density),
 * 1 / its diagonal, and minus the divergence of the updated grid velocity as the residual; the solve starts from zero.
 */
export const LIQUID_PROJECT_CELLS_WGSL = /* wgsl */ `${HEADER}${PROJECT}
@group(0) @binding(1) var<storage, read> grid: array<vec4i>;
@group(0) @binding(2) var<storage, read> nodes: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> cells: array<vec4f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = id.x;
  if (c >= cellCount()) { return; }
  let ci = cellCoord(c);
  var kind = 0.0;
  var theta = 0.0;
  var inv = 0.0;
  var r = 0.0;
  let lo = vec3u(PAD);
  let hi = vec3u(PAD) + sim.cells.xyz;
  if (all(ci >= lo) && all(ci < hi)) {
    var solid = true;
    for (var k = 0u; k < 8u; k++) {
      let n = index3(ci + vec3u(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u));
      theta += nodes[2u * n].x;
      solid = solid && (u32(nodes[2u * n + 1u].w) & 16u) != 0u;
    }
    theta /= 8.0;
    kind = 2.0;
    if (theta >= proj.w) {
      kind = 0.0;
      if (!solid) {
        let q = quarter();
        var diag = 0.0;
        var div = 0.0;
        for (var k = 0u; k < 8u; k++) {
          let o = vec3u(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u);
          let at = ci + o;
          let n = index3(at);
          let v = bitcast<vec4f>(grid[2u * n]).xyz;
          let w = nodes[2u * n].w;
          let b = nodes[2u * n + 1u];
          let held = (u32(b.w) & 15u) != 0u;
          for (var a = 0u; a < 3u; a++) {
            div += select(-1.0, 1.0, o[a] == 1u) * q[a] * v[a];
            if (onWall(at, a) || w == 0.0) { continue; }
            var along = 0.0;
            if (held) { along = b[a]; }
            diag += q[a] * q[a] * w * (1.0 - along * along);
          }
        }
        if (diag > 0.0) {
          kind = 1.0;
          inv = 1.0 / diag;
          r = -div;
        }
      }
    }
  }
  cells[2u * c] = vec4f(0.0, r, 0.0, 0.0);
  cells[2u * c + 1u] = vec4f(inv, theta, kind, 0.0);
}
`;

/**
 * The volume: a liquid cell above rest density is pushed apart, and one below drawn together where none of its six
 * neighbours is air, at the volume rate; then each workgroup's sum of r z (z = r / diagonal).
 */
export const LIQUID_PROJECT_VOLUME_WGSL = /* wgsl */ `${HEADER}${PROJECT}${GROUP_SUM}
@group(0) @binding(1) var<storage, read_write> cells: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> solve: array<f32>;
fn isAir(c: vec3i) -> bool {
  let d = vec3i(cellDims());
  if (any(c < vec3i(0)) || any(c >= d)) { return false; }
  return cells[2u * cellAt(vec3u(c)) + 1u].z == 2.0;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3u) {
  let c = id.x;
  var rz = 0.0;
  if (c < cellCount()) {
    let info = cells[2u * c + 1u];
    if (info.z == 1.0) {
      let ci = vec3i(cellCoord(c));
      var enclosed = true;
      for (var a = 0u; a < 3u; a++) {
        var e = vec3i(0);
        e[a] = 1;
        if (isAir(ci - e) || isAir(ci + e)) { enclosed = false; }
      }
      var excess = info.y - 1.0;
      if (!enclosed) { excess = max(excess, 0.0); }
      let r = cells[2u * c].y + proj.y * excess;
      cells[2u * c].y = r;
      rz = r * r * info.x;
    }
  }
  let sum = groupSum(lid, rz);
  if (lid == 0u) { solve[8u + wg.x] = sum; }
}
`;

/** Shared by the single-workgroup passes: the sum of every workgroup's partial, in a fixed order. */
const PARTIALS = /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> solve: array<f32>;
@group(0) @binding(2) var<storage, read_write> args: array<u32>;
fn partials(lid: u32) -> f32 {
  let parts = (cellCount() + 255u) / 256u;
  var s = 0.0;
  for (var k = lid; k < parts; k += 256u) { s += solve[8u + k]; }
  return groupSum(lid, s);
}
// The iteration passes' sizes: every node and cell, or nothing once the solve has converged.
fn setArgs(run: bool) {
  args[0] = select(0u, (sim.counts.y + 255u) / 256u, run);
  args[1] = 1u;
  args[2] = 1u;
  args[3] = select(0u, (cellCount() + 255u) / 256u, run);
  args[4] = 1u;
  args[5] = 1u;
  args[6] = select(0u, 1u, run);
  args[7] = 1u;
  args[8] = 1u;
}
`;

/** The start of the solve: rz of the residual, the goal tolerance^2 rz, no direction yet. */
export const LIQUID_PROJECT_START_WGSL = /* wgsl */ `${HEADER}${PROJECT}${GROUP_SUM}${PARTIALS}
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lid: u32) {
  let rz = partials(lid);
  if (lid == 0u) {
    solve[0] = rz;
    solve[1] = 0.0;
    solve[2] = 0.0;
    solve[3] = proj.x * rz;
    solve[4] = 0.0;
    let run = rz > solve[3] && proj.z > 0.0;
    solve[5] = select(1.0, 0.0, run);
    setArgs(run);
  }
}
`;

/**
 * u = P W P^T D^T d at every node from the liquid cells round it, with the direction d = z + beta d taken on the fly
 * (the cells pass stores it); zero at a node next to no liquid cell.
 */
export const LIQUID_PROJECT_APPLY_WGSL = /* wgsl */ `${HEADER}${PROJECT}
@group(0) @binding(1) var<storage, read_write> nodes: array<vec4f>;
@group(0) @binding(2) var<storage, read> cells: array<vec4f>;
@group(0) @binding(3) var<storage, read> solve: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= sim.counts.y) { return; }
  let i = nodeCoord(node);
  let b = nodes[2u * node + 1u];
  let w = nodes[2u * node].w;
  var u = vec3f(0.0);
  if (w != 0.0 || (u32(b.w) & 15u) != 0u) {
    let q = quarter();
    let d = cellDims();
    let beta = solve[2];
    var g = vec3f(0.0);
    var touched = false;
    for (var k = 0u; k < 8u; k++) {
      let o = vec3u(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u);
      // The cell with the node as corner 1 - o: below it on axis a when o[a] is 0.
      if (any(i + o < vec3u(1u)) || any(i + o > d)) { continue; }
      let c = cellAt(i + o - vec3u(1u));
      let info = cells[2u * c + 1u];
      if (info.z != 1.0) { continue; }
      let s = cells[2u * c];
      let dir = s.y * info.x + beta * s.z;
      touched = true;
      for (var a = 0u; a < 3u; a++) { g[a] += select(-1.0, 1.0, o[a] == 0u) * q[a] * dir; }
    }
    if (touched) { u = applyP(i, b, w, g); }
  }
  nodes[2u * node] = vec4f(u, w);
}
`;

/** q = D u on every liquid cell; stores the direction d; each workgroup's sum of d q. */
export const LIQUID_PROJECT_MATVEC_WGSL = /* wgsl */ `${HEADER}${PROJECT}${GROUP_SUM}
@group(0) @binding(1) var<storage, read> nodes: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> cells: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> solve: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3u) {
  let c = id.x;
  var dq = 0.0;
  if (c < cellCount()) {
    let info = cells[2u * c + 1u];
    if (info.z == 1.0) {
      let ci = cellCoord(c);
      let q4 = quarter();
      var q = 0.0;
      for (var k = 0u; k < 8u; k++) {
        let o = vec3u(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u);
        let u = nodes[2u * index3(ci + o)].xyz;
        for (var a = 0u; a < 3u; a++) { q += select(-1.0, 1.0, o[a] == 1u) * q4[a] * u[a]; }
      }
      let s = cells[2u * c];
      let dir = s.y * info.x + solve[2] * s.z;
      cells[2u * c] = vec4f(s.x, s.y, dir, q);
      dq = dir * q;
    }
  }
  let sum = groupSum(lid, dq);
  workgroupBarrier();
  if (lid == 0u) { solve[8u + wg.x] = sum; }
}
`;

/** alpha = rz / (d q), or 0 when d q is not positive. */
export const LIQUID_PROJECT_ALPHA_WGSL = /* wgsl */ `${HEADER}${PROJECT}${GROUP_SUM}${PARTIALS}
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lid: u32) {
  let dq = partials(lid);
  if (lid == 0u) { solve[1] = select(0.0, solve[0] / dq, dq > 0.0); }
}
`;

/** x += alpha d, r -= alpha q on every liquid cell; each workgroup's sum of the new r z. */
export const LIQUID_PROJECT_UPDATE_WGSL = /* wgsl */ `${HEADER}${PROJECT}${GROUP_SUM}
@group(0) @binding(1) var<storage, read_write> cells: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> solve: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3u) {
  let c = id.x;
  var rz = 0.0;
  let alpha = solve[1];
  if (c < cellCount()) {
    let info = cells[2u * c + 1u];
    if (info.z == 1.0) {
      let s = cells[2u * c];
      let x = s.x + alpha * s.z;
      let r = s.y - alpha * s.w;
      cells[2u * c] = vec4f(x, r, s.z, s.w);
      rz = r * r * info.x;
    }
  }
  let sum = groupSum(lid, rz);
  workgroupBarrier();
  if (lid == 0u) { solve[8u + wg.x] = sum; }
}
`;

/**
 * beta = the new rz over the old; one more iteration; the iteration passes stop once rz is at the goal or the cap. It
 * writes the indirect sizes, so it runs directly every iteration and does nothing once the solve is done (solve[5]).
 */
export const LIQUID_PROJECT_BETA_WGSL = /* wgsl */ `${HEADER}${PROJECT}${GROUP_SUM}${PARTIALS}
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lid: u32) {
  let next = partials(lid);
  if (lid == 0u && solve[5] == 0.0) {
    let rz = solve[0];
    solve[2] = select(0.0, next / rz, rz > 0.0);
    solve[0] = next;
    solve[4] += 1.0;
    let run = next > solve[3] && solve[4] < proj.z;
    solve[5] = select(1.0, 0.0, run);
    setArgs(run);
  }
}
`;

/**
 * The new velocity v* + P W P^T D^T x at every node next to a liquid cell (marked set), the pressure a collider holds
 * back as its impulse: rest density times the normal part of D^T x, in particle masses.
 */
export const LIQUID_PROJECT_FINAL_WGSL = /* wgsl */ `${HEADER}${PROJECT}
@group(0) @binding(1) var<storage, read_write> grid: array<vec4i>;
@group(0) @binding(2) var<storage, read_write> nodes: array<vec4f>;
@group(0) @binding(3) var<storage, read> cells: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> forces: array<atomic<i32>>;
${ADD_IMPULSE}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= sim.counts.y) { return; }
  let i = nodeCoord(node);
  let b = nodes[2u * node + 1u];
  let w = nodes[2u * node].w;
  let code = u32(b.w);
  if (w == 0.0 && (code & 15u) == 0u) { return; }
  let q = quarter();
  let d = cellDims();
  var g = vec3f(0.0);
  var touched = false;
  for (var k = 0u; k < 8u; k++) {
    let o = vec3u(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u);
    if (any(i + o < vec3u(1u)) || any(i + o > d)) { continue; }
    let c = cellAt(i + o - vec3u(1u));
    if (cells[2u * c + 1u].z != 1.0) { continue; }
    touched = true;
    let x = cells[2u * c].x;
    for (var a = 0u; a < 3u; a++) { g[a] += select(-1.0, 1.0, o[a] == 0u) * q[a] * x; }
  }
  if (!touched) { return; }
  nodes[2u * node + 1u].w = f32(code | 32u);
  if ((code & 15u) != 0u) {
    var gw = g;
    for (var a = 0u; a < 3u; a++) { if (onWall(i, a)) { gw[a] = 0.0; } }
    let k = (code & 15u) - 1u;
    let held = dot(gw, b.xyz) * b.xyz * sim.invCell.w;
    if (any(held != vec3f(0.0))) {
      addImpulse(k, sim.origin.xyz + vec3f(i) * sim.cell.xyz - sim.colliders[k].center.xyz, held);
    }
  }
  if (w == 0.0) { return; }
  let raw = bitcast<vec4f>(grid[2u * node]);
  grid[2u * node] = bitcast<vec4i>(vec4f(raw.xyz + applyP(i, b, w, g), raw.w));
}
`;

/**
 * One layer of the velocity carried out past the liquid: a node with mass not set yet takes the mean velocity of its
 * set face neighbours (`layer` 0 reads those the projection set, 1 those and the first layer), its wall normals zeroed.
 */
export const LIQUID_PROJECT_EXTEND_WGSL = /* wgsl */ `${HEADER}${PROJECT}
@group(0) @binding(1) var<storage, read_write> grid: array<vec4i>;
@group(0) @binding(2) var<storage, read_write> nodes: array<vec4f>;
@group(0) @binding(6) var<uniform> layer: vec4u;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= sim.counts.y) { return; }
  let read = select(32u, 96u, layer.x == 1u);
  let code = u32(nodes[2u * node + 1u].w);
  if ((code & read) != 0u) { return; }
  let raw = bitcast<vec4f>(grid[2u * node]);
  if (!(raw.w > 0.0)) { return; }
  let i = nodeCoord(node);
  var sum = vec3f(0.0);
  var k = 0.0;
  for (var a = 0u; a < 3u; a++) {
    for (var s = 0u; s < 2u; s++) {
      if ((s == 0u && i[a] == 0u) || (s == 1u && i[a] + 1u >= sim.dims[a])) { continue; }
      let at = step3(i, a, s == 1u);
      let n = index3(at);
      if ((u32(nodes[2u * n + 1u].w) & read) == 0u) { continue; }
      sum += bitcast<vec4f>(grid[2u * n]).xyz;
      k += 1.0;
    }
  }
  if (k == 0.0) { return; }
  var v = sum / k;
  for (var a = 0u; a < 3u; a++) { if (onWall(i, a)) { v[a] = 0.0; } }
  grid[2u * node] = bitcast<vec4i>(vec4f(v, raw.w));
  nodes[2u * node + 1u].w = f32(code | select(64u, 128u, layer.x == 1u));
}
`;

const EMIT_HEADER = /* wgsl */ `
struct Emitter {
  // nozzle centre, radius
  pos: vec4f,
  // jet velocity, liquid index
  vel: vec4f,
  // across the nozzle, the spiral's slots
  u: vec4f,
  // across the nozzle, unused
  w: vec4f,
  // the liquid's colour, unused
  color: vec4f,
  // its first thread, its first spiral slot, the particles it adds this frame, unused
  idx: vec4u,
}
struct Emit {
  // emitters, particles to add, capacity, unused
  head: vec4u,
  // frame length dt, unused
  frame: vec4f,
  em: array<Emitter, 4>,
}
`;

/**
 * The emit pass: thread j writes the j-th particle the emitters add this frame into slot live + j while there is room:
 * on its emitter's Vogel spiral, spread downstream over the frame (emitterPoint in the twin), at the jet's velocity.
 */
export const LIQUID_EMIT_WGSL = /* wgsl */ `${HEADER}${EMIT_HEADER}
@group(0) @binding(1) var<uniform> emit: Emit;
@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(3) var<storage, read> tally: array<u32>;
const GOLDEN: f32 = 2.399963229728653;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let j = id.x;
  if (j >= emit.head.y) { return; }
  let slot = tally[0] + j;
  if (slot >= emit.head.z) { return; }
  var k = 0u;
  for (var e = 1u; e < emit.head.x; e++) { if (j >= emit.em[e].idx.x) { k = e; } }
  let em = emit.em[k];
  let jj = j - em.idx.x;
  let ring = u32(em.u.w);
  let spiral = (em.idx.y + jj) % ring;
  let r = em.pos.w * sqrt((f32(spiral) + 0.5) / em.u.w);
  let a = f32(spiral) * GOLDEN;
  let along = emit.frame.x * (f32(jj) + 0.5) / f32(em.idx.z);
  let x = clamp(em.pos.xyz + em.u.xyz * (r * cos(a)) + em.w.xyz * (r * sin(a)) + em.vel.xyz * along, sim.boxMin.xyz, sim.boxMax.xyz);
  var p: Particle;
  p.pos = vec4f(x, 1.0);
  p.vel = em.vel;
  p.c0 = vec4f(0.0);
  p.c1 = vec4f(0.0);
  p.c2 = vec4f(0.0, em.color.xyz);
  particles[slot] = p;
}
`;

/** After the emit pass: the live count grows by what was written, at most to the capacity. */
export const LIQUID_COMMIT_WGSL = /* wgsl */ `${EMIT_HEADER}
@group(0) @binding(0) var<uniform> emit: Emit;
@group(0) @binding(1) var<storage, read_write> tally: array<u32>;
@compute @workgroup_size(1)
fn main() {
  tally[0] = min(emit.head.z, tally[0] + emit.head.y);
}
`;

/**
 * Compaction, pass 1 of 3: the live, undrained particles of each block of 256 slots, counted in workgroup memory.
 * The three passes keep the particles in order (a stable partition by a prefix sum), so a run repeats exactly.
 */
export const LIQUID_COUNT_WGSL = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> blocks: array<u32>;
@group(0) @binding(3) var<storage, read> tally: array<u32>;
var<workgroup> alive: atomic<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  if (li == 0u) { atomicStore(&alive, 0u); }
  workgroupBarrier();
  if (id.x < tally[0] && particles[id.x].pos.w >= 0.0) { atomicAdd(&alive, 1u); }
  workgroupBarrier();
  if (li == 0u) { blocks[wg.x] = atomicLoad(&alive); }
}
`;

/** Compaction, pass 2: one workgroup turns the block counts into their exclusive prefix sums and the total. */
export const LIQUID_SCAN_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> blocks: array<u32>;
// blocks, unused
@group(0) @binding(1) var<storage, read> span: array<u32>;
var<workgroup> sums: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  let n = span[0];
  let per = (n + 255u) / 256u;
  var own = 0u;
  for (var b = li * per; b < min(n, (li + 1u) * per); b++) { own += blocks[b]; }
  sums[li] = own;
  workgroupBarrier();
  // Hillis and Steele's inclusive scan over the 256 sums.
  for (var step = 1u; step < 256u; step *= 2u) {
    var add = 0u;
    if (li >= step) { add = sums[li - step]; }
    workgroupBarrier();
    sums[li] += add;
    workgroupBarrier();
  }
  var run = sums[li] - own;
  for (var b = li * per; b < min(n, (li + 1u) * per); b++) {
    let c = blocks[b];
    blocks[b] = run;
    run += c;
  }
  // The total after the last block.
  if (li == 255u) { blocks[n] = sums[255]; }
}
`;

/**
 * Compaction, pass 3: each block ranks its live particles in workgroup memory and copies them to their place in
 * scratch, the drained and empty ones after the total as empty slots (NaN positions, drawn as nothing).
 */
export const LIQUID_SCATTER_WGSL = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> scratch: array<Particle>;
@group(0) @binding(3) var<storage, read> blocks: array<u32>;
@group(0) @binding(4) var<storage, read> tally: array<u32>;
var<workgroup> ranks: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  let i = id.x;
  var keep = 0u;
  if (i < tally[0] && particles[i].pos.w >= 0.0) { keep = 1u; }
  ranks[li] = keep;
  workgroupBarrier();
  for (var step = 1u; step < 256u; step *= 2u) {
    var add = 0u;
    if (li >= step) { add = ranks[li - step]; }
    workgroupBarrier();
    ranks[li] += add;
    workgroupBarrier();
  }
  if (i >= sim.counts.x) { return; }
  let before = ranks[li] - keep;
  let start = blocks[wg.x];
  let total = blocks[(sim.counts.x + 255u) / 256u];
  if (keep == 1u) {
    scratch[start + before] = particles[i];
  } else {
    var e: Particle;
    let nan = bitcast<f32>(0x7fc00000u | (i & 0u));
    e.pos = vec4f(nan, nan, nan, -1.0);
    e.vel = vec4f(0.0);
    e.c0 = vec4f(0.0);
    e.c1 = vec4f(0.0);
    e.c2 = vec4f(0.0);
    scratch[total + (wg.x * 256u - start) + (li - before)] = e;
  }
}
`;

/** Compaction, pass 4: the live count becomes the total. */
export const LIQUID_SETTLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> blocks: array<u32>;
@group(0) @binding(1) var<storage, read> span: array<u32>;
@group(0) @binding(2) var<storage, read_write> tally: array<u32>;
@compute @workgroup_size(1)
fn main() {
  tally[0] = blocks[span[0]];
}
`;

const DEBUG_HEADER = /* wgsl */ `
struct View {
  // view projection
  matrix: mat4x4f,
  // camera right, sprite radius
  right: vec4f,
  // camera up, mode (1 speed, 2 density, 3 the particle's colour)
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
  var o: Out;
  // An empty or drained slot draws nothing (a point outside the clip volume).
  if (!(p.pos.w >= 0.0)) {
    o.clip = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  let world = p.pos.xyz + (view.right.xyz * uv.x + view.up.xyz * uv.y) * view.right.w;
  var t = 0.0;
  if (view.up.w < 1.5) {
    t = length(p.vel.xyz) / view.params.x;
  } else {
    // Density over rest density: 0.8 at the bottom of the ramp, 1.2 at the top.
    t = (p.pos.w - 0.8) / 0.4;
  }
  o.clip = view.matrix * vec4f(world, 1.0);
  o.uv = uv;
  o.color = ramp(t);
  if (view.up.w > 2.5) { o.color = p.c2.yzw; }
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
