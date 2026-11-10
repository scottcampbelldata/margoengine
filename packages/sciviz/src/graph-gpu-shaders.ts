// Clean room from FR (1991), Barnes and Hut (1986), Jacomy et al. (2014).
const header = `struct Params {
  n: u32, padded: u32, leaves: u32, base: u32,
  side: u32, dims: u32, fan: u32, model: u32,
  k: f32, temperature: f32, gravity: f32, scaling: f32,
  theta: f32, jitter: f32, space: f32, linLog: u32,
  strong: u32, shift: u32, stage: u32, offset: u32,
  count: u32, overlap: u32, pad0: u32, pad1: u32
}
struct Cell { mass: vec4f, lo: vec4f, hi: vec4f }
@group(0) @binding(0) var<uniform> cfg: Params;
fn index(id: vec3u) -> u32 { return id.x + id.y * 65536u; }
fn direction(i: u32) -> vec3f {
  let angle = f32(i) * 2.39996323;
  let z = select(0.0, 1.0 - 2.0 * fract(f32(i) * 0.61803399), cfg.dims == 3u);
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(cos(angle) * r, sin(angle) * r, z);
}
fn pairForce(delta: vec3f, mass: f32, radius: f32, i: u32) -> vec3f {
  let d2 = dot(delta, delta);
  let d = sqrt(d2);
  let eps = 0.01 * cfg.k;
  var v = delta;
  if (d2 == 0.0) { v = direction(i) * eps; }
  var scale = cfg.k * cfg.k * mass / max(d2, eps * eps);
  if (cfg.model == 1u) {
    let gap = d - radius;
    scale = cfg.scaling * mass / max(d2, eps * eps);
    if (cfg.overlap == 1u) {
      scale = cfg.scaling * mass / max(gap * gap, eps * eps);
      if (gap < 0.0) { scale = 100.0 * cfg.scaling * mass; }
    }
  }
  return v * scale;
}
`;
export const keyShader =
  header +
  `
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> tree: array<Cell>;
@group(0) @binding(3) var<storage, read_write> keys: array<vec2u>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = index(id); if (i >= cfg.padded) { return; }
  var key = 0xffffffffu;
  if (i < cfg.n) {
    var low = vec3f(-cfg.space * 0.5);
    var span = cfg.space;
    if (tree[0].mass.w > 0.0) {
      let size = tree[0].hi.xyz - tree[0].lo.xyz;
      span = max(max(size.x, size.y), size.z) * 1.1 + 2.0 * max(cfg.temperature, 10.0);
      low = (tree[0].lo.xyz + tree[0].hi.xyz - vec3f(span)) * 0.5;
    }
    let cell = vec3u(clamp(floor((pos[i].xyz - low) / span * f32(cfg.side)), vec3f(0.0), vec3f(f32(cfg.side - 1u))));
    key = 0u; var bit = 0u;
    for (var s = 1u; s < cfg.side; s *= 2u) {
      key |= ((cell.x / s) & 1u) << bit;
      key |= ((cell.y / s) & 1u) << (bit + 1u);
      if (cfg.dims == 3u) { key |= ((cell.z / s) & 1u) << (bit + 2u); }
      bit += cfg.dims;
    }
  }
  keys[i] = vec2u(key, i);
}`;
export const sortShader =
  header +
  `
@group(0) @binding(1) var<storage, read> src: array<vec2u>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2u>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = index(id); if (i >= cfg.padded) { return; }
  let j = i ^ cfg.shift;
  let a = src[i]; let b = src[j];
  let less = a.x < b.x || (a.x == b.x && a.y < b.y);
  let takeMin = ((i & cfg.stage) == 0u) == (i < j);
  dst[i] = select(b, a, less == takeMin);
}`;
export const leafShader =
  header +
  `
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> keys: array<vec2u>;
@group(0) @binding(3) var<storage, read> attrs: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> tree: array<Cell>;
@group(0) @binding(5) var<storage, read_write> ranges: array<vec2u>;
fn lower(key: u32) -> u32 {
  var a = 0u; var b = cfg.n;
  while (a < b) { let m = (a + b) / 2u; if (keys[m].x < key) { a = m + 1u; } else { b = m; } }
  return a;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = index(id); if (i >= cfg.leaves) { return; }
  let a = lower(i); let b = lower(i + 1u);
  var sum = vec4f(0.0); var lo = vec3f(1e30); var hi = vec3f(-1e30); var radius = 0.0;
  for (var j = a; j < b; j++) {
    let k = keys[j].y; let p = pos[k]; sum += vec4f(p.xyz * p.w, p.w);
    lo = min(lo, p.xyz); hi = max(hi, p.xyz); radius = max(radius, attrs[k].x);
  }
  tree[cfg.base + i] = Cell(sum, vec4f(lo, radius), vec4f(hi, 0.0));
  ranges[i] = vec2u(a, b);
}`;
export const treeShader =
  header +
  `
@group(0) @binding(1) var<storage, read> src: array<Cell>;
@group(0) @binding(2) var<storage, read_write> dst: array<Cell>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = index(id); if (i >= cfg.count) { return; }
  var sum = vec4f(0.0); var lo = vec3f(1e30); var hi = vec3f(-1e30); var radius = 0.0;
  for (var q = 0u; q < cfg.fan; q++) {
    let c = src[(cfg.offset + i) * cfg.fan + 1u + q];
    if (c.mass.w > 0.0) { sum += c.mass; lo = min(lo, c.lo.xyz); hi = max(hi, c.hi.xyz); radius = max(radius, c.lo.w); }
  }
  dst[cfg.offset + i] = Cell(sum, vec4f(lo, radius), vec4f(hi, 0.0));
}`;
export const forceShader =
  header +
  `
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> keys: array<vec2u>;
@group(0) @binding(3) var<storage, read> tree: array<Cell>;
@group(0) @binding(4) var<storage, read> ranges: array<vec2u>;
@group(0) @binding(5) var<storage, read> attrs: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> forces: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = index(id); if (i >= cfg.n) { return; }
  let p = pos[i]; var f = vec3f(0.0); var visits = 0.0; var c = 0u;
  loop {
    let cell = tree[c]; var open = false;
    if (cell.mass.w > 0.0) {
      let center = cell.mass.xyz / cell.mass.w;
      let delta = p.xyz - center; let size = cell.hi.xyz - cell.lo.xyz;
      let reach = length(delta) - length(center - (cell.hi.xyz + cell.lo.xyz) * 0.5);
      let inside = all(p.xyz >= cell.lo.xyz) && all(p.xyz <= cell.hi.xyz);
      let near = cfg.overlap == 1u && length(delta) <= attrs[i].x + cell.lo.w + length(size);
      if (!inside && !near && reach > 0.0 && max(max(size.x, size.y), size.z) < cfg.theta * reach) {
        f += pairForce(delta, p.w * cell.mass.w, attrs[i].x + cell.lo.w, i); visits += 1.0;
      } else if (c >= cfg.base) {
        let range = ranges[c - cfg.base];
        for (var at = range.x; at < range.y; at++) {
          let j = keys[at].y;
          if (j != i) { f += pairForce(p.xyz - pos[j].xyz, p.w * pos[j].w, attrs[i].x + attrs[j].x, i); visits += 1.0; }
        }
      } else { open = true; }
    }
    if (open) { c = c * cfg.fan + 1u; continue; }
    while (c > 0u && c % cfg.fan == 0u) { c = (c - 1u) / cfg.fan; }
    if (c == 0u) { break; }
    c += 1u;
  }
  forces[i] = vec4f(f, visits);
}`;
export const attractionShader =
  header +
  `
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read> adjacency: array<vec2u>;
@group(0) @binding(4) var<storage, read> edges: array<vec2f>;
@group(0) @binding(5) var<storage, read> attrs: array<vec4f>;
@group(0) @binding(6) var<storage, read> repulsion: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> forces: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = index(id); if (i >= cfg.n) { return; }
  let p = pos[i]; var f = repulsion[i].xyz;
  for (var e = offsets[i]; e < offsets[i + 1u]; e++) {
    let edge = adjacency[e]; let delta = pos[edge.x].xyz - p.xyz;
    let d = length(delta); let weight = edges[edge.y]; var factor = d / cfg.k;
    if (cfg.model == 1u) {
      factor = 1.0 / weight.y;
      if (cfg.linLog == 1u) { factor *= log(1.0 + d) / max(d, 1e-20); }
      if (cfg.overlap == 1u && d <= attrs[i].x + attrs[edge.x].x) { factor = 0.0; }
    }
    f += delta * factor * weight.x;
  }
  var g = cfg.gravity * cfg.k;
  if (cfg.model == 1u) {
    g = cfg.gravity * p.w;
    if (cfg.strong == 0u) { g /= max(length(p.xyz), 1e-20); }
  }
  f -= p.xyz * g;
  if (cfg.dims == 2u) { f.z = 0.0; }
  forces[i] = vec4f(f, repulsion[i].w);
}`;
export const statsShader =
  header +
  `
@group(0) @binding(1) var<storage, read> forces: array<vec4f>;
@group(0) @binding(2) var<storage, read> previous: array<vec4f>;
@group(0) @binding(3) var<storage, read> pos: array<vec4f>;
@group(0) @binding(4) var<storage, read> attrs: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> stats: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = index(id); if (i >= cfg.count) { return; }
  var sum = vec4f(0.0);
  for (var j = i * 256u; j < min(cfg.n, (i + 1u) * 256u); j++) {
    let f = forces[j]; let old = previous[j].xyz;
    if (attrs[j].y == 0.0) { sum.x += pos[j].w * length(f.xyz - old); sum.y += pos[j].w * length(f.xyz + old) * 0.5; }
    sum.z += f.w;
  }
  stats[i] = sum;
}`;
export const speedShader =
  header +
  `
@group(0) @binding(1) var<storage, read> stats: array<vec4f>;
@group(0) @binding(2) var<storage, read> old: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> state: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  var sum = vec4f(0.0);
  for (var i = 0u; i < cfg.count; i++) { sum += stats[i]; }
  var speed = old[0].x;
  if (sum.x > 0.0) { speed = min(cfg.jitter * cfg.jitter * sum.y / sum.x, speed * 1.5); }
  state[0] = vec4f(speed, sum.x, sum.y, sum.z);
}`;
export const moveShader =
  header +
  `
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> forces: array<vec4f>;
@group(0) @binding(3) var<storage, read> previous: array<vec4f>;
@group(0) @binding(4) var<storage, read> attrs: array<vec4f>;
@group(0) @binding(5) var<storage, read> state: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> dst: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = index(id); if (i >= cfg.n) { return; }
  let p = pos[i]; let f = forces[i].xyz; let d = length(f); var step = 0.0;
  if (d > 0.0 && attrs[i].y == 0.0) {
    step = min(d, cfg.temperature) / d;
    if (cfg.model == 1u) {
      let swing = p.w * length(f - previous[i].xyz);
      step = 0.1 * state[0].x / (1.0 + state[0].x * sqrt(swing));
      if (cfg.overlap == 1u) { step *= 0.1; }
      step = min(step, 10.0 / d);
    }
  }
  dst[i] = vec4f(p.xyz + f * step, p.w);
}`;
