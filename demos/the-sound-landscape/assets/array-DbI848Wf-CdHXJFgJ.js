var e=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),t=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,n=(n,r,i=n)=>e(n,t(r,i)),r=(e,n)=>TypeError(t(e,n)),i=(e,n)=>RangeError(t(e,n)),a=[`f32`,`f16`,`i32`,`u32`],o=e=>e===`f16`?2:4,s=e=>e===`f32`||e===`f16`,c=globalThis.Float16Array;function l(e){switch(e){case`f32`:return Float32Array;case`i32`:return Int32Array;case`u32`:return Uint32Array;case`f16`:if(!c)throw r(`f16 data needs Float16Array; read it as f32 with astype("f32")`,`compute`);return c}}function u(e){if(c&&e instanceof c)return`f16`;if(e instanceof Float32Array||e instanceof Float64Array)return`f32`;if(e instanceof Int32Array||e instanceof Int16Array||e instanceof Int8Array)return`i32`;if(e instanceof Uint32Array||e instanceof Uint16Array||e instanceof Uint8Array||e instanceof Uint8ClampedArray)return`u32`;if(ArrayBuffer.isView(e))throw r(`Compute arrays take number TypedArrays, not BigInt arrays or DataView`,`compute`);return`f32`}function d(e,t){let n=l(t);return e instanceof n&&e.buffer instanceof ArrayBuffer?e:n.from(e)}function f(e,t){return e===t?e:e===`f32`||t===`f32`?`f32`:e===`f16`||t===`f16`?`f16`:`i32`}function p(e,t){return s(t)?t:Number.isInteger(e)?t===`u32`&&e<0?`i32`:t:`f32`}function m(e,t){let n=new DataView(new ArrayBuffer(4));return t===`f32`||t===`f16`?n.setFloat32(0,e,!0):t===`i32`?n.setInt32(0,e,!0):n.setUint32(0,e>>>0,!0),n.getUint32(0,!0)}function h(e,t){return t===`u32`?e:t===`f16`?`f16(bitcast<f32>(${e}))`:`bitcast<${t}>(${e})`}var g=Object.freeze({twoOverPi:[0,2734261102,1313084713,4230436817,4113882560,3680671129,1011060801,4266746795],halfPiFixed:3373259426,halfPi:[1.5707963705062866,-4.371138828673793e-8],quarterPi:[.7853981852531433,-2.1855694143368964e-8],pi:[3.1415927410125732,-8.742277657347586e-8],ln2:[.693145751953125,1428606765330187e-21],ln2Pair:[.6931471824645996,-1.9046542121259336e-9],log2e:[1.4426950216293335,1.925963033500011e-8],sin:[-.1666666716337204,.008333379402756691,-.00019853089179378003,2833021881087916e-21],cos:[.0416666679084301,-.0013888980029150844,2482202216924634e-20,-2.8881245839329495e-7],atan:[-.3333333432674408,.20000059902668,-.14286741614341736,.11114691942930222,-.09025663882493973,.06947030127048492,-.03550770878791809],asin:[.1666666716337204,.07499949634075165,.044659871608018875,.03011295571923256,.024605773389339447,.007497195154428482,.03466988354921341],sinh:[.1666666716337204,.00833326205611229,.00019874409190379083,20846018742304295e-22,6.411173671949655e-7,-2.0997923400045693e-7],cosh:[.0416666679084301,.0013888796092942357,2482521813362837e-20,2.506288865333772e-7,1.1460320692435744e-8],tanh:[-.3333333432674408,.1333339512348175,-.05398104339838028,.021990614011883736,-.009435489773750305,.004868379328399897,-.0023415694013237953],expm1:[.5,.1666666567325592,.04166649281978607,.008333546109497547,.0013932319125160575,.00019761594012379646],log:[.6666666269302368,.40000975131988525,.28498485684394836,.24286234378814697]}),_=e=>{let t=String(e);for(let n=1;n<=9;n++){let r=e.toPrecision(n);if(Math.fround(Number(r))===e){t=r;break}}return/[.e]/.test(t)?t:`${t}.0`},v=(e,t)=>{let n=_(t[t.length-1]);for(let r=t.length-2;r>=0;r--)n=`(${e} * ${n} + ${_(t[r])})`;return n},y=e=>`0x${e.toString(16)}u`,b,x=()=>b??={pmBits:[[],`fn pmExponent(x: f32) -> u32 { return (bitcast<u32>(x) >> 23u) & 0xffu; }
fn pmNegative(x: f32) -> bool { return (bitcast<u32>(x) >> 31u) == 1u; }
fn pmIsNan(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u; }
fn pmIsZero(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) == 0u; }
fn pmNan(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) | 0x7fc00000u); }
fn pmInfinity(negative: bool, x: f32) -> f32 { return bitcast<f32>((bitcast<u32>(x) & 0u) | select(0x7f800000u, 0xff800000u, negative)); }
fn pmWithSign(v: f32, x: f32) -> f32 { return select(v, -v, pmNegative(x)); }
fn pmSplit(v: f32) -> vec2f { let h = bitcast<f32>(bitcast<u32>(v) & 0xfffff000u); return vec2f(h, v - h); }
fn pmHide(v: f32) -> f32 {
 let b = bitcast<u32>(v);
 let e = (b >> 23u) & 0xffu;
 let m = i32((b & 0x7fffffu) | select(0x800000u, 0u, e == 0u));
 return ldexp(f32(select(m, -m, (b >> 31u) == 1u)), max(i32(e), 1) - 150);
}
fn pmFastTwoSum(a: f32, b: f32) -> vec2f { let s = a + b; return vec2f(s, pmHide(b - pmHide(pmHide(s) - a))); }
fn pmProductError(a: f32, b: f32, p: f32) -> f32 {
 let x = pmSplit(a); let y = pmSplit(b);
 return pmHide((((pmHide(x.x * y.x) - p) + pmHide(x.x * y.y)) + pmHide(x.y * y.x)) + pmHide(x.y * y.y));
}
const PM_PIO2_HI: f32 = ${_(g.halfPi[0])};
const PM_PIO2_LO: f32 = ${_(g.halfPi[1])};
const PM_PIO4_HI: f32 = ${_(g.quarterPi[0])};
const PM_PIO4_LO: f32 = ${_(g.quarterPi[1])};
const PM_PI_HI: f32 = ${_(g.pi[0])};
const PM_PI_LO: f32 = ${_(g.pi[1])};
const PM_LN2_HI: f32 = ${_(g.ln2[0])};
const PM_LN2_LO: f32 = ${_(g.ln2[1])};
const PM_LN2: f32 = ${_(g.ln2Pair[0])};
const PM_LN2_TAIL: f32 = ${_(g.ln2Pair[1])};
const PM_LOG2E: f32 = ${_(g.log2e[0])};
const PM_LOG2E_LO: f32 = ${_(g.log2e[1])};
`],preciseDiv:[[`pmBits`],`fn preciseDiv(a: f32, b: f32) -> f32 {
 let q = a / b;
 if (pmExponent(a) == 255u || pmExponent(b) == 255u || pmExponent(q) == 255u || pmExponent(q) == 0u) { return q; }
 let p = pmHide(q * b);
 let r = (a - p) - pmProductError(q, b, p);
 return q + pmHide(r / b);
}
`],preciseSqrt:[[`pmBits`],`fn pmSqrt2(a: f32) -> vec2f {
 let s = sqrt(a);
 if (a <= 0.0 || pmIsNan(a) || pmExponent(a) == 255u || pmExponent(s) == 0u) { return vec2f(s, 0.0); }
 let p = pmHide(s * s);
 let r = (a - p) - pmProductError(s, s, p);
 return pmFastTwoSum(s, r / (2.0 * s));
}
fn preciseSqrt(a: f32) -> f32 { return pmSqrt2(a).x; }
`],pmReduce:[[`pmBits`],`fn pmTwoOverPi(i: u32) -> u32 {
 switch i {
${g.twoOverPi.map((e,t)=>`    case ${t}u: { return ${y(e)}; }`).join(`
`)}
  default: { return 0u; }
 }
}
fn pmMul24x32(m: u32, v: u32) -> vec2u {
 let ml = m & 0xfffu; let mh = m >> 12u; let vl = v & 0xffffu; let vh = v >> 16u;
 let p0 = ml * vl; let p1 = ml * vh; let p2 = mh * vl; let p3 = mh * vh;
 var lo = p0;
 var hi = (p1 >> 16u) + (p2 >> 20u) + (p3 >> 4u);
 var t = lo + (p1 << 16u); hi = hi + select(0u, 1u, t < lo); lo = t;
 t = lo + (p2 << 12u); hi = hi + select(0u, 1u, t < lo); lo = t;
 t = lo + (p3 << 28u); hi = hi + select(0u, 1u, t < lo); lo = t;
 return vec2u(hi, lo);
}
fn pmMul32(a: u32, b: u32) -> vec2u {
 let al = a & 0xffffu; let ah = a >> 16u; let bl = b & 0xffffu; let bh = b >> 16u;
 let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh;
 let mid = (ll >> 16u) + (lh & 0xffffu) + (hl & 0xffffu);
 return vec2u(hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u), (ll & 0xffffu) | (mid << 16u));
}
struct PmReduced { hi: f32, lo: f32, q: u32 }
fn pmReduce(a: f32) -> PmReduced {
 let u = bitcast<u32>(a);
 let e = i32(u >> 23u) - 150;
 let m = (u & 0x7fffffu) | 0x800000u;
 let t = u32(e + 30);
 let w = t >> 5u; let s = t & 31u; let r = 32u - s;
 let A = pmTwoOverPi(w); let B = pmTwoOverPi(w + 1u); let C = pmTwoOverPi(w + 2u); let D = pmTwoOverPi(w + 3u);
 let v0 = select((A << s) | (B >> r), A, s == 0u);
 let v1 = select((B << s) | (C >> r), B, s == 0u);
 let v2 = select((C << s) | (D >> r), C, s == 0u);
 let P0 = pmMul24x32(m, v0); let P1 = pmMul24x32(m, v1); let P2 = pmMul24x32(m, v2);
 let p0 = P2.y;
 let p1 = P1.y + P2.x;
 let p2 = P0.y + P1.x + select(0u, 1u, p1 < P1.y);
 var q = p2 >> 30u;
 var hi = (p2 << 2u) | (p1 >> 30u);
 var lo = (p1 << 2u) | (p0 >> 30u);
 let neg = (hi >> 31u) == 1u;
 if (neg) { q = q + 1u; lo = ~lo + 1u; hi = ~hi + select(0u, 1u, lo == 0u); }
 let L = pmMul32(lo, ${g.halfPiFixed}u); let H = pmMul32(hi, ${g.halfPiFixed}u);
 let g1 = H.y + L.x;
 let g2 = H.x + select(0u, 1u, g1 < H.y);
 var n: u32; var top: u32; var low: u32;
 if (g2 != 0u) {
  n = countLeadingZeros(g2);
  top = select((g2 << n) | (g1 >> (32u - n)), g2, n == 0u);
  low = g1 << n;
 } else {
  let z = countLeadingZeros(g1);
  n = 32u + z;
  top = select(g1 << z, 0u, z == 32u);
  low = 0u;
 }
 let hi24 = top >> 8u;
 let next = ((top & 0xffu) << 16u) | (low >> 16u);
 let sign = select(1.0, -1.0, neg);
 return PmReduced(sign * ldexp(f32(hi24), -23 - i32(n)), sign * ldexp(f32(next), -47 - i32(n)), q & 3u);
}
`],pmTrig:[[`pmReduce`,`pmBits`],`fn pmSinK(h: f32, l: f32) -> f32 {
 let w = h * h;
 let p = ${v(`w`,g.sin)};
 return h + pmHide(l * (1.0 - 0.5 * w) + (h * w) * p);
}
fn pmCosK(h: f32, l: f32) -> f32 {
 let w = pmHide(h * h); let hw = 0.5 * w; let t = pmFastTwoSum(1.0, -hw);
 let ew = pmProductError(h, h, w);
 let p = ${v(`w`,g.cos)};
 return t.x + pmHide((t.y - 0.5 * ew) + ((w * w) * p - h * l));
}
fn pmReduceTrig(a: f32) -> PmReduced {
 if (a <= 0.78125) { return PmReduced(a, 0.0, 0u); }
 return pmReduce(a);
}
`],preciseSin:[[`pmTrig`],`fn preciseSin(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 let v = select(select(select(-c, -s, r.q == 2u), c, r.q == 1u), s, r.q == 0u);
 return pmWithSign(v, x);
}
`],preciseCos:[[`pmTrig`],`fn preciseCos(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return 1.0; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 return select(select(select(s, -c, r.q == 2u), -s, r.q == 1u), c, r.q == 0u);
}
`],preciseTan:[[`pmTrig`,`preciseDiv`],`fn preciseTan(x: f32) -> f32 {
 let a = abs(x);
 if (pmExponent(x) == 255u) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 let r = pmReduceTrig(a);
 let s = pmSinK(r.hi, r.lo); let c = pmCosK(r.hi, r.lo);
 var v: f32;
 if ((r.q & 1u) == 0u) { v = preciseDiv(s, c); } else { v = -preciseDiv(c, s); }
 return pmWithSign(v, x);
}
`],pmAtanK:[[`pmBits`],`fn pmAtanK(u: f32) -> f32 {
 let w = u * u;
 let p = ${v(`w`,g.atan)};
 return u + pmHide((u * w) * p);
}
`],preciseAtan:[[`pmAtanK`,`preciseDiv`],`fn preciseAtan(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 var r: f32;
 if (a <= 0.5) { r = pmAtanK(a); }
 else if (a <= 2.0) { r = PM_PIO4_HI + pmHide(pmAtanK(preciseDiv(a - 1.0, a + 1.0)) + PM_PIO4_LO); }
 else { r = PM_PIO2_HI + pmHide(PM_PIO2_LO - pmAtanK(preciseDiv(1.0, a))); }
 return pmWithSign(r, x);
}
`],preciseAtan2:[[`pmAtanK`,`preciseDiv`],`fn preciseAtan2(y: f32, x: f32) -> f32 {
 if (pmIsNan(x) || pmIsNan(y)) { return pmNan(x + y); }
 var ax = abs(x); var ay = abs(y);
 var t: f32;
 if (pmExponent(ax) == 255u && pmExponent(ay) == 255u) { t = PM_PIO4_HI; }
 else {
  if (ax > 4.253529586511731e37 || ay > 4.253529586511731e37) { ax = ax * 0.25; ay = ay * 0.25; }
  let big = max(ax, ay); let small = min(ax, ay);
  if (big == 0.0) { t = 0.0; }
  else if (small <= 0.5 * big) {
   let k = pmAtanK(preciseDiv(small, big));
   t = select(k, PM_PIO2_HI + pmHide(PM_PIO2_LO - k), ay > ax);
  } else { t = PM_PIO4_HI + pmHide(pmAtanK(preciseDiv(ay - ax, ay + ax)) + PM_PIO4_LO); }
 }
 if (pmNegative(x) && (!pmIsZero(x) || pmIsZero(y))) { t = PM_PI_HI + pmHide(PM_PI_LO - t); }
 return pmWithSign(t, y);
}
`],pmAsin:[[`preciseSqrt`,`pmBits`],`fn pmAsinK(x: f32) -> f32 {
 let w = x * x;
 let p = ${v(`w`,g.asin)};
 return (x * w) * p;
}
fn pmAsinTail(a: f32) -> vec2f {
 let z = 0.5 * (1.0 - a);
 let s = pmSqrt2(z);
 return vec2f(2.0 * s.x, 2.0 * (s.y + pmAsinK(s.x)));
}
`],preciseAsin:[[`pmAsin`],`fn preciseAsin(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x) || a > 1.0) { return pmNan(x); }
 if (a < 0.000244140625) { return x; }
 var r: f32;
 if (a < 0.5) { r = a + pmAsinK(a); }
 else { let t = pmAsinTail(a); r = PM_PIO2_HI - pmHide(t.x - pmHide(PM_PIO2_LO - t.y)); }
 return pmWithSign(r, x);
}
`],preciseAcos:[[`pmAsin`],`fn preciseAcos(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x) || a > 1.0) { return pmNan(x); }
 if (a < 0.5) { return PM_PIO2_HI - pmHide(x - pmHide(PM_PIO2_LO - pmAsinK(x))); }
 let t = pmAsinTail(a);
 if (pmNegative(x)) { return PM_PI_HI - pmHide(t.x - pmHide(PM_PI_LO - t.y)); }
 return t.x + t.y;
}
`],pmExp:[[`pmBits`],`fn pmExpm1P(r: f32) -> f32 { return ${v(`r`,g.expm1)}; }
fn pmExpm1K(r: f32) -> f32 { return r + pmHide((r * r) * pmExpm1P(r)); }
fn pmReduceLn2(x: f32) -> vec4f {
 let k = round(x * PM_LOG2E);
 let hi = pmHide(x - k * PM_LN2_HI);
 let lo = -k * PM_LN2_LO;
 return vec4f(k, hi + lo, hi, lo);
}
fn pmScale(v: f32, k: i32) -> f32 { let h = k / 2; return ldexp(pmHide(ldexp(v, k - h)), h); }
`],preciseExp:[[`pmExp`],`fn preciseExp(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x > 88.72284) { return pmInfinity(false, x); }
 if (x < -103.97208) { return 0.0; }
 if (abs(x) < 2.9802322387695312e-8) { return 1.0 + x; }
 let k = pmReduceLn2(x);
 return pmScale(1.0 + pmHide(pmExpm1K(k.y)), i32(k.x));
}
`],preciseExp2:[[`pmExp`],`fn preciseExp2(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x >= 128.0) { return pmInfinity(false, x); }
 if (x < -150.0) { return 0.0; }
 let k = round(x);
 return pmScale(1.0 + pmHide(pmExpm1K((x - k) * PM_LN2)), i32(k));
}
`],preciseExpm1:[[`preciseExp`],`fn preciseExpm1(x: f32) -> f32 {
 if (pmIsNan(x)) { return x; }
 if (x > 88.72284) { return pmInfinity(false, x); }
 let a = abs(x);
 if (a < 2.9802322387695312e-8) { return x; }
 if (a <= 0.3465735) { return pmExpm1K(x); }
 if (x < -17.0) { return preciseExp(x) - 1.0; }
 let k = pmReduceLn2(x);
 if (k.x > 24.0) { return preciseExp(x) - 1.0; }
 let T = (k.y * k.y) * pmExpm1P(k.y);
 let p = ldexp(1.0, i32(k.x));
 if (k.x > 0.0) { return pmHide((p - 1.0) + pmHide(p * k.z)) + pmHide(p * (k.w + T)); }
 return pmHide(p * (k.z + (k.w + T))) + (p - 1.0);
}
`],preciseSinh:[[`preciseExpm1`,`preciseDiv`],`fn preciseSinh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 var r: f32;
 if (a <= 1.0) { let w = a * a; r = a + pmHide((a * w) * ${v(`w`,g.sinh)}); }
 else if (a > 88.72284) { let t = preciseExp(0.5 * a); r = pmHide(0.5 * t) * t; }
 else if (a > 9.0) { r = 0.5 * preciseExp(a); }
 else { let e = preciseExpm1(a); r = 0.5 * (e + preciseDiv(e, e + 1.0)); }
 return pmWithSign(r, x);
}
`],preciseCosh:[[`preciseExp`,`preciseDiv`],`fn preciseCosh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return 1.0; }
 if (a <= 1.0) { let w = a * a; return 1.0 + pmHide((w * w) * ${v(`w`,g.cosh)} + 0.5 * w); }
 if (a > 88.72284) { let t = preciseExp(0.5 * a); return pmHide(0.5 * t) * t; }
 let t = preciseExp(a);
 return 0.5 * (t + preciseDiv(1.0, t));
}
`],preciseTanh:[[`preciseExpm1`,`preciseDiv`],`fn preciseTanh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 if (a > 9.1) { return pmWithSign(1.0, x); }
 if (a <= 0.55) { let w = a * a; return pmWithSign(a + pmHide((a * w) * ${v(`w`,g.tanh)}), x); }
 let e = preciseExpm1(2.0 * a);
 return pmWithSign(preciseDiv(e, e + 2.0), x);
}
`],pmLog:[[`preciseDiv`],`struct PmLogK { s: f32, R: f32, hfsq: f32, t: f32 }
fn pmLogK(f: f32) -> PmLogK {
 let s = preciseDiv(f, 2.0 + f);
 let z = s * s;
 let R = z * ${v(`z`,g.log)};
 let hfsq = (0.5 * f) * f;
 return PmLogK(s, R, hfsq, s * (hfsq + R));
}
fn pmDecompose(x: f32) -> vec2f {
 var u = bitcast<u32>(x);
 var e = i32(u >> 23u) - 127;
 if (e == -127) { let z = countLeadingZeros(u) - 8u; u = u << z; e = -126 - i32(z); }
 var m = bitcast<f32>((u & 0x7fffffu) | 0x3f800000u);
 if (m > 1.4142135) { m = 0.5 * m; e = e + 1; }
 return vec2f(f32(e), m - 1.0);
}
fn pmLogSpecial(x: f32) -> u32 {
 if (pmIsNan(x) || (pmNegative(x) && !pmIsZero(x))) { return 1u; }
 if (pmIsZero(x)) { return 2u; }
 if (pmExponent(x) == 255u) { return 3u; }
 return 0u;
}
fn pmLogSpecialValue(kind: u32, x: f32) -> f32 {
 return select(select(x, pmInfinity(true, x), kind == 2u), pmNan(x), kind == 1u);
}
`],preciseLog:[[`pmLog`],`fn preciseLog(x: f32) -> f32 {
 let special = pmLogSpecial(x);
 if (special != 0u) { return pmLogSpecialValue(special, x); }
 let d = pmDecompose(x);
 let k = pmLogK(d.y);
 return d.x * PM_LN2_HI + pmHide(d.y - pmHide(k.hfsq - (k.t + d.x * PM_LN2_LO)));
}
`],preciseLog2:[[`pmLog`],`fn preciseLog2(x: f32) -> f32 {
 let special = pmLogSpecial(x);
 if (special != 0u) { return pmLogSpecialValue(special, x); }
 let d = pmDecompose(x);
 let k = pmLogK(d.y);
 let ah = pmHide(d.y * PM_LOG2E);
 let al = pmProductError(d.y, PM_LOG2E, ah);
 let tail = (al + d.y * PM_LOG2E_LO) - (k.hfsq - k.t) * PM_LOG2E;
 return pmHide(d.x + ah) + pmHide(tail);
}
`],preciseLog1p:[[`preciseLog`],`fn preciseLog1p(x: f32) -> f32 {
 if (pmIsNan(x) || x < -1.0) { return pmNan(x); }
 if (x == -1.0) { return pmInfinity(true, x); }
 if (pmExponent(x) == 255u) { return x; }
 let u = 1.0 + x;
 if (u == 1.0) { return x; }
 let c = select(pmFastTwoSum(x, 1.0).y, pmFastTwoSum(1.0, x).y, abs(x) <= 1.0);
 return preciseLog(u) + preciseDiv(c, u);
}
`],precisePow:[[`pmLog`,`pmExp`],`fn pmLog2Pair(x: f32) -> vec2f {
 let d = pmDecompose(x);
 let e = d.x; let f = d.y;
 let k = pmLogK(f);
 let q = pmHide(f * f);
 let hh = 0.5 * q;
 let hl = 0.5 * pmProductError(f, f, q);
 let d2 = pmFastTwoSum(2.0, f); let dh = d2.x; let dl = d2.y;
 let sd = pmHide(k.s * dh);
 let rho = pmHide(f - sd) - pmProductError(k.s, dh, sd);
 let sl = (rho - k.s * dl) / dh;
 let th = pmHide(k.s * hh);
 let z = pmHide(k.s * k.s);
 let zl = pmProductError(k.s, k.s, z) + (2.0 * k.s) * sl;
 let w = pmFastTwoSum(${_(Math.fround(2/3))}, ${_(Math.fround(2/3-Math.fround(2/3)))} + z * ${v(`z`,[2/5,2/7,2/9,2/11,2/13,2/15].map(e=>Math.fround(e)))});
 let rh = pmHide(z * w.x);
 let rl = (pmProductError(z, w.x, rh) + z * w.y) + zl * w.x;
 let uh = pmHide(k.s * rh);
 let u = pmFastTwoSum(th, uh);
 let tl = (((pmProductError(k.s, hh, th) + k.s * hl) + sl * hh) + ((pmProductError(k.s, rh, uh) + k.s * rl) + sl * rh)) + u.y;
 let ah = pmHide(f * PM_LOG2E); let al = pmProductError(f, PM_LOG2E, ah);
 let bh = pmHide(hh * PM_LOG2E); let bl = pmProductError(hh, PM_LOG2E, bh);
 let ch = pmHide(u.x * PM_LOG2E); let cl = pmProductError(u.x, PM_LOG2E, ch);
 let s1 = pmFastTwoSum(e, ah); let s2 = pmFastTwoSum(s1.x, -bh); let s3 = pmFastTwoSum(s2.x, ch);
 let small = ((f - hh) + u.x) * PM_LOG2E_LO;
 let tail = (((s1.y + s2.y) + s3.y) + ((al - bl) + cl)) + ((tl - hl) * PM_LOG2E + small);
 return pmFastTwoSum(s3.x, tail);
}
fn pmIsOdd(y: f32) -> bool { return abs(y) < 16777216.0 && floor(y) == y && (i32(y) & 1) == 1; }
fn precisePow(x: f32, y: f32) -> f32 {
 if (pmIsNan(y)) { return y; }
 if (y == 0.0) { return 1.0; }
 if (pmIsNan(x)) { return x; }
 let ax = abs(x); let ay = abs(y);
 if (pmExponent(ay) == 255u) {
  if (ax == 1.0) { return pmNan(x); }
  return select(0.0, pmInfinity(false, x), (ax > 1.0) == (y > 0.0));
 }
 let negative = pmNegative(x) && pmIsOdd(y);
 if (pmExponent(ax) == 255u) { return select(select(0.0, -0.0, negative), pmInfinity(negative, x), y > 0.0); }
 if (pmIsZero(ax)) { return select(pmInfinity(negative, x), select(0.0, -0.0, negative), y > 0.0); }
 if (pmNegative(x) && floor(y) != y) { return pmNan(x); }
 let L = pmLog2Pair(ax);
 let ph = pmHide(y * L.x);
 let pl = pmProductError(y, L.x, ph) + y * L.y;
 if (ph > 128.0 || (ph == 128.0 && pl >= 0.0)) { return pmInfinity(negative, x); }
 if (ph < -151.0) { return select(0.0, -0.0, negative); }
 let k = round(ph);
 let f = (ph - k) + pl;
 let r = pmHide(f * PM_LN2);
 let rl = pmProductError(f, PM_LN2, r) + f * PM_LN2_TAIL;
 let v = pmScale(1.0 + pmHide(pmExpm1K(r) + rl), i32(k));
 return select(v, -v, negative);
}
`]},S=Object.freeze([`preciseDiv`,`preciseSqrt`,`preciseSin`,`preciseCos`,`preciseTan`,`preciseAtan`,`preciseAtan2`,`preciseAsin`,`preciseAcos`,`preciseExp`,`preciseExp2`,`preciseExpm1`,`preciseSinh`,`preciseCosh`,`preciseTanh`,`preciseLog`,`preciseLog2`,`preciseLog1p`,`precisePow`]);function C(e){let t=[],n=new Set,r=e=>{if(n.has(e))return;let i=x()[e];if(!i)throw RangeError(`Unknown precise maths function ${e}; use one of ${S.join(`, `)}`);n.add(e);for(let e of i[0])r(e);t.push(i[1])};for(let t of e)r(t);return t.join(``)}function w(e,t){let n=Math.max(e.length,t.length),r=[];for(let a=0;a<n;a++){let o=e[e.length-n+a]??1,s=t[t.length-n+a]??1;if(o!==s&&o!==1&&s!==1)throw i(`Shapes [${e.join(`, `)}] and [${t.join(`, `)}] do not broadcast; reshape one of them`,`compute`);r.push(o===1?s:o)}return r}var T=e=>e.kind===`leaf`?e.array.shape:e.kind===`scalar`?[]:e.shape,E=new Set([`div`,`pow`,`sqrt`,`rsqrt`,`exp`,`exp2`,`log`,`log2`,`log1p`,`expm1`,`sin`,`cos`,`tan`,`asin`,`acos`,`atan`,`atan2`,`sinh`,`cosh`,`tanh`,`reciprocal`,`hypot`,`degrees`,`radians`]),D=new Set([`bitAnd`,`bitOr`,`bitXor`,`bitNot`,`shiftLeft`,`shiftRight`,`popcount`]),O=new Set([`lt`,`le`,`gt`,`ge`,`eq`,`ne`,`and`,`or`,`xor`,`not`,`isnan`,`isinf`,`isfinite`]),k=class e{get size(){return this.shape.reduce((e,t)=>e*t,1)}get ndim(){return this.shape.length}op(t,n,i){let a=(n.find(t=>t instanceof e)??this).dtype;for(let t of n)t instanceof e&&(a=f(a,t.dtype));for(let e of n)typeof e==`number`&&(a=f(a,p(e,a)));if(D.has(t)&&s(a))throw r(`${t} needs integer arrays; astype('i32') or astype('u32') first`,`compute`);let o=n.map(n=>{if(typeof n==`number`)return{kind:`scalar`,value:n,dtype:a};if(!(n instanceof e))throw r(`Operand of ${t} must be a number, a GpuArray or an Expr`,`compute`);if(n.context!==this.context)throw r(`Operand of ${t} belongs to another compute context; create it with this context`,`compute`);return n.node()}),c=o.map(T).reduce((e,t)=>w(e,t),[]),l=i??(O.has(t)?`u32`:E.has(t)&&!s(a)?`f32`:a);return new A(this.context,{kind:`op`,op:t,args:o,dtype:l,shape:c})}add(e){return this.op(`add`,[this,e])}sub(e){return this.op(`sub`,[this,e])}mul(e){return this.op(`mul`,[this,e])}div(e){return this.op(`div`,[this,e])}floorDiv(e){return this.op(`floorDiv`,[this,e])}mod(e){return this.op(`mod`,[this,e])}pow(e){return this.op(`pow`,[this,e])}minimum(e){return this.op(`minimum`,[this,e])}maximum(e){return this.op(`maximum`,[this,e])}clip(e,t){return this.op(`clip`,[this,e,t])}atan2(e){return this.op(`atan2`,[this,e])}hypot(e){return this.op(`hypot`,[this,e])}neg(){return this.op(`neg`,[this])}abs(){return this.op(`abs`,[this])}sign(){return this.op(`sign`,[this])}square(){return this.op(`square`,[this])}sqrt(){return this.op(`sqrt`,[this])}rsqrt(){return this.op(`rsqrt`,[this])}reciprocal(){return this.op(`reciprocal`,[this])}exp(){return this.op(`exp`,[this])}exp2(){return this.op(`exp2`,[this])}expm1(){return this.op(`expm1`,[this])}log(){return this.op(`log`,[this])}log2(){return this.op(`log2`,[this])}log1p(){return this.op(`log1p`,[this])}sin(){return this.op(`sin`,[this])}cos(){return this.op(`cos`,[this])}tan(){return this.op(`tan`,[this])}asin(){return this.op(`asin`,[this])}acos(){return this.op(`acos`,[this])}atan(){return this.op(`atan`,[this])}sinh(){return this.op(`sinh`,[this])}cosh(){return this.op(`cosh`,[this])}tanh(){return this.op(`tanh`,[this])}degrees(){return this.op(`degrees`,[this])}radians(){return this.op(`radians`,[this])}floor(){return this.op(`floor`,[this])}ceil(){return this.op(`ceil`,[this])}round(){return this.op(`round`,[this])}trunc(){return this.op(`trunc`,[this])}lt(e){return this.op(`lt`,[this,e])}le(e){return this.op(`le`,[this,e])}gt(e){return this.op(`gt`,[this,e])}ge(e){return this.op(`ge`,[this,e])}eq(e){return this.op(`eq`,[this,e])}ne(e){return this.op(`ne`,[this,e])}and(e){return this.op(`and`,[this,e])}or(e){return this.op(`or`,[this,e])}xor(e){return this.op(`xor`,[this,e])}not(){return this.op(`not`,[this])}isnan(){return this.op(`isnan`,[this])}isinf(){return this.op(`isinf`,[this])}isfinite(){return this.op(`isfinite`,[this])}bitAnd(e){return this.op(`bitAnd`,[this,e])}bitOr(e){return this.op(`bitOr`,[this,e])}bitXor(e){return this.op(`bitXor`,[this,e])}bitNot(){return this.op(`bitNot`,[this])}shiftLeft(e){return this.op(`shiftLeft`,[this,e])}shiftRight(e){return this.op(`shiftRight`,[this,e])}popcount(){return this.op(`popcount`,[this])}bitcast(e){if(this.dtype===`f16`)throw r(`bitcast needs a 32-bit type; astype f16 to f32 first`,`compute`);return this.op(`bitcast`,[this],e)}astype(e){return this.op(`astype`,[this],e)}eval(){return this.context.evaluate(this)}async read(e){let t=this.eval();try{return await t.read(e)}finally{t.dispose()}}async item(e){if(this.size!==1)throw i(`item() needs exactly one element, the shape is [${this.shape.join(`, `)}]; reduce it first`,`compute`);return(await this.read(e))[0]}sum(e){return this.context.sum(this,e)}prod(e){return this.context.prod(this,e)}min(e){return this.context.min(this,e)}max(e){return this.context.max(this,e)}mean(e){return this.context.mean(this,e)}var(e){return this.context.var(this,e)}std(e){return this.context.std(this,e)}argmin(e){return this.context.argmin(this,e)}argmax(e){return this.context.argmax(this,e)}all(e){return this.context.all(this,e)}any(e){return this.context.any(this,e)}},A=class extends k{#e;constructor(e,t){super(),this.context=e,this.#e=t}get dtype(){return this.#e.dtype}get shape(){return this.#e.shape}node(){return this.#e}},j=`xyzw`,M=e=>{let t=Array(e.length),n=1;for(let r=e.length-1;r>=0;r--)t[r]=n,n*=e[r];return t},N={pow:`precisePow`,atan2:`preciseAtan2`,sqrt:`preciseSqrt`,exp:`preciseExp`,exp2:`preciseExp2`,expm1:`preciseExpm1`,log:`preciseLog`,log2:`preciseLog2`,log1p:`preciseLog1p`,sin:`preciseSin`,cos:`preciseCos`,tan:`preciseTan`,asin:`preciseAsin`,acos:`preciseAcos`,atan:`preciseAtan`,sinh:`preciseSinh`,cosh:`preciseCosh`,tanh:`preciseTanh`};function P(e,t,n,i,a){let[o,c,l]=t,u=`${n}(0)`,d=e=>`select(0u, 1u, ${e})`,f=e=>s(n)?e:`f32(${e})`,p=a&&N[e];if(p){a.add(p);let r=e=>n===`f32`?e:`f32(${e})`,o=`${p}(${t.slice(0,e===`pow`||e===`atan2`?2:1).map(e=>`operandF32(${r(e)})`).join(`, `)})`;return i===`f32`?o:`${i}(${o})`}switch(e){case`add`:return`(${o} + ${c})`;case`sub`:return`(${o} - ${c})`;case`mul`:return`(${o} * ${c})`;case`div`:return`(${f(o)} / ${f(c)})`;case`floorDiv`:return s(n)?`floor(${o} / ${c})`:n===`u32`?`select(0u, ${o} / ${c}, ${c} != 0u)`:`select(0i, (${o} / ${c}) - select(0i, 1i, (${o} % ${c} != 0i) && ((${o} < 0i) != (${c} < 0i))), ${c} != 0i)`;case`mod`:return s(n)?`(${o} - ${c} * floor(${o} / ${c}))`:n===`u32`?`select(0u, ${o} % ${c}, ${c} != 0u)`:`select(0i, ((${o} % ${c}) + ${c}) % ${c}, ${c} != 0i)`;case`pow`:return`pow(${f(o)}, ${f(c)})`;case`minimum`:return`min(${o}, ${c})`;case`maximum`:return`max(${o}, ${c})`;case`clip`:return`clamp(${o}, ${c}, ${l})`;case`atan2`:return`atan2(${f(o)}, ${f(c)})`;case`hypot`:return`length(vec2(${f(o)}, ${f(c)}))`;case`neg`:return n===`u32`?`(0u - ${o})`:`(-${o})`;case`abs`:return`abs(${o})`;case`sign`:return n===`u32`?`select(0u, 1u, ${o} > 0u)`:`sign(${o})`;case`square`:return`(${o} * ${o})`;case`sqrt`:case`exp`:case`exp2`:case`log`:case`log2`:case`sin`:case`cos`:case`tan`:case`asin`:case`acos`:case`atan`:case`sinh`:case`cosh`:case`tanh`:case`degrees`:case`radians`:return`${e}(${f(o)})`;case`rsqrt`:return`inverseSqrt(${f(o)})`;case`reciprocal`:return`(1.0 / ${f(o)})`;case`log1p`:{let e=f(o),t=`(1.0 + ${e})`,n=`bitcast<u32>(${t})`,r=`(ldexp(f32(i32((${n} & 0x7fffffu) | 0x800000u)), i32((${n} >> 23u) & 0xffu) - 150i) - 1.0)`;return`select(${e} * log(${t}) / ${r}, ${e}, ${r} == 0.0)`}case`expm1`:{let e=f(o),t=`exp(${e})`;return`select(select(select((${t} - 1.0) * ${e} / log(${t}), ${e}, ${t} == 1.0), -1.0, ${e} < -80.0), ${t}, ${e} > 80.0)`}case`floor`:case`ceil`:case`round`:case`trunc`:return s(n)?`${e}(${o})`:o;case`lt`:return d(`${o} < ${c}`);case`le`:return d(`${o} <= ${c}`);case`gt`:return d(`${o} > ${c}`);case`ge`:return d(`${o} >= ${c}`);case`eq`:return d(`${o} == ${c}`);case`ne`:return d(`${o} != ${c}`);case`and`:return d(`(${o} != ${u}) && (${c} != ${u})`);case`or`:return d(`(${o} != ${u}) || (${c} != ${u})`);case`xor`:return d(`(${o} != ${u}) != (${c} != ${u})`);case`not`:return d(`${o} == ${u}`);case`isnan`:case`isinf`:case`isfinite`:{if(!s(n))return e===`isfinite`?`1u`:`0u`;let t=n===`f16`?`(bitcast<u32>(f32(${o})) & 0x7fffffffu)`:`(bitcast<u32>(${o}) & 0x7fffffffu)`;return d(e===`isnan`?`${t} > 0x7f800000u`:e===`isinf`?`${t} == 0x7f800000u`:`${t} < 0x7f800000u`)}case`bitAnd`:case`bitOr`:case`bitXor`:case`bitNot`:case`shiftLeft`:case`shiftRight`:case`popcount`:if(s(n))throw r(`${e} needs integer arrays; astype('i32') or astype('u32') first`,`compute`);return e===`bitAnd`?`(${o} & ${c})`:e===`bitOr`?`(${o} | ${c})`:e===`bitXor`?`(${o} ^ ${c})`:e===`bitNot`?`(~${o})`:e===`shiftLeft`?`(${o} << (u32(${c}) & 31u))`:e===`shiftRight`?`(${o} >> (u32(${c}) & 31u))`:`${n}(countOneBits(${o}))`;case`bitcast`:return`bitcast<${i}>(${o})`;case`astype`:return`${i}(${o})`;case`where`:return`select(${l}, ${c}, ${o} != ${u})`;default:throw r(`Unknown element-wise operation ${e}`,`compute`)}}function F(e,t,n,r){let a=e.node(),o=e.shape,s=(e,t=new Set)=>{if(e.kind===`leaf`)t.add(e.array.storage);else if(e.kind===`op`)for(let n of e.args)s(n,t);return t},c=t=>{if(t.kind!==`op`||s(t).size<=n)return t;let a=t.args.map(c),o={...t,args:a};for(;s(o).size>n;){let t=o.args.map((e,t)=>[t,e.kind===`op`?s(e).size:0]).sort((e,t)=>t[1]-e[1])[0];if(!t||t[1]===0)throw i(`Expression reads more than ${n} buffers in one operation; evaluate parts of it first`,`compute`);let a=o.args[t[0]],c=e.context.evaluate(new A(e.context,a));r.push(c);let l=[...o.args];l[t[0]]={kind:`leaf`,array:c},o={...o,args:l}}return o};a=c(a);let l=new Map,u={},d=[],p=[],g=new Map,_=``,v=t,y=!1,b=e.context.fastMath?void 0:new Set,x=M(o),S=(e,t,n)=>t===n?e:`${n}(${e})`,w=t=>{let n=g.get(t);if(n!==void 0)return n;let r;if(t.kind===`leaf`){let n=t.array,i=l.get(n.storage);i||(i=`src${l.size}`,l.set(n.storage,i),_+=`@group(0) @binding(${v++}) var<storage, read> ${i}: array<${n.dtype}>;
`,n.check(e.context),u[i]={buffer:n.storage.buffer});let a=o.length,s=n.contiguous&&n.shape.length===a&&n.shape.every((e,t)=>e===o[t]),c;if(s)c=n.offset?`(i + ${n.offset}u)`:`i`;else{let e=n.strides.some(e=>e<0),t=e?`i`:`u`,r=n.offset?[`${n.offset}${t}`]:[];for(let i=0;i<n.shape.length;i++){let s=a-n.shape.length+i;if(n.shape[i]===1||n.strides[i]===0)continue;let c=s===0?`(i / ${x[0]}u)`:`((i / ${x[s]}u) % ${o[s]}u)`;e&&(c=`i32${c}`),r.push(n.strides[i]===1?c:`${c} * ${n.strides[i]}${t}`)}c=r.length?e?`u32(${r.join(` + `)})`:r.join(` + `):`0u`}r=`${i}[${c}]`}else if(t.kind===`scalar`){let e=d.length;d.push(m(t.value,t.dtype)),r=h(`fused[${e>>2}].${j[e&3]}`,t.dtype)}else if(t.kind===`index`)r=`i`;else if(t.op===`where`){let[e,n,i]=t.args;r=`select(${S(w(i),I(i),t.dtype)}, ${S(w(n),I(n),t.dtype)}, ${w(e)} != ${I(e)}(0))`}else{let e=t.args.map(I).reduce(f);r=P(t.op,t.args.map(t=>S(w(t),I(t),e)),e,t.dtype,b)}let i=I(t);i===`f16`&&(y=!0);let a=`v${g.size}`;return p.push(`let ${a}: ${i} = ${r};`),g.set(t,a),a},T=w(a),E=Math.max(1,Math.ceil(d.length/4)),D=new Uint32Array(E*4);D.set(d),_+=`@group(0) @binding(${v++}) var<uniform> fused: array<vec4u, ${E}>;\n`,u.fused=D;let O=`${b?.size?`${C([...b])}
fn operandF32(v: f32) -> f32 {
  if ((bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u) { return v; }
  return pmHide(v);
}
`:``}fn value(i: u32) -> ${e.dtype} {\n  ${p.join(`
  `)}\n  return ${T};\n}`;return{enables:y?`enable f16;
`:``,declarations:_,fn:O,resources:u,next:v,dtype:e.dtype,shape:o,key:`${_}\n${O}`}}var I=e=>e.kind===`leaf`?e.array.dtype:e.dtype;function L(e,t,n){if(!(e instanceof k))throw r(`where needs a condition array or expression`,`compute`);let i=(e,t)=>typeof e==`number`?p(e,t instanceof k?t.dtype:`f32`):e.dtype,a=f(i(t,n),i(n,t));return e.op(`where`,[e,t,n],a)}function R(e){let t=Array(e.length),n=1;for(let r=e.length-1;r>=0;r--)t[r]=n,n*=e[r];return t}function z(e,t=`Shape`){if(!Array.isArray(e)||e.some(e=>!Number.isInteger(e)||e<0))throw i(`${t} must be whole numbers of at least 0, got [${String(e)}]`,`compute`);return[...e]}function B(e,t){if(!Number.isInteger(e)||e<-t||e>=Math.max(t,1))throw i(`Axis ${e} is out of range for ${t} dimensions`,`compute`);return e<0?e+t:e}var V=class e extends k{#e=!1;#t;constructor(e,t,n,r,a=0){if(super(),this.context=e,this.dtype=t,this.shape=Object.freeze(z(n)),r){this.storage=r.storage,this.strides=Object.freeze([...r.strides]),this.offset=r.offset,this.#t=!!r.owner;return}let s=this.size,c=s*o(t),l=e.device.limits.maxStorageBufferBindingSize;if(c>l)throw i(`GpuArray of ${s} ${t} elements needs ${c} bytes, over this device's ${l}-byte storage binding limit; split the data or stream it`,`compute`);this.storage={buffer:e.allocate(Math.max(16,Math.ceil(c/16)*16),a,t),dtype:t,disposed:!1},this.strides=Object.freeze(R(this.shape)),this.offset=0,this.#t=!0}get buffer(){return this.storage.buffer}get byteLength(){return this.size*o(this.dtype)}get contiguous(){let e=R(this.shape);return this.shape.every((t,n)=>t===1||this.strides[n]===e[n])}get disposed(){return this.#e||this.storage.disposed}get owner(){return this.#t}node(){return{kind:`leaf`,array:this}}check(e){if(this.disposed)throw n(`disposed`,`GpuArray disposed; create a new array with gpu.array()`,`compute`);if(e!==this.context)throw n(`state`,`GpuArray belongs to another compute context; create it with this context`,`compute`)}#n(t,n,r){return this.check(this.context),new e(this.context,this.dtype,t,{storage:this.storage,strides:n,offset:r})}reshape(...e){let t=e.length===1&&Array.isArray(e[0])?e[0]:e,n=t.filter(e=>e!==-1).reduce((e,t)=>e*t,1);if(t.filter(e=>e===-1).length>1)throw i(`reshape takes at most one -1 dimension`,`compute`);let r=t.map(e=>e===-1?n?this.size/n:0:e);if(z(r),r.reduce((e,t)=>e*t,1)!==this.size)throw i(`Cannot reshape ${this.size} elements [${this.shape.join(`, `)}] into [${t.join(`, `)}]`,`compute`);let a=this.contiguous?this:this.eval();return a.#n(r,R(r),a.offset)}flatten(){return this.reshape(this.size)}transpose(...e){let t=e.length?e.map(e=>B(e,this.ndim)):this.shape.map((e,t)=>this.ndim-1-t);if(t.length!==this.ndim||new Set(t).size!==this.ndim)throw i(`transpose needs a permutation of ${this.ndim} axes, got [${e.join(`, `)}]`,`compute`);return this.#n(t.map(e=>this.shape[e]),t.map(e=>this.strides[e]),this.offset)}get T(){return this.transpose()}slice(...e){if(e.length>this.ndim)throw i(`slice got ${e.length} specs for ${this.ndim} dimensions`,`compute`);let t=this.offset,n=[],r=[];return this.shape.forEach((a,o)=>{let s=e[o]??null;if(typeof s==`number`){let e=s<0?s+a:s;if(!Number.isInteger(s)||e<0||e>=a)throw i(`Index ${s} is out of range for dimension ${o} of length ${a}`,`compute`);t+=e*this.strides[o];return}let[c,l,u]=s??[],d=u??1;if(!Number.isInteger(d)||d===0)throw i(`Slice step must be a non-zero integer, got ${d}`,`compute`);let f=(e,t)=>{if(e==null)return t;let n=e<0?e+a:e;return d>0?Math.min(Math.max(n,0),a):Math.min(Math.max(n,-1),a-1)},p=f(c,d>0?0:a-1),m=f(l,d>0?a:-1),h=Math.max(0,Math.ceil((m-p)/d));h&&(t+=p*this.strides[o]),n.push(h),r.push(this.strides[o]*d)}),this.#n(n,r,t)}expandDims(e){let t=e<0?e+this.ndim+1:e;if(!Number.isInteger(t)||t<0||t>this.ndim)throw i(`expandDims axis ${e} is out of range`,`compute`);let n=[...this.shape],r=[...this.strides];return n.splice(t,0,1),r.splice(t,0,0),this.#n(n,r,this.offset)}squeeze(e){let t=e===void 0?this.shape.map(e=>e===1):this.shape.map((t,n)=>n===B(e,this.ndim));if(e!==void 0&&this.shape[B(e,this.ndim)]!==1)throw i(`squeeze axis ${e} has length ${this.shape[B(e,this.ndim)]}, not 1`,`compute`);return this.#n(this.shape.filter((e,n)=>!t[n]),this.strides.filter((e,n)=>!t[n]),this.offset)}broadcastTo(e){z(e);let t=e.length;if(t<this.ndim)throw i(`Cannot broadcast [${this.shape.join(`, `)}] to fewer dimensions`,`compute`);let n=e.map((n,r)=>{let a=r-(t-this.ndim);if(a<0)return 0;if(this.shape[a]===n)return this.strides[a];if(this.shape[a]===1)return 0;throw i(`Cannot broadcast [${this.shape.join(`, `)}] to [${e.join(`, `)}]`,`compute`)});return this.#n(e,n,this.offset)}ascontiguous(){return this.check(this.context),this.contiguous&&this.offset===0?this:this.eval()}transfer(t){if(!this.#t||!this.contiguous||this.offset)throw n(`state`,`Only a contiguous owning array can transfer its buffer`,`compute`);if(z(t).reduce((e,t)=>e*t,1)!==this.size)throw i(`Cannot give ${this.size} elements the shape [${t.join(`, `)}]`,`compute`);let r=new e(this.context,this.dtype,t,{storage:this.storage,strides:R(t),offset:0,owner:!0});return this.#t=!1,this.#e=!0,this.context.forget(this),this.context.track(r),r}write(e,t=0){if(this.check(this.context),!this.contiguous)throw r(`write needs a contiguous array; write to the array the view came from`,`compute`);if(!Number.isInteger(t)||t<0||t+e.length>this.size)throw i(`GpuArray write of ${e.length} elements at ${t} does not fit ${this.size} elements`,`compute`);if(!e.length)return this;let n=d(e,this.dtype),a=o(this.dtype),s=(this.offset+t)*a;return s%4||n.byteLength%4?this.context.writeUnaligned(this.storage.buffer,s,new Uint8Array(n.buffer,n.byteOffset,n.byteLength)):this.context.device.queue.writeBuffer(this.storage.buffer,s,n),this}async read(e={}){if(this.check(this.context),!this.contiguous)return await super.read(e);let t=e.offset??0,n=e.length??this.size-t;if(!Number.isInteger(t)||!Number.isInteger(n)||t<0||n<0||t+n>this.size)throw i(`GpuArray read of ${n} elements at ${t} is outside ${this.size} elements`,`compute`);let r=o(this.dtype),a=await this.context.readBytes(this.storage.buffer,(this.offset+t)*r,n*r,e.signal);return new(l(this.dtype))(a)}dispose(){this.#e||(this.#e=!0,this.#t&&(this.storage.disposed=!0,this.storage.buffer.destroy(),this.context.forget(this)))}[Symbol.dispose](){this.dispose()}};export{n as _,k as a,m as c,f as d,a as f,i as g,w as h,A as i,h as l,u as m,B as n,F as o,o as p,V as r,L as s,z as t,s as u,r as v};