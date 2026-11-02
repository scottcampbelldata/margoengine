// Clean-room integer primitives derived from Margo fixed.ts/hash.ts.
// W3C WGSL CRD 2026-10-26 https://www.w3.org/TR/2026/CRD-WGSL-20261026/
// #integer-types, #arithmetic-expr, #bit-expr: modulo arithmetic and bit operations.
// Limb arithmetic is our derivation. Unsigned division only; floor signs are explicit.
export const PLACEMENT_FLOW_ARITHMETIC = /* wgsl */ `
fn wide(a: u32, b: u32) -> vec2<u32> {
  let p = (a & 65535u) * (b & 65535u);
  let q = (a >> 16u) * (b & 65535u) + (p >> 16u);
  let r = (a & 65535u) * (b >> 16u) + (q & 65535u);
  return vec2<u32>((r << 16u) | (p & 65535u), (a >> 16u) * (b >> 16u) + (q >> 16u) + (r >> 16u));
}
fn addwide(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
  let lo = a.x + b.x;
  return vec2<u32>(lo, a.y + b.y + select(0u, 1u, lo < a.x));
}
fn lesswide(a: vec2<u32>, b: vec2<u32>) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }
fn subwide(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { return vec2<u32>(a.x-b.x, a.y-b.y-select(0u,1u,a.x<b.x)); }
fn shlwide(a: vec2<u32>) -> vec2<u32> { return vec2<u32>(a.x << 1u, (a.y << 1u) | (a.x >> 31u)); }
// Restoring division. Quotient callers establish <= u32; the remainder retains all 64 bits.
fn dividewide(a: vec2<u32>, b: vec2<u32>) -> u32 {
  var rem = vec2<u32>(0u); var q = 0u;
  for (var k = 0u; k < 64u; k++) {
    let bit = 63u-k;
    rem = shlwide(rem);
    rem.x |= select((a.x >> (bit & 31u)) & 1u, (a.y >> (bit & 31u)) & 1u, bit >= 32u);
    q <<= 1u;
    if (!lesswide(rem,b)) { rem = subwide(rem,b); q |= 1u; }
  }
  return q;
}
fn floorSigned(a: i32, d: u32) -> i32 {
  let mag = select(bitcast<u32>(a), 0u-bitcast<u32>(a), a < 0);
  let q = mag / d;
  return select(i32(q), -i32(q + select(0u,1u,mag % d != 0u)), a < 0);
}
fn qmul(a: i32, b: i32) -> i32 {
  let p = wide(select(bitcast<u32>(a),0u-bitcast<u32>(a),a<0), select(bitcast<u32>(b),0u-bitcast<u32>(b),b<0));
  let q = (p.y << 16u) | (p.x >> 16u);
  return bitcast<i32>(select(q, 0u-q-select(0u,1u,(p.x & 65535u)!=0u), (a<0)!=(b<0)));
}
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> (((state >> 28u) + 4u) & 31u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn hash5(seed: u32, code: u32, x: i32, z: i32, k: u32) -> u32 {
  return pcg(seed + pcg(code + pcg(bitcast<u32>(x) + pcg(bitcast<u32>(z) + pcg(k)))));
}
fn poisson(mu: u32, e0: u32, h: u32) -> u32 {
  let u = h >> 16u; var p = e0; var cdf = p; var k = 0u;
  while (u >= cdf && k < 40u) {
    k++; p = dividewide(wide(p,mu), vec2<u32>(k*65536u,0u));
    if (p == 0u) { break; } cdf += p;
  }
  return k;
}
fn fade(t: u32) -> i32 {
  let a = wide(t,t);
  let cube = wide(a.x,t);
  let c = (cube.x >> 16u) | (cube.y << 16u);
  // 6t^2 - 15 ONE t + 10 ONE^2 stays positive and below 2^36.
  let poly = subwide(addwide(wide(a.x,6u), vec2<u32>(0u,10u)), wide(t,983040u));
  let p = (poly.x >> 16u) | (poly.y << 16u);
  return i32(wide(c,p).y);
}
fn noise(seed: u32, x: i32, z: i32) -> i32 {
  let ix = x >> 16u; let iz = z >> 16u;
  let fx = fade(bitcast<u32>(x)&65535u); let fz = fade(bitcast<u32>(z)&65535u);
  let z0 = pcg(bitcast<u32>(iz)); let z1 = pcg(bitcast<u32>(iz+1));
  let a = i32(pcg(seed + pcg(bitcast<u32>(ix)+z0)) >> 16u);
  let b = i32(pcg(seed + pcg(bitcast<u32>(ix+1)+z0)) >> 16u);
  let c = i32(pcg(seed + pcg(bitcast<u32>(ix)+z1)) >> 16u);
  let d = i32(pcg(seed + pcg(bitcast<u32>(ix+1)+z1)) >> 16u);
  let top = a+qmul(b-a,fx); let bottom = c+qmul(d-c,fx);
  return top+qmul(bottom-top,fz);
}
fn stand(seed: u32, scale: u32, top: i32, px: i32, pz: i32) -> i32 {
  if (scale == 0u) { return 65536; }
  // Positions are in the finite world, nonnegative; the quotient is then wrapped like CPU noise coordinates.
  var x = bitcast<i32>(dividewide(wide(u32(px),65536u),vec2<u32>(scale,0u)));
  var z = bitcast<i32>(dividewide(wide(u32(pz),65536u),vec2<u32>(scale,0u)));
  let key = pcg(seed+pcg(scale)); var sum = 0; var amp = 65536;
  for (var i = 0u; i < 3u; i++) {
    sum += qmul(noise(key+i*1013u,x,z),amp);
    let nx = 2*x-(z >> 1u)+63369013; let nz = (x >> 1u)+2*z+461845907;
    x=nx; z=nz; amp >>= 1u;
  }
  let value = i32(dividewide(wide(u32(sum),65535u),vec2<u32>(114688u,0u)));
  let delta = top-value;
  let magnitude = wide(u32(abs(delta)),65536u);
  let quotient = dividewide(magnitude,vec2<u32>(6000u,0u));
  let remainder = subwide(magnitude,wide(quotient,6000u));
  let signed = select(i32(quotient),-i32(quotient+select(0u,1u,any(remainder!=vec2<u32>(0u)))),delta<0);
  let r = clamp(signed,0,65536);
  if (r <= 0) { return 65536; } if (r >= 65536) { return 0; }
  let s = 65536-r; let s2 = qmul(s,s);
  return qmul(qmul(s2,s2),4*r+65536);
}
`;
