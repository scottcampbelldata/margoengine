// WGSL of @margoengine/vfx/flocking: the eight compute passes of one step, the instanced boid draw and the debug
// overlay. The step is the CPU twin's (flocking-sim.ts) in f32, pass for pass. Buffers:
// - boids: two per boid vec4f (x, y, z, phase) and (vx, vy, vz, bank), ping-ponged between two buffers;
// - grid: u32 bucket counts [0, G), bucket starts [G, 2G), block sums [2G, 2G + 256), block starts [2G + 256, 2G + 512);
// - keys: u32 boid bucket [0, N), slot in bucket [N, 2N), unranked ids [2N, 3N), ranked ids [3N, 4N);
// - sorted: the boids in bucket order, ascending index within a bucket.
// The build strips the comments inside the WGSL strings (docs/conventions.md, "Shader comments").

/** Floats of the simulation uniform: ten vec4 of parameters, then 32 attractor, 32 predator and 64 obstacle vec4. */
export const FLOCK_SIM_FLOATS = (10 + 32 + 32 + 64) * 4;

const SIM_HEADER = /* wgsl */ `
struct Boid {
  pos: vec4f,
  vel: vec4f,
}
struct Sim {
  // count, buckets G, bucket mask, max neighbours
  counts: vec4u,
  // bounds centre, shape (0 box, 1 sphere)
  boundsCenter: vec4f,
  // box half size, sphere radius
  boundsHalf: vec4f,
  // neighbour radius, separation radius, cos of half the vision angle, 1 / cell size
  radii: vec4f,
  // separation, alignment, cohesion, bounds strength
  weights: vec4f,
  // min speed, max speed, max force, max turn acceleration
  speeds: vec4f,
  // dt, bounds margin, mesh scale, cell size
  limits: vec4f,
  // bank strength, flap frequency, bank factor, unused
  anim: vec4f,
  // attractors, predators, obstacles, unused
  entities: vec4u,
  // debug on, inspected boid, unused, unused
  debug: vec4u,
  // per attractor: (position, strength), (radius, 0, 0, 0)
  attractors: array<vec4f, 32>,
  // per predator: (position, radius), (strength, 0, 0, 0)
  predators: array<vec4f, 32>,
  // per obstacle: (position, radius), (strength, 0, 0, 0)
  obstacles: array<vec4f, 64>,
}
@group(0) @binding(0) var<uniform> sim: Sim;
// Teschner et al. (2003): three large primes, XOR, then the table mask.
fn hashCell(c: vec3i) -> u32 {
  return ((bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u)) & sim.counts.z;
}
fn cellOf(p: vec3f) -> vec3i {
  return vec3i(floor(p * sim.radii.w));
}
`;

/** Pass 1: clears the bucket counts. */
export const FLOCK_CLEAR_WGSL =
  SIM_HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> grid: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < sim.counts.y) {
    grid[id.x] = 0u;
  }
}
`;

/** Pass 2: hashes each boid into its bucket and takes a slot there by an atomic add (in any order). */
export const FLOCK_COUNT_WGSL =
  SIM_HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> boids: array<Boid>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> keys: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let n = sim.counts.x;
  if (i >= n) { return; }
  let b = hashCell(cellOf(boids[i].pos.xyz));
  keys[i] = b;
  keys[n + i] = atomicAdd(&grid[b], 1u);
}
`;

/** Pass 3: Blelloch (1990) exclusive scan of each 256-bucket block of counts into bucket starts and block sums. */
export const FLOCK_SCAN_BLOCKS_WGSL =
  SIM_HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> grid: array<u32>;
