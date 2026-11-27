(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),t=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,n=(n,r,i=n)=>e(n,t(r,i)),r=(e,n)=>TypeError(t(e,n)),i=(e,n)=>RangeError(t(e,n)),a=[`f32`,`f16`,`i32`,`u32`],o=e=>e===`f16`?2:4,s=e=>e===`f32`||e===`f16`,c=globalThis.Float16Array;function l(e){switch(e){case`f32`:return Float32Array;case`i32`:return Int32Array;case`u32`:return Uint32Array;case`f16`:if(!c)throw r(`f16 data needs Float16Array; read it as f32 with astype("f32")`,`compute`);return c}}function u(e){if(c&&e instanceof c)return`f16`;if(e instanceof Float32Array||e instanceof Float64Array)return`f32`;if(e instanceof Int32Array||e instanceof Int16Array||e instanceof Int8Array)return`i32`;if(e instanceof Uint32Array||e instanceof Uint16Array||e instanceof Uint8Array||e instanceof Uint8ClampedArray)return`u32`;if(ArrayBuffer.isView(e))throw r(`Compute arrays take number TypedArrays, not BigInt arrays or DataView`,`compute`);return`f32`}function d(e,t){let n=l(t);return e instanceof n&&e.buffer instanceof ArrayBuffer?e:n.from(e)}function f(e,t){return e===t?e:e===`f32`||t===`f32`?`f32`:e===`f16`||t===`f16`?`f16`:`i32`}function p(e,t){return s(t)?t:Number.isInteger(e)?t===`u32`&&e<0?`i32`:t:`f32`}function m(e,t){let n=new DataView(new ArrayBuffer(4));return t===`f32`||t===`f16`?n.setFloat32(0,e,!0):t===`i32`?n.setInt32(0,e,!0):n.setUint32(0,e>>>0,!0),n.getUint32(0,!0)}function h(e,t){return t===`u32`?e:t===`f16`?`f16(bitcast<f32>(${e}))`:`bitcast<${t}>(${e})`}var g=Object.freeze({twoOverPi:[0,2734261102,1313084713,4230436817,4113882560,3680671129,1011060801,4266746795],halfPiFixed:3373259426,halfPi:[1.5707963705062866,-4.371138828673793e-8],quarterPi:[.7853981852531433,-2.1855694143368964e-8],pi:[3.1415927410125732,-8.742277657347586e-8],ln2:[.693145751953125,1428606765330187e-21],ln2Pair:[.6931471824645996,-1.9046542121259336e-9],log2e:[1.4426950216293335,1.925963033500011e-8],sin:[-.1666666716337204,.008333379402756691,-.00019853089179378003,2833021881087916e-21],cos:[.0416666679084301,-.0013888980029150844,2482202216924634e-20,-2.8881245839329495e-7],atan:[-.3333333432674408,.20000059902668,-.14286741614341736,.11114691942930222,-.09025663882493973,.06947030127048492,-.03550770878791809],asin:[.1666666716337204,.07499949634075165,.044659871608018875,.03011295571923256,.024605773389339447,.007497195154428482,.03466988354921341],sinh:[.1666666716337204,.00833326205611229,.00019874409190379083,20846018742304295e-22,6.411173671949655e-7,-2.0997923400045693e-7],cosh:[.0416666679084301,.0013888796092942357,2482521813362837e-20,2.506288865333772e-7,1.1460320692435744e-8],tanh:[-.3333333432674408,.1333339512348175,-.05398104339838028,.021990614011883736,-.009435489773750305,.004868379328399897,-.0023415694013237953],expm1:[.5,.1666666567325592,.04166649281978607,.008333546109497547,.0013932319125160575,.00019761594012379646],log:[.6666666269302368,.40000975131988525,.28498485684394836,.24286234378814697]}),_=e=>{let t=String(e);for(let n=1;n<=9;n++){let r=e.toPrecision(n);if(Math.fround(Number(r))===e){t=r;break}}return/[.e]/.test(t)?t:`${t}.0`},v=(e,t)=>{let n=_(t[t.length-1]);for(let r=t.length-2;r>=0;r--)n=`(${e} * ${n} + ${_(t[r])})`;return n},y=e=>`0x${e.toString(16)}u`,b,x=()=>b??={pmBits:[[],`fn pmExponent(x: f32) -> u32 { return (bitcast<u32>(x) >> 23u) & 0xffu; }
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
`]},S=Object.freeze([`preciseDiv`,`preciseSqrt`,`preciseSin`,`preciseCos`,`preciseTan`,`preciseAtan`,`preciseAtan2`,`preciseAsin`,`preciseAcos`,`preciseExp`,`preciseExp2`,`preciseExpm1`,`preciseSinh`,`preciseCosh`,`preciseTanh`,`preciseLog`,`preciseLog2`,`preciseLog1p`,`precisePow`]);function C(e){let t=[],n=new Set,r=e=>{if(n.has(e))return;let i=x()[e];if(!i)throw RangeError(`Unknown precise maths function ${e}; use one of ${S.join(`, `)}`);n.add(e);for(let e of i[0])r(e);t.push(i[1])};for(let t of e)r(t);return t.join(``)}function w(e,t){let n=Math.max(e.length,t.length),r=[];for(let a=0;a<n;a++){let o=e[e.length-n+a]??1,s=t[t.length-n+a]??1;if(o!==s&&o!==1&&s!==1)throw i(`Shapes [${e.join(`, `)}] and [${t.join(`, `)}] do not broadcast; reshape one of them`,`compute`);r.push(o===1?s:o)}return r}var ee=e=>e.kind===`leaf`?e.array.shape:e.kind===`scalar`?[]:e.shape,T=new Set([`div`,`pow`,`sqrt`,`rsqrt`,`exp`,`exp2`,`log`,`log2`,`log1p`,`expm1`,`sin`,`cos`,`tan`,`asin`,`acos`,`atan`,`atan2`,`sinh`,`cosh`,`tanh`,`reciprocal`,`hypot`,`degrees`,`radians`]),E=new Set([`bitAnd`,`bitOr`,`bitXor`,`bitNot`,`shiftLeft`,`shiftRight`,`popcount`]),D=new Set([`lt`,`le`,`gt`,`ge`,`eq`,`ne`,`and`,`or`,`xor`,`not`,`isnan`,`isinf`,`isfinite`]),O=class e{get size(){return this.shape.reduce((e,t)=>e*t,1)}get ndim(){return this.shape.length}op(t,n,i){let a=(n.find(t=>t instanceof e)??this).dtype;for(let t of n)t instanceof e&&(a=f(a,t.dtype));for(let e of n)typeof e==`number`&&(a=f(a,p(e,a)));if(E.has(t)&&s(a))throw r(`${t} needs integer arrays; astype('i32') or astype('u32') first`,`compute`);let o=n.map(n=>{if(typeof n==`number`)return{kind:`scalar`,value:n,dtype:a};if(!(n instanceof e))throw r(`Operand of ${t} must be a number, a GpuArray or an Expr`,`compute`);if(n.context!==this.context)throw r(`Operand of ${t} belongs to another compute context; create it with this context`,`compute`);return n.node()}),c=o.map(ee).reduce((e,t)=>w(e,t),[]),l=i??(D.has(t)?`u32`:T.has(t)&&!s(a)?`f32`:a);return new k(this.context,{kind:`op`,op:t,args:o,dtype:l,shape:c})}add(e){return this.op(`add`,[this,e])}sub(e){return this.op(`sub`,[this,e])}mul(e){return this.op(`mul`,[this,e])}div(e){return this.op(`div`,[this,e])}floorDiv(e){return this.op(`floorDiv`,[this,e])}mod(e){return this.op(`mod`,[this,e])}pow(e){return this.op(`pow`,[this,e])}minimum(e){return this.op(`minimum`,[this,e])}maximum(e){return this.op(`maximum`,[this,e])}clip(e,t){return this.op(`clip`,[this,e,t])}atan2(e){return this.op(`atan2`,[this,e])}hypot(e){return this.op(`hypot`,[this,e])}neg(){return this.op(`neg`,[this])}abs(){return this.op(`abs`,[this])}sign(){return this.op(`sign`,[this])}square(){return this.op(`square`,[this])}sqrt(){return this.op(`sqrt`,[this])}rsqrt(){return this.op(`rsqrt`,[this])}reciprocal(){return this.op(`reciprocal`,[this])}exp(){return this.op(`exp`,[this])}exp2(){return this.op(`exp2`,[this])}expm1(){return this.op(`expm1`,[this])}log(){return this.op(`log`,[this])}log2(){return this.op(`log2`,[this])}log1p(){return this.op(`log1p`,[this])}sin(){return this.op(`sin`,[this])}cos(){return this.op(`cos`,[this])}tan(){return this.op(`tan`,[this])}asin(){return this.op(`asin`,[this])}acos(){return this.op(`acos`,[this])}atan(){return this.op(`atan`,[this])}sinh(){return this.op(`sinh`,[this])}cosh(){return this.op(`cosh`,[this])}tanh(){return this.op(`tanh`,[this])}degrees(){return this.op(`degrees`,[this])}radians(){return this.op(`radians`,[this])}floor(){return this.op(`floor`,[this])}ceil(){return this.op(`ceil`,[this])}round(){return this.op(`round`,[this])}trunc(){return this.op(`trunc`,[this])}lt(e){return this.op(`lt`,[this,e])}le(e){return this.op(`le`,[this,e])}gt(e){return this.op(`gt`,[this,e])}ge(e){return this.op(`ge`,[this,e])}eq(e){return this.op(`eq`,[this,e])}ne(e){return this.op(`ne`,[this,e])}and(e){return this.op(`and`,[this,e])}or(e){return this.op(`or`,[this,e])}xor(e){return this.op(`xor`,[this,e])}not(){return this.op(`not`,[this])}isnan(){return this.op(`isnan`,[this])}isinf(){return this.op(`isinf`,[this])}isfinite(){return this.op(`isfinite`,[this])}bitAnd(e){return this.op(`bitAnd`,[this,e])}bitOr(e){return this.op(`bitOr`,[this,e])}bitXor(e){return this.op(`bitXor`,[this,e])}bitNot(){return this.op(`bitNot`,[this])}shiftLeft(e){return this.op(`shiftLeft`,[this,e])}shiftRight(e){return this.op(`shiftRight`,[this,e])}popcount(){return this.op(`popcount`,[this])}bitcast(e){if(this.dtype===`f16`)throw r(`bitcast needs a 32-bit type; astype f16 to f32 first`,`compute`);return this.op(`bitcast`,[this],e)}astype(e){return this.op(`astype`,[this],e)}eval(){return this.context.evaluate(this)}async read(e){let t=this.eval();try{return await t.read(e)}finally{t.dispose()}}async item(e){if(this.size!==1)throw i(`item() needs exactly one element, the shape is [${this.shape.join(`, `)}]; reduce it first`,`compute`);return(await this.read(e))[0]}sum(e){return this.context.sum(this,e)}prod(e){return this.context.prod(this,e)}min(e){return this.context.min(this,e)}max(e){return this.context.max(this,e)}mean(e){return this.context.mean(this,e)}var(e){return this.context.var(this,e)}std(e){return this.context.std(this,e)}argmin(e){return this.context.argmin(this,e)}argmax(e){return this.context.argmax(this,e)}all(e){return this.context.all(this,e)}any(e){return this.context.any(this,e)}},k=class extends O{#e;constructor(e,t){super(),this.context=e,this.#e=t}get dtype(){return this.#e.dtype}get shape(){return this.#e.shape}node(){return this.#e}},te=`xyzw`,ne=e=>{let t=Array(e.length),n=1;for(let r=e.length-1;r>=0;r--)t[r]=n,n*=e[r];return t},re={pow:`precisePow`,atan2:`preciseAtan2`,sqrt:`preciseSqrt`,exp:`preciseExp`,exp2:`preciseExp2`,expm1:`preciseExpm1`,log:`preciseLog`,log2:`preciseLog2`,log1p:`preciseLog1p`,sin:`preciseSin`,cos:`preciseCos`,tan:`preciseTan`,asin:`preciseAsin`,acos:`preciseAcos`,atan:`preciseAtan`,sinh:`preciseSinh`,cosh:`preciseCosh`,tanh:`preciseTanh`};function ie(e,t,n,i,a){let[o,c,l]=t,u=`${n}(0)`,d=e=>`select(0u, 1u, ${e})`,f=e=>s(n)?e:`f32(${e})`,p=a&&re[e];if(p){a.add(p);let r=e=>n===`f32`?e:`f32(${e})`,o=`${p}(${t.slice(0,e===`pow`||e===`atan2`?2:1).map(e=>`operandF32(${r(e)})`).join(`, `)})`;return i===`f32`?o:`${i}(${o})`}switch(e){case`add`:return`(${o} + ${c})`;case`sub`:return`(${o} - ${c})`;case`mul`:return`(${o} * ${c})`;case`div`:return`(${f(o)} / ${f(c)})`;case`floorDiv`:return s(n)?`floor(${o} / ${c})`:n===`u32`?`select(0u, ${o} / ${c}, ${c} != 0u)`:`select(0i, (${o} / ${c}) - select(0i, 1i, (${o} % ${c} != 0i) && ((${o} < 0i) != (${c} < 0i))), ${c} != 0i)`;case`mod`:return s(n)?`(${o} - ${c} * floor(${o} / ${c}))`:n===`u32`?`select(0u, ${o} % ${c}, ${c} != 0u)`:`select(0i, ((${o} % ${c}) + ${c}) % ${c}, ${c} != 0i)`;case`pow`:return`pow(${f(o)}, ${f(c)})`;case`minimum`:return`min(${o}, ${c})`;case`maximum`:return`max(${o}, ${c})`;case`clip`:return`clamp(${o}, ${c}, ${l})`;case`atan2`:return`atan2(${f(o)}, ${f(c)})`;case`hypot`:return`length(vec2(${f(o)}, ${f(c)}))`;case`neg`:return n===`u32`?`(0u - ${o})`:`(-${o})`;case`abs`:return`abs(${o})`;case`sign`:return n===`u32`?`select(0u, 1u, ${o} > 0u)`:`sign(${o})`;case`square`:return`(${o} * ${o})`;case`sqrt`:case`exp`:case`exp2`:case`log`:case`log2`:case`sin`:case`cos`:case`tan`:case`asin`:case`acos`:case`atan`:case`sinh`:case`cosh`:case`tanh`:case`degrees`:case`radians`:return`${e}(${f(o)})`;case`rsqrt`:return`inverseSqrt(${f(o)})`;case`reciprocal`:return`(1.0 / ${f(o)})`;case`log1p`:{let e=f(o),t=`(1.0 + ${e})`,n=`bitcast<u32>(${t})`,r=`(ldexp(f32(i32((${n} & 0x7fffffu) | 0x800000u)), i32((${n} >> 23u) & 0xffu) - 150i) - 1.0)`;return`select(${e} * log(${t}) / ${r}, ${e}, ${r} == 0.0)`}case`expm1`:{let e=f(o),t=`exp(${e})`;return`select(select(select((${t} - 1.0) * ${e} / log(${t}), ${e}, ${t} == 1.0), -1.0, ${e} < -80.0), ${t}, ${e} > 80.0)`}case`floor`:case`ceil`:case`round`:case`trunc`:return s(n)?`${e}(${o})`:o;case`lt`:return d(`${o} < ${c}`);case`le`:return d(`${o} <= ${c}`);case`gt`:return d(`${o} > ${c}`);case`ge`:return d(`${o} >= ${c}`);case`eq`:return d(`${o} == ${c}`);case`ne`:return d(`${o} != ${c}`);case`and`:return d(`(${o} != ${u}) && (${c} != ${u})`);case`or`:return d(`(${o} != ${u}) || (${c} != ${u})`);case`xor`:return d(`(${o} != ${u}) != (${c} != ${u})`);case`not`:return d(`${o} == ${u}`);case`isnan`:case`isinf`:case`isfinite`:{if(!s(n))return e===`isfinite`?`1u`:`0u`;let t=n===`f16`?`(bitcast<u32>(f32(${o})) & 0x7fffffffu)`:`(bitcast<u32>(${o}) & 0x7fffffffu)`;return d(e===`isnan`?`${t} > 0x7f800000u`:e===`isinf`?`${t} == 0x7f800000u`:`${t} < 0x7f800000u`)}case`bitAnd`:case`bitOr`:case`bitXor`:case`bitNot`:case`shiftLeft`:case`shiftRight`:case`popcount`:if(s(n))throw r(`${e} needs integer arrays; astype('i32') or astype('u32') first`,`compute`);return e===`bitAnd`?`(${o} & ${c})`:e===`bitOr`?`(${o} | ${c})`:e===`bitXor`?`(${o} ^ ${c})`:e===`bitNot`?`(~${o})`:e===`shiftLeft`?`(${o} << (u32(${c}) & 31u))`:e===`shiftRight`?`(${o} >> (u32(${c}) & 31u))`:`${n}(countOneBits(${o}))`;case`bitcast`:return`bitcast<${i}>(${o})`;case`astype`:return`${i}(${o})`;case`where`:return`select(${l}, ${c}, ${o} != ${u})`;default:throw r(`Unknown element-wise operation ${e}`,`compute`)}}function A(e,t,n,r){let a=e.node(),o=e.shape,s=(e,t=new Set)=>{if(e.kind===`leaf`)t.add(e.array.storage);else if(e.kind===`op`)for(let n of e.args)s(n,t);return t},c=t=>{if(t.kind!==`op`||s(t).size<=n)return t;let a=t.args.map(c),o={...t,args:a};for(;s(o).size>n;){let t=o.args.map((e,t)=>[t,e.kind===`op`?s(e).size:0]).sort((e,t)=>t[1]-e[1])[0];if(!t||t[1]===0)throw i(`Expression reads more than ${n} buffers in one operation; evaluate parts of it first`,`compute`);let a=o.args[t[0]],c=e.context.evaluate(new k(e.context,a));r.push(c);let l=[...o.args];l[t[0]]={kind:`leaf`,array:c},o={...o,args:l}}return o};a=c(a);let l=new Map,u={},d=[],p=[],g=new Map,_=``,v=t,y=!1,b=e.context.fastMath?void 0:new Set,x=ne(o),S=(e,t,n)=>t===n?e:`${n}(${e})`,w=t=>{let n=g.get(t);if(n!==void 0)return n;let r;if(t.kind===`leaf`){let n=t.array,i=l.get(n.storage);i||(i=`src${l.size}`,l.set(n.storage,i),_+=`@group(0) @binding(${v++}) var<storage, read> ${i}: array<${n.dtype}>;
`,n.check(e.context),u[i]={buffer:n.storage.buffer});let a=o.length,s=n.contiguous&&n.shape.length===a&&n.shape.every((e,t)=>e===o[t]),c;if(s)c=n.offset?`(i + ${n.offset}u)`:`i`;else{let e=n.strides.some(e=>e<0),t=e?`i`:`u`,r=n.offset?[`${n.offset}${t}`]:[];for(let i=0;i<n.shape.length;i++){let s=a-n.shape.length+i;if(n.shape[i]===1||n.strides[i]===0)continue;let c=s===0?`(i / ${x[0]}u)`:`((i / ${x[s]}u) % ${o[s]}u)`;e&&(c=`i32${c}`),r.push(n.strides[i]===1?c:`${c} * ${n.strides[i]}${t}`)}c=r.length?e?`u32(${r.join(` + `)})`:r.join(` + `):`0u`}r=`${i}[${c}]`}else if(t.kind===`scalar`){let e=d.length;d.push(m(t.value,t.dtype)),r=h(`fused[${e>>2}].${te[e&3]}`,t.dtype)}else if(t.kind===`index`)r=`i`;else if(t.op===`where`){let[e,n,i]=t.args;r=`select(${S(w(i),j(i),t.dtype)}, ${S(w(n),j(n),t.dtype)}, ${w(e)} != ${j(e)}(0))`}else{let e=t.args.map(j).reduce(f);r=ie(t.op,t.args.map(t=>S(w(t),j(t),e)),e,t.dtype,b)}let i=j(t);i===`f16`&&(y=!0);let a=`v${g.size}`;return p.push(`let ${a}: ${i} = ${r};`),g.set(t,a),a},ee=w(a),T=Math.max(1,Math.ceil(d.length/4)),E=new Uint32Array(T*4);E.set(d),_+=`@group(0) @binding(${v++}) var<uniform> fused: array<vec4u, ${T}>;\n`,u.fused=E;let D=`${b?.size?`${C([...b])}
fn operandF32(v: f32) -> f32 {
  if ((bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u) { return v; }
  return pmHide(v);
}
`:``}fn value(i: u32) -> ${e.dtype} {\n  ${p.join(`
  `)}\n  return ${ee};\n}`;return{enables:y?`enable f16;
`:``,declarations:_,fn:D,resources:u,next:v,dtype:e.dtype,shape:o,key:`${_}\n${D}`}}var j=e=>e.kind===`leaf`?e.array.dtype:e.dtype;function M(e,t,n){if(!(e instanceof O))throw r(`where needs a condition array or expression`,`compute`);let i=(e,t)=>typeof e==`number`?p(e,t instanceof O?t.dtype:`f32`):e.dtype,a=f(i(t,n),i(n,t));return e.op(`where`,[e,t,n],a)}function ae(e){let t=Array(e.length),n=1;for(let r=e.length-1;r>=0;r--)t[r]=n,n*=e[r];return t}function N(e,t=`Shape`){if(!Array.isArray(e)||e.some(e=>!Number.isInteger(e)||e<0))throw i(`${t} must be whole numbers of at least 0, got [${String(e)}]`,`compute`);return[...e]}function P(e,t){if(!Number.isInteger(e)||e<-t||e>=Math.max(t,1))throw i(`Axis ${e} is out of range for ${t} dimensions`,`compute`);return e<0?e+t:e}var F=class e extends O{#e=!1;#t;constructor(e,t,n,r,a=0){if(super(),this.context=e,this.dtype=t,this.shape=Object.freeze(N(n)),r){this.storage=r.storage,this.strides=Object.freeze([...r.strides]),this.offset=r.offset,this.#t=!!r.owner;return}let s=this.size,c=s*o(t),l=e.device.limits.maxStorageBufferBindingSize;if(c>l)throw i(`GpuArray of ${s} ${t} elements needs ${c} bytes, over this device's ${l}-byte storage binding limit; split the data or stream it`,`compute`);this.storage={buffer:e.allocate(Math.max(16,Math.ceil(c/16)*16),a,t),dtype:t,disposed:!1},this.strides=Object.freeze(ae(this.shape)),this.offset=0,this.#t=!0}get buffer(){return this.storage.buffer}get byteLength(){return this.size*o(this.dtype)}get contiguous(){let e=ae(this.shape);return this.shape.every((t,n)=>t===1||this.strides[n]===e[n])}get disposed(){return this.#e||this.storage.disposed}get owner(){return this.#t}node(){return{kind:`leaf`,array:this}}check(e){if(this.disposed)throw n(`disposed`,`GpuArray disposed; create a new array with gpu.array()`,`compute`);if(e!==this.context)throw n(`state`,`GpuArray belongs to another compute context; create it with this context`,`compute`)}#n(t,n,r){return this.check(this.context),new e(this.context,this.dtype,t,{storage:this.storage,strides:n,offset:r})}reshape(...e){let t=e.length===1&&Array.isArray(e[0])?e[0]:e,n=t.filter(e=>e!==-1).reduce((e,t)=>e*t,1);if(t.filter(e=>e===-1).length>1)throw i(`reshape takes at most one -1 dimension`,`compute`);let r=t.map(e=>e===-1?n?this.size/n:0:e);if(N(r),r.reduce((e,t)=>e*t,1)!==this.size)throw i(`Cannot reshape ${this.size} elements [${this.shape.join(`, `)}] into [${t.join(`, `)}]`,`compute`);let a=this.contiguous?this:this.eval();return a.#n(r,ae(r),a.offset)}flatten(){return this.reshape(this.size)}transpose(...e){let t=e.length?e.map(e=>P(e,this.ndim)):this.shape.map((e,t)=>this.ndim-1-t);if(t.length!==this.ndim||new Set(t).size!==this.ndim)throw i(`transpose needs a permutation of ${this.ndim} axes, got [${e.join(`, `)}]`,`compute`);return this.#n(t.map(e=>this.shape[e]),t.map(e=>this.strides[e]),this.offset)}get T(){return this.transpose()}slice(...e){if(e.length>this.ndim)throw i(`slice got ${e.length} specs for ${this.ndim} dimensions`,`compute`);let t=this.offset,n=[],r=[];return this.shape.forEach((a,o)=>{let s=e[o]??null;if(typeof s==`number`){let e=s<0?s+a:s;if(!Number.isInteger(s)||e<0||e>=a)throw i(`Index ${s} is out of range for dimension ${o} of length ${a}`,`compute`);t+=e*this.strides[o];return}let[c,l,u]=s??[],d=u??1;if(!Number.isInteger(d)||d===0)throw i(`Slice step must be a non-zero integer, got ${d}`,`compute`);let f=(e,t)=>{if(e==null)return t;let n=e<0?e+a:e;return d>0?Math.min(Math.max(n,0),a):Math.min(Math.max(n,-1),a-1)},p=f(c,d>0?0:a-1),m=f(l,d>0?a:-1),h=Math.max(0,Math.ceil((m-p)/d));h&&(t+=p*this.strides[o]),n.push(h),r.push(this.strides[o]*d)}),this.#n(n,r,t)}expandDims(e){let t=e<0?e+this.ndim+1:e;if(!Number.isInteger(t)||t<0||t>this.ndim)throw i(`expandDims axis ${e} is out of range`,`compute`);let n=[...this.shape],r=[...this.strides];return n.splice(t,0,1),r.splice(t,0,0),this.#n(n,r,this.offset)}squeeze(e){let t=e===void 0?this.shape.map(e=>e===1):this.shape.map((t,n)=>n===P(e,this.ndim));if(e!==void 0&&this.shape[P(e,this.ndim)]!==1)throw i(`squeeze axis ${e} has length ${this.shape[P(e,this.ndim)]}, not 1`,`compute`);return this.#n(this.shape.filter((e,n)=>!t[n]),this.strides.filter((e,n)=>!t[n]),this.offset)}broadcastTo(e){N(e);let t=e.length;if(t<this.ndim)throw i(`Cannot broadcast [${this.shape.join(`, `)}] to fewer dimensions`,`compute`);let n=e.map((n,r)=>{let a=r-(t-this.ndim);if(a<0)return 0;if(this.shape[a]===n)return this.strides[a];if(this.shape[a]===1)return 0;throw i(`Cannot broadcast [${this.shape.join(`, `)}] to [${e.join(`, `)}]`,`compute`)});return this.#n(e,n,this.offset)}ascontiguous(){return this.check(this.context),this.contiguous&&this.offset===0?this:this.eval()}transfer(t){if(!this.#t||!this.contiguous||this.offset)throw n(`state`,`Only a contiguous owning array can transfer its buffer`,`compute`);if(N(t).reduce((e,t)=>e*t,1)!==this.size)throw i(`Cannot give ${this.size} elements the shape [${t.join(`, `)}]`,`compute`);let r=new e(this.context,this.dtype,t,{storage:this.storage,strides:ae(t),offset:0,owner:!0});return this.#t=!1,this.#e=!0,this.context.forget(this),this.context.track(r),r}write(e,t=0){if(this.check(this.context),!this.contiguous)throw r(`write needs a contiguous array; write to the array the view came from`,`compute`);if(!Number.isInteger(t)||t<0||t+e.length>this.size)throw i(`GpuArray write of ${e.length} elements at ${t} does not fit ${this.size} elements`,`compute`);if(!e.length)return this;let n=d(e,this.dtype),a=o(this.dtype),s=(this.offset+t)*a;return s%4||n.byteLength%4?this.context.writeUnaligned(this.storage.buffer,s,new Uint8Array(n.buffer,n.byteOffset,n.byteLength)):this.context.device.queue.writeBuffer(this.storage.buffer,s,n),this}async read(e={}){if(this.check(this.context),!this.contiguous)return await super.read(e);let t=e.offset??0,n=e.length??this.size-t;if(!Number.isInteger(t)||!Number.isInteger(n)||t<0||n<0||t+n>this.size)throw i(`GpuArray read of ${n} elements at ${t} is outside ${this.size} elements`,`compute`);let r=o(this.dtype),a=await this.context.readBytes(this.storage.buffer,(this.offset+t)*r,n*r,e.signal);return new(l(this.dtype))(a)}dispose(){this.#e||(this.#e=!0,this.#t&&(this.storage.disposed=!0,this.storage.buffer.destroy(),this.context.forget(this)))}[Symbol.dispose](){this.dispose()}},oe=`modulepreload`,se=function(e,t){return new URL(e,t).href},ce={},le=function(e){return e.pathname.endsWith(`.css`)},ue=function(e,t,n){if(t in e)return e[t];let r=n();if(!r){e[t]=void 0;return}let i=r.then(()=>{e[t]=void 0},n=>{throw e[t]=void 0,n});return e[t]=i,i},de=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e,i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}function s(e){return import.meta.resolve?new URL(import.meta.resolve(e)):new URL(e,import.meta.url)}r=o(t.map(t=>{t=se(t,n);let r=s(t),i=le(r);return ue(ce,r.href,()=>{if(e===void 0){e={all:new Set,styles:new Set};let t=document.getElementsByTagName(`link`);for(let n=t.length-1;n>=0;n--){let r=t[n];e.all.add(r.href),r.rel===`stylesheet`&&e.styles.add(r.href)}}if((i?e.styles:e.all).has(r.href))return;let t=document.createElement(`link`);if(t.rel=i?`stylesheet`:oe,i||(t.as=`script`),t.crossOrigin=``,t.href=r.href,a&&t.setAttribute(`nonce`,a),document.head.appendChild(t),i)return new Promise((e,n)=>{t.addEventListener(`load`,e),t.addEventListener(`error`,()=>n(Error(`Unable to preload CSS for ${r}`)))})})}).filter(e=>e!==void 0))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})};function fe(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function pe(e,t){return fe(e)===`webgl2`?t():void 0}function me(e){return e?e.then(()=>void 0,()=>void 0):Promise.resolve()}var he=new Float32Array(1),ge=new Uint32Array(he.buffer);function _e(e){he[0]=e;let t=Math.abs(e)-Math.abs(he[0]);(t>0||t<0)&&!(ge[0]&1)&&(ge[0]+=t>0?1:-1);let n=ge[0],r=n>>>16&32768,i=n>>>23&255,a=n&8388607;if(i===255)return r|31744|(a?512:0);let o=i-127+15;if(o>=31)return r|31744;if(o<=0){if(o<-10)return r;let e=(a|8388608)>>>1-o+13,t=(a|8388608)&(1<<1-o+13)-1,n=1<<1-o+12;return r|e+(t>n||t===n&&e&1?1:0)}let s=a>>>13,c=a&8191,l=r|o<<10|s;return(c>4096||c===4096&&s&1)&&l++,l}var ve=new Set([`f32`,`i32`,`u32`,`f16`,`bool`]),ye={f:`f32`,i:`i32`,u:`u32`,h:`f16`};function be(e){let t=``,n=0;for(let r=0;r<e.length;r++){let i=e[r],a=e[r+1];if(n===0&&i===`/`&&a===`/`){for(;r<e.length&&e[r]!==`
`;)r++;t+=`
`}else i===`/`&&a===`*`?(n++,r++):n>0&&i===`*`&&a===`/`?(n--,r++):n===0?t+=i:i===`
`&&(t+=`
`)}return t}function xe(e){let t=[],n=0,r=0;for(let i=0;i<e.length;i++){let a=e[i];a===`<`||a===`(`?n++:a===`>`||a===`)`?n--:a===`,`&&n===0&&(t.push(e.slice(r,i).trim()),r=i+1)}let i=e.slice(r).trim();return i&&t.push(i),t}var I=(e,t)=>Math.ceil(t/e)*e;function Se(e){let t=new Map,n=new Map,r=new Map;for(let n of e.matchAll(/\balias\s+(\w+)\s*=\s*([^;]+);/g))t.set(n[1],n[2].trim());for(let t of e.matchAll(/\b(?:const|override)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*([^;]+);/g))r.set(t[1],t[2].trim());for(let t of e.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)){let e=[];for(let n of xe(t[2])){let t=/^((?:@\w+(?:\([^)]*\))?\s*)*)(\w+)\s*:\s*(.+)$/s.exec(n);if(!t)continue;let r=t[1],i=/@align\(\s*(\d+)\s*\)/.exec(r),a=/@size\(\s*(\d+)\s*\)/.exec(r);e.push({name:t[2],type:t[3].trim(),align:i?Number(i[1]):void 0,size:a?Number(a[1]):void 0})}n.set(t[1],e)}return{aliases:t,structs:n,constants:r}}function L(e,t,n=new Set){let r=e.trim(),i=/^(0[xX][0-9a-fA-F]+|\d+)[iu]?$/.exec(r);if(i)return Number(i[1]);if(/^\w+$/.test(r)&&t.constants.has(r)&&!n.has(r))return n.add(r),L(t.constants.get(r),t,n)}function Ce(e){let t=e.trim(),n=t.indexOf(`<`);return n<0?{base:t,args:[]}:{base:t.slice(0,n).trim(),args:xe(t.slice(n+1,t.lastIndexOf(`>`)))}}function R(e,t,n=0){if(n>32)return;let r=e.trim();for(;t.aliases.has(r);)r=t.aliases.get(r);let i=/^(vec[234]|mat[234]x[234])([fiuh])$/.exec(r);i&&(r=`${i[1]}<${ye[i[2]]}>`);let{base:a,args:o}=Ce(r);if(ve.has(a)){if(a===`bool`)return;let e=a===`f16`?2:4;return{name:a,kind:`scalar`,align:e,size:e,scalar:a}}if(a===`atomic`){let e=R(o[0]??``,t,n+1);return e&&{...e,name:r,kind:`atomic`}}let s=/^vec([234])$/.exec(a);if(s){let e=Number(s[1]),i=R(o[0]??``,t,n+1);if(!i||i.kind!==`scalar`)return;let a=i.size;return{name:r,kind:`vector`,align:(e===2?2:4)*a,size:e*a,scalar:i.scalar,rows:e}}let c=/^mat([234])x([234])$/.exec(a);if(c){let e=Number(c[1]),i=Number(c[2]),a=R(`vec${i}<${o[0]}>`,t,n+1);if(!a)return;let s=I(a.align,a.size);return{name:r,kind:`matrix`,align:a.align,size:e*s,scalar:a.scalar,rows:i,columns:e,stride:s}}if(a===`array`){let e=R(o[0]??``,t,n+1);if(!e)return;let i=I(e.align,e.size),a=o[1]===void 0?0:L(o[1],t);return a===void 0?void 0:{name:r,kind:`array`,align:e.align,size:a===0?i:a*i,element:e,stride:i,count:a}}let l=t.structs.get(a);if(l){let e=0,r=1,i=[];for(let a of l){let o=R(a.type,t,n+1);if(!o)return;let s=a.align??o.align;e=I(s,e),i.push({name:a.name,offset:e,layout:o}),e+=a.size??o.size,r=Math.max(r,s)}return{name:a,kind:`struct`,align:r,size:I(r,e),members:i}}}var we={"1d":`1d`,"2d":`2d`,"2d_array":`2d-array`,"3d":`3d`,cube:`cube`,cube_array:`cube-array`},Te={f32:`float`,i32:`sint`,u32:`uint`};function Ee(e){let{base:t,args:n}=Ce(e),r=/^texture_storage_(1d|2d|2d_array|3d)$/.exec(t);if(r){let e={read:`read-only`,write:`write-only`,read_write:`read-write`}[n[1]??`write`];return{viewDimension:we[r[1]],format:n[0],access:e}}let i=/^texture_depth_(multisampled_)?(2d|2d_array|cube|cube_array)$/.exec(t);if(i)return{viewDimension:we[i[2]],sampleType:`depth`,multisampled:!!i[1]};let a=/^texture_(multisampled_)?(1d|2d|2d_array|3d|cube|cube_array)$/.exec(t);if(a)return{viewDimension:we[a[2]],sampleType:Te[n[0]??`f32`]??`float`,multisampled:!!a[1]}}function De(e){let t=be(e),n=Se(t),i=[],a=[];for(let e of t.matchAll(/((?:@\w+\s*(?:\([^)]*\))?\s*)+)var\s*(?:<\s*([\w\s,]+)\s*>)?\s*(\w+)\s*:\s*([^;=]+?)\s*;/g)){let t=e[1],a=/@group\(\s*([^)]+)\)/.exec(t),o=/@binding\(\s*([^)]+)\)/.exec(t);if(!a||!o)continue;let s=L(a[1],n),c=L(o[1],n);if(s===void 0||c===void 0)throw r(`Kernel binding ${e[3]} has a group or binding that is not a constant integer`,`compute`);let l=(e[2]??``).split(`,`).map(e=>e.trim()),u=e[3],d=e[4].trim();if(l[0]===`uniform`)i.push({name:u,group:s,binding:c,resource:`uniform`,type:d,layout:R(d,n)});else if(l[0]===`storage`)i.push({name:u,group:s,binding:c,resource:l[1]===`read_write`?`storage`:`read-only-storage`,type:d,layout:R(d,n)});else if(/^sampler(_comparison)?$/.test(d))i.push({name:u,group:s,binding:c,resource:`sampler`,type:d,sampler:d===`sampler`?`filtering`:`comparison`});else{let e=Ee(d);if(!e)throw r(`Kernel binding ${u} has a type the kernel cannot bind: ${d}`,`compute`);i.push({name:u,group:s,binding:c,resource:e.format?`storage-texture`:`texture`,type:d,texture:e})}}for(let e of t.matchAll(/@compute\s*((?:@\w+\s*(?:\([^)]*\))?\s*)*)fn\s+(\w+)|((?:@\w+\s*(?:\([^)]*\))?\s*)+)fn\s+(\w+)/g)){let t=e[1]??e[3]??``,i=e[2]??e[4];if(e[3]!==void 0&&!/@compute\b/.test(t))continue;let o=/@workgroup_size\(([^)]*)\)/.exec(t),s=o?xe(o[1]).map(e=>L(e,n)):[1];if(s.some(e=>e===void 0))throw r(`Kernel entry point ${i} has a workgroup size that is not a constant integer`,`compute`);a.push({name:i,workgroupSize:[s[0]??1,s[1]??1,s[2]??1]})}return i.sort((e,t)=>e.group-t.group||e.binding-t.binding),{bindings:i,entryPoints:a}}function Oe(e,t,n,a,o){let s=(t,n,a)=>{let s=typeof a==`boolean`?Number(a):a;if(typeof s!=`number`)throw r(`Uniform ${o} needs a number, got ${typeof a}`,`compute`);if(n===`f32`)e.setFloat32(t,s,!0);else if(n===`f16`)e.setUint16(t,_e(s),!0);else{let[r,a]=n===`i32`?[-2147483648,2147483647]:[0,4294967295];if(!Number.isInteger(s)||s<r||s>a)throw i(`Uniform ${o} needs an integer from ${r} to ${a}, got ${s}`,`compute`);n===`i32`?e.setInt32(t,s,!0):e.setUint32(t,s,!0)}},c=(e,t)=>{if(typeof e!=`object`||!e||typeof e.length!=`number`)throw r(`Uniform ${o} needs an array of ${t} numbers`,`compute`);let n=e;if(n.length!==t)throw r(`Uniform ${o} needs ${t} numbers, got ${n.length}`,`compute`);return n},l=n.scalar===`f16`?2:4;switch(n.kind){case`scalar`:case`atomic`:return s(t,n.scalar,a);case`vector`:{let e=c(a,n.rows);for(let r=0;r<n.rows;r++)s(t+r*l,n.scalar,e[r]);return}case`matrix`:{let e=c(a,n.rows*n.columns);for(let r=0;r<n.columns;r++)for(let i=0;i<n.rows;i++)s(t+r*n.stride+i*l,n.scalar,e[r*n.rows+i]);return}case`array`:{let i=n.element,s=a;if(typeof s!=`object`||!s||typeof s.length!=`number`)throw r(`Uniform ${o} needs an array`,`compute`);if(n.count&&s.length!==n.count)throw r(`Uniform ${o} needs ${n.count} items, got ${s.length}`,`compute`);for(let r=0;r<s.length;r++)Oe(e,t+r*n.stride,i,s[r],`${o}[${r}]`);return}case`struct`:{if(typeof a!=`object`||!a||ArrayBuffer.isView(a)||Array.isArray(a))throw r(`Uniform ${o} needs an object with the struct's members`,`compute`);let i=a;for(let a of n.members){if(!(a.name in i))throw r(`Uniform ${o}.${a.name} is missing; pass every struct member`,`compute`);Oe(e,t+a.offset,a.layout,i[a.name],`${o}.${a.name}`)}}}}function ke(e,t=0){return e.kind===`array`&&e.count===0?e.stride*t:e.size}function Ae(e,t,n=`value`){let r=e.kind===`array`&&e.count===0?t.length:0,i=new Uint8Array(I(16,Math.max(ke(e,r),4)));return Oe(new DataView(i.buffer),0,e,t,n),i}var z=1024,B=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`,V=`struct Params { n: u32, inf: u32, a: u32, b: u32 }`;function je(e,t){if(typeof e==`object`){if(typeof e.combine!=`string`||typeof e.identity!=`string`)throw r(`A custom operator needs WGSL strings combine (of a and b) and identity`,`compute`);return e}let n=t===`f16`?`bitcast<vec2<f16>>((params.inf >> 16u) & 0x7c00u).x`:`bitcast<f32>(params.inf)`;switch(e){case`sum`:return{combine:`a + b`,identity:`${t}(0)`};case`product`:return{combine:`a * b`,identity:`${t}(1)`};case`min`:return{combine:`min(a, b)`,identity:t===`i32`?`i32(2147483647)`:t===`u32`?`0xffffffffu`:n};case`max`:return{combine:`max(a, b)`,identity:t===`i32`?`(-2147483647i - 1i)`:t===`u32`?`0u`:`-${n}`}}}function Me(e,t,n,r=256){let i=e.dtype,a=z/r;return`${e.enables}${e.declarations}${V}
${B}
@group(0) @binding(${e.next}) var<storage, read_write> dst: array<${i}>;
@group(0) @binding(${e.next+1}) var<storage, read_write> sums: array<${i}>;
@group(0) @binding(${e.next+2}) var<uniform> params: Params;
var<workgroup> partial: array<${i}, ${r}>;
${e.fn}
fn combine(a: ${i}, b: ${i}) -> ${i} { return ${t}; }
@compute @workgroup_size(${r})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let base = g * 1024u + lid * ${a}u;
  var item: array<${i}, ${a}>;
  var acc: ${i} = ${n};
  for (var k = 0u; k < ${a}u; k++) {
    var v: ${i} = ${n};
    if (base + k < params.n) { v = value(base + k); }
    acc = combine(acc, v);
    item[k] = acc;
  }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 1u; offset < ${r}u; offset <<= 1u) {
    var v = partial[lid];
    if (lid >= offset) { v = combine(partial[lid - offset], v); }
    workgroupBarrier();
    partial[lid] = v;
    workgroupBarrier();
  }
  var before: ${i} = ${n};
  if (lid > 0u) { before = partial[lid - 1u]; }
  for (var k = 0u; k < ${a}u; k++) {
    if (base + k < params.n) {
      if (params.a == 1u) {
        var previous = before;
        if (k > 0u) { previous = combine(before, item[k - 1u]); }
        dst[base + k] = previous;
      } else {
        dst[base + k] = combine(before, item[k]);
      }
    }
  }
  if (lid == ${r-1}u) { sums[g] = partial[${r-1}]; }
}`}function Ne(e,t){return`${e===`f16`?`enable f16;
`:``}${V}
${B}
@group(0) @binding(0) var<storage, read_write> data: array<${e}>;
@group(0) @binding(1) var<storage, read> sums: array<${e}>;
@group(0) @binding(2) var<uniform> params: Params;
fn combine(a: ${e}, b: ${e}) -> ${e} { return ${t}; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let prefix = sums[g];
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n) { data[i] = combine(prefix, data[i]); }
  }
}`}function Pe(e,t,n,r){let i=e.dtype,a=e.next;return`${e.enables}${e.declarations}${V}
${B}
@group(0) @binding(${a}) var<storage, read> flagsIn: array<u32>;
@group(0) @binding(${a+1}) var<storage, read_write> dst: array<${i}>;
@group(0) @binding(${a+2}) var<storage, read_write> seen: array<u32>;
@group(0) @binding(${a+3}) var<storage, read_write> sumFlags: array<u32>;
@group(0) @binding(${a+4}) var<storage, read_write> sumValues: array<${i}>;
@group(0) @binding(${a+5}) var<uniform> params: Params;
var<workgroup> partialFlags: array<u32, 256>;
var<workgroup> partialValues: array<${i}, 256>;
${e.fn}
fn combine(a: ${i}, b: ${i}) -> ${i} { return ${t}; }
fn flagAt(i: u32) -> u32 { ${r?`return select(0u, 1u, i % params.b == 0u);`:`return select(0u, 1u, flagsIn[i] != 0u);`} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let base = g * 1024u + lid * 4u;
  var itemFlags: array<u32, 4>;
  var itemValues: array<${i}, 4>;
  var f = 0u;
  var v: ${i} = ${n};
  for (var k = 0u; k < 4u; k++) {
    var fk = 0u;
    var vk: ${i} = ${n};
    if (base + k < params.n) { fk = flagAt(base + k); vk = value(base + k); }
    if (fk == 1u) { v = vk; } else { v = combine(v, vk); }
    f = f | fk;
    itemFlags[k] = f;
    itemValues[k] = v;
  }
  partialFlags[lid] = f;
  partialValues[lid] = v;
  workgroupBarrier();
  for (var offset = 1u; offset < 256u; offset <<= 1u) {
    var pf = partialFlags[lid];
    var pv = partialValues[lid];
    if (lid >= offset && pf == 0u) {
      pv = combine(partialValues[lid - offset], pv);
      pf = partialFlags[lid - offset];
    } else if (lid >= offset) {
      pf = 1u;
    }
    workgroupBarrier();
    partialFlags[lid] = pf;
    partialValues[lid] = pv;
    workgroupBarrier();
  }
  var beforeFlag = 0u;
  var beforeValue: ${i} = ${n};
  if (lid > 0u) { beforeFlag = partialFlags[lid - 1u]; beforeValue = partialValues[lid - 1u]; }
  for (var k = 0u; k < 4u; k++) {
    let i = base + k;
    if (i < params.n) {
      var out = itemValues[k];
      if (itemFlags[k] == 0u) { out = combine(beforeValue, out); }
      dst[i] = out;
      seen[i] = itemFlags[k] | beforeFlag;
    }
  }
  if (lid == 255u) { sumFlags[g] = partialFlags[255]; sumValues[g] = partialValues[255]; }
}`}function Fe(e,t){return`${e===`f16`?`enable f16;
`:``}${V}
${B}
@group(0) @binding(0) var<storage, read_write> data: array<${e}>;
@group(0) @binding(1) var<storage, read> seen: array<u32>;
@group(0) @binding(2) var<storage, read> scanned: array<${e}>;
@group(0) @binding(3) var<uniform> params: Params;
fn combine(a: ${e}, b: ${e}) -> ${e} { return ${t}; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g == 0u || g * 1024u >= params.n) { return; }
  let prefix = scanned[g - 1u];
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n && seen[i] == 0u) { data[i] = combine(prefix, data[i]); }
  }
}`}function Ie(e,t,n){let r=t===`f16`||e.some(e=>e.type===`f16`),i=e.map((e,t)=>`@group(0) @binding(${t+1}) var<storage, read> in_${e.name}: array<${e.type}>;`).join(`
`),a=e.map(e=>`${e.name}: ${e.type}`).join(`, `),o=e.map(e=>`in_${e.name}[i]`).join(`, `),s=/\breturn\b/.test(n)?n:`return ${t}(${n});`;return`${r?`enable f16;
`:``}${V}
${B}
@group(0) @binding(0) var<storage, read_write> out: array<${t}>;
${i}
@group(0) @binding(${e.length+1}) var<uniform> params: Params;
fn f(i: u32, n: u32${a?`, `+a:``}) -> ${t} { ${s} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  out[i] = f(i, params.n${o?`, `+o:``});
}`}function Le(e){switch(e){case`f32`:return`let bits = bitcast<u32>(v); return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);`;case`f16`:return`let bits = bitcast<u32>(f32(v)); return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);`;case`i32`:return`return bitcast<u32>(v) ^ 0x80000000u;`;case`u32`:return`return v;`}}function Re(e){return`${e.enables}${e.declarations}${V}
${B}
@group(0) @binding(${e.next}) var<storage, read_write> keys: array<u32>;
@group(0) @binding(${e.next+1}) var<storage, read_write> order: array<u32>;
@group(0) @binding(${e.next+2}) var<uniform> params: Params;
${e.fn}
fn toKey(v: ${e.dtype}) -> u32 { ${Le(e.dtype)} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = toKey(value(i));
  if (params.a == 1u) { k = ~k; }
  keys[i] = k;
  if (params.b == 1u) { order[i] = i; }
}`}function ze(e){return`${e===`f16`?`enable f16;
`:``}${V}
${B}
@group(0) @binding(0) var<storage, read> keys: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<${e}>;
@group(0) @binding(2) var<uniform> params: Params;
fn fromKey(k: u32) -> ${e} { ${e===`f32`?`return bitcast<f32>(select(~k, k & 0x7fffffffu, (k & 0x80000000u) != 0u));`:e===`f16`?`return f16(bitcast<f32>(select(~k, k & 0x7fffffffu, (k & 0x80000000u) != 0u)));`:e===`i32`?`return bitcast<i32>(k ^ 0x80000000u);`:`return k;`} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = keys[i];
  if (params.a == 1u) { k = ~k; }
  dst[i] = fromKey(k);
}`}var Be=`struct Radix { n: u32, shift: u32, blocks: u32, values: u32 }`,Ve=e=>`${Be}
${B}
@group(0) @binding(0) var<storage, read> keysIn: array<u32>;
@group(0) @binding(1) var<storage, read> valuesIn: array<u32>;
@group(0) @binding(2) var<storage, read_write> keysLocal: array<u32>;
@group(0) @binding(3) var<storage, read_write> valuesLocal: array<u32>;
@group(0) @binding(4) var<storage, read_write> counts: array<u32>;
@group(0) @binding(5) var<storage, read_write> starts: array<u32>;
@group(0) @binding(6) var<uniform> radix: Radix;
var<workgroup> sharedKeys: array<u32, ${e}>;
var<workgroup> sharedValues: array<u32, ${e}>;
var<workgroup> scan: array<u32, ${e}>;
var<workgroup> histogram: array<atomic<u32>, 16>;
@compute @workgroup_size(${e})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g >= radix.blocks) { return; }
  let i = g * ${e}u + lid;
  var key = 0xffffffffu;
  var value = 0u;
  if (i < radix.n) {
    key = keysIn[i];
    if (radix.values == 1u) { value = valuesIn[i]; }
  }
  if (lid < 16u) { atomicStore(&histogram[lid], 0u); }
  for (var b = 0u; b < 4u; b++) {
    let bit = (key >> (radix.shift + b)) & 1u;
    scan[lid] = 1u - bit;
    workgroupBarrier();
    for (var offset = 1u; offset < ${e}u; offset <<= 1u) {
      var v = scan[lid];
      if (lid >= offset) { v += scan[lid - offset]; }
      workgroupBarrier();
      scan[lid] = v;
      workgroupBarrier();
    }
    let zeros = scan[${e-1}];
    let zerosBefore = scan[lid] - (1u - bit);
    var dest = zerosBefore;
    if (bit == 1u) { dest = zeros + lid - zerosBefore; }
    workgroupBarrier();
    sharedKeys[dest] = key;
    sharedValues[dest] = value;
    workgroupBarrier();
    key = sharedKeys[lid];
    value = sharedValues[lid];
    workgroupBarrier();
  }
  let valid = min(${e}u, radix.n - g * ${e}u);
  let digit = (key >> radix.shift) & 15u;
  if (lid < valid) { atomicAdd(&histogram[digit], 1u); }
  keysLocal[i] = key;
  valuesLocal[i] = value;
  workgroupBarrier();
  if (lid < 16u) {
    counts[lid * radix.blocks + g] = atomicLoad(&histogram[lid]);
    var start = 0u;
    for (var d = 0u; d < lid; d++) { start += atomicLoad(&histogram[d]); }
    starts[g * 16u + lid] = start;
  }
}`,He=e=>`${Be}
${B}
@group(0) @binding(0) var<storage, read> keysLocal: array<u32>;
@group(0) @binding(1) var<storage, read> valuesLocal: array<u32>;
@group(0) @binding(2) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read> starts: array<u32>;
@group(0) @binding(4) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(5) var<storage, read_write> valuesOut: array<u32>;
@group(0) @binding(6) var<uniform> radix: Radix;
@compute @workgroup_size(${e})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g >= radix.blocks || lid >= min(${e}u, radix.n - g * ${e}u)) { return; }
  let key = keysLocal[g * ${e}u + lid];
  let digit = (key >> radix.shift) & 15u;
  let dest = offsets[digit * radix.blocks + g] + lid - starts[g * 16u + digit];
  keysOut[dest] = key;
  if (radix.values == 1u) { valuesOut[dest] = valuesLocal[g * ${e}u + lid]; }
}`,Ue=4096;function We(e,t){let n=t?`localCounts`:`counts`;return`${e.enables}${e.declarations}struct Bins { n: u32, bins: u32, pad0: u32, pad1: u32 }
${B}
@group(0) @binding(${e.next}) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(${e.next+1}) var<storage, read> range: array<f32>;
@group(0) @binding(${e.next+2}) var<uniform> params: Bins;
${t?`var<workgroup> localCounts: array<atomic<u32>, ${Ue}>;`:``}
${e.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let lo = range[0];
  let hi = range[1];
  let scale = f32(params.bins) / (hi - lo);
  ${t?`for (var b = lid; b < params.bins; b += 256u) { atomicStore(&localCounts[b], 0u); }
  workgroupBarrier();`:``}
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + k * 256u + lid;
    if (i < params.n) {
      let x = f32(value(i));
      if (x >= lo && x <= hi) {
        let bin = min(u32((x - lo) * scale), params.bins - 1u);
        atomicAdd(&${n}[bin], 1u);
      }
    }
  }
  ${t?`workgroupBarrier();
  for (var b = lid; b < params.bins; b += 256u) {
    let c = atomicLoad(&localCounts[b]);
    if (c > 0u) { atomicAdd(&counts[b], c); }
  }`:``}
}`}var Ge=`struct Params { n: u32, inf: u32, len: u32, inner: u32 }`,Ke=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`,qe=4096;function Je(e,t){if(e===void 0)return Array.from({length:t},(e,t)=>t);let n=(typeof e==`number`?[e]:[...e]).map(e=>P(e,t));if(new Set(n).size!==n.length)throw i(`Reduction axes repeat: [${String(e)}]`,`compute`);return n.sort((e,t)=>e-t)}var Ye=(e,t,n)=>n?e.map((e,n)=>t.includes(n)?1:e):e.filter((e,n)=>!t.includes(n));function Xe(e,t,n,r=256){let i=e.dtype,a=z/r;return`${e.enables}${e.declarations}${Ge}
${Ke}
@group(0) @binding(${e.next}) var<storage, read_write> dst: array<${i}>;
@group(0) @binding(${e.next+1}) var<uniform> params: Params;
var<workgroup> partial: array<${i}, ${r}>;
${e.fn}
fn combine(a: ${i}, b: ${i}) -> ${i} { return ${t}; }
@compute @workgroup_size(${r})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  var acc: ${i} = ${n};
  for (var k = 0u; k < ${a}u; k++) {
    let i = g * 1024u + lid * ${a}u + k;
    if (i < params.n) { acc = combine(acc, value(i)); }
  }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = ${r/2}u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = combine(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }
  if (lid == 0u) { dst[g] = partial[0]; }
}`}function Ze(e,t,n,r){let i=e.dtype,a=`${e.enables}${e.declarations}${Ge}
${Ke}
@group(0) @binding(${e.next}) var<storage, read_write> dst: array<${i}>;
@group(0) @binding(${e.next+1}) var<uniform> params: Params;
${e.fn}
fn combine(a: ${i}, b: ${i}) -> ${i} { return ${t}; }
fn at(o: u32, k: u32) -> u32 { return ((o / params.inner) * params.len + k) * params.inner + o % params.inner; }`;return r?`${a}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= params.n) { return; }
  var acc: ${i} = ${n};
  for (var k = 0u; k < params.len; k++) { acc = combine(acc, value(at(o, k))); }
  dst[o] = acc;
}`:`${a}
var<workgroup> partial: array<${i}, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg);
  if (o >= params.n) { return; }
  let run = (params.len + 255u) / 256u;
  var acc: ${i} = ${n};
  for (var k = lid * run; k < min(params.len, lid * run + run); k++) { acc = combine(acc, value(at(o, k))); }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 128u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = combine(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }
  if (lid == 0u) { dst[o] = partial[0]; }
}`}var H=2139095040;function U(e,t,n,i={}){if(e.check(),!(t instanceof O))throw r(`Reductions take a GpuArray or an Expr`,`compute`);if(typeof n==`string`&&![`sum`,`product`,`min`,`max`].includes(n))throw r(`Unknown reduce op ${n}; use sum, product, min, max or { combine, identity }`,`compute`);let a=Je(i.axis,t.ndim),o=!!i.keepdims,s=Ye(t.shape,a,o),{combine:c,identity:l}=je(n,t.dtype);if(a.length===t.ndim)return Qe(e,t,c,l,s);let u=t,d=[...t.shape],f=[];for(let n=a.length-1;n>=0;n--){let r=a[n],i=n===0,o=d.filter((e,t)=>t!==r),p=e.empty(i?s:o,t.dtype);$e(e,u,r,d,c,l,p),i||f.push(p),u=p,d=o}for(let e of f)e.dispose();return u}function Qe(e,t,n,r,i){let a=t.size;if(a===0){let n=e.empty(i,t.dtype),a=`${t.dtype===`f16`?`enable f16;
`:``}${Ge}
@group(0) @binding(0) var<storage, read_write> dst: array<${t.dtype}>;
@group(0) @binding(1) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { dst[0] = ${r}; }`;return e.submit([{program:e.program(a,void 0,`reduce`),resources:{dst:n,params:new Uint32Array([0,H,0,0])},workgroups:[1,1,1]}]),n}let o=t,s=a,c=[],l=[],u;do{let a=Math.ceil(s/z),d=[],f=A(o,0,e.maxStorage(1),d);c.push(...d),u=e.empty(a===1?i:[a],t.dtype),l.push({program:e.program(e.kernelRoute?.level(f,n,r)??Xe(f,n,r,e.tuned.reduce),void 0,`reduce`),resources:{...f.resources,dst:u,params:new Uint32Array([s,H,0,0])},workgroups:e.grid(a)}),a>1&&c.push(u),o=u,s=a}while(s>1);e.submit(l);for(let e of c)e.dispose();return u}function $e(e,t,n,r,i,a,o){let s=r[n],c=r.slice(n+1).reduce((e,t)=>e*t,1),l=o.size;if(l===0)return;let u=[],d=A(t,0,e.maxStorage(1),u),f=l>=qe||s<=64;e.submit([{program:e.program((f?void 0:e.kernelRoute?.axis(d,i,a))??Ze(d,i,a,f),void 0,`reduce.axis`),resources:{...d.resources,dst:o,params:new Uint32Array([l,H,s,c])},workgroups:e.grid(f?Math.ceil(l/256):l)}]);for(let e of u)e.dispose()}var et=(e,t)=>t.reduce((t,n)=>t*e[n],1);function tt(e,t,n={}){let r=et(t.shape,Je(n.axis,t.ndim));return nt(U(e,s(t.dtype)&&t.dtype===`f32`?t:t.astype(`f32`),`sum`,n),r?1/r:NaN)}function nt(e,t){let n=e.mul(t).eval();return e.dispose(),n}function rt(e,t,n={}){let r=n.ddof??0;if(!Number.isFinite(r)||r<0)throw i(`ddof must be a number of at least 0, got ${r}`,`compute`);let a=t.dtype===`f32`?t:t.astype(`f32`),o=tt(e,a,{axis:n.axis,keepdims:!0}),s=et(t.shape,Je(n.axis,t.ndim)),c=U(e,a.sub(o).square(),`sum`,n);return o.dispose(),nt(c,s-r>0?1/(s-r):NaN)}function it(e,t,n={}){let r=rt(e,t,n),i=r.sqrt().eval();return r.dispose(),i}function at(e,t,n={}){let r=t.dtype===`f32`?t:t.astype(`f32`),i=U(e,M(r.isnan(),0,r),`sum`,n),a=U(e,r.isnan().not(),`sum`,n),o=i.div(a).eval();return i.dispose(),a.dispose(),o}function ot(e,t,n){let r=e.dtype,i=t===`min`?`<`:`>`,a=n===`level`?`fn load(i: u32) -> Pair { return Pair(vals[i], idx[i]); }`:`fn load(i: u32) -> Pair { return Pair(value(i), i); }`,o=`${e.enables}${e.declarations}${Ge}
${Ke}
struct Pair { v: ${r}, i: u32 }
@group(0) @binding(${e.next}) var<storage, read_write> outValues: array<${r}>;
@group(0) @binding(${e.next+1}) var<storage, read_write> outIndices: array<u32>;
@group(0) @binding(${e.next+2}) var<uniform> params: Params;
${n===`level`?`@group(0) @binding(${e.next+3}) var<storage, read> vals: array<${r}>;\n@group(0) @binding(${e.next+4}) var<storage, read> idx: array<u32>;`:``}
${e.fn}
${a}
fn pick(a: Pair, b: Pair) -> Pair {
  if (b.i == 0xffffffffu) { return a; }
  if (a.i == 0xffffffffu || b.v ${i} a.v || (b.v == a.v && b.i < a.i)) { return b; }
  return a;
}
fn at(o: u32, k: u32) -> u32 { return ((o / params.inner) * params.len + k) * params.inner + o % params.inner; }`,s=`Pair(${r}(0), 0xffffffffu)`,c=`
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 128u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = pick(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }`;return n===`thread`?`${o}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= params.n) { return; }
  var acc = ${s};
  for (var k = 0u; k < params.len; k++) { let p = load(at(o, k)); acc = pick(acc, Pair(p.v, k)); }
  outValues[o] = acc.v;
  outIndices[o] = acc.i;
}`:n===`group`?`${o}
var<workgroup> partial: array<Pair, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg);
  if (o >= params.n) { return; }
  let run = (params.len + 255u) / 256u;
  var acc = ${s};
  for (var k = lid * run; k < min(params.len, lid * run + run); k++) { let p = load(at(o, k)); acc = pick(acc, Pair(p.v, k)); }
  ${c}
  if (lid == 0u) { outValues[o] = partial[0].v; outIndices[o] = partial[0].i; }
}`:`${o}
var<workgroup> partial: array<Pair, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  var acc = ${s};
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n) { acc = pick(acc, load(i)); }
  }
  ${c}
  if (lid == 0u) { outValues[g] = partial[0].v; outIndices[g] = partial[0].i; }
}`}function st(e,t,n,a={}){if(e.check(),!(t instanceof O))throw r(`arg${n} takes a GpuArray or an Expr`,`compute`);if(t.size===0)throw i(`arg${n} of an empty array has no answer`,`compute`);let o=[],s=t.dtype;if(a.axis===void 0){let r=a.keepdims?t.shape.map(()=>1):[],i=t.size,c,l,u=[],d=!0;do{let a=Math.ceil(i/z),f=a===1,p=A(d?t:c,0,e.maxStorage(4),o),m=e.empty([a],s),h=e.empty(f?r:[a],`u32`),g={...p.resources,outValues:m,outIndices:h,params:new Uint32Array([i,H,0,0])};d||Object.assign(g,{vals:c,idx:l}),u.push({program:e.program(ot(p,n,d?`flat`:`level`),void 0,`arg${n}`),resources:g,workgroups:e.grid(a)}),c&&o.push(c),l&&o.push(l),c=m,l=h,i=a,d=!1}while(i>1);e.submit(u),o.push(c);for(let e of o)e.dispose();return l}let c=P(a.axis,t.ndim),l=t.shape[c],u=t.shape.slice(c+1).reduce((e,t)=>e*t,1),d=Ye(t.shape,[c],!!a.keepdims),f=d.reduce((e,t)=>e*t,1),p=f>=qe||l<=64,m=A(t,0,e.maxStorage(2),o),h=e.empty([f],s),g=e.empty(d,`u32`);e.submit([{program:e.program(ot(m,n,p?`thread`:`group`),void 0,`arg${n}.axis`),resources:{...m.resources,outValues:h,outIndices:g,params:new Uint32Array([f,H,l,u])},workgroups:e.grid(p?Math.ceil(f/256):f)}]),o.push(h);for(let e of o)e.dispose();return g}var ct=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`;function lt(e){if(!(e instanceof O))throw r(`Indices must be a GpuArray or an Expr`,`compute`);if(s(e.dtype))throw r(`Indices must be integers; astype('i32') first`,`compute`);return e instanceof F&&e.dtype===`i32`&&e.contiguous&&e.offset===0?{array:e,owned:!1}:{array:e.astype(`i32`).eval(),owned:!0}}function ut(e,t,n,a={}){if(e.check(),!(t instanceof O))throw r(`take reads a GpuArray or an Expr`,`compute`);let{array:o,owned:s}=lt(n),c=a.mode??`clip`;if(c!==`clip`&&c!==`wrap`)throw r(`take mode must be 'clip' or 'wrap', got ${String(c)}`,`compute`);let l=a.axis===void 0?void 0:P(a.axis,t.ndim),u=l===void 0?t.size:t.shape[l],d=l===void 0?1:t.shape.slice(l+1).reduce((e,t)=>e*t,1),f=l===void 0?o.shape:[...t.shape.slice(0,l),...o.shape,...t.shape.slice(l+1)],p=e.empty(f,t.dtype),m=p.size;if(m>0&&u===0)throw i(`take from an empty axis has nothing to take`,`compute`);if(m>0){let n=[],r=A(t,0,e.maxStorage(2),n),i=`${r.enables}${r.declarations}struct Take { n: u32, len: u32, inner: u32, count: u32, wrap: u32 }
${ct}
@group(0) @binding(${r.next}) var<storage, read> idx: array<i32>;
@group(0) @binding(${r.next+1}) var<storage, read_write> out: array<${t.dtype}>;
@group(0) @binding(${r.next+2}) var<uniform> take: Take;
${r.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= take.n) { return; }
  let j = o % take.inner;
  let p = (o / take.inner) % take.count;
  let outer = o / (take.inner * take.count);
  let len = i32(take.len);
  var k = idx[p];
  if (k < 0) { k += len; }
  if (take.wrap == 1u) { k = ((k % len) + len) % len; } else { k = clamp(k, 0, len - 1); }
  out[o] = value((outer * take.len + u32(k)) * take.inner + j);
}`;e.submit([{program:e.program(i,void 0,`take`),resources:{...r.resources,idx:o,out:p,take:new Uint32Array([m,u,d,Math.max(1,o.size),+(c===`wrap`),0,0,0])},workgroups:e.grid(Math.ceil(m/256))}]);for(let e of n)e.dispose()}return s&&o.dispose(),p}function dt(e,t){let n=e=>e.kind===`leaf`?e.array.storage===t.storage:e.kind===`op`&&e.args.some(n);return n(e.node())}function ft(e,t,n,a,o={}){if(e.check(),!(t instanceof F))throw r(`scatter writes into a GpuArray`,`compute`);if(t.check(e),!t.contiguous||t.offset)throw r(`scatter needs a contiguous target; scatter into the array the view came from`,`compute`);let s=o.op??`set`;if(![`set`,`add`,`min`,`max`].includes(s))throw r(`scatter op must be set, add, min or max, got ${s}`,`compute`);if(t.dtype===`f16`&&s!==`set`)throw r(`scatter add/min/max needs a 32-bit target; use 'f32'`,`compute`);let{array:c,owned:l}=lt(n),u=c.size,d=typeof a==`number`;if(!d&&!(a instanceof O))throw r(`scatter values must be a number, a GpuArray or an Expr`,`compute`);if(!d&&a.size!==u&&a.size!==1)throw i(`scatter has ${u} indices but ${a.size} values; pass one value or one per index`,`compute`);if(u>0){let n=t.dtype,r=[],i=d?void 0:a.astype(n);if(i&&dt(i,t)){let e=i.eval();r.push(e),i=e}let o=i?A(i,0,e.maxStorage(2),r):void 0,l=o?.next??0,f=n===`i32`?`atomic<i32>`:`atomic<u32>`,p=d?`${h(`params.value`,n)}`:a.size===1?`value(0u)`:`value(i)`,g;g=s===`set`?`dst[j] = v;`:n===`f32`?`var old = atomicLoad(&dst[j]);
    loop {
      let swapped = atomicCompareExchangeWeak(&dst[j], old, bitcast<u32>(${s===`add`?`bitcast<f32>(old) + v`:`${s}(bitcast<f32>(old), v)`}));
      if (swapped.exchanged) { break; }
      old = swapped.old_value;
    }`:`atomic${s[0].toUpperCase()}${s.slice(1)}(&dst[j], v);`;let _=`${o?.enables??(n===`f16`?`enable f16;
`:``)}${o?.declarations??``}struct Params { n: u32, len: u32, value: u32, pad: u32 }
${ct}
@group(0) @binding(${l}) var<storage, read> idx: array<i32>;
@group(0) @binding(${l+1}) var<storage, read_write> dst: array<${s===`set`?n:f}>;
@group(0) @binding(${l+2}) var<uniform> params: Params;
${o?.fn??``}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = idx[i];
  if (k < 0) { k += i32(params.len); }
  if (k < 0 || k >= i32(params.len)) { return; }
  let j = u32(k);
  let v = ${p};
  ${g}
}`;e.submit([{program:e.program(_,void 0,`scatter.${s}`),resources:{...o?.resources??{},idx:c,dst:t,params:new Uint32Array([u,t.size,d?m(a,n):0,0])},workgroups:e.grid(Math.ceil(u/256))}]);for(let e of r)e.dispose()}return l&&c.dispose(),t}function pt(e,t,n){let r=n?.length;if(!Number.isInteger(r)||r<0)throw i(`bincount needs length (the number of bins, one past the largest value) as a whole number`,`compute`);return ft(e,e.zeros([r],n.weights?`f32`:`u32`),t,n.weights??1,{op:`add`})}function W(e,t,n){if(e.check(),!(t instanceof O)||!(n instanceof O))throw r(`compact takes an input and a mask (GpuArrays or Exprs)`,`compute`);if(t.size!==n.size)throw i(`compact input (${t.size}) and mask (${n.size}) differ in size`,`compute`);let a=t.size,o=e.empty([a],t.dtype),s=e.empty([1],`u32`);if(a===0)return{values:o,count:s};let c=n.ne(0).eval(),l=e.empty([a],`u32`),u=[c,l],d=[];St(e,c,l,a,d,u);let f=A(t,0,e.maxStorage(4),u),p=`${f.enables}${f.declarations}${ct}
@group(0) @binding(${f.next}) var<storage, read> flags: array<u32>;
@group(0) @binding(${f.next+1}) var<storage, read> offsets: array<u32>;
@group(0) @binding(${f.next+2}) var<storage, read_write> values: array<${t.dtype}>;
@group(0) @binding(${f.next+3}) var<storage, read_write> count: array<u32>;
@group(0) @binding(${f.next+4}) var<uniform> size: vec4u;
${f.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= size.x) { return; }
  if (flags[i] != 0u) { values[offsets[i]] = value(i); }
  if (i == size.x - 1u) { count[0] = offsets[i] + flags[i]; }
}`;d.push({program:e.program(p,void 0,`compact`),resources:{...f.resources,flags:c,offsets:l,values:o,count:s,size:new Uint32Array([a,0,0,0])},workgroups:e.grid(Math.ceil(a/256))}),e.submit(d);for(let e of u)e.dispose();return{values:o,count:s}}function mt(e,t,n){return W(e,t,n)}async function ht(e,t,n){return(await t.read({signal:n}))[0]}async function gt(e,t,n,r={}){let i=W(e,t,n);try{let n=await ht(e,i.count,r.signal),a=e.empty([n],t.dtype);return e.submit([],[[i.values.buffer,0,a.buffer,0,a.byteLength]]),a}finally{i.values.dispose(),i.count.dispose()}}async function _t(e,t,n={}){let r=e.arange(0,t.size,1,`u32`);try{return await gt(e,r,t,n)}finally{r.dispose()}}var vt=2139095040;function yt(e,t,n,r,i,a,o,s){let{combine:c,identity:l}=je(i,n.dtype),u=Math.ceil(r/z),d=e.empty([u],n.dtype),f=A(t,0,e.maxStorage(2),s);if(s.push(d),o.push({program:e.program(e.kernelRoute?.scan(f,c,l)??Me(f,c,l,e.tuned.scan),void 0,`scan`),resources:{...f.resources,dst:n,sums:d,params:new Uint32Array([r,vt,+!!a,0])},workgroups:e.grid(u)}),u===1)return;let p=e.empty([u],n.dtype);s.push(p),yt(e,d,p,u,i,!0,o,s),o.push({program:e.program(Ne(n.dtype,c),void 0,`scan.add`),resources:{data:n,sums:p,params:new Uint32Array([r,vt,0,0])},workgroups:e.grid(u)})}function bt(e,t,n,r,i,a,o,s,c){let{combine:l,identity:u}=je(o,i.dtype),d=Math.ceil(a/z),f=e.empty([a],`u32`),p=e.empty([d],`u32`),m=e.empty([d],i.dtype),h=A(t,0,e.maxStorage(5),c),g=n?void 0:e.empty([1],`u32`);if(c.push(f,p,m),g&&c.push(g),s.push({program:e.program(Pe(h,l,u,!n),void 0,`scan.segmented`),resources:{...h.resources,flagsIn:n??g,dst:i,seen:f,sumFlags:p,sumValues:m,params:new Uint32Array([a,vt,0,r])},workgroups:e.grid(d)}),d===1)return;let _=e.empty([d],i.dtype);c.push(_),bt(e,m,p,0,_,d,o,s,c),s.push({program:e.program(Fe(i.dtype,l),void 0,`scan.segmented.add`),resources:{data:i,seen:f,scanned:_,params:new Uint32Array([a,vt,0,0])},workgroups:e.grid(d)})}function xt(e,t,n,r,i){let{identity:a}=je(i,t.dtype),o=`${t.dtype===`f16`?`enable f16;
`:``}struct Params { n: u32, inf: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> inclusive: array<${t.dtype}>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<${t.dtype}>;
@group(0) @binding(3) var<uniform> params: Params;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (i >= params.n) { return; }
  var start = i == 0u;
  if (params.b > 0u) { start = start || i % params.b == 0u; } else { start = start || flags[i] != 0u; }
  if (start) { dst[i] = ${a}; } else { dst[i] = inclusive[i - 1u]; }
}`,s=e.empty(t.shape,t.dtype);return e.submit([{program:e.program(o,void 0,`scan.exclusive`),resources:{inclusive:t,flags:n??t,dst:s,params:new Uint32Array([t.size,vt,0,n?0:r])},workgroups:e.grid(Math.ceil(t.size/256))}]),s}function St(e,t,n,r,i,a){yt(e,t,n,r,`sum`,!0,i,a)}function Ct(e,t,n={}){if(e.check(),!(t instanceof O))throw r(`scan takes a GpuArray or an Expr`,`compute`);let i=n.op??`sum`,a=!!n.exclusive,o=t.size,s=[],c=[];if(n.axis===void 0||t.ndim<=1){let r=e.empty(n.axis===void 0?[o]:t.shape,t.dtype);if(o===0)return r;yt(e,t,r,o,i,a,c,s),e.submit(c);for(let e of s)e.dispose();return r}let l=P(n.axis,t.ndim),u=[...t.shape.keys()].filter(e=>e!==l).concat(l),d=u.map((e,t)=>u.indexOf(t)),f=t instanceof O&&`transpose`in t?t:t.eval(),p=f.transpose(...u),m=t.shape[l],h=e.empty(p.shape,t.dtype);o>0&&(bt(e,p,void 0,m,h,o,i,c,s),e.submit(c));let g=h;a&&o>0&&(g=xt(e,h,void 0,m,i),h.dispose());let _=g.transpose(...d).eval();g.dispose(),f!==t&&f.dispose();for(let e of s)e.dispose();return _}function wt(e,t,n,i={}){if(e.check(),!(t instanceof O)||!(n instanceof O))throw r(`segmentedScan takes values and flags as GpuArrays or Exprs`,`compute`);if(t.size!==n.size)throw r(`segmentedScan values (${t.size}) and flags (${n.size}) differ in size`,`compute`);let a=i.op??`sum`,o=t.size,s=e.empty([o],t.dtype);if(o===0)return s;let c=n.ne(0).eval(),l=[c],u=[];if(bt(e,t,c,0,s,o,a,u,l),e.submit(u),!i.exclusive){for(let e of l)e.dispose();return s}let d=xt(e,s,c,0,a);s.dispose();for(let e of l)e.dispose();return d}async function Tt(e,t,n,i={}){if(e.check(),t.size!==n.size)throw r(`reduceByKey keys (${t.size}) and values (${n.size}) differ in size`,`compute`);let a=t.size;if(a===0)return{keys:e.empty([0],t.dtype),values:e.empty([0],n.dtype)};let o=t instanceof O&&`storage`in t&&t.contiguous?t:t.eval(),s=o.reshape(a),c=s.slice([0,a-1]),l=s.slice([1,a]).ne(c).eval(),u=e.empty([a],`u32`),d=e.empty([a],`u32`);e.submit([],[[l.buffer,0,u.buffer,4,(a-1)*4],[l.buffer,0,d.buffer,0,(a-1)*4]]),u.write([1],0),d.write([1],a-1);let f=wt(e,n,u,{op:i.op}),p=W(e,s,u),m=W(e,f,d),h=await ht(e,p.count,i.signal),g=e.empty([h],t.dtype),_=e.empty([h],n.dtype);e.submit([],[[p.values.buffer,0,g.buffer,0,g.byteLength],[m.values.buffer,0,_.buffer,0,_.byteLength]]);for(let e of[l,u,d,f,p.values,p.count,m.values,m.count])e.dispose();return o!==t&&o.dispose(),{keys:g,values:_}}var Et=2139095040;function Dt(e,t,n,a){if(e.check(),!(t instanceof O))throw r(`sort takes a GpuArray or an Expr`,`compute`);let s=t.size,c=a.bits??32;if(!Number.isInteger(c)||c<1||c>32)throw i(`Sort bits must be a whole number from 1 to 32, got ${c}`,`compute`);if(c<32&&t.dtype!==`u32`)throw i(`Sort bits below 32 apply to u32 keys only; drop bits for other types`,`compute`);let l=e.kernelRoute||e.sortRoute?256:e.tuned.sort??256,u=Math.max(1,Math.ceil(s/l)),d=u*l,f=n!==void 0,p=[],m=t=>{let n=e.empty([t],`u32`);return p.push(n),n},h=m(d),g=m(d),_=m(f?d:1),v=m(f?d:1);if(s===0)return{keys:h,values:f?_:void 0,scratch:p};let y=[],b=[],x=A(t,0,e.maxStorage(2),p);if(y.push({program:e.program(Re(x),void 0,`sort.keys`),resources:{...x.resources,keys:h,order:_,params:new Uint32Array([s,Et,+!!a.descending,+(n===`index`)])},workgroups:e.grid(Math.ceil(s/256))}),n&&n!==`index`){let t=n.ascontiguous();if(t!==n&&p.push(t),o(t.dtype)!==4)throw r(`sortByKey values must be a 32-bit type; astype("f32") first`,`compute`);b.push([t.buffer,t.offset*4,_.buffer,0,s*4]),e.submit([],b.splice(0))}if(e.sortRoute){let t=Math.ceil(c/4)*4;return y.push({program:e.program(e.sortRoute,void 0,`sort.layer`),resources:{keys:h,values:_,spareKeys:g,spareValues:v,sort:new Uint32Array([s,t===32?4294967295:2**t-1,Math.ceil(t/8),+!!f])},workgroups:[1,1,1]}),e.submit(y),{keys:h,values:f?_:void 0,scratch:p}}let S=m(d),C=m(f?d:1),w=m(16*u),ee=m(16*u),T=m(16*u),E=e.program(e.kernelRoute?.radixLocal??Ve(l),void 0,`sort.local`),D=e.program(He(l),void 0,`sort.scatter`),k=e.grid(u);for(let t=0;t<c;t+=4){let n=new Uint32Array([s,t,u,+!!f]);y.push({program:E,resources:{keysIn:h,valuesIn:_,keysLocal:S,valuesLocal:C,counts:w,starts:T,radix:n},workgroups:k}),St(e,w,ee,16*u,y,p),y.push({program:D,resources:{keysLocal:S,valuesLocal:C,offsets:ee,starts:T,keysOut:g,valuesOut:v,radix:n},workgroups:k}),[h,g]=[g,h],[_,v]=[v,_]}return e.submit(y),{keys:h,values:f?_:void 0,scratch:p}}function Ot(e,t,n={}){let r=Dt(e,t,void 0,n),i=t.size,a=e.empty([i],t.dtype);i>0&&e.submit([{program:e.program(ze(t.dtype),void 0,`sort.values`),resources:{keys:r.keys,dst:a,params:new Uint32Array([i,Et,+!!n.descending,0])},workgroups:e.grid(Math.ceil(i/256))}]);for(let e of r.scratch)e.dispose();return a}function kt(e,t,n={}){let r=Dt(e,t,`index`,n),i=t.size,a=e.empty([i],`u32`);e.submit([],[[r.values.buffer,0,a.buffer,0,i*4]]);for(let e of r.scratch)e.dispose();return a}function At(e,t,n,a={}){if(!(n instanceof O))throw r(`sortByKey values must be a GpuArray or an Expr`,`compute`);if(t.size!==n.size)throw i(`sortByKey keys (${t.size}) and values (${n.size}) differ in size`,`compute`);let o=n.eval(),s=Dt(e,t,o,a),c=t.size,l=e.empty([c],t.dtype),u=e.empty([c],n.dtype);c>0&&e.submit([{program:e.program(ze(t.dtype),void 0,`sort.values`),resources:{keys:s.keys,dst:l,params:new Uint32Array([c,Et,+!!a.descending,0])},workgroups:e.grid(Math.ceil(c/256))}],[[s.values.buffer,0,u.buffer,0,c*4]]),o.dispose();for(let e of s.scratch)e.dispose();return{keys:l,values:u}}function jt(e,t,n,r={}){if(!Number.isInteger(n)||n<0||n>t.size)throw i(`topk k must be a whole number from 0 to ${t.size}, got ${n}`,`compute`);let a=kt(e,t,{descending:r.largest??!0}),o=e.empty([n],`u32`);return e.submit([],[[a.buffer,0,o.buffer,0,n*4]]),a.dispose(),{values:e.take(t,o),indices:o}}function Mt(e,t,n){let r=typeof n==`number`?[n]:[...n];for(let e of r)if(!(e>=0&&e<=1))throw i(`Quantiles must be in [0, 1], got ${e}`,`compute`);let a=t.size;if(a===0)throw i(`quantile of an empty array has no answer`,`compute`);let o=Ot(e,t).astype(`f32`).eval(),s=r.map(e=>Math.floor(e*(a-1))),c=s.map(e=>Math.min(e+1,a-1)),l=r.map((e,t)=>e*(a-1)-s[t]),u=e.take(o,e.array(s,`u32`)),d=e.take(o,e.array(c,`u32`)),f=e.array(l,`f32`),p=u.add(d.sub(u).mul(f)).eval();for(let e of[o,u,d,f])e.dispose();return typeof n==`number`?p.transfer([]):p}async function Nt(e,t,n={}){let r=t.size;if(r===0)return{values:e.empty([0],t.dtype),...n.counts?{counts:e.empty([0],`u32`)}:{}};let i=Ot(e,t),a=e.empty([r],`u32`);if(r>1){let t=i.slice([1,r]).ne(i.slice([0,r-1])).eval();e.submit([],[[t.buffer,0,a.buffer,4,(r-1)*4]]),t.dispose()}a.write([1],0);let o=W(e,i,a),s;if(n.counts){let t=e.arange(0,r,1,`u32`);s=W(e,t,a),t.dispose()}let c=await ht(e,o.count,n.signal),l=e.empty([c],t.dtype);e.submit([],[[o.values.buffer,0,l.buffer,0,l.byteLength]]);let u;if(s){let t=e.empty([c+1],`u32`);e.submit([],[[s.values.buffer,0,t.buffer,0,c*4]]),t.write([r],c),u=t.slice([1,c+1]).sub(t.slice([0,c])).eval(),t.dispose(),s.values.dispose(),s.count.dispose()}for(let e of[i,a,o.values,o.count])e.dispose();return u?{values:l,counts:u}:{values:l}}var Pt=e=>`${e===`f16`?`enable f16;
`:``}struct Given { lo: f32, hi: f32, bins: u32, given: u32 }
@group(0) @binding(0) var<storage, read> low: array<${e}>;
@group(0) @binding(1) var<storage, read> high: array<${e}>;
@group(0) @binding(2) var<storage, read_write> range: array<f32>;
@group(0) @binding(3) var<storage, read_write> edges: array<f32>;
@group(0) @binding(4) var<uniform> given: Given;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var lo = given.lo;
  var hi = given.hi;
  if (given.given == 0u) { lo = f32(low[0]); hi = f32(high[0]); }
  if (lo == hi) { lo -= 0.5; hi += 0.5; }
  if (id.x == 0u) { range[0] = lo; range[1] = hi; }
  if (id.x <= given.bins) { edges[id.x] = lo + (hi - lo) * f32(id.x) / f32(given.bins); }
}`;function Ft(e,t,n={}){if(e.check(),!(t instanceof O))throw r(`histogram takes a GpuArray or an Expr`,`compute`);let a=t.size,o=n.bins??64;if(!Number.isInteger(o)||o<1)throw i(`Histogram bins must be a whole number of at least 1, got ${o}`,`compute`);let s=n.range;if(s){let[e,t]=s;if(!Number.isFinite(e)||!Number.isFinite(t)||e>t)throw i(`Histogram range must be finite [min, max] with min <= max, got [${e}, ${t}]`,`compute`)}else a===0&&(s=[0,1]);let c=e.empty([o],`u32`),l=e.empty([o+1],`f32`),u=e.empty([2],`f32`),d=s?e.empty([1],`f32`):U(e,t,`min`),f=s?d:U(e,t,`max`),p=new DataView(new ArrayBuffer(16));if(p.setFloat32(0,s?.[0]??0,!0),p.setFloat32(4,s?.[1]??0,!0),p.setUint32(8,o,!0),p.setUint32(12,+!!s,!0),e.submit([{program:e.program(Pt(s?`f32`:t.dtype),void 0,`histogram.range`),resources:{low:d,high:f,range:u,edges:l,given:new Uint8Array(p.buffer)},workgroups:[Math.ceil((o+1)/64),1,1]}]),a>0){let n=[],r=A(t,0,e.maxStorage(2),n);e.submit([{program:e.program(We(r,o<=Ue),void 0,`histogram`),resources:{...r.resources,counts:c,range:u,params:new Uint32Array([a,o,0,0])},workgroups:e.grid(Math.ceil(a/z))}]);for(let e of n)e.dispose()}return d.dispose(),f!==d&&f.dispose(),u.dispose(),{counts:c,edges:l}}function It(e,t,n){if(n.indirect){let e=n.indirect instanceof F?n.indirect.buffer:n.indirect,t=(n.indirectOffset??0)*4+(n.indirect instanceof F?n.indirect.offset*4:0);if(!Number.isInteger(t)||t<0)throw i(`indirectOffset must be a whole number of elements`,`compute`);return{indirect:{buffer:e,offset:t}}}let a=e=>typeof e==`number`?[e,1,1]:[e[0],e[1]??1,e[2]??1],o;if(n.workgroups!==void 0)o=a(n.workgroups);else if(n.count!==void 0)o=a(n.count).map((e,n)=>Math.ceil(e/t[n]));else throw r(`Kernel run needs count (threads), workgroups or indirect`,`compute`);let s=e.device.limits.maxComputeWorkgroupsPerDimension;for(let e of o)if(!Number.isInteger(e)||e<0||e>s)throw i(`Kernel run of ${o.join(` x `)} workgroups is over ${s} per dimension; spread the work over y and z`,`compute`);return{workgroups:o}}var Lt=class{#e;#t;#n=!1;constructor(e,t){this.#e=e,this.#t=t,this.bindings=t.info.bindings,this.entryPoint=t.entry.name,this.workgroupSize=t.entry.workgroupSize}#r(){if(this.#n)throw n(`disposed`,`Kernel disposed; compile it again with gpu.kernel()`,`compute`)}run(e,t){this.#r();let n=It(this.#e,this.workgroupSize,t);return(n.indirect||n.workgroups.every(e=>e>0))&&this.#e.submit([{program:this.#t,resources:{...e},...n}]),this}bind(e){return this.#r(),new Rt(this.#e,this.#t,e)}indirectArgs(e=[0,1,1]){return this.#r(),this.#e.indirectArgs(e)}dispose(){this.#n=!0}[Symbol.dispose](){this.dispose()}},Rt=class{#e;#t;#n;#r=new Map;#i;#a=!1;constructor(e,t,n){this.#e=e,this.#t=t,this.#n={...n},this.#o()}#o(){for(let e of this.#r.values())e.destroy();this.#r.clear();let e=[],t={...this.#n};for(let e of this.#t.info.bindings){let n=t[e.name];if(!this.#s(e,n))continue;let r=this.#e.bytesFor(e,n),i=this.#e.device.createBuffer({size:r.byteLength,usage:(e.resource===`uniform`?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_DST});this.#e.device.queue.writeBuffer(i,0,r),this.#r.set(e.name,i),t[e.name]=i}this.#i=this.#e.scoped(()=>this.#e.bindGroups(this.#t,t,e))}#s(e,t){return e.resource!==`uniform`&&e.resource!==`read-only-storage`||t===void 0||t instanceof F||typeof GPUBuffer<`u`&&t instanceof GPUBuffer?!1:!(typeof t==`object`&&t&&`buffer`in t&&!ArrayBuffer.isView(t)&&!Array.isArray(t))}set(e,t){if(this.#a)throw n(`disposed`,`BoundKernel disposed; bind the kernel again`,`compute`);let i=this.#t.info.bindings.find(t=>t.name===e);if(!i)throw r(`Kernel has no binding named ${e}`,`compute`);let a=this.#r.get(e);if(a&&this.#s(i,t)){let n=this.#e.bytesFor(i,t);if(n.byteLength===a.size)return this.#e.device.queue.writeBuffer(a,0,n),this.#n[e]=t,this}return this.#n[e]=t,this.#o(),this}encode(e,t){if(this.#a)throw n(`disposed`,`BoundKernel disposed; bind the kernel again`,`compute`);for(let e of Object.values(this.#n))e instanceof F&&e.check(this.#e);let r=It(this.#e,this.#t.entry.workgroupSize,t);if(r.workgroups&&!r.workgroups.every(e=>e>0))return;let i=`beginComputePass`in e,a=i?e.beginComputePass({label:this.#t.label}):e;a.setPipeline(this.#t.pipeline),this.#i.forEach((e,t)=>a.setBindGroup(t,e)),r.indirect?a.dispatchWorkgroupsIndirect(r.indirect.buffer,r.indirect.offset):a.dispatchWorkgroups(...r.workgroups),i&&a.end()}run(e){return this.#e.check(),this.#e.scoped(()=>{let t=this.#e.device.createCommandEncoder();this.encode(t,e),this.#e.device.queue.submit([t.finish()])}),this}dispose(){if(!this.#a){this.#a=!0;for(let e of this.#r.values())e.destroy();this.#r.clear(),this.#i=void 0}}[Symbol.dispose](){this.dispose()}};function zt(e,t){for(let[n,a]of Object.entries(e)){if(![`reduce`,`scan`,`sort`].includes(n))throw r(`createCompute tuned takes reduce, scan and sort, got ${n}`,`compute`);if(![64,128,256,512,1024].includes(a))throw i(`Tuned ${n} must be 64, 128, 256, 512 or 1024 threads, got ${String(a)}`,`compute`);if(a>t)throw i(`Tuned ${n} of ${a} threads is over this device's limit of ${t}; measure again on it`,`compute`)}}var Bt=512,Vt=e=>{let t={binding:e.binding,visibility:GPUShaderStage.COMPUTE};switch(e.resource){case`uniform`:case`storage`:case`read-only-storage`:return{...t,buffer:{type:e.resource}};case`sampler`:return{...t,sampler:{type:e.sampler}};case`storage-texture`:return{...t,storageTexture:{format:e.texture.format,access:e.texture.access,viewDimension:e.texture.viewDimension}};default:return{...t,texture:{sampleType:e.texture.sampleType,viewDimension:e.texture.viewDimension,multisampled:e.texture.multisampled}}}},G=e=>{if(e?.aborted)throw e.reason};function Ht(e,t){return t?(G(t),new Promise((n,r)=>{let i=()=>r(t.reason);t.addEventListener(`abort`,i,{once:!0}),e.then(n,r).finally(()=>t.removeEventListener(`abort`,i))})):e}var Ut=class{#e;#t;#n;#r;#i;#a;#o;constructor(e,t,n=!1){this.#e=new Set,this.#t=new Map,this.#n=new Set,this.#r=[],this.#i=!1,this.tuned={},this.device=e,this.ownsDevice=t,this.lost=e.lost,this.fastMath=n;let r=pe(e,()=>de(()=>import(`./compat-YK57ZCbA-CpLc6vno.js`),[],import.meta.url));this.routeReady=(r??Promise.resolve(void 0)).then(e=>{this.sortRoute=e?.sortShader}),this.#a=r?me(this.routeReady):Promise.resolve()}get ready(){return this.#a}get disposed(){return this.#i}get backend(){return`webgpu`}get f16(){return this.device.features.has(`shader-f16`)}get subgroups(){return this.device.features.has(`subgroups`)}check(){if(this.#i)throw n(`disposed`,`ComputeContext disposed; create a new one with createCompute()`,`compute`)}#s(e){if(!a.includes(e))throw r(`dtype must be 'f32', 'f16', 'i32' or 'u32', got ${String(e)}`,`compute`);if(e===`f16`&&!this.f16)throw n(`unsupported`,`This GPU has no shader-f16 feature; use 'f32' arrays`,`compute`)}allocate(e,t,n){return this.device.createBuffer({size:e,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST|t})}empty(e,t,n=0){this.check(),this.#s(t);let r=new F(this,t,e,void 0,n);return this.#e.add(r),r}array(e,t={}){let n=typeof t==`string`?{dtype:t}:t;if(typeof e!=`object`||!e||typeof e.length!=`number`)throw r(`gpu.array takes a TypedArray or an array of numbers; use gpu.zeros(shape) for an empty array`,`compute`);let a=e,o=n.dtype??u(a),s=n.shape??[a.length];if(N(s).reduce((e,t)=>e*t,1)!==a.length)throw i(`Shape [${s.join(`, `)}] does not hold ${a.length} elements`,`compute`);return this.empty(s,o).write(a)}indirectArgs(e=[0,1,1]){return this.empty([3],`u32`,GPUBufferUsage.INDIRECT).write(e)}drawable(e,t){return this.empty(typeof e==`number`?[e]:e,t??`f32`,GPUBufferUsage.VERTEX|GPUBufferUsage.INDIRECT)}zeros(e,t){return this.empty(typeof e==`number`?[e]:e,t??`f32`)}ones(e,t){return this.full(e,1,t)}full(e,t,n){let r=typeof e==`number`?[e]:e;return this.#c(r).astype(`f32`).mul(0).add(t).astype(n??`f32`).eval()}arange(e,t,n=1,r){if(t===void 0&&([e,t]=[0,e]),!Number.isFinite(e)||!Number.isFinite(t)||!Number.isFinite(n)||n===0)throw i(`arange needs finite start and stop and a non-zero step, got ${e}, ${t}, ${n}`,`compute`);let a=Math.max(0,Math.ceil((t-e)/n)),o=Number.isInteger(e)&&Number.isInteger(n),s=r??(o?e>=0&&n>0?`u32`:`i32`:`f32`),c=this.#c([a]);return(o&&s!==`f32`&&s!==`f16`?c.astype(`i32`).mul(n).add(e):c.astype(`f32`).mul(n).add(e)).astype(s).eval()}linspace(e,t,n=50){if(!Number.isInteger(n)||n<0)throw i(`linspace num must be a whole number, got ${n}`,`compute`);let r=n>1?(t-e)/(n-1):0;return this.#c([n]).astype(`f32`).mul(r).add(e).eval()}eye(e,t){let n=this.#c([e,e]);return n.floorDiv(e).eq(n.mod(e)).astype(t??`f32`).eval()}#c(e){return this.check(),new k(this,{kind:`index`,dtype:`u32`,shape:N(e)})}where(e,t,n){return M(e,t,n)}forget(e){this.#e.delete(e)}track(e){this.#e.add(e)}evaluate(e){this.check();let t=this.empty(e.shape,e.dtype),n=t.size;if(n===0)return t;let r=[],i=A(e,0,this.maxStorage(1),r),a=`${i.enables}${i.declarations}@group(0) @binding(${i.next}) var<storage, read_write> out: array<${i.dtype}>;
@group(0) @binding(${i.next+1}) var<uniform> size: vec4u;
${i.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (i >= size.x) { return; }
  out[i] = value(i);
}`;this.submit([{program:this.program(a,void 0,`eval`),resources:{...i.resources,out:t,size:new Uint32Array([n,0,0,0])},workgroups:this.grid(Math.ceil(n/256))}]);for(let e of r)e.dispose();return t}maxStorage(e){return Math.max(1,this.device.limits.maxStorageBuffersPerShaderStage-e)}writeUnaligned(e,t,n){let r=t&-4,i=Math.ceil((t+n.length)/4)*4,a=new Uint8Array(i-r),o=(i-r)/4,s=new Uint32Array(o);a.set(n,t-r);for(let e=t-r;e<t-r+n.length;e++)s[e>>2]|=255<<(e&3)*8;let c=this.program(`@group(0) @binding(0) var<storage, read_write> dst: array<u32>;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> keep: array<u32>;
@group(0) @binding(3) var<uniform> at: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= at.y) { return; }
  let m = keep[id.x];
  dst[at.x + id.x] = (dst[at.x + id.x] & ~m) | (src[id.x] & m);
}`,void 0,`write`),l=this.empty([o],`u32`).write(new Uint32Array(a.buffer)),u=this.empty([o],`u32`).write(s);this.submit([{program:c,resources:{dst:e,src:l,keep:u,at:new Uint32Array([r/4,o,0,0])},workgroups:[Math.ceil(o/64),1,1]}]),l.dispose(),u.dispose()}kernel(e,t={}){if(this.check(),typeof e!=`string`)throw r(`gpu.kernel takes WGSL source text`,`compute`);return new Lt(this,this.program(e,t.entryPoint,t.label))}program(e,t,n){let i=`${t??``}\n${e}`,a=this.#t.get(i);if(a)return this.#t.delete(i),this.#t.set(i,a),a;let o=De(e);if(!o.entryPoints.length)throw r(`Kernel WGSL has no @compute entry point`,`compute`);let s=t===void 0?o.entryPoints[0]:o.entryPoints.find(e=>e.name===t);if(!s||t===void 0&&o.entryPoints.length>1)throw r(`Kernel entry point ${t??`(none given)`} not found; pass entryPoint, one of ${o.entryPoints.map(e=>e.name).join(`, `)}`,`compute`);let c=Math.max(-1,...o.bindings.map(e=>e.group))+1,l=n??s.name,u=this.scoped(()=>{let t=Array.from({length:c},(e,t)=>this.device.createBindGroupLayout({entries:o.bindings.filter(e=>e.group===t).map(Vt)}));return{pipeline:this.device.createComputePipeline({label:l,layout:this.device.createPipelineLayout({bindGroupLayouts:t}),compute:{module:this.device.createShaderModule({code:e,label:l}),entryPoint:s.name}}),layouts:t,info:o,entry:s,label:l}});return this.#t.set(i,u),this.#t.size>Bt&&this.#t.delete(this.#t.keys().next().value),u}scoped(e){this.device.pushErrorScope(`validation`),this.device.pushErrorScope(`out-of-memory`),this.device.pushErrorScope(`internal`);try{return e()}finally{for(let e of[`internal error`,`out of memory`,`validation error`])this.#r.push({kind:e,error:this.device.popErrorScope()})}}bindGroups(e,t,n){let i=Object.keys(t).find(t=>!e.info.bindings.some(e=>e.name===t));if(i!==void 0)throw r(`Kernel has no binding named ${i}; its bindings are ${e.info.bindings.map(e=>e.name).join(`, `)}`,`compute`);return e.layouts.map((r,i)=>this.device.createBindGroup({layout:r,entries:e.info.bindings.filter(e=>e.group===i).map(e=>({binding:e.binding,resource:this.resource(e,t[e.name],n)}))}))}encode(e,t){let n=[],r=this.#o&&this.device.features.has(`timestamp-query`)&&t.length>0?this.device.createQuerySet({type:`timestamp`,count:t.length*2}):void 0;if(t.forEach((t,i)=>{let a=this.bindGroups(t.program,t.resources,n),o=e.beginComputePass(r?{timestampWrites:{querySet:r,beginningOfPassWriteIndex:2*i,endOfPassWriteIndex:2*i+1}}:{});o.setPipeline(t.program.pipeline),a.forEach((e,t)=>o.setBindGroup(t,e)),t.indirect?o.dispatchWorkgroupsIndirect(t.indirect.buffer,t.indirect.offset):o.dispatchWorkgroups(...t.workgroups),o.end()}),r){let i=t.length*16,a=this.device.createBuffer({size:i,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),o=this.device.createBuffer({size:i,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});e.resolveQuerySet(r,0,t.length*2,a,0),e.copyBufferToBuffer(a,0,o,0,i),n.push(a),this.#n.add(o),this.#o.push({staging:o,queries:r,labels:t.map(e=>e.program.label)})}return n}submit(e,t=[]){this.check();let n=[];try{this.scoped(()=>{let r=this.device.createCommandEncoder();n=this.encode(r,e);for(let[e,n,i,a,o]of t)o&&r.copyBufferToBuffer(e,n,i,a,o);this.device.queue.submit([r.finish()])})}finally{for(let e of n)e.destroy()}}resource(e,t,n){if(t===void 0)throw r(`Kernel binding ${e.name} is missing; pass it in run()`,`compute`);if(t instanceof F){if(t.check(this),!t.offset)return{buffer:t.buffer};let n=t.offset*o(t.dtype),r=this.device.limits.minStorageBufferOffsetAlignment;if(n%r)throw i(`View ${e.name} starts at byte ${n}, not a multiple of ${r}; bind view.ascontiguous()`,`compute`);return{buffer:t.buffer,offset:n}}let a=typeof GPUBuffer<`u`&&t instanceof GPUBuffer;if(e.resource===`uniform`||e.resource===`storage`||e.resource===`read-only-storage`){if(a)return{buffer:t};if(typeof t==`object`&&t&&`buffer`in t&&!ArrayBuffer.isView(t)&&!Array.isArray(t))return t;if(e.resource===`storage`)throw r(`Kernel binding ${e.name} is read_write; pass a GpuArray or GPUBuffer to keep its results`,`compute`);let i=this.bytesFor(e,t),o=this.device.createBuffer({size:i.byteLength,usage:(e.resource===`uniform`?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_DST});return n.push(o),this.device.queue.writeBuffer(o,0,i),{buffer:o}}return e.resource===`sampler`?t:typeof GPUTexture<`u`&&t instanceof GPUTexture?t.createView({dimension:e.texture.viewDimension}):t}bytesFor(e,t){if(ArrayBuffer.isView(t)){let e=new Uint8Array(t.buffer,t.byteOffset,t.byteLength),n=new Uint8Array(Math.max(16,Math.ceil(e.length/16)*16));return n.set(e),n}if(!e.layout)throw r(`Kernel binding ${e.name} has a type (${e.type}) the kernel cannot lay out; pass bytes`,`compute`);return Ae(e.layout,t,e.name)}grid(e){let t=this.device.limits.maxComputeWorkgroupsPerDimension;if(e<=t)return[Math.max(1,e),1,1];let n=Math.ceil(e/t);if(n>t)throw i(`Compute array too large: ${e} workgroups exceed ${t} x ${t}`,`compute`);return[Math.ceil(e/n),n,1]}async readBytes(e,t,r,i){if(this.check(),G(i),r===0)return await this.#l(),new ArrayBuffer(0);let a=t&-4,o=Math.ceil((t+r)/4)*4,s=this.device.createBuffer({size:o-a,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});this.#n.add(s);let c=()=>s.destroy();i?.addEventListener(`abort`,c,{once:!0});try{let n=this.device.createCommandEncoder();return n.copyBufferToBuffer(e,a,s,0,o-a),this.device.queue.submit([n.finish()]),await this.#l(),await s.mapAsync(GPUMapMode.READ),s.getMappedRange().slice(t-a,t-a+r)}catch(e){throw this.#i?n(`disposed`,`ComputeContext disposed during a read; keep it alive until reads finish`,`compute`):(G(i),e)}finally{i?.removeEventListener(`abort`,c),this.#n.delete(s),s.destroy()}}async#l(){this.device.pushErrorScope(`validation`);let e=[...this.#r,{kind:`validation error`,error:this.device.popErrorScope()}];this.#r=[];let t=await Promise.all(e.map(e=>e.error)),r=t.findIndex(e=>e);if(r>=0)throw n(`failed`,`GPU ${e[r].kind}: ${t[r].message.trim()}; fix the kernel WGSL or its bindings (or use smaller arrays)`,`compute`)}async done(e={}){this.check(),G(e.signal),await this.#l(),await Ht(this.device.queue.onSubmittedWorkDone(),e.signal)}async profile(e,t={}){if(this.check(),this.#o)throw n(`state`,`profile() is already running; await it before profiling again`,`compute`);this.#o=[];let r=[];try{try{await e()}finally{r=this.#o,this.#o=void 0}return await this.#l(),(await Ht(Promise.all(r.map(async({staging:e,labels:t})=>{await e.mapAsync(GPUMapMode.READ);let n=new BigUint64Array(e.getMappedRange().slice(0));return t.map((e,t)=>({label:e,ms:Number(n[2*t+1]-n[2*t])/1e6}))})),t.signal)).flat()}finally{for(let{staging:e,queries:t}of r)this.#n.delete(e),e.destroy(),t.destroy()}}map(e,t,n={}){this.check();let a=e instanceof O?{x:e}:e,o=Object.keys(a);if(!o.length)throw r(`gpu.map needs at least one input array`,`compute`);for(let e of o)if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)||[`i`,`n`,`f`,`main`,`out`,`params`].includes(e)||e.startsWith(`in_`))throw r(`gpu.map input name ${e} is not a usable WGSL name; rename it`,`compute`);if(typeof t!=`string`||!t.trim())throw r(`gpu.map needs a WGSL expression`,`compute`);let s=o.map(e=>{let t=a[e];if(!(t instanceof O))throw r(`gpu.map input ${e} must be a GpuArray or an Expr`,`compute`);return t instanceof F&&t.contiguous&&t.offset===0?t:t.eval()}),c=s[0].shape,l=s[0].size;if(s.some(e=>e.shape.length!==c.length||e.shape.some((e,t)=>e!==c[t])))throw i(`gpu.map inputs must share one shape, got ${s.map(e=>`[${e.shape.join(`, `)}]`).join(`, `)}`,`compute`);let u=n.dtype??s[0].dtype,d=this.empty(c,u);if(l>0){let e=Ie(o.map((e,t)=>({name:e,type:s[t].dtype})),u,t),r={out:d,params:new Uint32Array([l,2139095040,0,0])};o.forEach((e,t)=>r[`in_${e}`]=s[t]),this.submit([{program:this.program(e,void 0,n.label??`map`),resources:r,workgroups:this.grid(Math.ceil(l/256))}])}return o.forEach((e,t)=>s[t]!==a[e]&&s[t].dispose()),d}reduce(e,t=`sum`,n={}){return U(this,e,t,n)}sum(e,t){return U(this,e,`sum`,t)}prod(e,t){return U(this,e,`product`,t)}min(e,t){return U(this,e,`min`,t)}max(e,t){return U(this,e,`max`,t)}mean(e,t){return tt(this,e,t)}var(e,t){return rt(this,e,t)}std(e,t){return it(this,e,t)}argmin(e,t){return st(this,e,`min`,t)}argmax(e,t){return st(this,e,`max`,t)}all(e,t){return U(this,e.ne(0),`min`,t)}any(e,t){return U(this,e.ne(0),`max`,t)}countNonzero(e,t){return U(this,e.ne(0),`sum`,t)}nansum(e,t){return U(this,M(e.isnan(),0,e),`sum`,t)}nanmin(e,t){return U(this,M(e.isnan(),1/0,e),`min`,t)}nanmax(e,t){return U(this,M(e.isnan(),-1/0,e),`max`,t)}nanmean(e,t){return at(this,e,t)}scan(e,t={}){return Ct(this,e,t)}cumsum(e,t={}){return Ct(this,e,t)}cumprod(e,t={}){return Ct(this,e,{...t,op:`product`})}segmentedScan(e,t,n={}){return wt(this,e,t,n)}reduceByKey(e,t,n={}){return Tt(this,e,t,n)}sort(e,t={}){return Ot(this,e,t)}argsort(e,t={}){return kt(this,e,t)}sortByKey(e,t,n={}){return At(this,e,t,n)}topk(e,t,n={}){return jt(this,e,t,n)}quantile(e,t){return Mt(this,e,t)}median(e){return Mt(this,e,.5)}unique(e,t={}){return Nt(this,e,t)}take(e,t,n={}){return ut(this,e,t,n)}scatter(e,t,n,r={}){return ft(this,e,t,n,r)}bincount(e,t){return pt(this,e,t)}compact(e,t){return mt(this,e,t)}filter(e,t,n={}){return gt(this,e,t,n)}nonzero(e,t={}){return _t(this,e,t)}histogram(e,t={}){return Ft(this,e,t)}dispose(){if(!this.#i){this.#i=!0;for(let e of[...this.#e])e.dispose();for(let e of this.#n)e.destroy();this.#t.clear(),this.ownsDevice&&this.device.destroy()}}[Symbol.dispose](){this.dispose()}},Wt=async e=>{let{cpuContext:t}=await de(async()=>{let{cpuContext:e}=await import(`./cpu-load-DZsQ-qON-D1zTlimq.js`);return{cpuContext:e}},[],import.meta.url);return G(e),t()};async function Gt(e){return await e.routeReady,e}async function Kt(e={}){G(e.signal);let t=e.backend??`auto`;if(t!==`auto`&&t!==`webgpu`&&t!==`cpu`)throw r(`createCompute backend must be 'auto', 'webgpu' or 'cpu', got ${String(t)}`,`compute`);if(e.fastMath!==void 0&&typeof e.fastMath!=`boolean`)throw r(`createCompute fastMath must be true or false, got ${String(e.fastMath)}`,`compute`);let i=e.tuned??{};zt(i,1024);let a=e.fastMath===!0,o=(e,t)=>{try{zt(i,e.limits.maxComputeInvocationsPerWorkgroup)}catch(n){throw t&&e.destroy(),n}let n=new Ut(e,t,a);return n.tuned=i,n};if(e.device)return Gt(o(e.device,!1));if(e.engine){let t=e.engine.gpu;if(!t)throw n(`unsupported`,`Engine has no WebGPU device (WebGL2 fallback); create the context without an engine`,`compute`);return Gt(o(t,!1))}if(t===`cpu`)return Wt(e.signal);let s=globalThis.navigator,c=s?.gpu;if(!c){if(t===`auto`)return Wt(e.signal);throw n(`unsupported`,`WebGPU unavailable; use a runtime with WebGPU, or backend: 'cpu'`,`compute`)}let l=e.powerPreference??(/Win/.test(s?.userAgent??``)?void 0:`high-performance`),u=await Ht(c.requestAdapter(l?{powerPreference:l}:{}),e.signal);if(!u){if(t===`auto`)return Wt(e.signal);throw n(`unsupported`,`WebGPU adapter unavailable; check that the GPU is enabled, or use backend: 'cpu'`,`compute`)}let d=await u.requestDevice({requiredFeatures:[`shader-f16`,`timestamp-query`,`subgroups`].filter(e=>u.features.has(e)),requiredLimits:{maxStorageBufferBindingSize:u.limits.maxStorageBufferBindingSize,maxBufferSize:u.limits.maxBufferSize,maxStorageBuffersPerShaderStage:u.limits.maxStorageBuffersPerShaderStage,maxComputeWorkgroupStorageSize:u.limits.maxComputeWorkgroupStorageSize,maxComputeInvocationsPerWorkgroup:u.limits.maxComputeInvocationsPerWorkgroup,maxComputeWorkgroupSizeX:u.limits.maxComputeWorkgroupSizeX,maxComputeWorkgroupSizeY:u.limits.maxComputeWorkgroupSizeY,maxComputeWorkgroupSizeZ:u.limits.maxComputeWorkgroupSizeZ}});if(e.signal?.aborted)throw d.destroy(),e.signal.reason;return Gt(o(d,!0))}var qt=`struct Pass { n: u32, l: u32, lines: u32, inverse: u32 }
@group(0) @binding(0) var<storage, read> reIn: array<f32>;
@group(0) @binding(1) var<storage, read> imIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> reOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> imOut: array<f32>;
@group(0) @binding(4) var<uniform> pass_: Pass;
@group(0) @binding(5) var<storage, read> twiddle: array<vec2f>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let t = (wid.x + wid.y * nwg.x) * 256u + lid;
  let half = pass_.n / 2u;
  if (t >= half * pass_.lines) { return; }
  let line = t / half;
  let j = t % half;
  let base = line * pass_.n;
  let k = j % pass_.l;

  var w = twiddle[k * (half / pass_.l)];
  if (pass_.inverse == 1u) { w.y = -w.y; }
  let a = vec2f(reIn[base + j], imIn[base + j]);
  let b0 = vec2f(reIn[base + j + half], imIn[base + j + half]);
  let b = vec2f(w.x * b0.x - w.y * b0.y, w.x * b0.y + w.y * b0.x);
  let dest = base + 2u * j - k;
  reOut[dest] = a.x + b.x;
  imOut[dest] = a.y + b.y;
  reOut[dest + pass_.l] = a.x - b.x;
  imOut[dest + pass_.l] = a.y - b.y;
}`,Jt=e=>e>0&&!(e&e-1);function Yt(e){if(!Jt(e)||e<2)throw i(`twiddleTable needs a power of two of at least 2, got ${e}`,`compute`);let t=e/2,n=new Float32Array(e);for(let r=0;r<t;r++){let t=2*Math.PI*r/e,i=4*r===e;n[2*r]=i?0:Math.cos(t),n[2*r+1]=i?-1:-Math.sin(t)}return n}var Xt=8,Zt=new WeakMap;function Qt(e,t){let n=Zt.get(e);n||Zt.set(e,n=new Map);let r=n.get(t);if(r&&!r.disposed?n.delete(t):r=e.array(Yt(t)),n.set(t,r),n.size>Xt){let[e,t]=n.entries().next().value;n.delete(e),t.dispose()}return r}function $t(e,t,n,r,i,a){let o=t,s=n,c=[],l=e.program(qt,void 0,`fft.stockham`),u=[],d=r*i,f=e.empty([d],`f32`),p=e.empty([d],`f32`),m=r>2?e.empty([d],`f32`):f,h=r>2?e.empty([d],`f32`):p;if(r===1)return e.submit([],[[t.buffer,t.offset*4,f.buffer,0,d*4],[n.buffer,n.offset*4,p.buffer,0,d*4]]),{re:f,im:p};let g=Qt(e,r),_=0;for(let t=1;t<r;t*=2){let[n,c]=_===0?[f,p]:[m,h];u.push({program:l,resources:{reIn:o,imIn:s,reOut:n,imOut:c,pass_:new Uint32Array([r,t,i,+!!a]),twiddle:g},workgroups:e.grid(Math.ceil(d/2/256))}),o=n,s=c,_^=1}if(e.submit(u),r>2)for(let e of o===f?[m,h]:[f,p])c.push(e);for(let e of c)e.dispose();return{re:o,im:s}}var en=(e,t,n,r)=>({re:e.mul(n).sub(t.mul(r)),im:e.mul(r).add(t.mul(n))});function tn(e,t,n,r,i,a){let o=1;for(;o<2*r-1;)o*=2;let s=a?1:-1,c=new Float32Array(r),l=new Float32Array(r);for(let e=0;e<r;e++){let t=s*Math.PI*(e*e%(2*r))/r;c[e]=Math.cos(t),l[e]=Math.sin(t)}let u=new Float32Array(o),d=new Float32Array(o);for(let e=0;e<r;e++)u[e]=c[e],d[e]=-l[e],e&&(u[o-e]=c[e],d[o-e]=-l[e]);let f=e.array(c,{shape:[1,r]}),p=e.array(l,{shape:[1,r]}),m=e.array(u),h=e.array(d),g=$t(e,m,h,o,1,!1),_=en(t.reshape(i,r),n.reshape(i,r),f,p),v=e.zeros([i,o]),y=e.zeros([i,o]),b=_.re.eval(),x=_.im.eval(),S=[];for(let e=0;e<i;e++)S.push([b.buffer,e*r*4,v.buffer,e*o*4,r*4]),S.push([x.buffer,e*r*4,y.buffer,e*o*4,r*4]);e.submit([],S);let C=$t(e,v,y,o,i,!1),w=g.re.reshape(1,o),ee=g.im.reshape(1,o),T=en(C.re.reshape(i,o),C.im.reshape(i,o),w,ee),E=T.re.eval(),D=T.im.eval(),O=$t(e,E,D,o,i,!0),k=en(O.re.reshape(i,o).slice(null,[0,r]),O.im.reshape(i,o).slice(null,[0,r]),f,p),te={re:k.re.mul(1/o).eval().transfer([i*r]),im:k.im.mul(1/o).eval().transfer([i*r])};for(let e of[f,p,m,h,g.re,g.im,v,y,b,x,C.re,C.im,E,D,O.re,O.im])e.dispose();return te}function nn(e,t,n){let a=e instanceof O?e:e.re,o=e instanceof O?void 0:e.im;if(!(a instanceof O))throw r(`fft takes a real array or { re, im } arrays`,`compute`);if(o&&(o.ndim!==a.ndim||o.shape.some((e,t)=>e!==a.shape[t])))throw i(`fft re and im must have one shape`,`compute`);let s=a.context;if(s.check(),a.ndim===0)throw i(`fft needs at least one dimension`,`compute`);let c=P(t.axis??-1,a.ndim),l=a.shape[c],u=a.shape,d=[...u.keys()].filter(e=>e!==c).concat(c),f=d.map((e,t)=>d.indexOf(t)),p=e=>{let t=e instanceof F?e:e.eval(),n=t.transpose(...d).astype(`f32`).eval();return t!==e&&t.dispose(),n},m=p(a),h=o?p(o):s.zeros(m.shape),g=l?m.size/l:0,_;_=m.size===0?{re:s.zeros(m.shape),im:s.zeros(m.shape)}:Jt(l)?$t(s,m.reshape(m.size),h.reshape(h.size),l,g,n):tn(s,m,h,l,g,n),m.dispose(),h.dispose();let v=d.map(e=>u[e]),y=e=>{let t=e.reshape(...v).transpose(...f),r=(n?t.mul(1/l):t).eval();return e.dispose(),r};return{re:y(_.re),im:y(_.im)}}function rn(e,t={}){return nn(e,t,!1)}function an(e,t={}){return nn(e,t,!0)}function on(e){let t=rn(e,{axis:-1}),n=rn(t,{axis:-2});return t.re.dispose(),t.im.dispose(),n}function sn(e){let t=an(e,{axis:-1}),n=an(t,{axis:-2});return t.re.dispose(),t.im.dispose(),n}var K=65536,cn=[.2126,.7152,.0722],ln=e=>e>=128?e-256:e,un=Array.from({length:256},(e,t)=>ln(t)**2),dn=Float32Array.from({length:K},(e,t)=>un[t%256]+un[t>>8]),fn=Math.log(2);function pn(e,t){let n=new Float32Array(K),r=-fn/(t*t);for(let t=0;t<K;t++){let i=dn[t]*r;e===`none`?n[t]=1:e===`low`?n[t]=Math.exp(i):e===`high`?n[t]=-Math.expm1(i):n[t]=Math.exp(i*.25)-Math.exp(i*4)}return n}var mn=Float32Array.from({length:256},(e,t)=>{let n=t/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});function hn(e){let t=new Float32Array(3*K);for(let n=0;n<K;n++)for(let r=0;r<3;r++)t[r*K+n]=mn[e[n*4+r]];return t}var gn=e=>Math.max(0,Math.min(1,e));function _n(e){let t=gn(e);return Math.round(255*(t<=.0031308?12.92*t:1.055*t**(1/2.4)-.055))}function vn(e,t){let n=new Uint8ClampedArray(K*4),r=t===`high`||t===`band`;for(let t=0;t<K;t++){for(let i=0;i<3;i++){let a=e[i*K+t];n[4*t+i]=_n(r?.16+a*2.6:a)}n[4*t+3]=255}return n}function yn(e,t){let n=new Float32Array(K);for(let r=0;r<K;r++){let i=0;for(let n=0;n<3;n++){let a=n*K+r;i+=cn[n]*(e[a]*e[a]+t[a]*t[a])}n[r]=i}return n}var bn=[[16,11,27],[44,29,78],[81,49,121],[168,78,112],[229,138,119],[255,231,183]];function xn(e){let t=bn.length-1,n=Math.min(t-1,Math.floor(e*t)),r=e*t-n;return bn[n].map((e,t)=>e+(bn[n+1][t]-e)*r)}function Sn(e,t){let n=new Uint8ClampedArray(K*4),r=0,i=0;for(let a=0;a<256;a++)for(let o=0;o<256;o++){let s=(a+128)%256*256+(o+128)%256,c=(a*256+o)*4,l=e[s],u=t[s];r+=l,i+=l*u*u;let d=xn(gn(Math.log1p(l*.33)/10.2)),f=.25+.75*u;n[c]=d[0]*f,n[c+1]=d[1]*f,n[c+2]=d[2]*f,n[c+3]=255}return{rgba:n,kept:r?100*i/r:0}}var q=e=>document.getElementById(e),Cn=q(`tools`),wn=q(`cutoff`),Tn=q(`wipe`),En=q(`state`),Dn=[...Cn.querySelectorAll(`[data-mode]`)],On=q(`image`).getContext(`2d`,{alpha:!1}),J=q(`spectrum`).getContext(`2d`,{alpha:!1}),kn=document.querySelector(`.compare`),Y=document.body.dataset,An=new AbortController,{signal:X}=An,jn={low:[`Low pass`,`Low pass preserves broad glow and smooths fine detail.`],high:[`High pass`,`High pass shows changes around neutral gray, revealing edges and fine detail.`],band:[`Band pass`,`Band pass isolates an intermediate scale. Gray is a zero response.`],none:[`Full spectrum`,`The inverse transform uses all frequencies and rebuilds the source.`]},Mn=new URLSearchParams(location.search).get(`backend`)===`webgl2`,Z,Q,Nn,$=`low`,Pn=0,Fn=!1;function In(){q(`frequency`).value=wn.value+` cycles / frame`,q(`filter-label`).textContent=jn[$][0],q(`meaning`).textContent=jn[$][1],wn.disabled=$===`none`;for(let e of Dn)e.setAttribute(`aria-pressed`,String(e.dataset.mode===$))}function Ln(e,t){if(e===`none`)return;let n=e===`band`?[t*.5,t*2]:[t];J.lineWidth=.65,J.strokeStyle=`rgba(255,230,196,.68)`,J.setLineDash([2,3]);for(let e of n)J.beginPath(),J.arc(128,128,e,0,Math.PI*2),J.stroke();J.setLineDash([])}function Rn(){kn.style.setProperty(`--split`,Tn.value+`%`),q(`split`).value=Tn.value+`%`,Tn.setAttribute(`aria-valuetext`,Tn.value+` percent original`)}async function zn(){let e=kn.querySelector(`img`);if(await e.decode(),e.naturalWidth!==256||e.naturalHeight!==256)throw Error(`Unexpected sample size.`);let t=document.createElement(`canvas`);t.width=t.height=256;let n=t.getContext(`2d`,{alpha:!1,willReadFrequently:!0});return n.drawImage(e,0,0),hn(n.getImageData(0,0,256,256).data)}async function Bn(){if(Mn||!navigator.gpu){let{install:e}=await de(async()=>{let{install:e}=await import(`./dist-ezr9R9v7.js`);return{install:e}},[],import.meta.url);await e({force:!0,signal:X})}return Kt({signal:X})}async function Vn(e,t){let n=pn(e,t),r=Z.array(n,{shape:[256,256]}),i=sn({re:Q.re.mul(r),im:Q.im.mul(r)});try{return{rgba:vn(await i.re.read({signal:X}),e),plot:Sn(Nn,n)}}finally{i.re.dispose(),i.im.dispose(),r.dispose()}}async function Hn(){if(!Fn){Fn=!0;try{for(;!X.aborted;){let e=Pn,t=$,n=wn.valueAsNumber,r=await Vn(t,n);if(X.throwIfAborted(),e===Pn){On.putImageData(new ImageData(r.rgba,256,256),0,0),J.putImageData(new ImageData(r.plot.rgba,256,256),0,0),Ln(t,n),q(`energy`).value=r.plot.kept.toLocaleString(`en-US`,{maximumFractionDigits:2})+`%`,Y.mode=t,Y.cutoff=String(n),Y.energy=r.plot.kept.toFixed(7),Y.revision=String(e),e>0&&!performance.getEntriesByName(`fft-first-mask`).length&&performance.mark(`fft-first-mask`),Y.ready||performance.mark(`fft-first-frame`);break}}}finally{Fn=!1}}}function Un(){Pn++,In(),Hn().catch(Kn)}function Wn(){for(let e of Dn)e.addEventListener(`click`,()=>{$!==e.dataset.mode&&($=e.dataset.mode,Un())},{signal:X});wn.addEventListener(`input`,Un,{signal:X}),Tn.addEventListener(`input`,Rn,{signal:X})}async function Gn(){let e=zn();e.catch(()=>{}),Z=await Bn(),performance.mark(`fft-device`),Y.renderer=Z.backend===`cpu`?`cpu`:Mn||Z.device?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`webgpu`;let t=Z.array(await e,{shape:[3,256,256]});try{Q=on(t)}finally{t.dispose()}let[n,r]=await Promise.all([Q.re.read({signal:X}),Q.im.read({signal:X})]);Nn=yn(n,r),performance.mark(`fft-forward`),await Hn(),Wn(),In(),Rn(),Cn.disabled=!1,Y.ready=`true`,Y.samples=`65536`,En.textContent=`256 × 256 image · RGB transform · `+{webgpu:`WebGPU`,webgl2:`WebGL2 compatibility`,cpu:`CPU fallback`}[Y.renderer]}function Kn(e){X.aborted||(En.textContent=`The transform could not be computed on this device.`,Y.error=e.message,console.error(e))}addEventListener(`pagehide`,e=>{e.persisted||(An.abort(),Q?.re.dispose(),Q?.im.dispose(),Z?.dispose())}),Gn().catch(Kn);export{F as a,s as c,n as d,r as f,P as i,f as l,Ut as n,O as o,de as r,M as s,G as t,i as u};