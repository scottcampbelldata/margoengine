// WGSL of `@margoengine/physics/gpu-cloth`: the five compute passes of a substep and the surface pass, each the GPU form of
// one loop of the CPU twin (gpu-cloth-sim.ts), in the same order. Group 0 holds the substep's record; group 1 the pass's
// buffers. No atomics: every thread writes only its own particle or, in an edge pass, the two particles of its edge, which
// no other edge of the colour touches, so a run gives the same bits every time on one GPU and driver.

/** The substep record, the first 96 bytes of a 256-byte slot (packClothFrame writes it). */
const SIM = /* wgsl */ `
struct Sim {
  dt: f32,            // substep length, s
  alpha0: f32,        // share of the frame done when the substep starts (pins and colliders move by it)
  alpha1: f32,        // share done when it ends
  time: f32,          // cloth time at its end, s (the wind's gusts)
  gravity: vec3f,
  damp: f32,          // velocity factor of a substep, exp(-damping dt)
  wind: vec3f,
  turbulence: f32,
  dragK: f32,         // 1/2 rho Cd
  thickness: f32,     // distance kept from colliders, m
  friction: f32,
  count: u32,         // particles
  compliance: vec3f,  // stretch, shear, bend, m/N
  pinCount: u32,
  colliderCount: u32,
  tetherStretch: f32, // 1 + the tethers' slack
  pad1: u32,
  pad2: u32,
}
@group(0) @binding(0) var<uniform> sim: Sim;
`;

/**
 * Integrate: each free particle's velocity takes the last substep's corrections, damping, the wind's drag through its faces
 * and gravity, and the particle moves by it. The velocity is state of its own, so float32 positions far from the origin
 * do not round small accelerations away (as (x - previous) / dt would).
 */
export const CLOTH_INTEGRATE_WGSL = /* wgsl */ `${SIM}
// [0, count) particles (xyz, w = inverse mass, 0 when pinned); [count, 2 count) velocities; [2 count, 3 count) where the
// substep's integrate put each particle (its prediction), before the constraints and colliders moved it.
@group(1) @binding(0) var<storage, read_write> state: array<vec4f>;
// xyz the particle's unit normal from the last surface pass, w its third of its triangles' rest area.
@group(1) @binding(1) var<storage, read> normals: array<vec4f>;

// The base wind varied by smooth gusts along and across it (windAt in gpu-cloth-sim.ts).
fn windAt(p: vec3f, t: f32) -> vec3f {
  let gust = sin(0.9 * p.x + 1.7 * t) * cos(1.1 * p.z + 1.3 * t) + 0.5 * sin(2.3 * p.y - 2.9 * t + 1.1 * p.x);
  let speed = length(sim.wind);
  let side = sim.turbulence * speed * 0.5 * sin(1.3 * p.x + 0.7 * p.z + 2.3 * t);
  let up = sim.turbulence * speed * 0.3 * sin(0.8 * p.y + 1.9 * p.z - 1.7 * t);
  let k = 1.0 + sim.turbulence * gust;
  var s = speed;
  if (s == 0.0) { s = 1.0; }
  return vec3f(sim.wind.x * k - side * sim.wind.z / s, sim.wind.y * k + up, sim.wind.z * k + side * sim.wind.x / s);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.count) { return; }
  let p = state[i];
  if (p.w == 0.0) { return; } // pinned: the pin pass places it
  let n2 = 2u * sim.count;
  var v = (state[sim.count + i].xyz + (p.xyz - state[n2 + i].xyz) / sim.dt) * sim.damp;
  let nrm = normals[i];
  if (sim.dragK > 0.0 && nrm.w > 0.0) {
    // A flat plate's drag on the air through the face, 1/2 rho Cd A |u_n| u_n, capped so it cannot reverse u_n in a substep.
    let un = dot(windAt(p.xyz, sim.time) - v, nrm.xyz);
    let k = min(sim.dragK * nrm.w * p.w * abs(un) * sim.dt, 1.0);
    v = v + nrm.xyz * (un * k);
  }
  v = v + sim.gravity * sim.dt;
  let x = p.xyz + v * sim.dt;
  state[sim.count + i] = vec4f(v, 0.0);
  state[i] = vec4f(x, p.w);
  state[n2 + i] = vec4f(x, 0.0);
}
`;