var<workgroup> temp: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wg: vec3u) {
  let g = sim.counts.y;
  let tid = lid.x;
  let gid = wg.x * 256u + tid;
  temp[tid] = select(0u, grid[gid], gid < g);
  // Up-sweep: partial sums in place.
  var offset = 1u;
  for (var d = 128u; d > 0u; d = d >> 1u) {
    workgroupBarrier();
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      temp[bi] = temp[bi] + temp[ai];
    }
    offset = offset << 1u;
  }
  workgroupBarrier();
  if (tid == 0u) {
    grid[2u * g + wg.x] = temp[255u];
    temp[255u] = 0u;
  }
  // Down-sweep: exclusive prefix sums.
  for (var d = 1u; d < 256u; d = d << 1u) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      let t = temp[ai];
      temp[ai] = temp[bi];
      temp[bi] = temp[bi] + t;
    }
  }
  workgroupBarrier();
  if (gid < g) {
    grid[g + gid] = temp[tid];
  }
}
`;

/** Pass 4: one workgroup scans the block sums (at most 256 blocks, so 65,536 buckets) into block starts. */
export const FLOCK_SCAN_SUMS_WGSL =
  SIM_HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> grid: array<u32>;
var<workgroup> temp: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3u) {
  let g = sim.counts.y;
  let tid = lid.x;
  let blocks = g >> 8u;
  temp[tid] = select(0u, grid[2u * g + tid], tid < blocks);
  var offset = 1u;
  for (var d = 128u; d > 0u; d = d >> 1u) {
    workgroupBarrier();
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      temp[bi] = temp[bi] + temp[ai];
    }
    offset = offset << 1u;
  }
  workgroupBarrier();
  if (tid == 0u) {
    temp[255u] = 0u;
  }
  for (var d = 1u; d < 256u; d = d << 1u) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      let t = temp[ai];
      temp[ai] = temp[bi];
      temp[bi] = temp[bi] + t;
    }
  }
  workgroupBarrier();
  if (tid < blocks) {
    grid[2u * g + 256u + tid] = temp[tid];
  }
}
`;

/** Pass 5: adds each block's start to its buckets' starts. */
export const FLOCK_ADD_OFFSETS_WGSL =
  SIM_HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> grid: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let g = sim.counts.y;
  if (id.x < g) {
    grid[g + id.x] = grid[g + id.x] + grid[2u * g + 256u + (id.x >> 8u)];
  }
}
`;

/** Pass 6: writes each boid's index at its bucket start plus its slot (an order that varies run to run). */
export const FLOCK_SCATTER_WGSL =
  SIM_HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> grid: array<u32>;
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let n = sim.counts.x;
  if (i >= n) { return; }
  keys[2u * n + grid[sim.counts.y + keys[i]] + keys[n + i]] = i;
}
`;

/**
 * Pass 7: ranks each boid among its bucket by index and copies it there, so a bucket lists its boids by ascending
 * index on every run: the step then visits neighbours in one fixed order and its result is the same every time.
 */
export const FLOCK_RANK_WGSL =
  SIM_HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> boids: array<Boid>;
