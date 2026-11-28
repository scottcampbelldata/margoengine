(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=e=>e instanceof Error?e.message:String(e);function t(t,n,r){let i=!1,a=(e,t)=>{e&&t!==void 0&&(e.textContent=t)};return{get failed(){return i},ready(e,r=`true`){return!i&&(a(n,e),t.dataset.ready=r,!0)},pending(e){i||(a(n,e),delete t.dataset.ready)},error(o){let s=e(o);i||a(r??n,s),i=!0,delete t.dataset.ready,t.dataset.error=t.dataset.error??s}}}var n=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),r=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,i=(e,t,i=e)=>n(e,r(t,i)),a=(e,t)=>TypeError(r(e,t)),o=(e,t)=>RangeError(r(e,t)),s=[`f32`,`f16`,`i32`,`u32`],c=e=>e===`f16`?2:4,l=e=>e===`f32`||e===`f16`,u=globalThis.Float16Array;function d(e){switch(e){case`f32`:return Float32Array;case`i32`:return Int32Array;case`u32`:return Uint32Array;case`f16`:if(!u)throw a(`f16 data needs Float16Array; read it as f32 with astype("f32")`,`compute`);return u}}function f(e){if(u&&e instanceof u)return`f16`;if(e instanceof Float32Array||e instanceof Float64Array)return`f32`;if(e instanceof Int32Array||e instanceof Int16Array||e instanceof Int8Array)return`i32`;if(e instanceof Uint32Array||e instanceof Uint16Array||e instanceof Uint8Array||e instanceof Uint8ClampedArray)return`u32`;if(ArrayBuffer.isView(e))throw a(`Compute arrays take number TypedArrays, not BigInt arrays or DataView`,`compute`);return`f32`}function p(e,t){let n=d(t);return e instanceof n&&e.buffer instanceof ArrayBuffer?e:n.from(e)}function m(e,t){return e===t?e:e===`f32`||t===`f32`?`f32`:e===`f16`||t===`f16`?`f16`:`i32`}function h(e,t){return l(t)?t:Number.isInteger(e)?t===`u32`&&e<0?`i32`:t:`f32`}function g(e,t){let n=new DataView(new ArrayBuffer(4));return t===`f32`||t===`f16`?n.setFloat32(0,e,!0):t===`i32`?n.setInt32(0,e,!0):n.setUint32(0,e>>>0,!0),n.getUint32(0,!0)}function _(e,t){return t===`u32`?e:t===`f16`?`f16(bitcast<f32>(${e}))`:`bitcast<${t}>(${e})`}var v=Object.freeze({twoOverPi:[0,2734261102,1313084713,4230436817,4113882560,3680671129,1011060801,4266746795],halfPiFixed:3373259426,halfPi:[1.5707963705062866,-4.371138828673793e-8],quarterPi:[.7853981852531433,-2.1855694143368964e-8],pi:[3.1415927410125732,-8.742277657347586e-8],ln2:[.693145751953125,1428606765330187e-21],ln2Pair:[.6931471824645996,-1.9046542121259336e-9],log2e:[1.4426950216293335,1.925963033500011e-8],sin:[-.1666666716337204,.008333379402756691,-.00019853089179378003,2833021881087916e-21],cos:[.0416666679084301,-.0013888980029150844,2482202216924634e-20,-2.8881245839329495e-7],atan:[-.3333333432674408,.20000059902668,-.14286741614341736,.11114691942930222,-.09025663882493973,.06947030127048492,-.03550770878791809],asin:[.1666666716337204,.07499949634075165,.044659871608018875,.03011295571923256,.024605773389339447,.007497195154428482,.03466988354921341],sinh:[.1666666716337204,.00833326205611229,.00019874409190379083,20846018742304295e-22,6.411173671949655e-7,-2.0997923400045693e-7],cosh:[.0416666679084301,.0013888796092942357,2482521813362837e-20,2.506288865333772e-7,1.1460320692435744e-8],tanh:[-.3333333432674408,.1333339512348175,-.05398104339838028,.021990614011883736,-.009435489773750305,.004868379328399897,-.0023415694013237953],expm1:[.5,.1666666567325592,.04166649281978607,.008333546109497547,.0013932319125160575,.00019761594012379646],log:[.6666666269302368,.40000975131988525,.28498485684394836,.24286234378814697]}),y=e=>{let t=String(e);for(let n=1;n<=9;n++){let r=e.toPrecision(n);if(Math.fround(Number(r))===e){t=r;break}}return/[.e]/.test(t)?t:`${t}.0`},b=(e,t)=>{let n=y(t[t.length-1]);for(let r=t.length-2;r>=0;r--)n=`(${e} * ${n} + ${y(t[r])})`;return n},x=e=>`0x${e.toString(16)}u`,S,C=()=>S??={pmBits:[[],`fn pmExponent(x: f32) -> u32 { return (bitcast<u32>(x) >> 23u) & 0xffu; }
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
const PM_PIO2_HI: f32 = ${y(v.halfPi[0])};
const PM_PIO2_LO: f32 = ${y(v.halfPi[1])};
const PM_PIO4_HI: f32 = ${y(v.quarterPi[0])};
const PM_PIO4_LO: f32 = ${y(v.quarterPi[1])};
const PM_PI_HI: f32 = ${y(v.pi[0])};
const PM_PI_LO: f32 = ${y(v.pi[1])};
const PM_LN2_HI: f32 = ${y(v.ln2[0])};
const PM_LN2_LO: f32 = ${y(v.ln2[1])};
const PM_LN2: f32 = ${y(v.ln2Pair[0])};
const PM_LN2_TAIL: f32 = ${y(v.ln2Pair[1])};
const PM_LOG2E: f32 = ${y(v.log2e[0])};
const PM_LOG2E_LO: f32 = ${y(v.log2e[1])};
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
${v.twoOverPi.map((e,t)=>`    case ${t}u: { return ${x(e)}; }`).join(`
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
 let L = pmMul32(lo, ${v.halfPiFixed}u); let H = pmMul32(hi, ${v.halfPiFixed}u);
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
 let p = ${b(`w`,v.sin)};
 return h + pmHide(l * (1.0 - 0.5 * w) + (h * w) * p);
}
fn pmCosK(h: f32, l: f32) -> f32 {
 let w = pmHide(h * h); let hw = 0.5 * w; let t = pmFastTwoSum(1.0, -hw);
 let ew = pmProductError(h, h, w);
 let p = ${b(`w`,v.cos)};
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
 let p = ${b(`w`,v.atan)};
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
 let p = ${b(`w`,v.asin)};
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
`],pmExp:[[`pmBits`],`fn pmExpm1P(r: f32) -> f32 { return ${b(`r`,v.expm1)}; }
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
 if (a <= 1.0) { let w = a * a; r = a + pmHide((a * w) * ${b(`w`,v.sinh)}); }
 else if (a > 88.72284) { let t = preciseExp(0.5 * a); r = pmHide(0.5 * t) * t; }
 else if (a > 9.0) { r = 0.5 * preciseExp(a); }
 else { let e = preciseExpm1(a); r = 0.5 * (e + preciseDiv(e, e + 1.0)); }
 return pmWithSign(r, x);
}
`],preciseCosh:[[`preciseExp`,`preciseDiv`],`fn preciseCosh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return 1.0; }
 if (a <= 1.0) { let w = a * a; return 1.0 + pmHide((w * w) * ${b(`w`,v.cosh)} + 0.5 * w); }
 if (a > 88.72284) { let t = preciseExp(0.5 * a); return pmHide(0.5 * t) * t; }
 let t = preciseExp(a);
 return 0.5 * (t + preciseDiv(1.0, t));
}
`],preciseTanh:[[`preciseExpm1`,`preciseDiv`],`fn preciseTanh(x: f32) -> f32 {
 let a = abs(x);
 if (pmIsNan(x)) { return x; }
 if (a < 0.000244140625) { return x; }
 if (a > 9.1) { return pmWithSign(1.0, x); }
 if (a <= 0.55) { let w = a * a; return pmWithSign(a + pmHide((a * w) * ${b(`w`,v.tanh)}), x); }
 let e = preciseExpm1(2.0 * a);
 return pmWithSign(preciseDiv(e, e + 2.0), x);
}
`],pmLog:[[`preciseDiv`],`struct PmLogK { s: f32, R: f32, hfsq: f32, t: f32 }
fn pmLogK(f: f32) -> PmLogK {
 let s = preciseDiv(f, 2.0 + f);
 let z = s * s;
 let R = z * ${b(`z`,v.log)};
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
 let w = pmFastTwoSum(${y(Math.fround(2/3))}, ${y(Math.fround(2/3-Math.fround(2/3)))} + z * ${b(`z`,[2/5,2/7,2/9,2/11,2/13,2/15].map(e=>Math.fround(e)))});
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
`]},w=Object.freeze([`preciseDiv`,`preciseSqrt`,`preciseSin`,`preciseCos`,`preciseTan`,`preciseAtan`,`preciseAtan2`,`preciseAsin`,`preciseAcos`,`preciseExp`,`preciseExp2`,`preciseExpm1`,`preciseSinh`,`preciseCosh`,`preciseTanh`,`preciseLog`,`preciseLog2`,`preciseLog1p`,`precisePow`]);function ee(e){let t=[],n=new Set,r=e=>{if(n.has(e))return;let i=C()[e];if(!i)throw RangeError(`Unknown precise maths function ${e}; use one of ${w.join(`, `)}`);n.add(e);for(let e of i[0])r(e);t.push(i[1])};for(let t of e)r(t);return t.join(``)}function T(e,t){let n=Math.max(e.length,t.length),r=[];for(let i=0;i<n;i++){let a=e[e.length-n+i]??1,s=t[t.length-n+i]??1;if(a!==s&&a!==1&&s!==1)throw o(`Shapes [${e.join(`, `)}] and [${t.join(`, `)}] do not broadcast; reshape one of them`,`compute`);r.push(a===1?s:a)}return r}var E=e=>e.kind===`leaf`?e.array.shape:e.kind===`scalar`?[]:e.shape,D=new Set([`div`,`pow`,`sqrt`,`rsqrt`,`exp`,`exp2`,`log`,`log2`,`log1p`,`expm1`,`sin`,`cos`,`tan`,`asin`,`acos`,`atan`,`atan2`,`sinh`,`cosh`,`tanh`,`reciprocal`,`hypot`,`degrees`,`radians`]),O=new Set([`bitAnd`,`bitOr`,`bitXor`,`bitNot`,`shiftLeft`,`shiftRight`,`popcount`]),te=new Set([`lt`,`le`,`gt`,`ge`,`eq`,`ne`,`and`,`or`,`xor`,`not`,`isnan`,`isinf`,`isfinite`]),k=class e{get size(){return this.shape.reduce((e,t)=>e*t,1)}get ndim(){return this.shape.length}op(t,n,r){let i=(n.find(t=>t instanceof e)??this).dtype;for(let t of n)t instanceof e&&(i=m(i,t.dtype));for(let e of n)typeof e==`number`&&(i=m(i,h(e,i)));if(O.has(t)&&l(i))throw a(`${t} needs integer arrays; astype('i32') or astype('u32') first`,`compute`);let o=n.map(n=>{if(typeof n==`number`)return{kind:`scalar`,value:n,dtype:i};if(!(n instanceof e))throw a(`Operand of ${t} must be a number, a GpuArray or an Expr`,`compute`);if(n.context!==this.context)throw a(`Operand of ${t} belongs to another compute context; create it with this context`,`compute`);return n.node()}),s=o.map(E).reduce((e,t)=>T(e,t),[]),c=r??(te.has(t)?`u32`:D.has(t)&&!l(i)?`f32`:i);return new ne(this.context,{kind:`op`,op:t,args:o,dtype:c,shape:s})}add(e){return this.op(`add`,[this,e])}sub(e){return this.op(`sub`,[this,e])}mul(e){return this.op(`mul`,[this,e])}div(e){return this.op(`div`,[this,e])}floorDiv(e){return this.op(`floorDiv`,[this,e])}mod(e){return this.op(`mod`,[this,e])}pow(e){return this.op(`pow`,[this,e])}minimum(e){return this.op(`minimum`,[this,e])}maximum(e){return this.op(`maximum`,[this,e])}clip(e,t){return this.op(`clip`,[this,e,t])}atan2(e){return this.op(`atan2`,[this,e])}hypot(e){return this.op(`hypot`,[this,e])}neg(){return this.op(`neg`,[this])}abs(){return this.op(`abs`,[this])}sign(){return this.op(`sign`,[this])}square(){return this.op(`square`,[this])}sqrt(){return this.op(`sqrt`,[this])}rsqrt(){return this.op(`rsqrt`,[this])}reciprocal(){return this.op(`reciprocal`,[this])}exp(){return this.op(`exp`,[this])}exp2(){return this.op(`exp2`,[this])}expm1(){return this.op(`expm1`,[this])}log(){return this.op(`log`,[this])}log2(){return this.op(`log2`,[this])}log1p(){return this.op(`log1p`,[this])}sin(){return this.op(`sin`,[this])}cos(){return this.op(`cos`,[this])}tan(){return this.op(`tan`,[this])}asin(){return this.op(`asin`,[this])}acos(){return this.op(`acos`,[this])}atan(){return this.op(`atan`,[this])}sinh(){return this.op(`sinh`,[this])}cosh(){return this.op(`cosh`,[this])}tanh(){return this.op(`tanh`,[this])}degrees(){return this.op(`degrees`,[this])}radians(){return this.op(`radians`,[this])}floor(){return this.op(`floor`,[this])}ceil(){return this.op(`ceil`,[this])}round(){return this.op(`round`,[this])}trunc(){return this.op(`trunc`,[this])}lt(e){return this.op(`lt`,[this,e])}le(e){return this.op(`le`,[this,e])}gt(e){return this.op(`gt`,[this,e])}ge(e){return this.op(`ge`,[this,e])}eq(e){return this.op(`eq`,[this,e])}ne(e){return this.op(`ne`,[this,e])}and(e){return this.op(`and`,[this,e])}or(e){return this.op(`or`,[this,e])}xor(e){return this.op(`xor`,[this,e])}not(){return this.op(`not`,[this])}isnan(){return this.op(`isnan`,[this])}isinf(){return this.op(`isinf`,[this])}isfinite(){return this.op(`isfinite`,[this])}bitAnd(e){return this.op(`bitAnd`,[this,e])}bitOr(e){return this.op(`bitOr`,[this,e])}bitXor(e){return this.op(`bitXor`,[this,e])}bitNot(){return this.op(`bitNot`,[this])}shiftLeft(e){return this.op(`shiftLeft`,[this,e])}shiftRight(e){return this.op(`shiftRight`,[this,e])}popcount(){return this.op(`popcount`,[this])}bitcast(e){if(this.dtype===`f16`)throw a(`bitcast needs a 32-bit type; astype f16 to f32 first`,`compute`);return this.op(`bitcast`,[this],e)}astype(e){return this.op(`astype`,[this],e)}eval(){return this.context.evaluate(this)}async read(e){let t=this.eval();try{return await t.read(e)}finally{t.dispose()}}async item(e){if(this.size!==1)throw o(`item() needs exactly one element, the shape is [${this.shape.join(`, `)}]; reduce it first`,`compute`);return(await this.read(e))[0]}sum(e){return this.context.sum(this,e)}prod(e){return this.context.prod(this,e)}min(e){return this.context.min(this,e)}max(e){return this.context.max(this,e)}mean(e){return this.context.mean(this,e)}var(e){return this.context.var(this,e)}std(e){return this.context.std(this,e)}argmin(e){return this.context.argmin(this,e)}argmax(e){return this.context.argmax(this,e)}all(e){return this.context.all(this,e)}any(e){return this.context.any(this,e)}},ne=class extends k{#e;constructor(e,t){super(),this.context=e,this.#e=t}get dtype(){return this.#e.dtype}get shape(){return this.#e.shape}node(){return this.#e}},re=`xyzw`,ie=e=>{let t=Array(e.length),n=1;for(let r=e.length-1;r>=0;r--)t[r]=n,n*=e[r];return t},ae={pow:`precisePow`,atan2:`preciseAtan2`,sqrt:`preciseSqrt`,exp:`preciseExp`,exp2:`preciseExp2`,expm1:`preciseExpm1`,log:`preciseLog`,log2:`preciseLog2`,log1p:`preciseLog1p`,sin:`preciseSin`,cos:`preciseCos`,tan:`preciseTan`,asin:`preciseAsin`,acos:`preciseAcos`,atan:`preciseAtan`,sinh:`preciseSinh`,cosh:`preciseCosh`,tanh:`preciseTanh`};function oe(e,t,n,r,i){let[o,s,c]=t,u=`${n}(0)`,d=e=>`select(0u, 1u, ${e})`,f=e=>l(n)?e:`f32(${e})`,p=i&&ae[e];if(p){i.add(p);let a=e=>n===`f32`?e:`f32(${e})`,o=`${p}(${t.slice(0,e===`pow`||e===`atan2`?2:1).map(e=>`operandF32(${a(e)})`).join(`, `)})`;return r===`f32`?o:`${r}(${o})`}switch(e){case`add`:return`(${o} + ${s})`;case`sub`:return`(${o} - ${s})`;case`mul`:return`(${o} * ${s})`;case`div`:return`(${f(o)} / ${f(s)})`;case`floorDiv`:return l(n)?`floor(${o} / ${s})`:n===`u32`?`select(0u, ${o} / ${s}, ${s} != 0u)`:`select(0i, (${o} / ${s}) - select(0i, 1i, (${o} % ${s} != 0i) && ((${o} < 0i) != (${s} < 0i))), ${s} != 0i)`;case`mod`:return l(n)?`(${o} - ${s} * floor(${o} / ${s}))`:n===`u32`?`select(0u, ${o} % ${s}, ${s} != 0u)`:`select(0i, ((${o} % ${s}) + ${s}) % ${s}, ${s} != 0i)`;case`pow`:return`pow(${f(o)}, ${f(s)})`;case`minimum`:return`min(${o}, ${s})`;case`maximum`:return`max(${o}, ${s})`;case`clip`:return`clamp(${o}, ${s}, ${c})`;case`atan2`:return`atan2(${f(o)}, ${f(s)})`;case`hypot`:return`length(vec2(${f(o)}, ${f(s)}))`;case`neg`:return n===`u32`?`(0u - ${o})`:`(-${o})`;case`abs`:return`abs(${o})`;case`sign`:return n===`u32`?`select(0u, 1u, ${o} > 0u)`:`sign(${o})`;case`square`:return`(${o} * ${o})`;case`sqrt`:case`exp`:case`exp2`:case`log`:case`log2`:case`sin`:case`cos`:case`tan`:case`asin`:case`acos`:case`atan`:case`sinh`:case`cosh`:case`tanh`:case`degrees`:case`radians`:return`${e}(${f(o)})`;case`rsqrt`:return`inverseSqrt(${f(o)})`;case`reciprocal`:return`(1.0 / ${f(o)})`;case`log1p`:{let e=f(o),t=`(1.0 + ${e})`,n=`bitcast<u32>(${t})`,r=`(ldexp(f32(i32((${n} & 0x7fffffu) | 0x800000u)), i32((${n} >> 23u) & 0xffu) - 150i) - 1.0)`;return`select(${e} * log(${t}) / ${r}, ${e}, ${r} == 0.0)`}case`expm1`:{let e=f(o),t=`exp(${e})`;return`select(select(select((${t} - 1.0) * ${e} / log(${t}), ${e}, ${t} == 1.0), -1.0, ${e} < -80.0), ${t}, ${e} > 80.0)`}case`floor`:case`ceil`:case`round`:case`trunc`:return l(n)?`${e}(${o})`:o;case`lt`:return d(`${o} < ${s}`);case`le`:return d(`${o} <= ${s}`);case`gt`:return d(`${o} > ${s}`);case`ge`:return d(`${o} >= ${s}`);case`eq`:return d(`${o} == ${s}`);case`ne`:return d(`${o} != ${s}`);case`and`:return d(`(${o} != ${u}) && (${s} != ${u})`);case`or`:return d(`(${o} != ${u}) || (${s} != ${u})`);case`xor`:return d(`(${o} != ${u}) != (${s} != ${u})`);case`not`:return d(`${o} == ${u}`);case`isnan`:case`isinf`:case`isfinite`:{if(!l(n))return e===`isfinite`?`1u`:`0u`;let t=n===`f16`?`(bitcast<u32>(f32(${o})) & 0x7fffffffu)`:`(bitcast<u32>(${o}) & 0x7fffffffu)`;return d(e===`isnan`?`${t} > 0x7f800000u`:e===`isinf`?`${t} == 0x7f800000u`:`${t} < 0x7f800000u`)}case`bitAnd`:case`bitOr`:case`bitXor`:case`bitNot`:case`shiftLeft`:case`shiftRight`:case`popcount`:if(l(n))throw a(`${e} needs integer arrays; astype('i32') or astype('u32') first`,`compute`);return e===`bitAnd`?`(${o} & ${s})`:e===`bitOr`?`(${o} | ${s})`:e===`bitXor`?`(${o} ^ ${s})`:e===`bitNot`?`(~${o})`:e===`shiftLeft`?`(${o} << (u32(${s}) & 31u))`:e===`shiftRight`?`(${o} >> (u32(${s}) & 31u))`:`${n}(countOneBits(${o}))`;case`bitcast`:return`bitcast<${r}>(${o})`;case`astype`:return`${r}(${o})`;case`where`:return`select(${c}, ${s}, ${o} != ${u})`;default:throw a(`Unknown element-wise operation ${e}`,`compute`)}}function A(e,t,n,r){let i=e.node(),a=e.shape,s=(e,t=new Set)=>{if(e.kind===`leaf`)t.add(e.array.storage);else if(e.kind===`op`)for(let n of e.args)s(n,t);return t},c=t=>{if(t.kind!==`op`||s(t).size<=n)return t;let i=t.args.map(c),a={...t,args:i};for(;s(a).size>n;){let t=a.args.map((e,t)=>[t,e.kind===`op`?s(e).size:0]).sort((e,t)=>t[1]-e[1])[0];if(!t||t[1]===0)throw o(`Expression reads more than ${n} buffers in one operation; evaluate parts of it first`,`compute`);let i=a.args[t[0]],c=e.context.evaluate(new ne(e.context,i));r.push(c);let l=[...a.args];l[t[0]]={kind:`leaf`,array:c},a={...a,args:l}}return a};i=c(i);let l=new Map,u={},d=[],f=[],p=new Map,h=``,v=t,y=!1,b=e.context.fastMath?void 0:new Set,x=ie(a),S=(e,t,n)=>t===n?e:`${n}(${e})`,C=t=>{let n=p.get(t);if(n!==void 0)return n;let r;if(t.kind===`leaf`){let n=t.array,i=l.get(n.storage);i||(i=`src${l.size}`,l.set(n.storage,i),h+=`@group(0) @binding(${v++}) var<storage, read> ${i}: array<${n.dtype}>;
`,n.check(e.context),u[i]={buffer:n.storage.buffer});let o=a.length,s=n.contiguous&&n.shape.length===o&&n.shape.every((e,t)=>e===a[t]),c;if(s)c=n.offset?`(i + ${n.offset}u)`:`i`;else{let e=n.strides.some(e=>e<0),t=e?`i`:`u`,r=n.offset?[`${n.offset}${t}`]:[];for(let i=0;i<n.shape.length;i++){let s=o-n.shape.length+i;if(n.shape[i]===1||n.strides[i]===0)continue;let c=s===0?`(i / ${x[0]}u)`:`((i / ${x[s]}u) % ${a[s]}u)`;e&&(c=`i32${c}`),r.push(n.strides[i]===1?c:`${c} * ${n.strides[i]}${t}`)}c=r.length?e?`u32(${r.join(` + `)})`:r.join(` + `):`0u`}r=`${i}[${c}]`}else if(t.kind===`scalar`){let e=d.length;d.push(g(t.value,t.dtype)),r=_(`fused[${e>>2}].${re[e&3]}`,t.dtype)}else if(t.kind===`index`)r=`i`;else if(t.op===`where`){let[e,n,i]=t.args;r=`select(${S(C(i),j(i),t.dtype)}, ${S(C(n),j(n),t.dtype)}, ${C(e)} != ${j(e)}(0))`}else{let e=t.args.map(j).reduce(m);r=oe(t.op,t.args.map(t=>S(C(t),j(t),e)),e,t.dtype,b)}let i=j(t);i===`f16`&&(y=!0);let o=`v${p.size}`;return f.push(`let ${o}: ${i} = ${r};`),p.set(t,o),o},w=C(i),T=Math.max(1,Math.ceil(d.length/4)),E=new Uint32Array(T*4);E.set(d),h+=`@group(0) @binding(${v++}) var<uniform> fused: array<vec4u, ${T}>;\n`,u.fused=E;let D=`${b?.size?`${ee([...b])}
fn operandF32(v: f32) -> f32 {
  if ((bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u) { return v; }
  return pmHide(v);
}
`:``}fn value(i: u32) -> ${e.dtype} {\n  ${f.join(`
  `)}\n  return ${w};\n}`;return{enables:y?`enable f16;
`:``,declarations:h,fn:D,resources:u,next:v,dtype:e.dtype,shape:a,key:`${h}\n${D}`}}var j=e=>e.kind===`leaf`?e.array.dtype:e.dtype;function M(e,t,n){if(!(e instanceof k))throw a(`where needs a condition array or expression`,`compute`);let r=(e,t)=>typeof e==`number`?h(e,t instanceof k?t.dtype:`f32`):e.dtype,i=m(r(t,n),r(n,t));return e.op(`where`,[e,t,n],i)}function se(e){let t=Array(e.length),n=1;for(let r=e.length-1;r>=0;r--)t[r]=n,n*=e[r];return t}function N(e,t=`Shape`){if(!Array.isArray(e)||e.some(e=>!Number.isInteger(e)||e<0))throw o(`${t} must be whole numbers of at least 0, got [${String(e)}]`,`compute`);return[...e]}function P(e,t){if(!Number.isInteger(e)||e<-t||e>=Math.max(t,1))throw o(`Axis ${e} is out of range for ${t} dimensions`,`compute`);return e<0?e+t:e}var F=class e extends k{#e=!1;#t;constructor(e,t,n,r,i=0){if(super(),this.context=e,this.dtype=t,this.shape=Object.freeze(N(n)),r){this.storage=r.storage,this.strides=Object.freeze([...r.strides]),this.offset=r.offset,this.#t=!!r.owner;return}let a=this.size,s=a*c(t),l=e.device.limits.maxStorageBufferBindingSize;if(s>l)throw o(`GpuArray of ${a} ${t} elements needs ${s} bytes, over this device's ${l}-byte storage binding limit; split the data or stream it`,`compute`);this.storage={buffer:e.allocate(Math.max(16,Math.ceil(s/16)*16),i,t),dtype:t,disposed:!1},this.strides=Object.freeze(se(this.shape)),this.offset=0,this.#t=!0}get buffer(){return this.storage.buffer}get byteLength(){return this.size*c(this.dtype)}get contiguous(){let e=se(this.shape);return this.shape.every((t,n)=>t===1||this.strides[n]===e[n])}get disposed(){return this.#e||this.storage.disposed}get owner(){return this.#t}node(){return{kind:`leaf`,array:this}}check(e){if(this.disposed)throw i(`disposed`,`GpuArray disposed; create a new array with gpu.array()`,`compute`);if(e!==this.context)throw i(`state`,`GpuArray belongs to another compute context; create it with this context`,`compute`)}#n(t,n,r){return this.check(this.context),new e(this.context,this.dtype,t,{storage:this.storage,strides:n,offset:r})}reshape(...e){let t=e.length===1&&Array.isArray(e[0])?e[0]:e,n=t.filter(e=>e!==-1).reduce((e,t)=>e*t,1);if(t.filter(e=>e===-1).length>1)throw o(`reshape takes at most one -1 dimension`,`compute`);let r=t.map(e=>e===-1?n?this.size/n:0:e);if(N(r),r.reduce((e,t)=>e*t,1)!==this.size)throw o(`Cannot reshape ${this.size} elements [${this.shape.join(`, `)}] into [${t.join(`, `)}]`,`compute`);let i=this.contiguous?this:this.eval();return i.#n(r,se(r),i.offset)}flatten(){return this.reshape(this.size)}transpose(...e){let t=e.length?e.map(e=>P(e,this.ndim)):this.shape.map((e,t)=>this.ndim-1-t);if(t.length!==this.ndim||new Set(t).size!==this.ndim)throw o(`transpose needs a permutation of ${this.ndim} axes, got [${e.join(`, `)}]`,`compute`);return this.#n(t.map(e=>this.shape[e]),t.map(e=>this.strides[e]),this.offset)}get T(){return this.transpose()}slice(...e){if(e.length>this.ndim)throw o(`slice got ${e.length} specs for ${this.ndim} dimensions`,`compute`);let t=this.offset,n=[],r=[];return this.shape.forEach((i,a)=>{let s=e[a]??null;if(typeof s==`number`){let e=s<0?s+i:s;if(!Number.isInteger(s)||e<0||e>=i)throw o(`Index ${s} is out of range for dimension ${a} of length ${i}`,`compute`);t+=e*this.strides[a];return}let[c,l,u]=s??[],d=u??1;if(!Number.isInteger(d)||d===0)throw o(`Slice step must be a non-zero integer, got ${d}`,`compute`);let f=(e,t)=>{if(e==null)return t;let n=e<0?e+i:e;return d>0?Math.min(Math.max(n,0),i):Math.min(Math.max(n,-1),i-1)},p=f(c,d>0?0:i-1),m=f(l,d>0?i:-1),h=Math.max(0,Math.ceil((m-p)/d));h&&(t+=p*this.strides[a]),n.push(h),r.push(this.strides[a]*d)}),this.#n(n,r,t)}expandDims(e){let t=e<0?e+this.ndim+1:e;if(!Number.isInteger(t)||t<0||t>this.ndim)throw o(`expandDims axis ${e} is out of range`,`compute`);let n=[...this.shape],r=[...this.strides];return n.splice(t,0,1),r.splice(t,0,0),this.#n(n,r,this.offset)}squeeze(e){let t=e===void 0?this.shape.map(e=>e===1):this.shape.map((t,n)=>n===P(e,this.ndim));if(e!==void 0&&this.shape[P(e,this.ndim)]!==1)throw o(`squeeze axis ${e} has length ${this.shape[P(e,this.ndim)]}, not 1`,`compute`);return this.#n(this.shape.filter((e,n)=>!t[n]),this.strides.filter((e,n)=>!t[n]),this.offset)}broadcastTo(e){N(e);let t=e.length;if(t<this.ndim)throw o(`Cannot broadcast [${this.shape.join(`, `)}] to fewer dimensions`,`compute`);let n=e.map((n,r)=>{let i=r-(t-this.ndim);if(i<0)return 0;if(this.shape[i]===n)return this.strides[i];if(this.shape[i]===1)return 0;throw o(`Cannot broadcast [${this.shape.join(`, `)}] to [${e.join(`, `)}]`,`compute`)});return this.#n(e,n,this.offset)}ascontiguous(){return this.check(this.context),this.contiguous&&this.offset===0?this:this.eval()}transfer(t){if(!this.#t||!this.contiguous||this.offset)throw i(`state`,`Only a contiguous owning array can transfer its buffer`,`compute`);if(N(t).reduce((e,t)=>e*t,1)!==this.size)throw o(`Cannot give ${this.size} elements the shape [${t.join(`, `)}]`,`compute`);let n=new e(this.context,this.dtype,t,{storage:this.storage,strides:se(t),offset:0,owner:!0});return this.#t=!1,this.#e=!0,this.context.forget(this),this.context.track(n),n}write(e,t=0){if(this.check(this.context),!this.contiguous)throw a(`write needs a contiguous array; write to the array the view came from`,`compute`);if(!Number.isInteger(t)||t<0||t+e.length>this.size)throw o(`GpuArray write of ${e.length} elements at ${t} does not fit ${this.size} elements`,`compute`);if(!e.length)return this;let n=p(e,this.dtype),r=c(this.dtype),i=(this.offset+t)*r;return i%4||n.byteLength%4?this.context.writeUnaligned(this.storage.buffer,i,new Uint8Array(n.buffer,n.byteOffset,n.byteLength)):this.context.device.queue.writeBuffer(this.storage.buffer,i,n),this}async read(e={}){if(this.check(this.context),!this.contiguous)return await super.read(e);let t=e.offset??0,n=e.length??this.size-t;if(!Number.isInteger(t)||!Number.isInteger(n)||t<0||n<0||t+n>this.size)throw o(`GpuArray read of ${n} elements at ${t} is outside ${this.size} elements`,`compute`);let r=c(this.dtype),i=await this.context.readBytes(this.storage.buffer,(this.offset+t)*r,n*r,e.signal);return new(d(this.dtype))(i)}dispose(){this.#e||(this.#e=!0,this.#t&&(this.storage.disposed=!0,this.storage.buffer.destroy(),this.context.forget(this)))}[Symbol.dispose](){this.dispose()}},ce=`modulepreload`,le=function(e,t){return new URL(e,t).href},ue={},de=function(e){return e.pathname.endsWith(`.css`)},fe=function(e,t,n){if(t in e)return e[t];let r=n();if(!r){e[t]=void 0;return}let i=r.then(()=>{e[t]=void 0},n=>{throw e[t]=void 0,n});return e[t]=i,i},pe=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e,i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}function s(e){return import.meta.resolve?new URL(import.meta.resolve(e)):new URL(e,import.meta.url)}r=o(t.map(t=>{t=le(t,n);let r=s(t),i=de(r);return fe(ue,r.href,()=>{if(e===void 0){e={all:new Set,styles:new Set};let t=document.getElementsByTagName(`link`);for(let n=t.length-1;n>=0;n--){let r=t[n];e.all.add(r.href),r.rel===`stylesheet`&&e.styles.add(r.href)}}if((i?e.styles:e.all).has(r.href))return;let t=document.createElement(`link`);if(t.rel=i?`stylesheet`:ce,i||(t.as=`script`),t.crossOrigin=``,t.href=r.href,a&&t.setAttribute(`nonce`,a),document.head.appendChild(t),i)return new Promise((e,n)=>{t.addEventListener(`load`,e),t.addEventListener(`error`,()=>n(Error(`Unable to preload CSS for ${r}`)))})})}).filter(e=>e!==void 0))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})};function me(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function he(e,t){return me(e)===`webgl2`?t():void 0}function ge(e){return e?e.then(()=>void 0,()=>void 0):Promise.resolve()}var _e=new Float32Array(1),ve=new Uint32Array(_e.buffer);function ye(e){_e[0]=e;let t=Math.abs(e)-Math.abs(_e[0]);(t>0||t<0)&&!(ve[0]&1)&&(ve[0]+=t>0?1:-1);let n=ve[0],r=n>>>16&32768,i=n>>>23&255,a=n&8388607;if(i===255)return r|31744|(a?512:0);let o=i-127+15;if(o>=31)return r|31744;if(o<=0){if(o<-10)return r;let e=(a|8388608)>>>1-o+13,t=(a|8388608)&(1<<1-o+13)-1,n=1<<1-o+12;return r|e+(t>n||t===n&&e&1?1:0)}let s=a>>>13,c=a&8191,l=r|o<<10|s;return(c>4096||c===4096&&s&1)&&l++,l}var be=new Set([`f32`,`i32`,`u32`,`f16`,`bool`]),xe={f:`f32`,i:`i32`,u:`u32`,h:`f16`};function Se(e){let t=``,n=0;for(let r=0;r<e.length;r++){let i=e[r],a=e[r+1];if(n===0&&i===`/`&&a===`/`){for(;r<e.length&&e[r]!==`
`;)r++;t+=`
`}else i===`/`&&a===`*`?(n++,r++):n>0&&i===`*`&&a===`/`?(n--,r++):n===0?t+=i:i===`
`&&(t+=`
`)}return t}function Ce(e){let t=[],n=0,r=0;for(let i=0;i<e.length;i++){let a=e[i];a===`<`||a===`(`?n++:a===`>`||a===`)`?n--:a===`,`&&n===0&&(t.push(e.slice(r,i).trim()),r=i+1)}let i=e.slice(r).trim();return i&&t.push(i),t}var I=(e,t)=>Math.ceil(t/e)*e;function we(e){let t=new Map,n=new Map,r=new Map;for(let n of e.matchAll(/\balias\s+(\w+)\s*=\s*([^;]+);/g))t.set(n[1],n[2].trim());for(let t of e.matchAll(/\b(?:const|override)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*([^;]+);/g))r.set(t[1],t[2].trim());for(let t of e.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)){let e=[];for(let n of Ce(t[2])){let t=/^((?:@\w+(?:\([^)]*\))?\s*)*)(\w+)\s*:\s*(.+)$/s.exec(n);if(!t)continue;let r=t[1],i=/@align\(\s*(\d+)\s*\)/.exec(r),a=/@size\(\s*(\d+)\s*\)/.exec(r);e.push({name:t[2],type:t[3].trim(),align:i?Number(i[1]):void 0,size:a?Number(a[1]):void 0})}n.set(t[1],e)}return{aliases:t,structs:n,constants:r}}function Te(e,t,n=new Set){let r=e.trim(),i=/^(0[xX][0-9a-fA-F]+|\d+)[iu]?$/.exec(r);if(i)return Number(i[1]);if(/^\w+$/.test(r)&&t.constants.has(r)&&!n.has(r))return n.add(r),Te(t.constants.get(r),t,n)}function Ee(e){let t=e.trim(),n=t.indexOf(`<`);return n<0?{base:t,args:[]}:{base:t.slice(0,n).trim(),args:Ce(t.slice(n+1,t.lastIndexOf(`>`)))}}function L(e,t,n=0){if(n>32)return;let r=e.trim();for(;t.aliases.has(r);)r=t.aliases.get(r);let i=/^(vec[234]|mat[234]x[234])([fiuh])$/.exec(r);i&&(r=`${i[1]}<${xe[i[2]]}>`);let{base:a,args:o}=Ee(r);if(be.has(a)){if(a===`bool`)return;let e=a===`f16`?2:4;return{name:a,kind:`scalar`,align:e,size:e,scalar:a}}if(a===`atomic`){let e=L(o[0]??``,t,n+1);return e&&{...e,name:r,kind:`atomic`}}let s=/^vec([234])$/.exec(a);if(s){let e=Number(s[1]),i=L(o[0]??``,t,n+1);if(!i||i.kind!==`scalar`)return;let a=i.size;return{name:r,kind:`vector`,align:(e===2?2:4)*a,size:e*a,scalar:i.scalar,rows:e}}let c=/^mat([234])x([234])$/.exec(a);if(c){let e=Number(c[1]),i=Number(c[2]),a=L(`vec${i}<${o[0]}>`,t,n+1);if(!a)return;let s=I(a.align,a.size);return{name:r,kind:`matrix`,align:a.align,size:e*s,scalar:a.scalar,rows:i,columns:e,stride:s}}if(a===`array`){let e=L(o[0]??``,t,n+1);if(!e)return;let i=I(e.align,e.size),a=o[1]===void 0?0:Te(o[1],t);return a===void 0?void 0:{name:r,kind:`array`,align:e.align,size:a===0?i:a*i,element:e,stride:i,count:a}}let l=t.structs.get(a);if(l){let e=0,r=1,i=[];for(let a of l){let o=L(a.type,t,n+1);if(!o)return;let s=a.align??o.align;e=I(s,e),i.push({name:a.name,offset:e,layout:o}),e+=a.size??o.size,r=Math.max(r,s)}return{name:a,kind:`struct`,align:r,size:I(r,e),members:i}}}var De={"1d":`1d`,"2d":`2d`,"2d_array":`2d-array`,"3d":`3d`,cube:`cube`,cube_array:`cube-array`},Oe={f32:`float`,i32:`sint`,u32:`uint`};function ke(e){let{base:t,args:n}=Ee(e),r=/^texture_storage_(1d|2d|2d_array|3d)$/.exec(t);if(r){let e={read:`read-only`,write:`write-only`,read_write:`read-write`}[n[1]??`write`];return{viewDimension:De[r[1]],format:n[0],access:e}}let i=/^texture_depth_(multisampled_)?(2d|2d_array|cube|cube_array)$/.exec(t);if(i)return{viewDimension:De[i[2]],sampleType:`depth`,multisampled:!!i[1]};let a=/^texture_(multisampled_)?(1d|2d|2d_array|3d|cube|cube_array)$/.exec(t);if(a)return{viewDimension:De[a[2]],sampleType:Oe[n[0]??`f32`]??`float`,multisampled:!!a[1]}}function Ae(e){let t=Se(e),n=we(t),r=[],i=[];for(let e of t.matchAll(/((?:@\w+\s*(?:\([^)]*\))?\s*)+)var\s*(?:<\s*([\w\s,]+)\s*>)?\s*(\w+)\s*:\s*([^;=]+?)\s*;/g)){let t=e[1],i=/@group\(\s*([^)]+)\)/.exec(t),o=/@binding\(\s*([^)]+)\)/.exec(t);if(!i||!o)continue;let s=Te(i[1],n),c=Te(o[1],n);if(s===void 0||c===void 0)throw a(`Kernel binding ${e[3]} has a group or binding that is not a constant integer`,`compute`);let l=(e[2]??``).split(`,`).map(e=>e.trim()),u=e[3],d=e[4].trim();if(l[0]===`uniform`)r.push({name:u,group:s,binding:c,resource:`uniform`,type:d,layout:L(d,n)});else if(l[0]===`storage`)r.push({name:u,group:s,binding:c,resource:l[1]===`read_write`?`storage`:`read-only-storage`,type:d,layout:L(d,n)});else if(/^sampler(_comparison)?$/.test(d))r.push({name:u,group:s,binding:c,resource:`sampler`,type:d,sampler:d===`sampler`?`filtering`:`comparison`});else{let e=ke(d);if(!e)throw a(`Kernel binding ${u} has a type the kernel cannot bind: ${d}`,`compute`);r.push({name:u,group:s,binding:c,resource:e.format?`storage-texture`:`texture`,type:d,texture:e})}}for(let e of t.matchAll(/@compute\s*((?:@\w+\s*(?:\([^)]*\))?\s*)*)fn\s+(\w+)|((?:@\w+\s*(?:\([^)]*\))?\s*)+)fn\s+(\w+)/g)){let t=e[1]??e[3]??``,r=e[2]??e[4];if(e[3]!==void 0&&!/@compute\b/.test(t))continue;let o=/@workgroup_size\(([^)]*)\)/.exec(t),s=o?Ce(o[1]).map(e=>Te(e,n)):[1];if(s.some(e=>e===void 0))throw a(`Kernel entry point ${r} has a workgroup size that is not a constant integer`,`compute`);i.push({name:r,workgroupSize:[s[0]??1,s[1]??1,s[2]??1]})}return r.sort((e,t)=>e.group-t.group||e.binding-t.binding),{bindings:r,entryPoints:i}}function je(e,t,n,r,i){let s=(t,n,r)=>{let s=typeof r==`boolean`?Number(r):r;if(typeof s!=`number`)throw a(`Uniform ${i} needs a number, got ${typeof r}`,`compute`);if(n===`f32`)e.setFloat32(t,s,!0);else if(n===`f16`)e.setUint16(t,ye(s),!0);else{let[r,a]=n===`i32`?[-2147483648,2147483647]:[0,4294967295];if(!Number.isInteger(s)||s<r||s>a)throw o(`Uniform ${i} needs an integer from ${r} to ${a}, got ${s}`,`compute`);n===`i32`?e.setInt32(t,s,!0):e.setUint32(t,s,!0)}},c=(e,t)=>{if(typeof e!=`object`||!e||typeof e.length!=`number`)throw a(`Uniform ${i} needs an array of ${t} numbers`,`compute`);let n=e;if(n.length!==t)throw a(`Uniform ${i} needs ${t} numbers, got ${n.length}`,`compute`);return n},l=n.scalar===`f16`?2:4;switch(n.kind){case`scalar`:case`atomic`:return s(t,n.scalar,r);case`vector`:{let e=c(r,n.rows);for(let r=0;r<n.rows;r++)s(t+r*l,n.scalar,e[r]);return}case`matrix`:{let e=c(r,n.rows*n.columns);for(let r=0;r<n.columns;r++)for(let i=0;i<n.rows;i++)s(t+r*n.stride+i*l,n.scalar,e[r*n.rows+i]);return}case`array`:{let o=n.element,s=r;if(typeof s!=`object`||!s||typeof s.length!=`number`)throw a(`Uniform ${i} needs an array`,`compute`);if(n.count&&s.length!==n.count)throw a(`Uniform ${i} needs ${n.count} items, got ${s.length}`,`compute`);for(let r=0;r<s.length;r++)je(e,t+r*n.stride,o,s[r],`${i}[${r}]`);return}case`struct`:{if(typeof r!=`object`||!r||ArrayBuffer.isView(r)||Array.isArray(r))throw a(`Uniform ${i} needs an object with the struct's members`,`compute`);let o=r;for(let r of n.members){if(!(r.name in o))throw a(`Uniform ${i}.${r.name} is missing; pass every struct member`,`compute`);je(e,t+r.offset,r.layout,o[r.name],`${i}.${r.name}`)}}}}function Me(e,t=0){return e.kind===`array`&&e.count===0?e.stride*t:e.size}function Ne(e,t,n=`value`){let r=e.kind===`array`&&e.count===0?t.length:0,i=new Uint8Array(I(16,Math.max(Me(e,r),4)));return je(new DataView(i.buffer),0,e,t,n),i}var R=1024,z=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`,B=`struct Params { n: u32, inf: u32, a: u32, b: u32 }`;function Pe(e,t){if(typeof e==`object`){if(typeof e.combine!=`string`||typeof e.identity!=`string`)throw a(`A custom operator needs WGSL strings combine (of a and b) and identity`,`compute`);return e}let n=t===`f16`?`bitcast<vec2<f16>>((params.inf >> 16u) & 0x7c00u).x`:`bitcast<f32>(params.inf)`;switch(e){case`sum`:return{combine:`a + b`,identity:`${t}(0)`};case`product`:return{combine:`a * b`,identity:`${t}(1)`};case`min`:return{combine:`min(a, b)`,identity:t===`i32`?`i32(2147483647)`:t===`u32`?`0xffffffffu`:n};case`max`:return{combine:`max(a, b)`,identity:t===`i32`?`(-2147483647i - 1i)`:t===`u32`?`0u`:`-${n}`}}}function Fe(e,t,n,r=256){let i=e.dtype,a=R/r;return`${e.enables}${e.declarations}${B}
${z}
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
}`}function Ie(e,t){return`${e===`f16`?`enable f16;
`:``}${B}
${z}
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
}`}function Le(e,t,n,r){let i=e.dtype,a=e.next;return`${e.enables}${e.declarations}${B}
${z}
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
}`}function Re(e,t){return`${e===`f16`?`enable f16;
`:``}${B}
${z}
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
}`}function ze(e,t,n){let r=t===`f16`||e.some(e=>e.type===`f16`),i=e.map((e,t)=>`@group(0) @binding(${t+1}) var<storage, read> in_${e.name}: array<${e.type}>;`).join(`
`),a=e.map(e=>`${e.name}: ${e.type}`).join(`, `),o=e.map(e=>`in_${e.name}[i]`).join(`, `),s=/\breturn\b/.test(n)?n:`return ${t}(${n});`;return`${r?`enable f16;
`:``}${B}
${z}
@group(0) @binding(0) var<storage, read_write> out: array<${t}>;
${i}
@group(0) @binding(${e.length+1}) var<uniform> params: Params;
fn f(i: u32, n: u32${a?`, `+a:``}) -> ${t} { ${s} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  out[i] = f(i, params.n${o?`, `+o:``});
}`}function Be(e){switch(e){case`f32`:return`let bits = bitcast<u32>(v); return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);`;case`f16`:return`let bits = bitcast<u32>(f32(v)); return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);`;case`i32`:return`return bitcast<u32>(v) ^ 0x80000000u;`;case`u32`:return`return v;`}}function Ve(e){return`${e.enables}${e.declarations}${B}
${z}
@group(0) @binding(${e.next}) var<storage, read_write> keys: array<u32>;
@group(0) @binding(${e.next+1}) var<storage, read_write> order: array<u32>;
@group(0) @binding(${e.next+2}) var<uniform> params: Params;
${e.fn}
fn toKey(v: ${e.dtype}) -> u32 { ${Be(e.dtype)} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = toKey(value(i));
  if (params.a == 1u) { k = ~k; }
  keys[i] = k;
  if (params.b == 1u) { order[i] = i; }
}`}function He(e){return`${e===`f16`?`enable f16;
`:``}${B}
${z}
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
}`}var Ue=`struct Radix { n: u32, shift: u32, blocks: u32, values: u32 }`,We=e=>`${Ue}
${z}
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
}`,Ge=e=>`${Ue}
${z}
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
}`,Ke=4096;function qe(e,t){let n=t?`localCounts`:`counts`;return`${e.enables}${e.declarations}struct Bins { n: u32, bins: u32, pad0: u32, pad1: u32 }
${z}
@group(0) @binding(${e.next}) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(${e.next+1}) var<storage, read> range: array<f32>;
@group(0) @binding(${e.next+2}) var<uniform> params: Bins;
${t?`var<workgroup> localCounts: array<atomic<u32>, ${Ke}>;`:``}
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
}`}var Je=`struct Params { n: u32, inf: u32, len: u32, inner: u32 }`,Ye=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`,Xe=4096;function Ze(e,t){if(e===void 0)return Array.from({length:t},(e,t)=>t);let n=(typeof e==`number`?[e]:[...e]).map(e=>P(e,t));if(new Set(n).size!==n.length)throw o(`Reduction axes repeat: [${String(e)}]`,`compute`);return n.sort((e,t)=>e-t)}var Qe=(e,t,n)=>n?e.map((e,n)=>t.includes(n)?1:e):e.filter((e,n)=>!t.includes(n));function $e(e,t,n,r=256){let i=e.dtype,a=R/r;return`${e.enables}${e.declarations}${Je}
${Ye}
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
}`}function et(e,t,n,r){let i=e.dtype,a=`${e.enables}${e.declarations}${Je}
${Ye}
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
}`}var V=2139095040;function H(e,t,n,r={}){if(e.check(),!(t instanceof k))throw a(`Reductions take a GpuArray or an Expr`,`compute`);if(typeof n==`string`&&![`sum`,`product`,`min`,`max`].includes(n))throw a(`Unknown reduce op ${n}; use sum, product, min, max or { combine, identity }`,`compute`);let i=Ze(r.axis,t.ndim),o=!!r.keepdims,s=Qe(t.shape,i,o),{combine:c,identity:l}=Pe(n,t.dtype);if(i.length===t.ndim)return tt(e,t,c,l,s);let u=t,d=[...t.shape],f=[];for(let n=i.length-1;n>=0;n--){let r=i[n],a=n===0,o=d.filter((e,t)=>t!==r),p=e.empty(a?s:o,t.dtype);nt(e,u,r,d,c,l,p),a||f.push(p),u=p,d=o}for(let e of f)e.dispose();return u}function tt(e,t,n,r,i){let a=t.size;if(a===0){let n=e.empty(i,t.dtype),a=`${t.dtype===`f16`?`enable f16;
`:``}${Je}
@group(0) @binding(0) var<storage, read_write> dst: array<${t.dtype}>;
@group(0) @binding(1) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { dst[0] = ${r}; }`;return e.submit([{program:e.program(a,void 0,`reduce`),resources:{dst:n,params:new Uint32Array([0,V,0,0])},workgroups:[1,1,1]}]),n}let o=t,s=a,c=[],l=[],u;do{let a=Math.ceil(s/R),d=[],f=A(o,0,e.maxStorage(1),d);c.push(...d),u=e.empty(a===1?i:[a],t.dtype),l.push({program:e.program(e.kernelRoute?.level(f,n,r)??$e(f,n,r,e.tuned.reduce),void 0,`reduce`),resources:{...f.resources,dst:u,params:new Uint32Array([s,V,0,0])},workgroups:e.grid(a)}),a>1&&c.push(u),o=u,s=a}while(s>1);e.submit(l);for(let e of c)e.dispose();return u}function nt(e,t,n,r,i,a,o){let s=r[n],c=r.slice(n+1).reduce((e,t)=>e*t,1),l=o.size;if(l===0)return;let u=[],d=A(t,0,e.maxStorage(1),u),f=l>=Xe||s<=64;e.submit([{program:e.program((f?void 0:e.kernelRoute?.axis(d,i,a))??et(d,i,a,f),void 0,`reduce.axis`),resources:{...d.resources,dst:o,params:new Uint32Array([l,V,s,c])},workgroups:e.grid(f?Math.ceil(l/256):l)}]);for(let e of u)e.dispose()}var rt=(e,t)=>t.reduce((t,n)=>t*e[n],1);function it(e,t,n={}){let r=rt(t.shape,Ze(n.axis,t.ndim));return at(H(e,l(t.dtype)&&t.dtype===`f32`?t:t.astype(`f32`),`sum`,n),r?1/r:NaN)}function at(e,t){let n=e.mul(t).eval();return e.dispose(),n}function ot(e,t,n={}){let r=n.ddof??0;if(!Number.isFinite(r)||r<0)throw o(`ddof must be a number of at least 0, got ${r}`,`compute`);let i=t.dtype===`f32`?t:t.astype(`f32`),a=it(e,i,{axis:n.axis,keepdims:!0}),s=rt(t.shape,Ze(n.axis,t.ndim)),c=H(e,i.sub(a).square(),`sum`,n);return a.dispose(),at(c,s-r>0?1/(s-r):NaN)}function st(e,t,n={}){let r=ot(e,t,n),i=r.sqrt().eval();return r.dispose(),i}function ct(e,t,n={}){let r=t.dtype===`f32`?t:t.astype(`f32`),i=H(e,M(r.isnan(),0,r),`sum`,n),a=H(e,r.isnan().not(),`sum`,n),o=i.div(a).eval();return i.dispose(),a.dispose(),o}function lt(e,t,n){let r=e.dtype,i=t===`min`?`<`:`>`,a=n===`level`?`fn load(i: u32) -> Pair { return Pair(vals[i], idx[i]); }`:`fn load(i: u32) -> Pair { return Pair(value(i), i); }`,o=`${e.enables}${e.declarations}${Je}
${Ye}
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
}`}function ut(e,t,n,r={}){if(e.check(),!(t instanceof k))throw a(`arg${n} takes a GpuArray or an Expr`,`compute`);if(t.size===0)throw o(`arg${n} of an empty array has no answer`,`compute`);let i=[],s=t.dtype;if(r.axis===void 0){let a=r.keepdims?t.shape.map(()=>1):[],o=t.size,c,l,u=[],d=!0;do{let r=Math.ceil(o/R),f=r===1,p=A(d?t:c,0,e.maxStorage(4),i),m=e.empty([r],s),h=e.empty(f?a:[r],`u32`),g={...p.resources,outValues:m,outIndices:h,params:new Uint32Array([o,V,0,0])};d||Object.assign(g,{vals:c,idx:l}),u.push({program:e.program(lt(p,n,d?`flat`:`level`),void 0,`arg${n}`),resources:g,workgroups:e.grid(r)}),c&&i.push(c),l&&i.push(l),c=m,l=h,o=r,d=!1}while(o>1);e.submit(u),i.push(c);for(let e of i)e.dispose();return l}let c=P(r.axis,t.ndim),l=t.shape[c],u=t.shape.slice(c+1).reduce((e,t)=>e*t,1),d=Qe(t.shape,[c],!!r.keepdims),f=d.reduce((e,t)=>e*t,1),p=f>=Xe||l<=64,m=A(t,0,e.maxStorage(2),i),h=e.empty([f],s),g=e.empty(d,`u32`);e.submit([{program:e.program(lt(m,n,p?`thread`:`group`),void 0,`arg${n}.axis`),resources:{...m.resources,outValues:h,outIndices:g,params:new Uint32Array([f,V,l,u])},workgroups:e.grid(p?Math.ceil(f/256):f)}]),i.push(h);for(let e of i)e.dispose();return g}var dt=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`;function ft(e){if(!(e instanceof k))throw a(`Indices must be a GpuArray or an Expr`,`compute`);if(l(e.dtype))throw a(`Indices must be integers; astype('i32') first`,`compute`);return e instanceof F&&e.dtype===`i32`&&e.contiguous&&e.offset===0?{array:e,owned:!1}:{array:e.astype(`i32`).eval(),owned:!0}}function pt(e,t,n,r={}){if(e.check(),!(t instanceof k))throw a(`take reads a GpuArray or an Expr`,`compute`);let{array:i,owned:s}=ft(n),c=r.mode??`clip`;if(c!==`clip`&&c!==`wrap`)throw a(`take mode must be 'clip' or 'wrap', got ${String(c)}`,`compute`);let l=r.axis===void 0?void 0:P(r.axis,t.ndim),u=l===void 0?t.size:t.shape[l],d=l===void 0?1:t.shape.slice(l+1).reduce((e,t)=>e*t,1),f=l===void 0?i.shape:[...t.shape.slice(0,l),...i.shape,...t.shape.slice(l+1)],p=e.empty(f,t.dtype),m=p.size;if(m>0&&u===0)throw o(`take from an empty axis has nothing to take`,`compute`);if(m>0){let n=[],r=A(t,0,e.maxStorage(2),n),a=`${r.enables}${r.declarations}struct Take { n: u32, len: u32, inner: u32, count: u32, wrap: u32 }
${dt}
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
}`;e.submit([{program:e.program(a,void 0,`take`),resources:{...r.resources,idx:i,out:p,take:new Uint32Array([m,u,d,Math.max(1,i.size),+(c===`wrap`),0,0,0])},workgroups:e.grid(Math.ceil(m/256))}]);for(let e of n)e.dispose()}return s&&i.dispose(),p}function mt(e,t){let n=e=>e.kind===`leaf`?e.array.storage===t.storage:e.kind===`op`&&e.args.some(n);return n(e.node())}function ht(e,t,n,r,i={}){if(e.check(),!(t instanceof F))throw a(`scatter writes into a GpuArray`,`compute`);if(t.check(e),!t.contiguous||t.offset)throw a(`scatter needs a contiguous target; scatter into the array the view came from`,`compute`);let s=i.op??`set`;if(![`set`,`add`,`min`,`max`].includes(s))throw a(`scatter op must be set, add, min or max, got ${s}`,`compute`);if(t.dtype===`f16`&&s!==`set`)throw a(`scatter add/min/max needs a 32-bit target; use 'f32'`,`compute`);let{array:c,owned:l}=ft(n),u=c.size,d=typeof r==`number`;if(!d&&!(r instanceof k))throw a(`scatter values must be a number, a GpuArray or an Expr`,`compute`);if(!d&&r.size!==u&&r.size!==1)throw o(`scatter has ${u} indices but ${r.size} values; pass one value or one per index`,`compute`);if(u>0){let n=t.dtype,i=[],a=d?void 0:r.astype(n);if(a&&mt(a,t)){let e=a.eval();i.push(e),a=e}let o=a?A(a,0,e.maxStorage(2),i):void 0,l=o?.next??0,f=n===`i32`?`atomic<i32>`:`atomic<u32>`,p=d?`${_(`params.value`,n)}`:r.size===1?`value(0u)`:`value(i)`,m;m=s===`set`?`dst[j] = v;`:n===`f32`?`var old = atomicLoad(&dst[j]);
    loop {
      let swapped = atomicCompareExchangeWeak(&dst[j], old, bitcast<u32>(${s===`add`?`bitcast<f32>(old) + v`:`${s}(bitcast<f32>(old), v)`}));
      if (swapped.exchanged) { break; }
      old = swapped.old_value;
    }`:`atomic${s[0].toUpperCase()}${s.slice(1)}(&dst[j], v);`;let h=`${o?.enables??(n===`f16`?`enable f16;
`:``)}${o?.declarations??``}struct Params { n: u32, len: u32, value: u32, pad: u32 }
${dt}
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
  ${m}
}`;e.submit([{program:e.program(h,void 0,`scatter.${s}`),resources:{...o?.resources??{},idx:c,dst:t,params:new Uint32Array([u,t.size,d?g(r,n):0,0])},workgroups:e.grid(Math.ceil(u/256))}]);for(let e of i)e.dispose()}return l&&c.dispose(),t}function gt(e,t,n){let r=n?.length;if(!Number.isInteger(r)||r<0)throw o(`bincount needs length (the number of bins, one past the largest value) as a whole number`,`compute`);return ht(e,e.zeros([r],n.weights?`f32`:`u32`),t,n.weights??1,{op:`add`})}function U(e,t,n){if(e.check(),!(t instanceof k)||!(n instanceof k))throw a(`compact takes an input and a mask (GpuArrays or Exprs)`,`compute`);if(t.size!==n.size)throw o(`compact input (${t.size}) and mask (${n.size}) differ in size`,`compute`);let r=t.size,i=e.empty([r],t.dtype),s=e.empty([1],`u32`);if(r===0)return{values:i,count:s};let c=n.ne(0).eval(),l=e.empty([r],`u32`),u=[c,l],d=[];wt(e,c,l,r,d,u);let f=A(t,0,e.maxStorage(4),u),p=`${f.enables}${f.declarations}${dt}
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
}`;d.push({program:e.program(p,void 0,`compact`),resources:{...f.resources,flags:c,offsets:l,values:i,count:s,size:new Uint32Array([r,0,0,0])},workgroups:e.grid(Math.ceil(r/256))}),e.submit(d);for(let e of u)e.dispose();return{values:i,count:s}}function _t(e,t,n){return U(e,t,n)}async function vt(e,t,n){return(await t.read({signal:n}))[0]}async function yt(e,t,n,r={}){let i=U(e,t,n);try{let n=await vt(e,i.count,r.signal),a=e.empty([n],t.dtype);return e.submit([],[[i.values.buffer,0,a.buffer,0,a.byteLength]]),a}finally{i.values.dispose(),i.count.dispose()}}async function bt(e,t,n={}){let r=e.arange(0,t.size,1,`u32`);try{return await yt(e,r,t,n)}finally{r.dispose()}}var W=2139095040;function xt(e,t,n,r,i,a,o,s){let{combine:c,identity:l}=Pe(i,n.dtype),u=Math.ceil(r/R),d=e.empty([u],n.dtype),f=A(t,0,e.maxStorage(2),s);if(s.push(d),o.push({program:e.program(e.kernelRoute?.scan(f,c,l)??Fe(f,c,l,e.tuned.scan),void 0,`scan`),resources:{...f.resources,dst:n,sums:d,params:new Uint32Array([r,W,+!!a,0])},workgroups:e.grid(u)}),u===1)return;let p=e.empty([u],n.dtype);s.push(p),xt(e,d,p,u,i,!0,o,s),o.push({program:e.program(Ie(n.dtype,c),void 0,`scan.add`),resources:{data:n,sums:p,params:new Uint32Array([r,W,0,0])},workgroups:e.grid(u)})}function St(e,t,n,r,i,a,o,s,c){let{combine:l,identity:u}=Pe(o,i.dtype),d=Math.ceil(a/R),f=e.empty([a],`u32`),p=e.empty([d],`u32`),m=e.empty([d],i.dtype),h=A(t,0,e.maxStorage(5),c),g=n?void 0:e.empty([1],`u32`);if(c.push(f,p,m),g&&c.push(g),s.push({program:e.program(Le(h,l,u,!n),void 0,`scan.segmented`),resources:{...h.resources,flagsIn:n??g,dst:i,seen:f,sumFlags:p,sumValues:m,params:new Uint32Array([a,W,0,r])},workgroups:e.grid(d)}),d===1)return;let _=e.empty([d],i.dtype);c.push(_),St(e,m,p,0,_,d,o,s,c),s.push({program:e.program(Re(i.dtype,l),void 0,`scan.segmented.add`),resources:{data:i,seen:f,scanned:_,params:new Uint32Array([a,W,0,0])},workgroups:e.grid(d)})}function Ct(e,t,n,r,i){let{identity:a}=Pe(i,t.dtype),o=`${t.dtype===`f16`?`enable f16;
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
}`,s=e.empty(t.shape,t.dtype);return e.submit([{program:e.program(o,void 0,`scan.exclusive`),resources:{inclusive:t,flags:n??t,dst:s,params:new Uint32Array([t.size,W,0,n?0:r])},workgroups:e.grid(Math.ceil(t.size/256))}]),s}function wt(e,t,n,r,i,a){xt(e,t,n,r,`sum`,!0,i,a)}function Tt(e,t,n={}){if(e.check(),!(t instanceof k))throw a(`scan takes a GpuArray or an Expr`,`compute`);let r=n.op??`sum`,i=!!n.exclusive,o=t.size,s=[],c=[];if(n.axis===void 0||t.ndim<=1){let a=e.empty(n.axis===void 0?[o]:t.shape,t.dtype);if(o===0)return a;xt(e,t,a,o,r,i,c,s),e.submit(c);for(let e of s)e.dispose();return a}let l=P(n.axis,t.ndim),u=[...t.shape.keys()].filter(e=>e!==l).concat(l),d=u.map((e,t)=>u.indexOf(t)),f=t instanceof k&&`transpose`in t?t:t.eval(),p=f.transpose(...u),m=t.shape[l],h=e.empty(p.shape,t.dtype);o>0&&(St(e,p,void 0,m,h,o,r,c,s),e.submit(c));let g=h;i&&o>0&&(g=Ct(e,h,void 0,m,r),h.dispose());let _=g.transpose(...d).eval();g.dispose(),f!==t&&f.dispose();for(let e of s)e.dispose();return _}function Et(e,t,n,r={}){if(e.check(),!(t instanceof k)||!(n instanceof k))throw a(`segmentedScan takes values and flags as GpuArrays or Exprs`,`compute`);if(t.size!==n.size)throw a(`segmentedScan values (${t.size}) and flags (${n.size}) differ in size`,`compute`);let i=r.op??`sum`,o=t.size,s=e.empty([o],t.dtype);if(o===0)return s;let c=n.ne(0).eval(),l=[c],u=[];if(St(e,t,c,0,s,o,i,u,l),e.submit(u),!r.exclusive){for(let e of l)e.dispose();return s}let d=Ct(e,s,c,0,i);s.dispose();for(let e of l)e.dispose();return d}async function Dt(e,t,n,r={}){if(e.check(),t.size!==n.size)throw a(`reduceByKey keys (${t.size}) and values (${n.size}) differ in size`,`compute`);let i=t.size;if(i===0)return{keys:e.empty([0],t.dtype),values:e.empty([0],n.dtype)};let o=t instanceof k&&`storage`in t&&t.contiguous?t:t.eval(),s=o.reshape(i),c=s.slice([0,i-1]),l=s.slice([1,i]).ne(c).eval(),u=e.empty([i],`u32`),d=e.empty([i],`u32`);e.submit([],[[l.buffer,0,u.buffer,4,(i-1)*4],[l.buffer,0,d.buffer,0,(i-1)*4]]),u.write([1],0),d.write([1],i-1);let f=Et(e,n,u,{op:r.op}),p=U(e,s,u),m=U(e,f,d),h=await vt(e,p.count,r.signal),g=e.empty([h],t.dtype),_=e.empty([h],n.dtype);e.submit([],[[p.values.buffer,0,g.buffer,0,g.byteLength],[m.values.buffer,0,_.buffer,0,_.byteLength]]);for(let e of[l,u,d,f,p.values,p.count,m.values,m.count])e.dispose();return o!==t&&o.dispose(),{keys:g,values:_}}var Ot=2139095040;function kt(e,t,n,r){if(e.check(),!(t instanceof k))throw a(`sort takes a GpuArray or an Expr`,`compute`);let i=t.size,s=r.bits??32;if(!Number.isInteger(s)||s<1||s>32)throw o(`Sort bits must be a whole number from 1 to 32, got ${s}`,`compute`);if(s<32&&t.dtype!==`u32`)throw o(`Sort bits below 32 apply to u32 keys only; drop bits for other types`,`compute`);let l=e.kernelRoute||e.sortRoute?256:e.tuned.sort??256,u=Math.max(1,Math.ceil(i/l)),d=u*l,f=n!==void 0,p=[],m=t=>{let n=e.empty([t],`u32`);return p.push(n),n},h=m(d),g=m(d),_=m(f?d:1),v=m(f?d:1);if(i===0)return{keys:h,values:f?_:void 0,scratch:p};let y=[],b=[],x=A(t,0,e.maxStorage(2),p);if(y.push({program:e.program(Ve(x),void 0,`sort.keys`),resources:{...x.resources,keys:h,order:_,params:new Uint32Array([i,Ot,+!!r.descending,+(n===`index`)])},workgroups:e.grid(Math.ceil(i/256))}),n&&n!==`index`){let t=n.ascontiguous();if(t!==n&&p.push(t),c(t.dtype)!==4)throw a(`sortByKey values must be a 32-bit type; astype("f32") first`,`compute`);b.push([t.buffer,t.offset*4,_.buffer,0,i*4]),e.submit([],b.splice(0))}if(e.sortRoute){let t=Math.ceil(s/4)*4;return y.push({program:e.program(e.sortRoute,void 0,`sort.layer`),resources:{keys:h,values:_,spareKeys:g,spareValues:v,sort:new Uint32Array([i,t===32?4294967295:2**t-1,Math.ceil(t/8),+!!f])},workgroups:[1,1,1]}),e.submit(y),{keys:h,values:f?_:void 0,scratch:p}}let S=m(d),C=m(f?d:1),w=m(16*u),ee=m(16*u),T=m(16*u),E=e.program(e.kernelRoute?.radixLocal??We(l),void 0,`sort.local`),D=e.program(Ge(l),void 0,`sort.scatter`),O=e.grid(u);for(let t=0;t<s;t+=4){let n=new Uint32Array([i,t,u,+!!f]);y.push({program:E,resources:{keysIn:h,valuesIn:_,keysLocal:S,valuesLocal:C,counts:w,starts:T,radix:n},workgroups:O}),wt(e,w,ee,16*u,y,p),y.push({program:D,resources:{keysLocal:S,valuesLocal:C,offsets:ee,starts:T,keysOut:g,valuesOut:v,radix:n},workgroups:O}),[h,g]=[g,h],[_,v]=[v,_]}return e.submit(y),{keys:h,values:f?_:void 0,scratch:p}}function At(e,t,n={}){let r=kt(e,t,void 0,n),i=t.size,a=e.empty([i],t.dtype);i>0&&e.submit([{program:e.program(He(t.dtype),void 0,`sort.values`),resources:{keys:r.keys,dst:a,params:new Uint32Array([i,Ot,+!!n.descending,0])},workgroups:e.grid(Math.ceil(i/256))}]);for(let e of r.scratch)e.dispose();return a}function jt(e,t,n={}){let r=kt(e,t,`index`,n),i=t.size,a=e.empty([i],`u32`);e.submit([],[[r.values.buffer,0,a.buffer,0,i*4]]);for(let e of r.scratch)e.dispose();return a}function Mt(e,t,n,r={}){if(!(n instanceof k))throw a(`sortByKey values must be a GpuArray or an Expr`,`compute`);if(t.size!==n.size)throw o(`sortByKey keys (${t.size}) and values (${n.size}) differ in size`,`compute`);let i=n.eval(),s=kt(e,t,i,r),c=t.size,l=e.empty([c],t.dtype),u=e.empty([c],n.dtype);c>0&&e.submit([{program:e.program(He(t.dtype),void 0,`sort.values`),resources:{keys:s.keys,dst:l,params:new Uint32Array([c,Ot,+!!r.descending,0])},workgroups:e.grid(Math.ceil(c/256))}],[[s.values.buffer,0,u.buffer,0,c*4]]),i.dispose();for(let e of s.scratch)e.dispose();return{keys:l,values:u}}function Nt(e,t,n,r={}){if(!Number.isInteger(n)||n<0||n>t.size)throw o(`topk k must be a whole number from 0 to ${t.size}, got ${n}`,`compute`);let i=jt(e,t,{descending:r.largest??!0}),a=e.empty([n],`u32`);return e.submit([],[[i.buffer,0,a.buffer,0,n*4]]),i.dispose(),{values:e.take(t,a),indices:a}}function Pt(e,t,n){let r=typeof n==`number`?[n]:[...n];for(let e of r)if(!(e>=0&&e<=1))throw o(`Quantiles must be in [0, 1], got ${e}`,`compute`);let i=t.size;if(i===0)throw o(`quantile of an empty array has no answer`,`compute`);let a=At(e,t).astype(`f32`).eval(),s=r.map(e=>Math.floor(e*(i-1))),c=s.map(e=>Math.min(e+1,i-1)),l=r.map((e,t)=>e*(i-1)-s[t]),u=e.take(a,e.array(s,`u32`)),d=e.take(a,e.array(c,`u32`)),f=e.array(l,`f32`),p=u.add(d.sub(u).mul(f)).eval();for(let e of[a,u,d,f])e.dispose();return typeof n==`number`?p.transfer([]):p}async function Ft(e,t,n={}){let r=t.size;if(r===0)return{values:e.empty([0],t.dtype),...n.counts?{counts:e.empty([0],`u32`)}:{}};let i=At(e,t),a=e.empty([r],`u32`);if(r>1){let t=i.slice([1,r]).ne(i.slice([0,r-1])).eval();e.submit([],[[t.buffer,0,a.buffer,4,(r-1)*4]]),t.dispose()}a.write([1],0);let o=U(e,i,a),s;if(n.counts){let t=e.arange(0,r,1,`u32`);s=U(e,t,a),t.dispose()}let c=await vt(e,o.count,n.signal),l=e.empty([c],t.dtype);e.submit([],[[o.values.buffer,0,l.buffer,0,l.byteLength]]);let u;if(s){let t=e.empty([c+1],`u32`);e.submit([],[[s.values.buffer,0,t.buffer,0,c*4]]),t.write([r],c),u=t.slice([1,c+1]).sub(t.slice([0,c])).eval(),t.dispose(),s.values.dispose(),s.count.dispose()}for(let e of[i,a,o.values,o.count])e.dispose();return u?{values:l,counts:u}:{values:l}}var It=e=>`${e===`f16`?`enable f16;
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
}`;function Lt(e,t,n={}){if(e.check(),!(t instanceof k))throw a(`histogram takes a GpuArray or an Expr`,`compute`);let r=t.size,i=n.bins??64;if(!Number.isInteger(i)||i<1)throw o(`Histogram bins must be a whole number of at least 1, got ${i}`,`compute`);let s=n.range;if(s){let[e,t]=s;if(!Number.isFinite(e)||!Number.isFinite(t)||e>t)throw o(`Histogram range must be finite [min, max] with min <= max, got [${e}, ${t}]`,`compute`)}else r===0&&(s=[0,1]);let c=e.empty([i],`u32`),l=e.empty([i+1],`f32`),u=e.empty([2],`f32`),d=s?e.empty([1],`f32`):H(e,t,`min`),f=s?d:H(e,t,`max`),p=new DataView(new ArrayBuffer(16));if(p.setFloat32(0,s?.[0]??0,!0),p.setFloat32(4,s?.[1]??0,!0),p.setUint32(8,i,!0),p.setUint32(12,+!!s,!0),e.submit([{program:e.program(It(s?`f32`:t.dtype),void 0,`histogram.range`),resources:{low:d,high:f,range:u,edges:l,given:new Uint8Array(p.buffer)},workgroups:[Math.ceil((i+1)/64),1,1]}]),r>0){let n=[],a=A(t,0,e.maxStorage(2),n);e.submit([{program:e.program(qe(a,i<=Ke),void 0,`histogram`),resources:{...a.resources,counts:c,range:u,params:new Uint32Array([r,i,0,0])},workgroups:e.grid(Math.ceil(r/R))}]);for(let e of n)e.dispose()}return d.dispose(),f!==d&&f.dispose(),u.dispose(),{counts:c,edges:l}}function Rt(e,t,n){if(n.indirect){let e=n.indirect instanceof F?n.indirect.buffer:n.indirect,t=(n.indirectOffset??0)*4+(n.indirect instanceof F?n.indirect.offset*4:0);if(!Number.isInteger(t)||t<0)throw o(`indirectOffset must be a whole number of elements`,`compute`);return{indirect:{buffer:e,offset:t}}}let r=e=>typeof e==`number`?[e,1,1]:[e[0],e[1]??1,e[2]??1],i;if(n.workgroups!==void 0)i=r(n.workgroups);else if(n.count!==void 0)i=r(n.count).map((e,n)=>Math.ceil(e/t[n]));else throw a(`Kernel run needs count (threads), workgroups or indirect`,`compute`);let s=e.device.limits.maxComputeWorkgroupsPerDimension;for(let e of i)if(!Number.isInteger(e)||e<0||e>s)throw o(`Kernel run of ${i.join(` x `)} workgroups is over ${s} per dimension; spread the work over y and z`,`compute`);return{workgroups:i}}var zt=class{#e;#t;#n=!1;constructor(e,t){this.#e=e,this.#t=t,this.bindings=t.info.bindings,this.entryPoint=t.entry.name,this.workgroupSize=t.entry.workgroupSize}#r(){if(this.#n)throw i(`disposed`,`Kernel disposed; compile it again with gpu.kernel()`,`compute`)}run(e,t){this.#r();let n=Rt(this.#e,this.workgroupSize,t);return(n.indirect||n.workgroups.every(e=>e>0))&&this.#e.submit([{program:this.#t,resources:{...e},...n}]),this}bind(e){return this.#r(),new Bt(this.#e,this.#t,e)}indirectArgs(e=[0,1,1]){return this.#r(),this.#e.indirectArgs(e)}dispose(){this.#n=!0}[Symbol.dispose](){this.dispose()}},Bt=class{#e;#t;#n;#r=new Map;#i;#a=!1;constructor(e,t,n){this.#e=e,this.#t=t,this.#n={...n},this.#o()}#o(){for(let e of this.#r.values())e.destroy();this.#r.clear();let e=[],t={...this.#n};for(let e of this.#t.info.bindings){let n=t[e.name];if(!this.#s(e,n))continue;let r=this.#e.bytesFor(e,n),i=this.#e.device.createBuffer({size:r.byteLength,usage:(e.resource===`uniform`?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_DST});this.#e.device.queue.writeBuffer(i,0,r),this.#r.set(e.name,i),t[e.name]=i}this.#i=this.#e.scoped(()=>this.#e.bindGroups(this.#t,t,e))}#s(e,t){return e.resource!==`uniform`&&e.resource!==`read-only-storage`||t===void 0||t instanceof F||typeof GPUBuffer<`u`&&t instanceof GPUBuffer?!1:!(typeof t==`object`&&t&&`buffer`in t&&!ArrayBuffer.isView(t)&&!Array.isArray(t))}set(e,t){if(this.#a)throw i(`disposed`,`BoundKernel disposed; bind the kernel again`,`compute`);let n=this.#t.info.bindings.find(t=>t.name===e);if(!n)throw a(`Kernel has no binding named ${e}`,`compute`);let r=this.#r.get(e);if(r&&this.#s(n,t)){let i=this.#e.bytesFor(n,t);if(i.byteLength===r.size)return this.#e.device.queue.writeBuffer(r,0,i),this.#n[e]=t,this}return this.#n[e]=t,this.#o(),this}encode(e,t){if(this.#a)throw i(`disposed`,`BoundKernel disposed; bind the kernel again`,`compute`);for(let e of Object.values(this.#n))e instanceof F&&e.check(this.#e);let n=Rt(this.#e,this.#t.entry.workgroupSize,t);if(n.workgroups&&!n.workgroups.every(e=>e>0))return;let r=`beginComputePass`in e,a=r?e.beginComputePass({label:this.#t.label}):e;a.setPipeline(this.#t.pipeline),this.#i.forEach((e,t)=>a.setBindGroup(t,e)),n.indirect?a.dispatchWorkgroupsIndirect(n.indirect.buffer,n.indirect.offset):a.dispatchWorkgroups(...n.workgroups),r&&a.end()}run(e){return this.#e.check(),this.#e.scoped(()=>{let t=this.#e.device.createCommandEncoder();this.encode(t,e),this.#e.device.queue.submit([t.finish()])}),this}dispose(){if(!this.#a){this.#a=!0;for(let e of this.#r.values())e.destroy();this.#r.clear(),this.#i=void 0}}[Symbol.dispose](){this.dispose()}};function Vt(e,t){for(let[n,r]of Object.entries(e)){if(![`reduce`,`scan`,`sort`].includes(n))throw a(`createCompute tuned takes reduce, scan and sort, got ${n}`,`compute`);if(![64,128,256,512,1024].includes(r))throw o(`Tuned ${n} must be 64, 128, 256, 512 or 1024 threads, got ${String(r)}`,`compute`);if(r>t)throw o(`Tuned ${n} of ${r} threads is over this device's limit of ${t}; measure again on it`,`compute`)}}var Ht=512,Ut=e=>{let t={binding:e.binding,visibility:GPUShaderStage.COMPUTE};switch(e.resource){case`uniform`:case`storage`:case`read-only-storage`:return{...t,buffer:{type:e.resource}};case`sampler`:return{...t,sampler:{type:e.sampler}};case`storage-texture`:return{...t,storageTexture:{format:e.texture.format,access:e.texture.access,viewDimension:e.texture.viewDimension}};default:return{...t,texture:{sampleType:e.texture.sampleType,viewDimension:e.texture.viewDimension,multisampled:e.texture.multisampled}}}},G=e=>{if(e?.aborted)throw e.reason};function Wt(e,t){return t?(G(t),new Promise((n,r)=>{let i=()=>r(t.reason);t.addEventListener(`abort`,i,{once:!0}),e.then(n,r).finally(()=>t.removeEventListener(`abort`,i))})):e}var Gt=class{#e;#t;#n;#r;#i;#a;#o;constructor(e,t,n=!1){this.#e=new Set,this.#t=new Map,this.#n=new Set,this.#r=[],this.#i=!1,this.tuned={},this.device=e,this.ownsDevice=t,this.lost=e.lost,this.fastMath=n;let r=he(e,()=>pe(()=>import(`./compat-YK57ZCbA-CpLc6vno.js`),[],import.meta.url));this.routeReady=(r??Promise.resolve(void 0)).then(e=>{this.sortRoute=e?.sortShader}),this.#a=r?ge(this.routeReady):Promise.resolve()}get ready(){return this.#a}get disposed(){return this.#i}get backend(){return`webgpu`}get f16(){return this.device.features.has(`shader-f16`)}get subgroups(){return this.device.features.has(`subgroups`)}check(){if(this.#i)throw i(`disposed`,`ComputeContext disposed; create a new one with createCompute()`,`compute`)}#s(e){if(!s.includes(e))throw a(`dtype must be 'f32', 'f16', 'i32' or 'u32', got ${String(e)}`,`compute`);if(e===`f16`&&!this.f16)throw i(`unsupported`,`This GPU has no shader-f16 feature; use 'f32' arrays`,`compute`)}allocate(e,t,n){return this.device.createBuffer({size:e,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST|t})}empty(e,t,n=0){this.check(),this.#s(t);let r=new F(this,t,e,void 0,n);return this.#e.add(r),r}array(e,t={}){let n=typeof t==`string`?{dtype:t}:t;if(typeof e!=`object`||!e||typeof e.length!=`number`)throw a(`gpu.array takes a TypedArray or an array of numbers; use gpu.zeros(shape) for an empty array`,`compute`);let r=e,i=n.dtype??f(r),s=n.shape??[r.length];if(N(s).reduce((e,t)=>e*t,1)!==r.length)throw o(`Shape [${s.join(`, `)}] does not hold ${r.length} elements`,`compute`);return this.empty(s,i).write(r)}indirectArgs(e=[0,1,1]){return this.empty([3],`u32`,GPUBufferUsage.INDIRECT).write(e)}drawable(e,t){return this.empty(typeof e==`number`?[e]:e,t??`f32`,GPUBufferUsage.VERTEX|GPUBufferUsage.INDIRECT)}zeros(e,t){return this.empty(typeof e==`number`?[e]:e,t??`f32`)}ones(e,t){return this.full(e,1,t)}full(e,t,n){let r=typeof e==`number`?[e]:e;return this.#c(r).astype(`f32`).mul(0).add(t).astype(n??`f32`).eval()}arange(e,t,n=1,r){if(t===void 0&&([e,t]=[0,e]),!Number.isFinite(e)||!Number.isFinite(t)||!Number.isFinite(n)||n===0)throw o(`arange needs finite start and stop and a non-zero step, got ${e}, ${t}, ${n}`,`compute`);let i=Math.max(0,Math.ceil((t-e)/n)),a=Number.isInteger(e)&&Number.isInteger(n),s=r??(a?e>=0&&n>0?`u32`:`i32`:`f32`),c=this.#c([i]);return(a&&s!==`f32`&&s!==`f16`?c.astype(`i32`).mul(n).add(e):c.astype(`f32`).mul(n).add(e)).astype(s).eval()}linspace(e,t,n=50){if(!Number.isInteger(n)||n<0)throw o(`linspace num must be a whole number, got ${n}`,`compute`);let r=n>1?(t-e)/(n-1):0;return this.#c([n]).astype(`f32`).mul(r).add(e).eval()}eye(e,t){let n=this.#c([e,e]);return n.floorDiv(e).eq(n.mod(e)).astype(t??`f32`).eval()}#c(e){return this.check(),new ne(this,{kind:`index`,dtype:`u32`,shape:N(e)})}where(e,t,n){return M(e,t,n)}forget(e){this.#e.delete(e)}track(e){this.#e.add(e)}evaluate(e){this.check();let t=this.empty(e.shape,e.dtype),n=t.size;if(n===0)return t;let r=[],i=A(e,0,this.maxStorage(1),r),a=`${i.enables}${i.declarations}@group(0) @binding(${i.next}) var<storage, read_write> out: array<${i.dtype}>;
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
}`,void 0,`write`),l=this.empty([o],`u32`).write(new Uint32Array(a.buffer)),u=this.empty([o],`u32`).write(s);this.submit([{program:c,resources:{dst:e,src:l,keep:u,at:new Uint32Array([r/4,o,0,0])},workgroups:[Math.ceil(o/64),1,1]}]),l.dispose(),u.dispose()}kernel(e,t={}){if(this.check(),typeof e!=`string`)throw a(`gpu.kernel takes WGSL source text`,`compute`);return new zt(this,this.program(e,t.entryPoint,t.label))}program(e,t,n){let r=`${t??``}\n${e}`,i=this.#t.get(r);if(i)return this.#t.delete(r),this.#t.set(r,i),i;let o=Ae(e);if(!o.entryPoints.length)throw a(`Kernel WGSL has no @compute entry point`,`compute`);let s=t===void 0?o.entryPoints[0]:o.entryPoints.find(e=>e.name===t);if(!s||t===void 0&&o.entryPoints.length>1)throw a(`Kernel entry point ${t??`(none given)`} not found; pass entryPoint, one of ${o.entryPoints.map(e=>e.name).join(`, `)}`,`compute`);let c=Math.max(-1,...o.bindings.map(e=>e.group))+1,l=n??s.name,u=this.scoped(()=>{let t=Array.from({length:c},(e,t)=>this.device.createBindGroupLayout({entries:o.bindings.filter(e=>e.group===t).map(Ut)}));return{pipeline:this.device.createComputePipeline({label:l,layout:this.device.createPipelineLayout({bindGroupLayouts:t}),compute:{module:this.device.createShaderModule({code:e,label:l}),entryPoint:s.name}}),layouts:t,info:o,entry:s,label:l}});return this.#t.set(r,u),this.#t.size>Ht&&this.#t.delete(this.#t.keys().next().value),u}scoped(e){this.device.pushErrorScope(`validation`),this.device.pushErrorScope(`out-of-memory`),this.device.pushErrorScope(`internal`);try{return e()}finally{for(let e of[`internal error`,`out of memory`,`validation error`])this.#r.push({kind:e,error:this.device.popErrorScope()})}}bindGroups(e,t,n){let r=Object.keys(t).find(t=>!e.info.bindings.some(e=>e.name===t));if(r!==void 0)throw a(`Kernel has no binding named ${r}; its bindings are ${e.info.bindings.map(e=>e.name).join(`, `)}`,`compute`);return e.layouts.map((r,i)=>this.device.createBindGroup({layout:r,entries:e.info.bindings.filter(e=>e.group===i).map(e=>({binding:e.binding,resource:this.resource(e,t[e.name],n)}))}))}encode(e,t){let n=[],r=this.#o&&this.device.features.has(`timestamp-query`)&&t.length>0?this.device.createQuerySet({type:`timestamp`,count:t.length*2}):void 0;if(t.forEach((t,i)=>{let a=this.bindGroups(t.program,t.resources,n),o=e.beginComputePass(r?{timestampWrites:{querySet:r,beginningOfPassWriteIndex:2*i,endOfPassWriteIndex:2*i+1}}:{});o.setPipeline(t.program.pipeline),a.forEach((e,t)=>o.setBindGroup(t,e)),t.indirect?o.dispatchWorkgroupsIndirect(t.indirect.buffer,t.indirect.offset):o.dispatchWorkgroups(...t.workgroups),o.end()}),r){let i=t.length*16,a=this.device.createBuffer({size:i,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),o=this.device.createBuffer({size:i,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});e.resolveQuerySet(r,0,t.length*2,a,0),e.copyBufferToBuffer(a,0,o,0,i),n.push(a),this.#n.add(o),this.#o.push({staging:o,queries:r,labels:t.map(e=>e.program.label)})}return n}submit(e,t=[]){this.check();let n=[];try{this.scoped(()=>{let r=this.device.createCommandEncoder();n=this.encode(r,e);for(let[e,n,i,a,o]of t)o&&r.copyBufferToBuffer(e,n,i,a,o);this.device.queue.submit([r.finish()])})}finally{for(let e of n)e.destroy()}}resource(e,t,n){if(t===void 0)throw a(`Kernel binding ${e.name} is missing; pass it in run()`,`compute`);if(t instanceof F){if(t.check(this),!t.offset)return{buffer:t.buffer};let n=t.offset*c(t.dtype),r=this.device.limits.minStorageBufferOffsetAlignment;if(n%r)throw o(`View ${e.name} starts at byte ${n}, not a multiple of ${r}; bind view.ascontiguous()`,`compute`);return{buffer:t.buffer,offset:n}}let r=typeof GPUBuffer<`u`&&t instanceof GPUBuffer;if(e.resource===`uniform`||e.resource===`storage`||e.resource===`read-only-storage`){if(r)return{buffer:t};if(typeof t==`object`&&t&&`buffer`in t&&!ArrayBuffer.isView(t)&&!Array.isArray(t))return t;if(e.resource===`storage`)throw a(`Kernel binding ${e.name} is read_write; pass a GpuArray or GPUBuffer to keep its results`,`compute`);let i=this.bytesFor(e,t),o=this.device.createBuffer({size:i.byteLength,usage:(e.resource===`uniform`?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_DST});return n.push(o),this.device.queue.writeBuffer(o,0,i),{buffer:o}}return e.resource===`sampler`?t:typeof GPUTexture<`u`&&t instanceof GPUTexture?t.createView({dimension:e.texture.viewDimension}):t}bytesFor(e,t){if(ArrayBuffer.isView(t)){let e=new Uint8Array(t.buffer,t.byteOffset,t.byteLength),n=new Uint8Array(Math.max(16,Math.ceil(e.length/16)*16));return n.set(e),n}if(!e.layout)throw a(`Kernel binding ${e.name} has a type (${e.type}) the kernel cannot lay out; pass bytes`,`compute`);return Ne(e.layout,t,e.name)}grid(e){let t=this.device.limits.maxComputeWorkgroupsPerDimension;if(e<=t)return[Math.max(1,e),1,1];let n=Math.ceil(e/t);if(n>t)throw o(`Compute array too large: ${e} workgroups exceed ${t} x ${t}`,`compute`);return[Math.ceil(e/n),n,1]}async readBytes(e,t,n,r){if(this.check(),G(r),n===0)return await this.#l(),new ArrayBuffer(0);let a=t&-4,o=Math.ceil((t+n)/4)*4,s=this.device.createBuffer({size:o-a,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});this.#n.add(s);let c=()=>s.destroy();r?.addEventListener(`abort`,c,{once:!0});try{let r=this.device.createCommandEncoder();return r.copyBufferToBuffer(e,a,s,0,o-a),this.device.queue.submit([r.finish()]),await this.#l(),await s.mapAsync(GPUMapMode.READ),s.getMappedRange().slice(t-a,t-a+n)}catch(e){throw this.#i?i(`disposed`,`ComputeContext disposed during a read; keep it alive until reads finish`,`compute`):(G(r),e)}finally{r?.removeEventListener(`abort`,c),this.#n.delete(s),s.destroy()}}async#l(){this.device.pushErrorScope(`validation`);let e=[...this.#r,{kind:`validation error`,error:this.device.popErrorScope()}];this.#r=[];let t=await Promise.all(e.map(e=>e.error)),n=t.findIndex(e=>e);if(n>=0)throw i(`failed`,`GPU ${e[n].kind}: ${t[n].message.trim()}; fix the kernel WGSL or its bindings (or use smaller arrays)`,`compute`)}async done(e={}){this.check(),G(e.signal),await this.#l(),await Wt(this.device.queue.onSubmittedWorkDone(),e.signal)}async profile(e,t={}){if(this.check(),this.#o)throw i(`state`,`profile() is already running; await it before profiling again`,`compute`);this.#o=[];let n=[];try{try{await e()}finally{n=this.#o,this.#o=void 0}return await this.#l(),(await Wt(Promise.all(n.map(async({staging:e,labels:t})=>{await e.mapAsync(GPUMapMode.READ);let n=new BigUint64Array(e.getMappedRange().slice(0));return t.map((e,t)=>({label:e,ms:Number(n[2*t+1]-n[2*t])/1e6}))})),t.signal)).flat()}finally{for(let{staging:e,queries:t}of n)this.#n.delete(e),e.destroy(),t.destroy()}}map(e,t,n={}){this.check();let r=e instanceof k?{x:e}:e,i=Object.keys(r);if(!i.length)throw a(`gpu.map needs at least one input array`,`compute`);for(let e of i)if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)||[`i`,`n`,`f`,`main`,`out`,`params`].includes(e)||e.startsWith(`in_`))throw a(`gpu.map input name ${e} is not a usable WGSL name; rename it`,`compute`);if(typeof t!=`string`||!t.trim())throw a(`gpu.map needs a WGSL expression`,`compute`);let s=i.map(e=>{let t=r[e];if(!(t instanceof k))throw a(`gpu.map input ${e} must be a GpuArray or an Expr`,`compute`);return t instanceof F&&t.contiguous&&t.offset===0?t:t.eval()}),c=s[0].shape,l=s[0].size;if(s.some(e=>e.shape.length!==c.length||e.shape.some((e,t)=>e!==c[t])))throw o(`gpu.map inputs must share one shape, got ${s.map(e=>`[${e.shape.join(`, `)}]`).join(`, `)}`,`compute`);let u=n.dtype??s[0].dtype,d=this.empty(c,u);if(l>0){let e=ze(i.map((e,t)=>({name:e,type:s[t].dtype})),u,t),r={out:d,params:new Uint32Array([l,2139095040,0,0])};i.forEach((e,t)=>r[`in_${e}`]=s[t]),this.submit([{program:this.program(e,void 0,n.label??`map`),resources:r,workgroups:this.grid(Math.ceil(l/256))}])}return i.forEach((e,t)=>s[t]!==r[e]&&s[t].dispose()),d}reduce(e,t=`sum`,n={}){return H(this,e,t,n)}sum(e,t){return H(this,e,`sum`,t)}prod(e,t){return H(this,e,`product`,t)}min(e,t){return H(this,e,`min`,t)}max(e,t){return H(this,e,`max`,t)}mean(e,t){return it(this,e,t)}var(e,t){return ot(this,e,t)}std(e,t){return st(this,e,t)}argmin(e,t){return ut(this,e,`min`,t)}argmax(e,t){return ut(this,e,`max`,t)}all(e,t){return H(this,e.ne(0),`min`,t)}any(e,t){return H(this,e.ne(0),`max`,t)}countNonzero(e,t){return H(this,e.ne(0),`sum`,t)}nansum(e,t){return H(this,M(e.isnan(),0,e),`sum`,t)}nanmin(e,t){return H(this,M(e.isnan(),1/0,e),`min`,t)}nanmax(e,t){return H(this,M(e.isnan(),-1/0,e),`max`,t)}nanmean(e,t){return ct(this,e,t)}scan(e,t={}){return Tt(this,e,t)}cumsum(e,t={}){return Tt(this,e,t)}cumprod(e,t={}){return Tt(this,e,{...t,op:`product`})}segmentedScan(e,t,n={}){return Et(this,e,t,n)}reduceByKey(e,t,n={}){return Dt(this,e,t,n)}sort(e,t={}){return At(this,e,t)}argsort(e,t={}){return jt(this,e,t)}sortByKey(e,t,n={}){return Mt(this,e,t,n)}topk(e,t,n={}){return Nt(this,e,t,n)}quantile(e,t){return Pt(this,e,t)}median(e){return Pt(this,e,.5)}unique(e,t={}){return Ft(this,e,t)}take(e,t,n={}){return pt(this,e,t,n)}scatter(e,t,n,r={}){return ht(this,e,t,n,r)}bincount(e,t){return gt(this,e,t)}compact(e,t){return _t(this,e,t)}filter(e,t,n={}){return yt(this,e,t,n)}nonzero(e,t={}){return bt(this,e,t)}histogram(e,t={}){return Lt(this,e,t)}dispose(){if(!this.#i){this.#i=!0;for(let e of[...this.#e])e.dispose();for(let e of this.#n)e.destroy();this.#t.clear(),this.ownsDevice&&this.device.destroy()}}[Symbol.dispose](){this.dispose()}},Kt=async e=>{let{cpuContext:t}=await pe(async()=>{let{cpuContext:e}=await import(`./cpu-load-DZsQ-qON-pnXmGO8V.js`);return{cpuContext:e}},[],import.meta.url);return G(e),t()};async function qt(e){return await e.routeReady,e}async function Jt(e={}){G(e.signal);let t=e.backend??`auto`;if(t!==`auto`&&t!==`webgpu`&&t!==`cpu`)throw a(`createCompute backend must be 'auto', 'webgpu' or 'cpu', got ${String(t)}`,`compute`);if(e.fastMath!==void 0&&typeof e.fastMath!=`boolean`)throw a(`createCompute fastMath must be true or false, got ${String(e.fastMath)}`,`compute`);let n=e.tuned??{};Vt(n,1024);let r=e.fastMath===!0,o=(e,t)=>{try{Vt(n,e.limits.maxComputeInvocationsPerWorkgroup)}catch(n){throw t&&e.destroy(),n}let i=new Gt(e,t,r);return i.tuned=n,i};if(e.device)return qt(o(e.device,!1));if(e.engine){let t=e.engine.gpu;if(!t)throw i(`unsupported`,`Engine has no WebGPU device (WebGL2 fallback); create the context without an engine`,`compute`);return qt(o(t,!1))}if(t===`cpu`)return Kt(e.signal);let s=globalThis.navigator,c=s?.gpu;if(!c){if(t===`auto`)return Kt(e.signal);throw i(`unsupported`,`WebGPU unavailable; use a runtime with WebGPU, or backend: 'cpu'`,`compute`)}let l=e.powerPreference??(/Win/.test(s?.userAgent??``)?void 0:`high-performance`),u=await Wt(c.requestAdapter(l?{powerPreference:l}:{}),e.signal);if(!u){if(t===`auto`)return Kt(e.signal);throw i(`unsupported`,`WebGPU adapter unavailable; check that the GPU is enabled, or use backend: 'cpu'`,`compute`)}let d=await u.requestDevice({requiredFeatures:[`shader-f16`,`timestamp-query`,`subgroups`].filter(e=>u.features.has(e)),requiredLimits:{maxStorageBufferBindingSize:u.limits.maxStorageBufferBindingSize,maxBufferSize:u.limits.maxBufferSize,maxStorageBuffersPerShaderStage:u.limits.maxStorageBuffersPerShaderStage,maxComputeWorkgroupStorageSize:u.limits.maxComputeWorkgroupStorageSize,maxComputeInvocationsPerWorkgroup:u.limits.maxComputeInvocationsPerWorkgroup,maxComputeWorkgroupSizeX:u.limits.maxComputeWorkgroupSizeX,maxComputeWorkgroupSizeY:u.limits.maxComputeWorkgroupSizeY,maxComputeWorkgroupSizeZ:u.limits.maxComputeWorkgroupSizeZ}});if(e.signal?.aborted)throw d.destroy(),e.signal.reason;return qt(o(d,!0))}var Yt=`struct Pass { n: u32, l: u32, lines: u32, inverse: u32 }
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
}`,Xt=e=>e>0&&!(e&e-1);function Zt(e){if(!Xt(e)||e<2)throw o(`twiddleTable needs a power of two of at least 2, got ${e}`,`compute`);let t=e/2,n=new Float32Array(e);for(let r=0;r<t;r++){let t=2*Math.PI*r/e,i=4*r===e;n[2*r]=i?0:Math.cos(t),n[2*r+1]=i?-1:-Math.sin(t)}return n}var Qt=8,$t=new WeakMap;function en(e,t){let n=$t.get(e);n||$t.set(e,n=new Map);let r=n.get(t);if(r&&!r.disposed?n.delete(t):r=e.array(Zt(t)),n.set(t,r),n.size>Qt){let[e,t]=n.entries().next().value;n.delete(e),t.dispose()}return r}function tn(e,t,n,r,i,a){let o=t,s=n,c=[],l=e.program(Yt,void 0,`fft.stockham`),u=[],d=r*i,f=e.empty([d],`f32`),p=e.empty([d],`f32`),m=r>2?e.empty([d],`f32`):f,h=r>2?e.empty([d],`f32`):p;if(r===1)return e.submit([],[[t.buffer,t.offset*4,f.buffer,0,d*4],[n.buffer,n.offset*4,p.buffer,0,d*4]]),{re:f,im:p};let g=en(e,r),_=0;for(let t=1;t<r;t*=2){let[n,c]=_===0?[f,p]:[m,h];u.push({program:l,resources:{reIn:o,imIn:s,reOut:n,imOut:c,pass_:new Uint32Array([r,t,i,+!!a]),twiddle:g},workgroups:e.grid(Math.ceil(d/2/256))}),o=n,s=c,_^=1}if(e.submit(u),r>2)for(let e of o===f?[m,h]:[f,p])c.push(e);for(let e of c)e.dispose();return{re:o,im:s}}var nn=(e,t,n,r)=>({re:e.mul(n).sub(t.mul(r)),im:e.mul(r).add(t.mul(n))});function rn(e,t,n,r,i,a){let o=1;for(;o<2*r-1;)o*=2;let s=a?1:-1,c=new Float32Array(r),l=new Float32Array(r);for(let e=0;e<r;e++){let t=s*Math.PI*(e*e%(2*r))/r;c[e]=Math.cos(t),l[e]=Math.sin(t)}let u=new Float32Array(o),d=new Float32Array(o);for(let e=0;e<r;e++)u[e]=c[e],d[e]=-l[e],e&&(u[o-e]=c[e],d[o-e]=-l[e]);let f=e.array(c,{shape:[1,r]}),p=e.array(l,{shape:[1,r]}),m=e.array(u),h=e.array(d),g=tn(e,m,h,o,1,!1),_=nn(t.reshape(i,r),n.reshape(i,r),f,p),v=e.zeros([i,o]),y=e.zeros([i,o]),b=_.re.eval(),x=_.im.eval(),S=[];for(let e=0;e<i;e++)S.push([b.buffer,e*r*4,v.buffer,e*o*4,r*4]),S.push([x.buffer,e*r*4,y.buffer,e*o*4,r*4]);e.submit([],S);let C=tn(e,v,y,o,i,!1),w=g.re.reshape(1,o),ee=g.im.reshape(1,o),T=nn(C.re.reshape(i,o),C.im.reshape(i,o),w,ee),E=T.re.eval(),D=T.im.eval(),O=tn(e,E,D,o,i,!0),te=nn(O.re.reshape(i,o).slice(null,[0,r]),O.im.reshape(i,o).slice(null,[0,r]),f,p),k={re:te.re.mul(1/o).eval().transfer([i*r]),im:te.im.mul(1/o).eval().transfer([i*r])};for(let e of[f,p,m,h,g.re,g.im,v,y,b,x,C.re,C.im,E,D,O.re,O.im])e.dispose();return k}function an(e,t,n){let r=e instanceof k?e:e.re,i=e instanceof k?void 0:e.im;if(!(r instanceof k))throw a(`fft takes a real array or { re, im } arrays`,`compute`);if(i&&(i.ndim!==r.ndim||i.shape.some((e,t)=>e!==r.shape[t])))throw o(`fft re and im must have one shape`,`compute`);let s=r.context;if(s.check(),r.ndim===0)throw o(`fft needs at least one dimension`,`compute`);let c=P(t.axis??-1,r.ndim),l=r.shape[c],u=r.shape,d=[...u.keys()].filter(e=>e!==c).concat(c),f=d.map((e,t)=>d.indexOf(t)),p=e=>{let t=e instanceof F?e:e.eval(),n=t.transpose(...d).astype(`f32`).eval();return t!==e&&t.dispose(),n},m=p(r),h=i?p(i):s.zeros(m.shape),g=l?m.size/l:0,_;_=m.size===0?{re:s.zeros(m.shape),im:s.zeros(m.shape)}:Xt(l)?tn(s,m.reshape(m.size),h.reshape(h.size),l,g,n):rn(s,m,h,l,g,n),m.dispose(),h.dispose();let v=d.map(e=>u[e]),y=e=>{let t=e.reshape(...v).transpose(...f),r=(n?t.mul(1/l):t).eval();return e.dispose(),r};return{re:y(_.re),im:y(_.im)}}function on(e,t={}){return an(e,t,!1)}function sn(e,t={}){return an(e,t,!0)}var cn=64;function ln(e,t,n){let r=l(n)?`f32`:n;return`${e===`f16`||t===`f16`||n===`f16`?`enable f16;
`:``}struct Shape { m: u32, n: u32, k: u32, pad: u32, aOffset: u32, aBatch: u32, aRow: u32, aCol: u32, bOffset: u32, bBatch: u32, bRow: u32, bCol: u32 }
@group(0) @binding(0) var<storage, read> left: array<${e}>;
@group(0) @binding(1) var<storage, read> right: array<${t}>;
@group(0) @binding(2) var<storage, read_write> product: array<${n}>;
@group(0) @binding(3) var<uniform> shape: Shape;
var<workgroup> tileA: array<array<${r}, 64>, 16>;
var<workgroup> tileB: array<array<${r}, 64>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let batch = wid.z;
  let row0 = wid.y * 64u;
  let col0 = wid.x * 64u;
  let thread = lid.y * 16u + lid.x;
  var acc: array<${r}, 16>;
  for (var k0 = 0u; k0 < shape.k; k0 += 16u) {
    for (var l = 0u; l < 4u; l++) {
      let e = thread + l * 256u;
      let am = e / 16u;
      let ak = e % 16u;
      var va: ${r} = ${r}(0);
      if (row0 + am < shape.m && k0 + ak < shape.k) {
        va = ${r}(left[shape.aOffset + batch * shape.aBatch + (row0 + am) * shape.aRow + (k0 + ak) * shape.aCol]);
      }
      tileA[ak][am] = va;
      let bk = e / 64u;
      let bn = e % 64u;
      var vb: ${r} = ${r}(0);
      if (k0 + bk < shape.k && col0 + bn < shape.n) {
        vb = ${r}(right[shape.bOffset + batch * shape.bBatch + (k0 + bk) * shape.bRow + (col0 + bn) * shape.bCol]);
      }
      tileB[bk][bn] = vb;
    }
    workgroupBarrier();
    for (var kk = 0u; kk < 16u; kk++) {
      var ra: array<${r}, 4>;
      var rb: array<${r}, 4>;
      for (var i = 0u; i < 4u; i++) { ra[i] = tileA[kk][lid.y * 4u + i]; rb[i] = tileB[kk][lid.x * 4u + i]; }
      for (var i = 0u; i < 4u; i++) {
        for (var j = 0u; j < 4u; j++) { acc[i * 4u + j] += ra[i] * rb[j]; }
      }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    let r = row0 + lid.y * 4u + i;
    for (var j = 0u; j < 4u; j++) {
      let c = col0 + lid.x * 4u + j;
      if (r < shape.m && c < shape.n) { product[(batch * shape.m + r) * shape.n + c] = ${n}(acc[i * 4u + j]); }
    }
  }
}`}function un(e,t){let n=t.length,r=e.ndim-2,i=[];for(let t=0;t<n;t++){let a=t-(n-r);i.push(a<0||e.shape[a]===1?0:e.strides[a])}if(i.every(e=>e===0))return 0;for(let e=0;e<n-1;e++)if(i[e]!==i[e+1]*t[e+1])return;return i[n-1]??0}function dn(e,t){if(!(e instanceof k)||!(t instanceof k))throw a(`matmul takes two GpuArrays or Exprs`,`compute`);if(e.context!==t.context)throw a(`matmul operands belong to different compute contexts`,`compute`);if(e.ndim===0||t.ndim===0)throw o(`matmul needs arrays of at least one dimension; use mul for scalars`,`compute`);let n=e.context;n.check();let r=[],i=e=>{if(e instanceof F)return e;let t=e.eval();return r.push(t),t},s=i(e),c=i(t),l=s.ndim===1,u=c.ndim===1;l&&(s=s.reshape(1,s.size)),u&&(c=c.reshape(c.size,1));let[d,f]=s.shape.slice(-2),[p,h]=c.shape.slice(-2);if(f!==p)throw o(`matmul shapes [${e.shape.join(`, `)}] and [${t.shape.join(`, `)}] differ in the inner dimension (${f} vs ${p})`,`compute`);let g=T(s.shape.slice(0,-2),c.shape.slice(0,-2)),_=g.reduce((e,t)=>e*t,1),v=un(s,g),y=un(c,g);v===void 0&&(s=s.broadcastTo([...g,d,f]).eval(),r.push(s),v=d*f),y===void 0&&(c=c.broadcastTo([...g,f,h]).eval(),r.push(c),y=f*h);let b=m(s.dtype,c.dtype),x=[...g,...l?[]:[d],...u?[]:[h]],S=n.empty(x,b);if(_>n.device.limits.maxComputeWorkgroupsPerDimension)throw o(`matmul batch of ${_} is over the device's ${n.device.limits.maxComputeWorkgroupsPerDimension}; split the batch`,`compute`);if(S.size>0){s.check(n),c.check(n);let e=s.ndim,t=c.ndim;n.submit([{program:n.program(ln(s.dtype,c.dtype,b),void 0,`matmul`),resources:{left:{buffer:s.buffer},right:{buffer:c.buffer},product:S,shape:new Uint32Array([d,h,f,0,s.offset,v,s.strides[e-2],s.strides[e-1],c.offset,y,c.strides[t-2],c.strides[t-1]])},workgroups:[Math.ceil(h/cn),Math.ceil(d/cn),_]}])}for(let e of r)e.dispose();return S}var K=24,fn=576,pn=Math.PI*2,mn=Float32Array.from({length:fn},(e,t)=>{let n=Math.floor(t/K)-11.5,r=t%K-11.5;return Math.cos(.42*r+.62*n)*Math.exp(-((r-n)**2)/95)+.28*Math.sin(.67*r-.33*n)}),hn=Float32Array.from({length:fn},(e,t)=>{let n=Math.floor(t/K)-11.5,r=t%K-11.5;return Math.sin(.31*r-.52*n+.025*r*n)*Math.exp(-((r+.52*n)**2)/160)+.31*Math.cos(.21*r+.74*n)}),gn=Float32Array.from({length:128},(e,t)=>Math.sin(pn*7*t/128)+.58*Math.cos(pn*23*t/128)),_n=8108521,vn=Float32Array.from({length:128},(e,t)=>(_n=Math.imul(_n,1664525)+1013904223>>>0,.94*(_n/2147483648-1)+.37*Math.sin(t*.219))),yn={A:{data:mn,shape:[K,K]},B:{data:hn,shape:[K,K]},signal:{data:gn,shape:[gn.length]},samples:{data:vn,shape:[vn.length]}},bn=[{label:`Matrix multiply`,expression:`A @ B`},{label:`FFT`,expression:`fft(signal)`},{label:`Sort`,expression:`sort(samples)`}],xn=e=>typeof e==`object`&&!!e&&`re`in e&&`im`in e;async function Sn(e){let t=new URLSearchParams(location.search).get(`backend`);if(t===`cpu`)return{gpu:await Jt({backend:`cpu`,signal:e}),backend:`cpu`};if(t!==`webgl2`&&navigator.gpu)try{return{gpu:await Jt({backend:`webgpu`,signal:e}),backend:`webgpu`}}catch(e){if(![`unsupported`,`no-adapter`].includes(e?.code))throw e}try{let{install:t}=await pe(async()=>{let{install:e}=await import(`./dist-CL_mhm0D.js`);return{install:e}},[],import.meta.url);return await t({force:!0,signal:e}),{gpu:await Jt({backend:`webgpu`,signal:e}),backend:`webgl2`}}catch(t){if(![`unsupported`,`no-adapter`].includes(t?.code))throw t;return{gpu:await Jt({backend:`cpu`,signal:e}),backend:`cpu`}}}async function Cn(e,t,n){let r=performance.now(),i=new Set,a=new Map,o=e.device.dispatches?{...e.device.dispatches}:void 0,s=e=>(i.add(e),e),c=(t,n)=>s(e.array(t,{shape:n,dtype:`f32`}));function l(e){if(xn(e))throw Error(`Use magnitude() or ifft() to operate on a complex transform.`);return typeof e==`number`?c(Float32Array.of(e),[]):e}let u=e=>typeof e==`number`?e:l(e),d=e=>xn(e)?e.re.square().add(e.im.square()).sqrt():l(e).abs();function f(t){switch(t.type){case`constant`:return t.value;case`array`:return c(Float32Array.from(t.values),t.shape);case`name`:if(!a.has(t.name)){let{data:e,shape:n}=yn[t.name];a.set(t.name,c(e,n))}return a.get(t.name);case`unary`:{let e=f(t.value);return typeof e==`number`?-e:l(e).neg()}case`binary`:{let e=l(f(t.left)),n=u(f(t.right));return t.operator===`@`?s(dn(e,l(n))):t.operator===`+`?e.add(n):t.operator===`-`?e.sub(n):t.operator===`*`?e.mul(n):e.div(n)}default:{let n=t.args.map(f),r=n[0];switch(t.name){case`fft`:case`ifft`:{let e=(t.name===`fft`?on:sn)(xn(r)?r:l(r));return s(e.re),s(e.im),e}case`magnitude`:return d(r);case`matmul`:return s(dn(l(r),l(n[1])));case`sort`:return s(e.sort(l(r)));case`transpose`:{let e=l(r),t=e instanceof F?e:s(e.eval());return s(t.transpose())}case`min`:case`max`:case`mean`:case`sum`:return s(l(r)[t.name]());default:return l(r)[t.name]()}}}}try{n.throwIfAborted();let i=f(t),a=xn(i),s=a?d(i):l(i),c=[...s.shape],u=a?{re:await i.re.read({signal:n}),im:await i.im.read({signal:n})}:void 0,p=await s.read({signal:n}),m=performance.now()-r,h=e.device.dispatches;return{data:p,shape:c,complex:u,elapsed:m,dispatches:o?{gpu:h.fragment+h.scatter-o.fragment-o.scatter,cpu:h.cpu-o.cpu}:void 0}}finally{for(let e of Array.from(i).reverse())e.dispose()}}var wn=[`A`,`B`,`signal`,`samples`],Tn={"+":1,"-":1,"*":2,"/":2,"@":2},En={abs:1,cos:1,fft:1,ifft:1,log:1,magnitude:1,matmul:2,max:1,mean:1,min:1,sin:1,sort:1,sqrt:1,square:1,sum:1,transpose:1},Dn=1e3,On=512,kn=48,q=class extends Error{constructor(e,t){super(e+` at character `+(t+1)+`.`),this.name=`ExpressionError`,this.column=t}};function An(e){if(e.length>Dn)throw new q(`Keep the expression within 1000 characters`,Dn);let t=/\s*(?:(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?|([A-Za-z][A-Za-z0-9_]*)|([()[\],+\-*/@]))/y,n=[];for(let r=0;r<e.length;){t.lastIndex=r;let i=t.exec(e);if(!i){if(/\S/.test(e.slice(r)))throw new q(`Unknown symbol`,r+(e.slice(r).match(/^\s*/)?.[0].length??0));break}let a=t.lastIndex-i[0].trimStart().length;if(n.length>=On)throw new q(`Expression has too many tokens`,a);if(i[1]){let e=Number(i[1]+(i[2]??``));if(!Number.isFinite(e)||Math.abs(e)>0x5af3107a4000)throw new q(`Literal is outside the supported numerical range`,a);n.push({type:`number`,number:e,column:a})}else n.push({type:i[4]??`name`,word:i[3],column:a});r=t.lastIndex}return n.push({type:`end`,column:e.length}),n}function jn(e){let t=An(e),n=0,r=()=>t[n],i=()=>t[n++];function a(e,t){let n=r();if(n.type!==e)throw new q(t,n.column);return i()}function o(e){if(e>2)throw new q(`An array literal supports two dimensions`,r().column);let t=a(`[`,`Expected a list`),n=[],s=null;do{let t=r().type===`[`;if(s===null&&(s=t),t!==s)throw new q(`Use a rectangular matrix or a single vector`,r().column);if(s)n.push(o(e+1));else{let e=1;(r().type===`-`||r().type===`+`)&&(e=i().type===`-`?-1:1),n.push(e*a(`number`,`Expected a number`).number)}if(r().type!==`,`)break;i()}while(r().type!==`]`);if(a(`]`,`Expected ]`),!s)return{type:`array`,shape:[n.length],values:n};if(n.some(e=>e.shape.length!==1||e.shape[0]!==n[0].shape[0]))throw new q(`Matrix rows must have equal length`,t.column);return{type:`array`,shape:[n.length,n[0].shape[0]],values:n.flatMap(e=>e.values)}}function s(e){if(e>kn)throw new q(`Expression is nested too deeply`,r().column);let t=r();if(t.type===`number`)return i(),{type:`constant`,value:t.number};if(t.type===`[`)return o(1);if(t.type===`-`||t.type===`+`){i();let n=s(e+1);return t.type===`+`?n:{type:`unary`,value:n}}if(t.type===`(`){i();let t=c(1,e+1);return a(`)`,`Expected )`),t}if(t.type===`name`){i();let n=t.word;if(r().type!==`(`){if(!wn.includes(n))throw new q(`Unknown array `+n,t.column);return{type:`name`,name:n}}if(!Object.hasOwn(En,n))throw new q(`Unknown operation `+n,t.column);i();let o=[];for(;r().type!==`)`&&(o.push(c(1,e+1)),r().type===`,`);)if(i(),r().type===`)`)throw new q(`Expected an argument`,r().column);if(a(`)`,`Expected )`),o.length!==En[n])throw new q(n+` expects `+En[n]+` argument`+(En[n]===1?``:`s`),t.column);return{type:`call`,name:n,args:o}}throw new q(`Expected a number, array, or expression`,t.column)}function c(e,t){let n=s(t);for(;(Tn[r().type]??0)>=e;){let{type:e}=i(),r=c(Tn[e]+1,t+1);n={type:`binary`,operator:e,left:n,right:r}}return n}let l=c(1,0);return a(`end`,`Unexpected token`),l}var J=e=>document.getElementById(e),Y=document.body.dataset,Mn=J(`compute-form`),Nn=J(`controls`),Pn=J(`expression`),Fn=J(`run`),X=J(`plot`),Z=J(`inspect`),In=J(`run-error`),Ln=[...Mn.querySelectorAll(`[data-example]`)],Rn=t(document.body,J(`status-text`),J(`fatal`)),zn=new AbortController,{signal:Q}=zn,Bn,Vn,Hn,Un=!1,Wn={webgpu:`WebGPU`,webgl2:`WebGL2 compatibility`,cpu:`CPU compatibility`},Gn=[30,34,49],Kn=[115,166,255],qn=[255,176,112];function $(e){if(!Number.isFinite(e))return String(e);let t=Math.abs(e);return t>=1e4||t!==0&&t<.001?e.toExponential(3):Number(e.toFixed(5)).toString()}function Jn(e,t,n=!1){if(!Number.isFinite(e))return`#69546a`;let r=Math.min(1,Math.abs(e)/t)**(n?.73:.91),i=e<0?Kn:qn;return`rgb(`+Gn.map((e,t)=>Math.round(e+(i[t]-e)*r)).join(` `)+`)`}function Yn(e){let{shape:t,data:n,complex:r}=Vn,i;if(i=t.length===2?`[`+Math.floor(e/t[1])+`, `+e%t[1]+`]`:t.length?`[`+e+`]`:`Scalar`,r){let{re:t,im:n}=r,a=n[e]<0?` − `:` + `;return i+` `+$(t[e])+a+$(Math.abs(n[e]))+`i`}return i+` `+$(n[e])}function Xn(e){Vn&&(Hn?.classList.remove(`selected`),Hn=X.children[e],Hn?.classList.add(`selected`),Z.value=String(e),J(`value`).textContent=Yn(e),Z.setAttribute(`aria-valuetext`,Yn(e)))}function Zn(e){let{shape:t,data:n,complex:r}=e,i=1/0,a=-1/0;for(let e of n)Number.isFinite(e)&&(i=Math.min(i,e),a=Math.max(a,e));let o=Number.isFinite(i)?Math.max(Math.abs(i),Math.abs(a),1e-10):1,s=J(`color-scale`);s.hidden=!t.length,s.classList.toggle(`sequential`,!!r),J(`lo`).textContent=$(r?0:-o),J(`hi`).textContent=$(o),Vn=e,Hn=void 0,X.replaceChildren();let c=t.length===2?`matrix`:t.length===1?`vector`:`scalar`;X.className=`plot `+c,J(`plotstage`).setAttribute(`aria-label`,r?`Complex array magnitude`:c+` output`);let l=J(`plot-axis`);l.hidden=c!==`vector`,l.textContent=(r?`Frequency bins `:`Indices `)+`0–`+(n.length-1);let u=document.createDocumentFragment();if(c===`matrix`){let[e,r]=t;X.style.setProperty(`--columns`,r),X.style.setProperty(`--rows`,e);for(let[e,t]of n.entries()){let n=document.createElement(`span`);n.dataset.index=e,n.style.background=Jn(t,o),u.append(n)}}else if(c===`vector`){let e=r?o:Math.max(0,a),t=r?0:Math.min(0,i),s=Number.isFinite(e)&&Number.isFinite(t),c=s?Math.max(e-t,1e-10):1,l=s?e/c*100:50;X.style.setProperty(`--axis`,l+`%`),X.style.setProperty(`--columns`,n.length);for(let[t,r]of n.entries()){let n=document.createElement(`span`),i=document.createElement(`i`),a=Number.isFinite(r)&&s?100*(e-r)/c:l;n.dataset.index=t,i.style.setProperty(`--begin`,Math.min(a,l)+`%`),i.style.setProperty(`--size`,Math.max(.8,Math.abs(a-l))+`%`),i.style.background=Jn(r,o,!0),n.append(i),u.append(n)}}else{let e=document.createElement(`strong`);e.textContent=$(n[0]),u.append(e)}X.append(u),Z.max=String(Math.max(0,n.length-1)),Z.disabled=n.length<2,Xn(c===`matrix`?Math.floor(t[0]/2)*t[1]+Math.floor(t[1]/2):0)}function Qn(e,t){Zn(e);let{shape:n,complex:r,dispatches:i}=e,a=n.length?n.join(` × `):`scalar`;J(`elapsed`).textContent=e.elapsed.toFixed(e.elapsed<10?2:1)+` ms`,J(`shape`).textContent=a,J(`result-expression`).textContent=t,J(`result-title`).textContent=r?`Magnitude`:n.length===2?`Matrix result`:n.length===1?`Array result`:`Scalar result`,J(`result-format`).textContent=r?`Complex · float32`:`Float32`,J(`dispatches`).hidden=!i,i&&(J(`dispatch-count`).textContent=i.gpu+` GPU · `+i.cpu+` CPU`,Y.gpuDispatches=String(i.gpu),Y.cpuDispatches=String(i.cpu)),Y.expression=t,Y.shape=n.join(`x`),Y.entries=String(e.data.length),Y.elapsed=e.elapsed.toFixed(3),Y.complex=String(!!r),Y.sample=Array.from(e.data.subarray(0,6)).join(`,`)}function $n(){return new Promise(e=>requestAnimationFrame(()=>requestAnimationFrame(e)))}async function er(e,t){if(!(Un||Q.aborted)){Un=!0,Fn.disabled=!0;for(let e of Ln)e.disabled=!0;In.hidden=!0,Fn.textContent=`Running…`;try{let n=jn(e),r=AbortSignal.any([Q,AbortSignal.timeout(8e3)]),i=await Cn(Bn,n,r);if(Q.aborted)return;Qn(i,e),await $n(),t&&!performance.getEntriesByName(`first-control-frame`).length&&performance.mark(`first-control-frame`),t&&performance.mark(`expression-frame`)}catch(e){if(!t)throw e;Q.aborted||(In.textContent=e?.message??String(e),In.hidden=!1)}finally{Un=!1,Fn.textContent=`Run expression`,Fn.disabled=!1;for(let e of Ln)e.disabled=!1}}}function tr(){Mn.addEventListener(`submit`,e=>{e.preventDefault(),er(Pn.value,!0)},{signal:Q});for(let e of Ln)e.addEventListener(`click`,()=>{Pn.value=bn[Number(e.dataset.example)].expression,er(Pn.value,!0)},{signal:Q});Z.addEventListener(`input`,()=>Xn(Number(Z.value)),{signal:Q}),X.addEventListener(`click`,e=>{let t=e.target.closest(`[data-index]`);t&&Xn(Number(t.dataset.index))},{signal:Q})}async function nr(){let e=await Sn(Q);Bn=e.gpu,Q.aborted?Bn.dispose():(Y.renderer=e.backend,J(`backend`).textContent=Wn[e.backend],performance.mark(`compute-ready`),await er(Pn.value,!1),Q.throwIfAborted(),tr(),Nn.disabled=!1,Rn.ready()&&(J(`status`).hidden=!0),performance.mark(`workbench-ready`))}addEventListener(`pagehide`,e=>{e.persisted||(zn.abort(),Bn?.dispose())}),nr().catch(e=>{Q.aborted||(Rn.error(e),J(`status-text`).textContent=`Margo Compute could not open.`)});export{F as a,l as c,i as d,a as f,P as i,m as l,Gt as n,k as o,pe as r,M as s,G as t,o as u};