/** Pins: each held particle moves from where its pin was to where it is, by the substep's share of the frame. */
export const CLOTH_PIN_WGSL = /* wgsl */ `${SIM}
@group(1) @binding(0) var<storage, read_write> state: array<vec4f>;
// Two a pin: (from xyz, particle index bits), (to xyz, 0).
@group(1) @binding(1) var<storage, read> pins: array<vec4f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= sim.pinCount) { return; }
  let a = pins[2u * k];
  let b = pins[2u * k + 1u];
  let i = bitcast<u32>(a.w);
  let x = mix(a.xyz, b.xyz, sim.alpha1);
  state[i] = vec4f(x, 0.0);
  state[sim.count + i] = vec4f((b.xyz - a.xyz) * (sim.alpha1 - sim.alpha0) / sim.dt, 0.0);
  state[2u * sim.count + i] = vec4f(x, 0.0);
}
`;

/** Edges of one colour: an XPBD distance constraint each (Macklin, Mueller and Chentanez 2016), one solve a substep. */
export const CLOTH_EDGES_WGSL = /* wgsl */ `${SIM}
@group(1) @binding(0) var<storage, read_write> state: array<vec4f>;
// This colour's edges only (the binding's slice): (i, j, rest length bits, kind); i = 0xffffffff pads the slice.
@group(1) @binding(1) var<storage, read> edges: array<vec4u>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let e = gid.x;
  if (e >= arrayLength(&edges)) { return; }
  let ed = edges[e];
  if (ed.x == 0xffffffffu) { return; }
  let pi = state[ed.x];
  let pj = state[ed.y];
  let ws = pi.w + pj.w;
  if (ws == 0.0) { return; }
  let d = pi.xyz - pj.xyz;
  let len = length(d);
  if (len < 1e-9) { return; }
  // The multiplier starts at zero each substep (small steps, Macklin et al. 2019): dl = -C / (w_i + w_j + alpha / dt^2).
  let c = len - bitcast<f32>(ed.z);
  let dl = -c / (ws + sim.compliance[ed.w] / (sim.dt * sim.dt));
  let n = d / len;
  state[ed.x] = vec4f(pi.xyz + n * (pi.w * dl), pi.w);
  state[ed.y] = vec4f(pj.xyz - n * (pj.w * dl), pj.w);
}
`;

/** Tethers: each free particle kept within its rest distance along the cloth (times 1 + slack) of its nearest pin. */
export const CLOTH_TETHER_WGSL = /* wgsl */ `${SIM}
@group(1) @binding(0) var<storage, read_write> state: array<vec4f>;
// Two a particle: its nearest pin's index (0xffffffff for none, or for a pin itself) and the rest distance's bits.
@group(1) @binding(1) var<storage, read> tethers: array<vec2u>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.count) { return; }
  let t = tethers[i];
  let p = state[i];
  if (t.x == 0xffffffffu || p.w == 0.0) { return; }
  // A long range attachment (Kim, Chentanez and Mueller 2012): one-sided, the pin does not move.
  let a = state[t.x].xyz;
  let d = p.xyz - a;
  let l = length(d);
  let most = bitcast<f32>(t.y) * sim.tetherStretch;
  if (!(l > most)) { return; }
  state[i] = vec4f(a + d * (most / l), p.w);
}
`;