@group(0) @binding(2) var<storage, read> grid: array<u32>;
@group(0) @binding(3) var<storage, read_write> keys: array<u32>;
@group(0) @binding(4) var<storage, read_write> sorted: array<Boid>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let n = sim.counts.x;
  if (i >= n) { return; }
  let b = keys[i];
  let start = grid[sim.counts.y + b];
  let m = grid[b];
  var rank = 0u;
  for (var k = 0u; k < m; k = k + 1u) {
    if (keys[2u * n + start + k] < i) { rank = rank + 1u; }
  }
  sorted[start + rank] = boids[i];
  keys[3u * n + start + rank] = i;
}
`;

/** Pass 8: the rules over the 3 x 3 x 3 cell neighbourhood, attractors, predators, obstacles, bounds and integration. */
export const FLOCK_STEP_WGSL =
  SIM_HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> boidsIn: array<Boid>;
@group(0) @binding(2) var<storage, read> sorted: array<Boid>;
@group(0) @binding(3) var<storage, read> keys: array<u32>;
@group(0) @binding(4) var<storage, read> grid: array<u32>;
@group(0) @binding(5) var<storage, read_write> boidsOut: array<Boid>;
@group(0) @binding(6) var<storage, read_write> debugOut: array<vec4f, 8>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let n = sim.counts.x;
  if (i >= n) { return; }
  let me = boidsIn[i];
  let myPos = me.pos.xyz;
  let myVel = me.vel.xyz;
  let h = sim.limits.x;
  let spd = length(myVel);
  let fwd = select(vec3f(0.0, 0.0, 1.0), myVel / max(spd, 1e-5), spd > 1e-5);
  let neighR2 = sim.radii.x * sim.radii.x;
  let sepR = sim.radii.y;
  let cosHalfVision = sim.radii.z;
  let maxN = sim.counts.w;
  let cellCap = maxN * 2u;
  let g = sim.counts.y;
  let c = cellOf(myPos);

  var sepSum = vec3f(0.0);
  var sepCount = 0u;
  var aliSum = vec3f(0.0);
  var cohSum = vec3f(0.0);
  var neighCount = 0u;
  var seen: array<u32, 27>;
  var nSeen = 0u;
  var done = false;
  // Cells z, then y, then x, from -1 to 1: the CPU twin's order.
  for (var dz = -1; dz <= 1 && !done; dz = dz + 1) {
    for (var dy = -1; dy <= 1 && !done; dy = dy + 1) {
      for (var dx = -1; dx <= 1 && !done; dx = dx + 1) {
        let b = hashCell(c + vec3i(dx, dy, dz));
        // Two of the 27 cells can share a bucket; its boids are counted once.
        var dup = false;
        for (var s = 0u; s < nSeen; s = s + 1u) {
          if (seen[s] == b) { dup = true; }
        }
        if (dup) { continue; }
        seen[nSeen] = b;
        nSeen = nSeen + 1u;
        let start = grid[g + b];
        let cnt = min(grid[b], cellCap);
        for (var k = 0u; k < cnt; k = k + 1u) {
          let j = keys[3u * n + start + k];
          if (j == i) { continue; }
          let other = sorted[start + k];
          let diff = other.pos.xyz - myPos;
          let d2 = dot(diff, diff);
          if (d2 <= 1e-8 || d2 > neighR2) { continue; }
          let d = sqrt(d2);
          let dir = diff / d;
          let dotFwd = dot(dir, fwd);
          // Separation sees a neighbour in the cone, or any neighbour closer than half the separation radius.
          if (d < sepR && (dotFwd >= cosHalfVision || d < sepR * 0.5)) {
            sepSum = sepSum - dir * ((sepR - d) / (sepR * max(d, 0.05)));
            sepCount = sepCount + 1u;
          }
          if (dotFwd >= cosHalfVision) {
            aliSum = aliSum + other.vel.xyz;
            cohSum = cohSum + other.pos.xyz;
            neighCount = neighCount + 1u;
            if (neighCount >= maxN) {
              done = true;
              break;
            }
          }
        }
      }
    }
  }

  let minSpeed = sim.speeds.x;
  let maxSpeed = sim.speeds.y;
  let maxForce = sim.speeds.z;
  let maxTurn = sim.speeds.w;

  // Reynolds steering: desired velocity at max speed along each rule, minus the velocity, times the rule's weight.
  var sf = vec3f(0.0);
  if (sepCount > 0u && sim.weights.x > 0.0) {
    let sl = length(sepSum);
    if (sl > 1e-5) { sf = (sepSum * (maxSpeed / sl) - myVel) * sim.weights.x; }
  }
  var af = vec3f(0.0);
  var cf = vec3f(0.0);
  if (neighCount > 0u) {
    if (sim.weights.y > 0.0) {
      let al = length(aliSum);
      if (al > 1e-5) { af = (aliSum * (maxSpeed / al) - myVel) * sim.weights.y; }
    }
    if (sim.weights.z > 0.0) {
      let toCenter = cohSum / f32(neighCount) - myPos;
      let cl = length(toCenter);
      if (cl > 1e-5) { cf = (toCenter * (maxSpeed / cl) - myVel) * sim.weights.z; }
    }
  }

  var attF = vec3f(0.0);
  for (var a = 0u; a < sim.entities.x; a = a + 1u) {
    let ap = sim.attractors[2u * a];
    let ar = sim.attractors[2u * a + 1u].x;
    if (ap.w <= 0.0) { continue; }
    let toA = ap.xyz - myPos;
    let d = length(toA);
    if (d > 1e-4 && (ar <= 0.0 || d < ar)) {
      let falloff = select(1.0, 1.0 - d / ar, ar > 0.0);
      attF = attF + (toA * (maxSpeed / d) - myVel) * (ap.w * falloff);
    }
  }

  // Predators push straight away, harder the closer they are: strength (1 + 2 u^2), u = 1 - d / radius.
  var predF = vec3f(0.0);
  var fleeing = false;
  for (var q = 0u; q < sim.entities.y; q = q + 1u) {
    let pp = sim.predators[2u * q];
    let ps = sim.predators[2u * q + 1u].x;
    if (ps <= 0.0) { continue; }
    let away = myPos - pp.xyz;
    let d = length(away);
    if (d < pp.w && d > 1e-5) {
      let u = 1.0 - d / pp.w;
      predF = predF + away * ((ps * (1.0 + 2.0 * u * u)) / d);
      fleeing = true;
    }
  }

  var obsF = vec3f(0.0);
  var dodging = false;
  let margin = max(sim.limits.y, 0.001);
  let obsMargin = max(margin * 0.6, sepR);
  for (var o = 0u; o < sim.entities.z; o = o + 1u) {
    let op = sim.obstacles[2u * o];
    let os = sim.obstacles[2u * o + 1u].x;
    let avoidR = op.w + obsMargin;
    let away = myPos - op.xyz;
    let d = length(away);
    if (d < avoidR && d > 1e-5) {
      let t = 1.0 - d / avoidR;
      obsF = obsF + away * ((os * t * t * maxForce) / d);
      dodging = true;
    }
  }

  // Containment: a push that grows with the square of the depth into the margin, capped at twice the margin.
  var bndF = vec3f(0.0);
  let bndScale = sim.weights.w * maxForce;
  let bCenter = sim.boundsCenter.xyz;
  let bHalf = sim.boundsHalf.xyz;
  let bRad = sim.boundsHalf.w;
  let rel = myPos - bCenter;
  if (sim.boundsCenter.w > 0.5) {
    let d = length(rel);
    let inner = max(0.0, bRad - margin);
    if (d > inner && d > 1e-5) {
      let t = min(2.0, (d - inner) / margin);
      bndF = -rel * ((t * t * bndScale) / d);
    }
  } else {
    let inner = max(vec3f(0.0), bHalf - vec3f(margin));
    for (var k = 0; k < 3; k = k + 1) {
      if (rel[k] > inner[k]) {
        let t = min(2.0, (rel[k] - inner[k]) / margin);
        bndF[k] = -(t * t) * bndScale;
      } else if (rel[k] < -inner[k]) {
        let t = min(2.0, (-inner[k] - rel[k]) / margin);
        bndF[k] = t * t * bndScale;
      }
    }
  }

  // The flock's own rules share maxForce; fleeing and dodging may add up to 2.5 times it.
  var acc = sf + af + cf + attF + bndF;
  let baseLen = length(acc);
  if (baseLen > maxForce) { acc = acc * (maxForce / baseLen); }
  acc = acc + predF + obsF;
  let totalCap = select(maxForce, maxForce * 2.5, fleeing || dodging);
  let totalLen = length(acc);
  if (totalLen > totalCap) { acc = acc * (totalCap / totalLen); }

  // Turning is limited to maxTurn across the heading (twice that when fleeing or dodging).
  let aPar = dot(acc, fwd);
  var lat = acc - fwd * aPar;
  let latLen = length(lat);
  let turnCap = select(maxTurn, maxTurn * 2.0, fleeing || dodging);
  if (latLen > turnCap) { lat = lat * (turnCap / latLen); }
  acc = fwd * aPar + lat;

  // Semi-implicit Euler: velocity first, clamped to [minSpeed, maxSpeed] (1.35 times max when fleeing), then position.
  var nv = myVel + acc * h;
  var nSpd = length(nv);
  let hiSpd = select(maxSpeed, maxSpeed * 1.35, fleeing);
  if (nSpd < 1e-5) {
    nv = fwd * minSpeed;
    nSpd = minSpeed;
  } else if (nSpd < minSpeed || nSpd > hiSpd) {
    let goal = select(hiSpd, minSpeed, nSpd < minSpeed);
    nv = nv * (goal / nSpd);
    nSpd = goal;
  }
  var np = myPos + nv * h;

  // A boid inside an obstacle is put back on its surface and bounces off it.
  let boidRad = sim.limits.z * 0.35;
  for (var o = 0u; o < sim.entities.z; o = o + 1u) {
    let op = sim.obstacles[2u * o];
    let diff = np - op.xyz;
    let d = length(diff);
    let minD = op.w + boidRad;
    if (d < minD) {
      let nrm = select(vec3f(0.0, 1.0, 0.0), diff / max(d, 1e-5), d > 1e-5);
      np = op.xyz + nrm * minD;
      let vn = dot(nv, nrm);
      if (vn < 0.0) { nv = nv - nrm * (1.5 * vn); }
    }
  }

  // A boid past the bounds is put back on them and bounces.
  if (sim.boundsCenter.w > 0.5) {
    let r = np - bCenter;
    let d = length(r);
    if (d > bRad) {
      let nrm = r / d;
      np = bCenter + nrm * bRad;
      let vn = dot(nv, nrm);
      if (vn > 0.0) { nv = nv - nrm * (1.5 * vn); }
    }
  } else {
    let hi = bCenter + bHalf;
    let lo = bCenter - bHalf;
    for (var k = 0; k < 3; k = k + 1) {
      if (np[k] > hi[k]) {
        np[k] = hi[k];
        if (nv[k] > 0.0) { nv[k] = -nv[k] * 0.6; }
      } else if (np[k] < lo[k]) {
        np[k] = lo[k];
        if (nv[k] < 0.0) { nv[k] = -nv[k] * 0.6; }
      }
    }
  }

  // Bank into the turn (eased at 6 per second) and advance the flap phase faster at higher speed.
  let newFwd = nv / max(length(nv), 1e-5);
  var right2 = vec2f(newFwd.z, -newFwd.x);
  let rLen = length(right2);
  right2 = select(vec2f(1.0, 0.0), right2 / rLen, rLen > 1e-4);
  let latDotRight = lat.x * right2.x + lat.z * right2.y;
  let targetBank = clamp(-latDotRight * sim.anim.x * sim.anim.z * 0.12, -1.1, 1.1);
  let newBank = me.vel.w + (targetBank - me.vel.w) * min(1.0, h * 6.0);
  let sRatio = clamp((nSpd - minSpeed) / max(maxSpeed - minSpeed, 1e-3), 0.0, 1.0);
  let twoPi = 6.283185307;
  let rawPhase = me.pos.w + h * sim.anim.y * (0.75 + 0.55 * sRatio) * twoPi;
  let newPhase = rawPhase - floor(rawPhase / twoPi) * twoPi;

  boidsOut[i] = Boid(vec4f(np, newPhase), vec4f(nv, newBank));

  // The inspected boid's record for the debug overlay (the CPU twin's debugData).
  if (sim.debug.x != 0u && i == sim.debug.y) {
    debugOut[0] = vec4f(np, newBank);
    debugOut[1] = vec4f(nv, f32(neighCount));
    debugOut[2] = vec4f(sf, f32(sepCount));
    debugOut[3] = vec4f(af, 0.0);
    debugOut[4] = vec4f(cf, 0.0);
    debugOut[5] = vec4f(predF, 0.0);
    debugOut[6] = vec4f(vec3f(c), sim.limits.w);
    debugOut[7] = vec4f(0.0, 0.0, 0.0, 1.0);
  }
}
`;

