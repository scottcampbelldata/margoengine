// Largest-pivot scaled Jacobi, derived from orthogonal plane rotations; no external implementation used.
export const deriveShader = /* wgsl */ `
struct Params { nx: u32, ny: u32, nz: u32, count: u32, ix: f32, iy: f32, iz: f32, missingBits: u32 }
// The smallest normal f32 (2^-126).
const MIN_NORMAL = 1.1754943508222875e-38;
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> gradient: array<u32>;
@group(0) @binding(2) var<storage, read_write> divergence: array<u32>;
@group(0) @binding(3) var<storage, read_write> curl: array<u32>;
@group(0) @binding(4) var<storage, read_write> vorticity: array<u32>;
@group(0) @binding(5) var<storage, read_write> q: array<u32>;
@group(0) @binding(6) var<storage, read_write> lambda2: array<u32>;
@group(0) @binding(7) var<storage, read_write> status: array<u32>;
@group(0) @binding(8) var<uniform> params: Params;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.x + wid.y * nwg.x) * 64u + lid;
  if (i >= params.count) { return; }
  var g: array<f32, 9>;
  var valid = source[4u * i + 3u] != 0.0;
  let sizes = array<u32, 3>(params.nx, params.ny, params.nz);
  let strides = array<u32, 3>(1u, params.nx, params.nx * params.ny);
  let inverse = array<f32, 3>(params.ix, params.iy, params.iz);
  for (var axis = 0u; axis < 3u; axis++) {
    let n = sizes[axis]; let stride = strides[axis]; let at = (i / stride) % n;
    if (n == 1u) { continue; }
    let oneSided = n > 2u && (at == 0u || at == n - 1u);
    var a = i; var b = i; var c = i;
    if (oneSided) {
      if (at == 0u) { b = i + stride; c = i + 2u * stride; }
      else { b = i - stride; c = i - 2u * stride; }
    } else {
      if (at > 0u) { a = i - stride; }
      if (at < n - 1u) { b = i + stride; }
      c = a;
    }
    valid = valid && source[4u*a+3u] != 0.0 && source[4u*b+3u] != 0.0 && source[4u*c+3u] != 0.0;
    for (var component = 0u; component < 3u; component++) {
      let va = source[4u*a+component]; let vb = source[4u*b+component]; let vc = source[4u*c+component];
      var value = (vb-va) * select(0.5, 1.0, n == 2u);
      if (oneSided) { value = (2.0*(vb-va) - 0.5*(vc-va)) * select(-1.0, 1.0, at == 0u); }
      g[3u*component+axis] = value * inverse[axis];
    }
  }
  if (!valid) {
    let missing = params.missingBits;
    for (var k = 0u; k < 9u; k++) { gradient[9u*i+k] = missing; }
    for (var k = 0u; k < 3u; k++) { curl[3u*i+k] = missing; }
    divergence[i] = missing; vorticity[i] = missing; q[i] = missing; lambda2[i] = missing;
    status[i] = 0u; return;
  }
  status[i] = 1u;
  var scale = 0.0;
  for (var k = 0u; k < 9u; k++) { gradient[9u*i+k] = bitcast<u32>(g[k]); scale = max(scale, abs(g[k])); }
  divergence[i] = bitcast<u32>(g[0] + g[4] + g[8]);
  let cv = vec3f(g[7]-g[5], g[2]-g[6], g[3]-g[1]);
  curl[3u*i] = bitcast<u32>(cv.x); curl[3u*i+1u] = bitcast<u32>(cv.y); curl[3u*i+2u] = bitcast<u32>(cv.z);
  let cs = max(abs(cv.x), max(abs(cv.y), abs(cv.z)));
  vorticity[i] = 0u;
  // Scale only by a normal f32: Metal flushes subnormals to zero, so a subnormal scale makes 0/0 (2026-11-09).
  if (cs >= MIN_NORMAL) { vorticity[i] = bitcast<u32>(length(cv/cs) * cs); }
  q[i] = 0u; lambda2[i] = 0u;
  if (!(scale >= MIN_NORMAL)) { return; }
  for (var k = 0u; k < 9u; k++) { g[k] /= scale; }
  var m: array<f32, 9>;
  var norm = 0.0;
  for (var r = 0u; r < 3u; r++) { for (var c = r; c < 3u; c++) {
    var value = 0.0;
    for (var k = 0u; k < 3u; k++) { value += 0.5*(g[3u*r+k]*g[3u*k+c] + g[3u*c+k]*g[3u*k+r]); }
    m[3u*r+c] = value; m[3u*c+r] = value; norm = max(norm, abs(value));
  } }
  q[i] = bitcast<u32>(-0.5*(m[0]+m[4]+m[8])*scale*scale);
  for (var turn = 0u; turn < 48u; turn++) {
    var p = 0u; var col = 1u;
    if (abs(m[2]) > abs(m[3u*p+col])) { p = 0u; col = 2u; }
    if (abs(m[5]) > abs(m[3u*p+col])) { p = 1u; col = 2u; }
    let b = m[3u*p+col]; let a = m[4u*p]; let d = m[4u*col];
    if (abs(b) <= 1e-7 * norm) { break; }
    let diff = d-a;
    var t = select(-1.0, 1.0, b >= 0.0);
    if (diff != 0.0) { t = 2.0*b*sign(diff)/(abs(diff)+sqrt(diff*diff+4.0*b*b)); }
    let cosine = inverseSqrt(1.0+t*t); let sine = t*cosine; let other = 3u-p-col;
    let rp = m[3u*other+p]; let rq = m[3u*other+col];
    m[3u*other+p] = cosine*rp-sine*rq; m[3u*p+other] = m[3u*other+p];
    m[3u*other+col] = sine*rp+cosine*rq; m[3u*col+other] = m[3u*other+col];
    m[4u*p] = a-t*b; m[4u*col] = d+t*b; m[3u*p+col] = 0.0; m[3u*col+p] = 0.0;
  }
  if (max(abs(m[1]), max(abs(m[2]), abs(m[5]))) > 1e-6*norm) { status[i] = 2u; }
  let middle = max(min(m[0],m[4]), min(max(m[0],m[4]),m[8]));
  lambda2[i] = bitcast<u32>(middle*scale*scale);
}`;