/** Colliders: each free particle pushed out of each collider in order, then its slide held back by Coulomb friction. */
export const CLOTH_COLLIDE_WGSL = /* wgsl */ `${SIM}
@group(1) @binding(0) var<storage, read_write> state: array<vec4f>;
// Eight vec4 a collider: (type, sdf offset, radius, half height), (from position, friction), (from rotation),
// (to position, 0), (to rotation), (box half extents | sdf min), (sdf spacing), (sdf samples per axis).
@group(1) @binding(1) var<storage, read> shapes: array<vec4f>;
// Every sdf collider's samples, x fastest, end to end.
@group(1) @binding(2) var<storage, read> sdf: array<f32>;

fn rot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
// Normalised blend of two rotations, along the shorter way.
fn qmix(a: vec4f, b: vec4f, t: f32) -> vec4f {
  var bb = b;
  if (dot(a, b) < 0.0) { bb = -b; }
  return normalize(mix(a, bb, t));
}
fn voxel(off: u32, i: u32, j: u32, k: u32, sx: u32, sxy: u32) -> f32 {
  return sdf[off + i + j * sx + k * sxy];
}
// The field's value and gradient at a point of the collider's space (trilinear, the gradient exact in the cell); w < -1e30
// outside the grid.
fn field(o: u32, local: vec3f) -> vec4f {
  let size = bitcast<vec3u>(shapes[o + 7u].xyz);
  let spacing = shapes[o + 6u].xyz;
  let g = (local - shapes[o + 5u].xyz) / spacing;
  let top = vec3f(size - vec3u(1u));
  if (any(g < vec3f(0.0)) || any(g > top)) { return vec4f(0.0, 0.0, 0.0, -1e38); }
  let c = min(vec3u(floor(g)), size - vec3u(2u));
  let f = g - vec3f(c);
  let sx = size.x;
  let sxy = size.x * size.y;
  let b = bitcast<u32>(shapes[o].y) + c.x + c.y * sx + c.z * sxy;
  let v000 = voxel(b, 0u, 0u, 0u, sx, sxy);
  let v100 = voxel(b, 1u, 0u, 0u, sx, sxy);
  let v010 = voxel(b, 0u, 1u, 0u, sx, sxy);
  let v110 = voxel(b, 1u, 1u, 0u, sx, sxy);
  let v001 = voxel(b, 0u, 0u, 1u, sx, sxy);
  let v101 = voxel(b, 1u, 0u, 1u, sx, sxy);
  let v011 = voxel(b, 0u, 1u, 1u, sx, sxy);
  let v111 = voxel(b, 1u, 1u, 1u, sx, sxy);
  let c00 = v000 + (v100 - v000) * f.x;
  let c10 = v010 + (v110 - v010) * f.x;
  let c01 = v001 + (v101 - v001) * f.x;
  let c11 = v011 + (v111 - v011) * f.x;
  let c0 = c00 + (c10 - c00) * f.y;
  let c1 = c01 + (c11 - c01) * f.y;
  let dx0 = (v100 - v000) * (1.0 - f.y) + (v110 - v010) * f.y;
  let dx1 = (v101 - v001) * (1.0 - f.y) + (v111 - v011) * f.y;
  let grad = vec3f((dx0 * (1.0 - f.z) + dx1 * f.z), ((c10 - c00) * (1.0 - f.z) + (c11 - c01) * f.z), (c1 - c0)) / spacing;
  return vec4f(grad, c0 + (c1 - c0) * f.z);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.count) { return; }
  var p = state[i];
  if (p.w == 0.0) { return; }
  // Where the particle began the substep: its prediction less the velocity that carried it there.
  let start = state[2u * sim.count + i].xyz - state[sim.count + i].xyz * sim.dt;
  for (var c = 0u; c < sim.colliderCount; c++) {
    let o = c * 8u;
    let head = shapes[o];
    let kind = bitcast<u32>(head.x);
    let x1 = mix(shapes[o + 1u].xyz, shapes[o + 3u].xyz, sim.alpha1);
    let x0 = mix(shapes[o + 1u].xyz, shapes[o + 3u].xyz, sim.alpha0);
    let q1 = qmix(shapes[o + 2u], shapes[o + 4u], sim.alpha1);
    let q0 = qmix(shapes[o + 2u], shapes[o + 4u], sim.alpha0);
    let local = rot(vec4f(-q1.xyz, q1.w), p.xyz - x1);
    var dist = 1e30;
    var n = vec3f(0.0, 1.0, 0.0);
    if (kind <= 1u) {
      // A sphere, or a capsule along its local y: the distance to the segment less the radius.
      var h = 0.0;
      if (kind == 1u) { h = head.w; }
      let v = local - vec3f(0.0, clamp(local.y, -h, h), 0.0);
      let l = length(v);
      if (l > 1e-9) { n = v / l; }
      dist = l - head.z - sim.thickness;
    } else if (kind == 2u) {
      let e = shapes[o + 5u].xyz;
      let g = abs(local) - e;
      let out = length(max(g, vec3f(0.0)));
      if (out > 0.0) {
        n = sign(local) * max(g, vec3f(0.0)) / out;
        dist = out - sim.thickness;
      } else {
        // Inside: out along the axis of least depth.
        var a = 2u;
        if (g.x >= g.y && g.x >= g.z) { a = 0u; } else if (g.y >= g.z) { a = 1u; }
        n = vec3f(0.0);
        n[a] = select(1.0, -1.0, local[a] < 0.0);
        dist = g[a] - sim.thickness;
      }
    } else if (kind == 3u) {
      dist = local.y - sim.thickness;
    } else {
      let f = field(o, local);
      let l = length(f.xyz);
      if (f.w > -1e30 && l > 1e-12) {
        n = f.xyz / l;
        dist = f.w - sim.thickness;
      }
    }
    if (dist < 0.0) {
      let lc = local - n * dist;
      let w0 = x0 + rot(q0, lc);
      let nw = rot(q1, n);
      let pw = x1 + rot(q1, lc);
      // The slide over the substep relative to the surface: friction takes back up to mu times the depth of it.
      let r = w0 - start;
      let t = r - nw * dot(r, nw);
      let lt = length(t);
      var k = 0.0;
      if (lt > 0.0) { k = min(1.0, shapes[o + 1u].w * -dist / lt); }
      p = vec4f(pw - t * k, p.w);
    }
  }
  state[i] = p;
}
`;