/** Instanced boid draw: each instance reads its boid, faces its velocity, banks, and flaps or swims by vertex weight. */
export const FLOCK_RENDER_WGSL = /* wgsl */ `
struct Boid {
  pos: vec4f,
  vel: vec4f,
}
struct RenderUniform {
  camera: mat4x4f,
  // camera position, mesh scale
  eyeScale: vec4f,
  // direction to the light, ambient
  lightDirAmb: vec4f,
  // body colour, flap amplitude
  primaryFlap: vec4f,
  // accent colour, mode (0 bird flap, 1 fish swim)
  accentMode: vec4f,
  // light colour, encode to sRGB (1) or not (0)
  lightColorEncode: vec4f,
}
@group(0) @binding(0) var<uniform> r: RenderUniform;
@group(0) @binding(1) var<storage, read> boids: array<Boid>;
// Two vec4f a triangle corner: (position, weight), (normal, accent mix).
@group(0) @binding(2) var<storage, read> meshCorners: array<vec4f>;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
  @location(2) world: vec3f,
}
// PCG hash (O'Neill 2014) of the instance, a per-boid tint in [0, 1].
fn boidHash(v: u32) -> f32 {
  var x = v * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x & 0xffffu) / 65535.0;
}
fn encodeSrgb(c: vec3f) -> vec3f {
  let k = max(c, vec3f(0.0));
  return select(1.055 * pow(k, vec3f(1.0 / 2.4)) - 0.055, k * 12.92, k <= vec3f(0.0031308));
}
@vertex
fn vertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Out {
  let b = boids[instance];
  let cPos = meshCorners[corner * 2u];
  let cNrm = meshCorners[corner * 2u + 1u];
  var lp = cPos.xyz;
  var ln = cNrm.xyz;
  let w = cPos.w;
  let phase = b.pos.w;
  let amp = r.primaryFlap.w;
  if (r.accentMode.w < 0.5) {
    // Bird: the wings lift and fall with the phase, more toward the tips.
    let flap = sin(phase) * amp * w;
    lp.y = lp.y + flap * abs(lp.x);
    let tilt = flap * select(-1.0, 1.0, lp.x >= 0.0) * 0.45;
    ln = normalize(vec3f(ln.x - tilt, ln.y + 0.1, ln.z));
  } else {
    // Fish: a sideways wave that travels down the body toward the tail.
    let wave = sin(phase + lp.z * 3.5) * amp * w;
    lp.x = lp.x + wave * 0.55;
    let twist = cos(phase + lp.z * 3.5) * amp * w * 0.35;
    ln = normalize(vec3f(ln.x, ln.y, ln.z - twist));
  }
  // Frame from the velocity and world up, rolled by the bank angle.
  let spd = length(b.vel.xyz);
  let fwd = select(vec3f(0.0, 0.0, 1.0), b.vel.xyz / max(spd, 1e-5), spd > 1e-5);
  let upHint = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(fwd.y) > 0.96);
  let right0 = normalize(cross(upHint, fwd));
  let up0 = cross(fwd, right0);
  let cb = cos(b.vel.w);
  let sb = sin(b.vel.w);
  let right = right0 * cb + up0 * sb;
  let up = -right0 * sb + up0 * cb;
  let world = b.pos.xyz + (right * lp.x + up * lp.y + fwd * lp.z) * r.eyeScale.w;
  var o: Out;
  o.clip = r.camera * vec4f(world, 1.0);
  o.normal = normalize(right * ln.x + up * ln.y + fwd * ln.z);
  o.color = mix(r.primaryFlap.rgb, r.accentMode.rgb, clamp(cNrm.w * 0.72 + boidHash(instance) * 0.28, 0.0, 1.0));
  o.world = world;
  return o;
}
@fragment
fn fragment(i: Out) -> @location(0) vec4f {
  // Lambert key light over a hemisphere ambient, with a faint rim in the accent colour.
  let n = normalize(i.normal);
  let v = normalize(r.eyeScale.xyz - i.world);
  let ndl = max(dot(n, r.lightDirAmb.xyz), 0.0);
  let hemi = 0.5 + 0.5 * n.y;
  let amb = r.lightDirAmb.w;
  let rim = pow(1.0 - max(dot(n, v), 0.0), 2.5) * 0.22;
  let lit = amb * (0.65 + 0.35 * hemi) + (1.0 - amb) * ndl;
  let rgb = i.color * r.lightColorEncode.rgb * lit + r.accentMode.rgb * rim;
  return vec4f(select(rgb, encodeSrgb(rgb), r.lightColorEncode.w > 0.5), 1.0);
}
`;

