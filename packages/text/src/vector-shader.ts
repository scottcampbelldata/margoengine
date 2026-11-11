/**
 * Vector text shader: glyph coverage straight from the quadratic outline (Lengyel, JCGT 2017). One instanced
 * draw per text block; instance i draws glyph i % count in layer i / count (shadow, then fill). The fragment
 * stage mirrors `vectorCoverage` in vector-glyph.ts line for line.
 */
export const vectorTextShader: string = /* wgsl */ `
struct Frame { viewProj: mat4x4f, right: vec4f, up: vec4f, info: vec4f }
struct Block { model: mat4x4f, color: vec4f, shadow: vec4f, params: vec4f, info: vec4u, extra: vec4f, clipRect: vec4f }
struct Glyph { rect: vec4f, box: vec4f, info: vec4u }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> block: Block;
@group(1) @binding(1) var<storage, read> glyphs: array<Glyph>;
@group(1) @binding(2) var<storage, read> bands: array<vec4u>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) em: vec2f,
  @location(1) local: vec2f,
  @location(2) @interpolate(flat) box: vec4f,
  @location(3) @interpolate(flat) info: vec4u,
}

fn place(local: vec2f, depth: f32) -> vec4f {
  if ((block.info.w & 1u) != 0u) {
    let sx = length(block.model[0].xyz);
    let sy = length(block.model[1].xyz);
    return vec4f(block.model[3].xyz + frame.right.xyz * (local.x * sx) + frame.up.xyz * (local.y * sy) + cross(frame.right.xyz, frame.up.xyz) * (depth * sx), 1.0);
  }
  return block.model * vec4f(local, depth, 1.0);
}

// Screen pixels per local unit along a local axis at a clip position (derivative of the perspective divide).
fn pixels(clip: vec4f, axis: vec4f) -> f32 {
  let d = frame.viewProj * axis;
  let j = (d.xy * clip.w - clip.xy * d.w) / (clip.w * clip.w) * (0.5 * frame.info.yz);
  return length(j);
}

@vertex fn vertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let n = max(block.info.x, 1u);
  let layer = ii / n;
  let g = glyphs[ii % n];
  let kind = (block.info.z >> (2u * layer)) & 3u;
  let corner = vi % 6u;
  let segments = max(u32(block.extra.z), 1u);
  let c = vec2f((f32(vi / 6u) + f32((0x32u >> corner) & 1u)) / f32(segments), f32((0x2cu >> corner) & 1u));
  let middle = 0.5 * (g.rect.xy + g.rect.zw);
  // Pad outer quad edges by one pixel (plus the shadow blur), measured at the glyph centre.
  let centre = frame.viewProj * place(middle, 0.0);
  var ax: vec4f;
  var ay: vec4f;
  if ((block.info.w & 1u) != 0u) {
    ax = vec4f(frame.right.xyz * length(block.model[0].xyz), 0.0);
    ay = vec4f(frame.up.xyz * length(block.model[1].xyz), 0.0);
  } else {
    ax = vec4f(block.model[0].xyz, 0.0);
    ay = vec4f(block.model[1].xyz, 0.0);
  }
  let size = g.rect.zw - g.rect.xy;
  let blur = select(0.0, 1.5 * block.params.z, kind == 0u);
  let pad = min(vec2f(1.0 / max(pixels(centre, ax), 1e-6), 1.0 / max(pixels(centre, ay), 1e-6)), vec2f(max(size.x, size.y))) + blur;
  let outward = vec2f(f32(c.x >= 1.0) - f32(c.x <= 0.0), f32(c.y >= 1.0) - f32(c.y <= 0.0));
  var local = mix(g.rect.xy, g.rect.zw, c) + outward * pad;
  let em = g.box.xy + (local - g.rect.xy) / block.extra.x;
  if (kind == 0u) { local += block.params.xy; }
  let clipLocal = local;
  var depth = 0.0;
  if (block.extra.y != 0.0) {
    let angle = local.x / block.extra.y;
    local.x = block.extra.y * sin(angle);
    let halfSin = sin(0.5 * angle);
    depth = 2.0 * block.extra.y * halfSin * halfSin;
  }
  var o: Out;
  o.clip = frame.viewProj * place(local, depth);
  o.em = em;
  o.local = clipLocal;
  o.box = g.box;
  o.info = vec4u(g.info.x, g.info.y, g.info.z, kind);
  return o;
}

const Q = 65535.0;

// One ray (+x for axis 0, +y for axis 1) through an em-space point. x: coverage of the pixel's filter window along
// the ray, y: nearest crossing in pixels, z: 1 when a curve hull reaches the pixel square or the band misses part of it.
fn ray(point: vec2f, axis: u32, ppe: vec2f, box: vec4f, base: u32, n: u32, fw: f32, dil: f32) -> vec3f {
  let size = box.zw - box.xy;
  let scale = size / Q;
  let hw = 0.5 * fw;
  let reach = 1.001 * (hw + abs(dil));
  let halfEm = reach / ppe;
  let stop = -hw - abs(dil);
  let axisSign = select(-1.0, 1.0, axis == 0u);
  let along = select(point.x, point.y, axis == 0u);
  let lower = select(box.x, box.y, axis == 0u);
  let span = select(size.x, size.y, axis == 0u);
  let radius = select(halfEm.x, halfEm.y, axis == 0u);
  let band = u32(clamp(floor((along - lower) / span * f32(n)), 0.0, f32(n - 1u)));
  let header = bands[base + band];
  let start = select(header.z, header.x, axis == 0u);
  let count = select(header.w, header.y, axis == 0u);
  var touched = max(along - radius, lower) < lower + f32(band) / f32(n) * span || min(along + radius, lower + span) > lower + f32(band + 1u) / f32(n) * span;
  var linear = 0.0;
  var beyond = 0.0;
  var inside = 0u;
  var nearest = 1e30;
  var d0 = hw; var d1 = hw; var d2 = hw; var d3 = hw;
  var s0 = 0.0; var s1 = 0.0; var s2 = 0.0; var s3 = 0.0;
  for (var r = start; r < start + count; r++) {
    let w = bands[r];
    var p1 = (box.xy + vec2f(f32(w.x & 0xffffu), f32(w.x >> 16u)) * scale - point) * ppe;
    var p2 = (box.xy + vec2f(f32(w.y & 0xffffu), f32(w.y >> 16u)) * scale - point) * ppe;
    var p3 = (box.xy + vec2f(f32(w.z & 0xffffu), f32(w.z >> 16u)) * scale - point) * ppe;
    // x: along the ray; y: across it, whose signs classify the roots.
    if (axis == 1u) { p1 = p1.yx; p2 = p2.yx; p3 = p3.yx; }
    if (max(max(p1.x, p2.x), p3.x) < stop) { break; }
    if (min(min(p1.x, p2.x), p3.x) <= reach && max(max(p1.y, p2.y), p3.y) >= -reach && min(min(p1.y, p2.y), p3.y) <= reach) { touched = true; }
    let shift = select(0u, 2u, p1.y > 0.0) + select(0u, 4u, p2.y > 0.0) + select(0u, 8u, p3.y > 0.0);
    let code = (0x2e74u >> shift) & 3u;
    if (code == 0u) { continue; }
    let a = p1.y - 2.0 * p2.y + p3.y;
    let b = p1.y - p2.y;
    let root = sqrt(max(b * b - a * p1.y, 0.0));
    let q = select(b - root, b + root, b >= 0.0);
    let safeA = select(a, 1.0, a == 0.0);
    let safeQ = select(q, 1.0, q == 0.0);
    let t1 = select(q / safeA, p1.y / safeQ, b >= 0.0);
    let t2 = select(p1.y / safeQ, q / safeA, b >= 0.0);
    let ax = p1.x - 2.0 * p2.x + p3.x;
    let bx = p1.x - p2.x;
    for (var k = 0u; k < 2u; k++) {
      if ((code & (1u << k)) == 0u) { continue; }
      // t1: the across coordinate falls through zero (winding +1 left of it); t2: it rises (-1).
      let t = select(t1, t2, k == 1u);
      let s = select(1.0, -1.0, k == 1u);
      let raw = (ax * t - 2.0 * bx) * t + p1.x;
      let d = raw - s * axisSign * dil;
      nearest = min(nearest, abs(raw));
      linear += s * clamp(d / fw + 0.5, 0.0, 1.0);
      if (d >= hw) {
        beyond += s;
      } else if (d > -hw) {
        inside += 1u;
        var cd = d;
        var cs = s;
        if (cd < d0) { let td = d0; let ts = s0; d0 = cd; s0 = cs; cd = td; cs = ts; }
        if (cd < d1) { let td = d1; let ts = s1; d1 = cd; s1 = cs; cd = td; cs = ts; }
        if (cd < d2) { let td = d2; let ts = s2; d2 = cd; s2 = cs; cd = td; cs = ts; }
        if (cd < d3) { d3 = cd; s3 = cs; }
      }
    }
  }
  // Walk the window right to left: the winding is beyond at its right end and steps by each crossing's axisSign.
  var wind = beyond;
  var covered = (hw - d3) * min(abs(wind), 1.0);
  wind += s3;
  covered += (d3 - d2) * min(abs(wind), 1.0);
  wind += s2;
  covered += (d2 - d1) * min(abs(wind), 1.0);
  wind += s1;
  covered += (d1 - d0) * min(abs(wind), 1.0);
  wind += s0;
  covered += (d0 + hw) * min(abs(wind), 1.0);
  let coverage = select(covered / fw, min(abs(linear), 1.0), inside > 4u);
  return vec3f(coverage, nearest, select(0.0, 1.0, touched));
}

@fragment fn fragment(i: Out) -> @location(0) vec4f {
  // Pixels per em along each em axis: the screen distance to an edge x = const is dx / |grad x|.
  let gx = vec2f(dpdx(i.em.x), dpdy(i.em.x));
  let gy = vec2f(dpdx(i.em.y), dpdy(i.em.y));
  let ppe = 1.0 / max(vec2f(length(gx), length(gy)), vec2f(1e-12));
  if (any(i.local < block.clipRect.xy) || any(i.local > block.clipRect.zw)) { discard; }
  let n = i.info.y;
  let kind = i.info.w;
  // Box filter width in pixels: one pixel, wider for a blurred shadow (blur is in local units; em = local / fontSize).
  let fw = select(1.0, max(1.0, 1.0 + 2.0 * block.params.z / block.extra.x * 0.5 * (ppe.x + ppe.y)), kind == 0u);
  let dil = block.params.w * select(-1.0, 1.0, i.info.z != 0u);
  // extra.w: rays per axis, 0 for auto (5 under 7.5 pixels per em, else 3).
  let rays = select(select(3u, 5u, min(ppe.x, ppe.y) < 7.5), u32(block.extra.w), block.extra.w > 0.5);
  let h0 = ray(i.em, 0u, ppe, i.box, i.info.x, n, fw, dil);
  let v0 = ray(i.em, 1u, ppe, i.box, i.info.x, n, fw, dil);
  var ch = h0.x;
  var cv = v0.x;
  var nh = h0.y;
  var nv = v0.y;
  if (rays > 1u && (h0.z > 0.5 || v0.z > 0.5)) {
    for (var k = 0u; k < rays; k++) {
      let offset = (f32(k) - 0.5 * f32(rays - 1u)) / f32(rays);
      if (offset == 0.0) { continue; }
      let h = ray(i.em + vec2f(0.0, offset / ppe.y), 0u, ppe, i.box, i.info.x, n, fw, dil);
      let v = ray(i.em + vec2f(offset / ppe.x, 0.0), 1u, ppe, i.box, i.info.x, n, fw, dil);
      ch += h.x;
      cv += v.x;
      nh = min(nh, h.y);
      nv = min(nv, v.y);
    }
    ch /= f32(rays);
    cv /= f32(rays);
  }
  let reach = 0.5 * fw + abs(dil);
  let wh = clamp(1.0 - nh / reach, 0.0, 1.0);
  let wv = clamp(1.0 - nv / reach, 0.0, 1.0);
  let coverage = select(0.5 * (ch + cv), (wh * ch + wv * cv) / max(wh + wv, 1e-5), wh + wv > 1e-5);
  let color = select(block.color, block.shadow, kind == 0u);
  let alpha = color.a * coverage;
  return vec4f(color.rgb * alpha, alpha);
}
`;