/** Normals: each particle's unit normal from its triangles now, for the drag of the substep (w, its area, is kept). */
export const CLOTH_NORMALS_WGSL = /* wgsl */ `${SIM}
@group(1) @binding(0) var<storage, read> state: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> normals: array<vec4f>;
// count + 1 offsets, then the triangles at each particle.
@group(1) @binding(2) var<storage, read> adjacency: array<u32>;
@group(1) @binding(3) var<storage, read> triangles: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let v = gid.x;
  if (v >= sim.count) { return; }
  var nsum = vec3f(0.0);
  for (var k = adjacency[v]; k < adjacency[v + 1u]; k++) {
    let t = adjacency[sim.count + 1u + k] * 3u;
    let a = state[triangles[t]].xyz;
    // Twice the area along the normal: the sum weights each face by its area.
    nsum += cross(state[triangles[t + 1u]].xyz - a, state[triangles[t + 2u]].xyz - a);
  }
  let l = length(nsum);
  if (l > 0.0) { normals[v] = vec4f(nsum / l, normals[v].w); }
}
`;

/** Surface: each particle's normal and tangent from its triangles, and its 20-float draw vertex (gltf PBR layout). */
export const CLOTH_SURFACE_WGSL = /* wgsl */ `${SIM}
@group(1) @binding(0) var<storage, read> state: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> normals: array<vec4f>;
// count + 1 offsets, then the triangles at each particle.
@group(1) @binding(2) var<storage, read> adjacency: array<u32>;
@group(1) @binding(3) var<storage, read> triangles: array<u32>;
@group(1) @binding(4) var<storage, read> uvs: array<vec2f>;
@group(1) @binding(5) var<storage, read_write> vertices: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let v = gid.x;
  if (v >= sim.count) { return; }
  var nsum = vec3f(0.0);
  var ssum = vec3f(0.0);
  var bsum = vec3f(0.0);
  for (var k = adjacency[v]; k < adjacency[v + 1u]; k++) {
    let t = adjacency[sim.count + 1u + k] * 3u;
    let i0 = triangles[t];
    let i1 = triangles[t + 1u];
    let i2 = triangles[t + 2u];
    let e1 = state[i1].xyz - state[i0].xyz;
    let e2 = state[i2].xyz - state[i0].xyz;
    // The cross product is twice the area along the normal: the sum weights each face by its area.
    nsum += cross(e1, e2);
    let d1 = uvs[i1] - uvs[i0];
    let d2 = uvs[i2] - uvs[i0];
    let det = d1.x * d2.y - d2.x * d1.y;
    var r = 0.0;
    if (det != 0.0) { r = 1.0 / det; }
    ssum += (e1 * d2.y - e2 * d1.y) * r;
    bsum += (e2 * d1.x - e1 * d2.x) * r;
  }
  let keep = normals[v];
  var n = keep.xyz;
  let l = length(nsum);
  if (l > 0.0) { n = nsum / l; }
  normals[v] = vec4f(n, keep.w);
  var t = ssum - n * dot(ssum, n);
  var tl = length(t);
  if (!(tl > 1e-12)) {
    t = select(vec3f(n.z, 0.0, -n.x), vec3f(0.0, -n.z, n.y), abs(n.x) < 0.9);
    tl = max(length(t), 1e-30);
  }
  t = t / tl;
  var hand = 1.0;
  if (dot(cross(n, t), bsum) < 0.0) { hand = -1.0; }
  let o = v * 20u;
  let p = state[v].xyz;
  let uv = uvs[v];
  vertices[o] = p.x;
  vertices[o + 1u] = p.y;
  vertices[o + 2u] = p.z;
  vertices[o + 3u] = 1.0;
  vertices[o + 4u] = n.x;
  vertices[o + 5u] = n.y;
  vertices[o + 6u] = n.z;
  vertices[o + 7u] = 0.0;
  vertices[o + 8u] = t.x;
  vertices[o + 9u] = t.y;
  vertices[o + 10u] = t.z;
  vertices[o + 11u] = hand;
  vertices[o + 12u] = uv.x;
  vertices[o + 13u] = uv.y;
  vertices[o + 14u] = uv.x;
  vertices[o + 15u] = uv.y;
  vertices[o + 16u] = 1.0;
  vertices[o + 17u] = 1.0;
  vertices[o + 18u] = 1.0;
  vertices[o + 19u] = 1.0;
}
`;