/** Vertices of the inspected boid's overlay in {@link FLOCK_DEBUG_WGSL} (274 line segments). */
export const FLOCK_DEBUG_VERTEX_COUNT = 548;

const DEBUG_HEADER = /* wgsl */ `
struct DebugUniform {
  camera: mat4x4f,
  // bounds centre, shape (0 box, 1 sphere)
  boundsCenterShape: vec4f,
  // box half size, sphere radius
  boundsHalfRad: vec4f,
  // neighbour radius, separation radius, half the vision angle, unused
  radiiVision: vec4f,
  // grid, perception, vectors, encode to sRGB
  flags: vec4f,
  // seconds of travel a velocity line shows, max speed, unused, unused
  velocity: vec4f,
}
@group(0) @binding(0) var<uniform> d: DebugUniform;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
}
fn encodeSrgb(c: vec3f) -> vec3f {
  let k = max(c, vec3f(0.0));
  return select(1.055 * pow(k, vec3f(1.0 / 2.4)) - 0.055, k * 12.92, k <= vec3f(0.0031308));
}
@fragment
fn fragment(i: Out) -> @location(0) vec4f {
  return vec4f(select(i.color, encodeSrgb(i.color), d.flags.w > 0.5), 1.0);
}
`;

/** Debug overlay, every boid: a line along its velocity, blue when slow and red at max speed. */
export const FLOCK_VELOCITY_WGSL =
  DEBUG_HEADER +
  /* wgsl */ `
struct Boid {
  pos: vec4f,
  vel: vec4f,
}
@group(0) @binding(1) var<storage, read> boids: array<Boid>;
@vertex
fn vertex(@builtin(vertex_index) vid: u32, @builtin(instance_index) instance: u32) -> Out {
  let b = boids[instance];
  let tip = b.pos.xyz + b.vel.xyz * d.velocity.x;
  let t = clamp(length(b.vel.xyz) / max(d.velocity.y, 1e-5), 0.0, 1.0);
  var o: Out;
  o.clip = d.camera * vec4f(select(b.pos.xyz, tip, vid == 1u), 1.0);
  o.color = mix(vec3f(0.2, 0.55, 1.0), vec3f(1.0, 0.25, 0.2), t);
  return o;
}
`;

/** Debug overlay, the inspected boid: bounds, its grid cell and neighbourhood, vision cone, radii and steering vectors. */
export const FLOCK_DEBUG_WGSL =
  DEBUG_HEADER +
  /* wgsl */ `
// The step pass's record of the inspected boid (FLOCK_STEP_WGSL debugOut).
@group(0) @binding(1) var<storage, read> debugBuf: array<vec4f, 8>;
// Edge 0 to 11 of a box, one end (endBit 0 or 1), as a corner of the cube [-1, 1]^3.
fn boxEdgeVertex(edgeIdx: u32, endBit: u32, center: vec3f, size: vec3f) -> vec3f {
  var a = vec3f(0.0);
  var b = vec3f(0.0);
  switch (edgeIdx) {
    case 0u: { a = vec3f(-1.0, -1.0, -1.0); b = vec3f(1.0, -1.0, -1.0); }
    case 1u: { a = vec3f(1.0, -1.0, -1.0); b = vec3f(1.0, -1.0, 1.0); }
    case 2u: { a = vec3f(1.0, -1.0, 1.0); b = vec3f(-1.0, -1.0, 1.0); }
    case 3u: { a = vec3f(-1.0, -1.0, 1.0); b = vec3f(-1.0, -1.0, -1.0); }
    case 4u: { a = vec3f(-1.0, 1.0, -1.0); b = vec3f(1.0, 1.0, -1.0); }
    case 5u: { a = vec3f(1.0, 1.0, -1.0); b = vec3f(1.0, 1.0, 1.0); }
    case 6u: { a = vec3f(1.0, 1.0, 1.0); b = vec3f(-1.0, 1.0, 1.0); }
    case 7u: { a = vec3f(-1.0, 1.0, 1.0); b = vec3f(-1.0, 1.0, -1.0); }
    case 8u: { a = vec3f(-1.0, -1.0, -1.0); b = vec3f(-1.0, 1.0, -1.0); }
    case 9u: { a = vec3f(1.0, -1.0, -1.0); b = vec3f(1.0, 1.0, -1.0); }
    case 10u: { a = vec3f(1.0, -1.0, 1.0); b = vec3f(1.0, 1.0, 1.0); }
    default: { a = vec3f(-1.0, -1.0, 1.0); b = vec3f(-1.0, 1.0, 1.0); }
  }
  return center + select(a, b, endBit == 1u) * size;
}
@vertex
fn vertex(@builtin(vertex_index) vid: u32) -> Out {
  let seg = vid >> 1u;
  let endBit = vid & 1u;
  var o: Out;
  // Unused segments are put outside the clip volume.
  o.clip = vec4f(2.0, 2.0, 2.0, 1.0);
  o.color = vec3f(1.0);
  let showGrid = d.flags.x > 0.5;
  let showPerc = d.flags.y > 0.5;
  let showVecs = d.flags.z > 0.5;
  let twoPi = 6.283185307;
  let bPos = debugBuf[0].xyz;
  let bVel = debugBuf[1].xyz;
  let hasBoid = debugBuf[7].w > 0.5;
  let spd = length(bVel);
  let fwd = select(vec3f(0.0, 0.0, 1.0), bVel / max(spd, 1e-5), spd > 1e-5);
  let upHint = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(fwd.y) > 0.96);
  let right = normalize(cross(upHint, fwd));
  let up = cross(fwd, right);
  var world = vec3f(0.0);
  var col = vec3f(0.35, 0.75, 1.0);
  var shown = false;

  if (seg < 12u) {
    // Segments 0 to 11: the box bounds.
    if (showGrid && d.boundsCenterShape.w < 0.5) {
      world = boxEdgeVertex(seg, endBit, d.boundsCenterShape.xyz, d.boundsHalfRad.xyz);
      col = vec3f(0.35, 0.78, 1.0);
      shown = true;
    }
  } else if (seg < 108u) {
    // 12 to 107: three great circles of the sphere bounds.
    if (showGrid && d.boundsCenterShape.w > 0.5) {
      let local = seg - 12u;
      let ring = local / 32u;
      let ang = f32(local % 32u + endBit) * (twoPi / 32.0);
      var dir = vec3f(cos(ang), 0.0, sin(ang));
      if (ring == 1u) { dir = vec3f(cos(ang), sin(ang), 0.0); }
      else if (ring == 2u) { dir = vec3f(0.0, cos(ang), sin(ang)); }
      world = d.boundsCenterShape.xyz + dir * d.boundsHalfRad.w;
      col = vec3f(0.35, 0.78, 1.0);
      shown = true;
    }
  } else if (seg < 132u) {
    // 108 to 119: the boid's grid cell; 120 to 131: its 3 x 3 x 3 neighbourhood.
    if (showGrid && hasBoid) {
      let cell = debugBuf[6];
      let cellCenter = (cell.xyz + vec3f(0.5)) * cell.w;
      let inner = seg < 120u;
      world = boxEdgeVertex(select(seg - 120u, seg - 108u, inner), endBit, cellCenter, vec3f(cell.w * select(1.5, 0.5, inner)));
      col = select(vec3f(0.95, 0.62, 0.18), vec3f(1.0, 0.92, 0.25), inner);
      shown = true;
    }
  } else if (seg < 180u) {
    // 132 to 179: two circles of the separation sphere.
    if (showPerc && hasBoid) {
      let local = seg - 132u;
      let ang = f32(local % 24u + endBit) * (twoPi / 24.0);
      let axisA = select(right, up, local / 24u == 1u);
      world = bPos + (fwd * cos(ang) + axisA * sin(ang)) * d.radiiVision.y;
      col = vec3f(1.0, 0.32, 0.35);
      shown = true;
    }
  } else if (seg < 228u) {
    // 180 to 227: two arcs of the neighbour radius across the vision cone.
    if (showPerc && hasBoid) {
      let local = seg - 180u;
      let halfAng = d.radiiVision.z;
      let t0 = -halfAng + f32(local % 24u + endBit) * (2.0 * halfAng / 24.0);
      let axisA = select(right, up, local / 24u == 1u);
      world = bPos + (fwd * cos(t0) + axisA * sin(t0)) * d.radiiVision.x;
      col = vec3f(0.22, 0.92, 0.85);
      shown = true;
    }
  } else if (seg < 252u) {
    // 228 to 251: the cone's rim at the neighbour radius.
    if (showPerc && hasBoid) {
      let halfAng = d.radiiVision.z;
      let phi = f32(seg - 228u + endBit) * (twoPi / 24.0);
      world = bPos + fwd * (cos(halfAng) * d.radiiVision.x) + (right * cos(phi) + up * sin(phi)) * (sin(halfAng) * d.radiiVision.x);
      col = vec3f(0.22, 0.92, 0.85);
      shown = true;
    }
  } else if (seg < 256u) {
    // 252 to 255: four rays from the boid to the rim, when the cone is not a full sphere.
    if (showPerc && hasBoid && d.radiiVision.z < 3.09) {
      let halfAng = d.radiiVision.z;
      let phi = f32(seg - 252u) * 1.5707963;
      let tip = bPos + fwd * (cos(halfAng) * d.radiiVision.x) + (right * cos(phi) + up * sin(phi)) * (sin(halfAng) * d.radiiVision.x);
      world = select(bPos, tip, endBit == 1u);
      col = vec3f(0.22, 0.92, 0.85);
      shown = true;
    }
  } else if (seg < 259u) {
    // 256 to 258: a small world-axis cross on the boid.
    if ((showVecs || showPerc) && hasBoid) {
      let span = max(d.radiiVision.y * 0.3, 0.35);
      var axis = vec3f(span, 0.0, 0.0);
      if (seg == 257u) { axis = vec3f(0.0, span, 0.0); }
      else if (seg == 258u) { axis = vec3f(0.0, 0.0, span); }
      world = select(bPos - axis, bPos + axis, endBit == 1u);
      col = vec3f(1.0);
      shown = true;
    }
  } else if (seg < 274u) {
    // 259 to 273: five arrows (shaft and two head strokes): velocity white, separation red, alignment cyan,
    // cohesion green, predator orange.
    if (showVecs && hasBoid) {
      let local = seg - 259u;
      let vecIdx = local / 3u;
      let part = local % 3u;
      var vecVal = debugBuf[2u + min(vecIdx, 4u) - 1u].xyz * 0.18;
      col = vec3f(1.0, 0.55, 0.15);
      if (vecIdx == 0u) { vecVal = bVel * 0.25; col = vec3f(1.0); }
      else if (vecIdx == 1u) { col = vec3f(1.0, 0.28, 0.35); }
      else if (vecIdx == 2u) { col = vec3f(0.22, 0.88, 1.0); }
      else if (vecIdx == 3u) { col = vec3f(0.28, 0.95, 0.45); }
      let vLen = length(vecVal);
      if (vLen > 0.02) {
        let len = min(vLen, max(d.radiiVision.x * 1.4, 3.0));
        let vDir = vecVal / vLen;
        let tip = bPos + vDir * len;
        let sideHint = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(vDir.y) > 0.92);
        let side = normalize(cross(sideHint, vDir));
        let headLen = min(len * 0.25, 0.4);
        if (part == 0u) {
          world = select(bPos, tip, endBit == 1u);
        } else {
          let s = select(-1.0, 1.0, part == 1u);
          world = select(tip, tip - vDir * headLen + side * (headLen * 0.5 * s), endBit == 1u);
        }
        shown = true;
      }
    }
  }
  if (shown) {
    o.clip = d.camera * vec4f(world, 1.0);
    o.color = col;
  }
  return o;
}
`;
