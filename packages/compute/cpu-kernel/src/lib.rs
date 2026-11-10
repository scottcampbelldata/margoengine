// Clean-room CPU execution from the Wasm SIMD specification and X100 vector execution.
// f64 intermediates, explicit f32 rounding and ordered folds match cpu.ts exactly.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "host")]
extern "C" {
    fn math(op: u32, a: f64, b: f64) -> f64;
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn math(op: u32, a: f64, b: f64) -> f64 {
    match op {
        6 => a.powf(b),
        10 => a.atan2(b),
        11 => a.hypot(b),
        16 => a.sqrt(),
        17 => a.exp(),
        18 => 2f64.powf(a),
        19 => a.ln(),
        20 => a.log2(),
        21 => a.sin(),
        22 => a.cos(),
        23 => a.tan(),
        24 => a.asin(),
        25 => a.acos(),
        26 => a.atan(),
        27 => a.sinh(),
        28 => a.cosh(),
        29 => a.tanh(),
        32 => 1. / a.sqrt(),
        33 => 1. / a,
        34 => a.ln_1p(),
        35 => a.exp_m1(),
        _ => unreachable!(),
    }
}
fn f(x: f64) -> f64 {
    (x as f32) as f64
}
fn uint(x: f64) -> u32 {
    if x.is_finite() {
        x.trunc().rem_euclid(4294967296.) as u32
    } else {
        0
    }
}
fn round(x: f64, t: usize) -> f64 {
    match t {
        1 => (uint(x) as i32) as f64,
        2 => uint(x) as f64,
        _ => f(x),
    }
}
fn cast(x: f64, from: usize, to: usize) -> f64 {
    if from == to {
        return x;
    }
    if to == 0 {
        return f(x);
    }
    if from == 0 {
        if to == 1 {
            (x as i32) as f64
        } else {
            (x as u32) as f64
        }
    } else {
        round(x, to)
    }
}
fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0. && b == 0. {
        if a.is_sign_negative() || b.is_sign_negative() {
            -0.
        } else {
            0.
        }
    } else if a < b {
        a
    } else {
        b
    }
}
fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0. && b == 0. {
        if a.is_sign_positive() || b.is_sign_positive() {
            0.
        } else {
            -0.
        }
    } else if a > b {
        a
    } else {
        b
    }
}
fn bitcast(x: f64, from: usize, to: usize) -> f64 {
    let bits = if from == 0 {
        (x as f32).to_bits()
    } else {
        uint(x)
    };
    match to {
        0 => f32::from_bits(bits) as f64,
        1 => (bits as i32) as f64,
        _ => bits as f64,
    }
}
fn op(id: usize, a: f64, b: f64, c: f64, t: usize, out: usize) -> f64 {
    let fl = |v| if t == 0 { v } else { f(v) };
    let imul = |a, b| (uint(a).wrapping_mul(uint(b)) as i32) as f64;
    let flag = |v| if v { 1. } else { 0. };
    match id {
        0 => round(a + b, out),
        1 => round(a - b, out),
        2 => {
            if t == 0 {
                f(a * b)
            } else {
                round(imul(a, b), out)
            }
        }
        3 => f(fl(a) / fl(b)),
        4 => {
            if t == 0 {
                f(f(a / b).floor())
            } else if b == 0. {
                0.
            } else if t == 2 {
                (a / b).floor()
            } else {
                let q = if a == i32::MIN as f64 && b == -1. {
                    a
                } else {
                    (a / b).trunc()
                };
                round(
                    q - if a % b != 0. && ((a < 0.) != (b < 0.)) {
                        1.
                    } else {
                        0.
                    },
                    1,
                )
            }
        }
        5 => {
            if t == 0 {
                f(a - f(b * f(a / b).floor()))
            } else if b == 0. {
                0.
            } else if t == 2 {
                a % b
            } else {
                let r = round(a % b, 1);
                round(round(r + b, 1) % b, 1)
            }
        }
        6 | 10 | 11 => f(unsafe { math(id as u32, fl(a), fl(b)) }),
        7 => min(a, b),
        8 => max(a, b),
        9 => min(max(a, b), c),
        12 => round(-a, out),
        13 => {
            if t == 2 {
                a
            } else {
                round(a.abs(), out)
            }
        }
        14 => {
            if a.is_nan() {
                a
            } else {
                flag(a > 0.) - flag(a < 0.)
            }
        }
        15 => {
            if t == 0 {
                f(a * a)
            } else {
                round(imul(a, a), out)
            }
        }
        16..=29 | 32..=35 => f(unsafe { math(id as u32, fl(a), 0.) }),
        30 => f(fl(a) * f(180. / std::f64::consts::PI)),
        31 => f(fl(a) * f(std::f64::consts::PI / 180.)),
        36 => {
            if t == 0 {
                a.floor()
            } else {
                a
            }
        }
        37 => {
            if t == 0 {
                a.ceil()
            } else {
                a
            }
        }
        38 => {
            if t == 0 {
                a.trunc()
            } else {
                a
            }
        }
        39 => {
            if t == 0 {
                a.round_ties_even()
            } else {
                a
            }
        }
        40 => flag(a < b),
        41 => flag(a <= b),
        42 => flag(a > b),
        43 => flag(a >= b),
        44 => flag(a == b),
        45 => flag(a != b),
        46 => flag(a != 0. && b != 0.),
        47 => flag(a != 0. || b != 0.),
        48 => flag((a != 0.) != (b != 0.)),
        49 => flag(a == 0.),
        50 => flag(t == 0 && a.is_nan()),
        51 => flag(t == 0 && a.is_infinite()),
        52 => flag(t != 0 || a.is_finite()),
        53 => round((uint(a) & uint(b)) as f64, out),
        54 => round((uint(a) | uint(b)) as f64, out),
        55 => round((uint(a) ^ uint(b)) as f64, out),
        56 => round((!uint(a)) as f64, out),
        57 => round(uint(a).wrapping_shl(uint(b) & 31) as f64, out),
        58 => {
            if t == 2 {
                (uint(a) >> (uint(b) & 31)) as f64
            } else {
                ((uint(a) as i32) >> (uint(b) & 31)) as f64
            }
        }
        59 => uint(a).count_ones() as f64,
        60 => bitcast(a, t, out),
        61 => cast(a, t, out),
        _ => unreachable!(),
    }
}
fn identity(t: usize, op: usize) -> f64 {
    match op {
        0 => 0.,
        1 => 1.,
        2 => match t {
            1 => i32::MAX as f64,
            2 => u32::MAX as f64,
            _ => f64::INFINITY,
        },
        _ => match t {
            1 => i32::MIN as f64,
            2 => 0.,
            _ => f64::NEG_INFINITY,
        },
    }
}
fn combine(a: f64, b: f64, t: usize, op: usize) -> f64 {
    match op {
        0 => {
            if t == 0 {
                a + b
            } else {
                round(a + b, t)
            }
        }
        1 => {
            if t == 0 {
                f(a * b)
            } else {
                round(uint(a).wrapping_mul(uint(b)) as f64, t)
            }
        }
        2 => {
            if b < a {
                b
            } else {
                a
            }
        }
        _ => {
            if b > a {
                b
            } else {
                a
            }
        }
    }
}
fn finish(a: f64, t: usize, op: usize) -> f64 {
    if t == 0 && op == 0 {
        f(a)
    } else {
        a
    }
}
fn product(a: &[f64]) -> usize {
    a.iter().map(|x| *x as usize).product()
}

fn expression(p: &[f64], a: &[Vec<f64>]) -> Vec<f64> {
    let id = p[0] as usize;
    let t = p[1] as usize;
    let out = p[2] as usize;
    let n = a[0].len();
    let mut v = vec![0.; n];
    let mut i = 0;
    // Independent double-precision lanes followed by the scalar path's exact rounding.
    #[cfg(target_arch = "wasm32")]
    if id <= 2 && t == 0 && out == 0 && p[3..].iter().all(|x| *x == 0.) {
        unsafe {
            use core::arch::wasm32::*;
            while i + 1 < n {
                let x = v128_load(a[0].as_ptr().add(i) as *const v128);
                let y = v128_load(a[1].as_ptr().add(i) as *const v128);
                let z = match id {
                    0 => f64x2_add(x, y),
                    1 => f64x2_sub(x, y),
                    _ => f64x2_mul(x, y),
                };
                v[i] = f(f64x2_extract_lane::<0>(z));
                v[i + 1] = f(f64x2_extract_lane::<1>(z));
                GROUPS += 1;
                i += 2;
            }
        }
    }
    while i < n {
        if id == 62 {
            v[i] = if a[0][i] != 0. {
                cast(a[1][i], p[4] as usize, out)
            } else {
                cast(a[2][i], p[5] as usize, out)
            };
        } else {
            let x = cast(a[0][i], p[3] as usize, t);
            let y = if a.len() > 1 {
                cast(a[1][i], p[4] as usize, t)
            } else {
                0.
            };
            let z = if a.len() > 2 {
                cast(a[2][i], p[5] as usize, t)
            } else {
                0.
            };
            v[i] = op(id, x, y, z, t, out);
        }
        i += 1;
    }
    v
}

fn execute(id: usize, p: &[f64], a: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let u = |i: usize| p[i] as usize;
    match id {
        0 => {
            let mut out = vec![0.; u(0)];
            for (i, v) in out.iter_mut().enumerate() {
                let mut rest = i;
                let mut at = p[1] as isize;
                for k in (0..a[1].len()).rev() {
                    at += (rest % (a[1][k] as usize)) as isize * a[2][k] as isize;
                    rest /= a[1][k] as usize;
                }
                *v = a[0][at as usize];
            }
            vec![out]
        }
        1 => vec![vec![round(p[1], u(2)); u(0)]],
        2 => vec![(0..u(0)).map(|i| i as f64).collect()],
        3 => vec![expression(p, a)],
        4 => {
            let t = u(0);
            let op = u(1);
            let mut out = vec![identity(t, op); u(2)];
            for (i, &v) in a[0].iter().enumerate() {
                let mut rest = i;
                let mut at = 0;
                let mut step = 1;
                for k in (0..a[1].len()).rev() {
                    let d = a[1][k] as usize;
                    let c = rest % d;
                    rest /= d;
                    if !a[2].contains(&(k as f64)) {
                        at += c * step;
                        step *= d;
                    }
                }
                out[at] = combine(out[at], v, t, op);
            }
            for v in &mut out {
                *v = finish(*v, t, op);
            }
            vec![out]
        }
        5 => {
            let len = u(0);
            let inner = u(1);
            let outer = a[0].len() / (len * inner);
            let mut out = vec![0.; outer * inner];
            for o in 0..outer {
                for j in 0..inner {
                    let mut best = 0;
                    for k in 1..len {
                        let x = a[0][(o * len + k) * inner + j];
                        let b = a[0][(o * len + best) * inner + j];
                        if if u(2) == 1 { x > b } else { x < b } {
                            best = k;
                        }
                    }
                    out[o * inner + j] = best as f64;
                }
            }
            vec![out]
        }
        6 => {
            let t = u(0);
            let op = u(1);
            let len = u(2);
            let inner = u(3);
            let mut out = vec![0.; a[0].len()];
            if len * inner > 0 {
                for o in 0..a[0].len() / (len * inner) {
                    for j in 0..inner {
                        let mut acc = identity(t, op);
                        for k in 0..len {
                            let at = (o * len + k) * inner + j;
                            if u(4) == 1 {
                                out[at] = finish(acc, t, op);
                            }
                            acc = combine(acc, a[0][at], t, op);
                            if u(4) == 0 {
                                out[at] = finish(acc, t, op);
                            }
                        }
                    }
                }
            }
            vec![out]
        }
        7 => {
            let t = u(0);
            let op = u(1);
            let mut out = vec![0.; a[0].len()];
            let mut acc = identity(t, op);
            for i in 0..out.len() {
                if a[1][i] != 0. {
                    acc = identity(t, op);
                }
                if u(2) == 1 {
                    out[i] = finish(acc, t, op);
                }
                acc = combine(acc, a[0][i], t, op);
                if u(2) == 0 {
                    out[i] = finish(acc, t, op);
                }
            }
            vec![out]
        }
        8 => {
            let t = u(0);
            let op = u(1);
            let mut keys = vec![];
            let mut vals = vec![];
            for i in 0..a[0].len() {
                if i == 0 || a[0][i] != a[0][i - 1] {
                    keys.push(a[0][i]);
                    vals.push(identity(t, op));
                }
                let last = vals.len() - 1;
                vals[last] = combine(vals[last], a[1][i], t, op);
            }
            for v in &mut vals {
                *v = finish(*v, t, op);
            }
            vec![keys, vals]
        }
        9 => {
            let t = u(0);
            let bits = u(1);
            let mask = if bits == 32 {
                u32::MAX
            } else {
                (1u32 << bits) - 1
            };
            let keys: Vec<u32> = a[0]
                .iter()
                .map(|&v| {
                    let k = match t {
                        2 => uint(v),
                        1 => uint(v) ^ 0x80000000,
                        _ => {
                            let b = (v as f32).to_bits();
                            if b & 0x80000000 != 0 {
                                !b
                            } else {
                                b | 0x80000000
                            }
                        }
                    };
                    (if u(2) == 1 { !k } else { k }) & mask
                })
                .collect();
            let mut order: Vec<usize> = (0..keys.len()).collect();
            let mut next = vec![0; keys.len()];
            for shift in (0..bits).step_by(8) {
                let mut counts = [0usize; 256];
                for &k in &keys {
                    counts[((k >> shift) & 255) as usize] += 1;
                }
                let mut sum = 0;
                for c in &mut counts {
                    let n = *c;
                    *c = sum;
                    sum += n;
                }
                for &k in &order {
                    let d = ((keys[k] >> shift) & 255) as usize;
                    next[counts[d]] = k;
                    counts[d] += 1;
                }
                std::mem::swap(&mut order, &mut next);
            }
            vec![order.iter().map(|&i| i as f64).collect()]
        }
        10 => vec![a[1].iter().map(|&i| a[0][i as usize]).collect()],
        11 => {
            let n = a[0].len();
            vec![a[1]
                .iter()
                .map(|&q| {
                    let lower = (q * (n - 1) as f64).floor() as usize;
                    let upper = (lower + 1).min(n - 1);
                    let w = f(q * (n - 1) as f64 - lower as f64);
                    f(a[0][lower] + f(f(a[0][upper] - a[0][lower]) * w))
                })
                .collect()]
        }
        12 => {
            let mut v = vec![];
            let mut c = vec![];
            for i in 0..a[0].len() {
                if i == 0 || a[0][i] != a[0][i - 1] {
                    v.push(a[0][i]);
                    c.push(0.);
                }
                *c.last_mut().unwrap() += 1.;
            }
            vec![v, c]
        }
        13 => {
            let len = u(0) as isize;
            let inner = u(1);
            let count = a[1].len().max(1);
            let mut out = vec![0.; u(2)];
            for o in 0..out.len() {
                let j = o % inner;
                let at = (o / inner) % count;
                let outer = o / (inner * count);
                let mut k = a[1][at] as isize;
                if k < 0 {
                    k += len;
                }
                k = if u(3) == 1 {
                    k.rem_euclid(len)
                } else {
                    k.clamp(0, len - 1)
                };
                out[o] = a[0][(outer * len as usize + k as usize) * inner + j];
            }
            vec![out]
        }
        14 => {
            let mut out = a[0].clone();
            let len = out.len() as isize;
            for i in 0..a[1].len() {
                let mut k = a[1][i] as isize;
                if k < 0 {
                    k += len;
                }
                if k < 0 || k >= len {
                    continue;
                }
                let k = k as usize;
                let v = a[2][if a[2].len() == 1 { 0 } else { i }];
                out[k] = match u(1) {
                    1 => round(out[k] + v, u(0)),
                    2 => min(out[k], v),
                    3 => max(out[k], v),
                    _ => v,
                };
            }
            vec![out]
        }
        15 => {
            let mut out = vec![0.; a[0].len()];
            let mut n = 0;
            for i in 0..out.len() {
                if a[1][i] != 0. {
                    out[n] = a[0][i];
                    n += 1;
                }
            }
            vec![out, vec![n as f64]]
        }
        16 => {
            let bins = u(0);
            let n = a[0].len();
            let mut lo = if u(1) == 1 {
                f(p[2])
            } else if n > 0 {
                f64::INFINITY
            } else {
                0.
            };
            let mut hi = if u(1) == 1 {
                f(p[3])
            } else if n > 0 {
                f64::NEG_INFINITY
            } else {
                1.
            };
            if u(1) == 0 {
                for &x in &a[0] {
                    if x < lo {
                        lo = x;
                    }
                    if x > hi {
                        hi = x;
                    }
                }
            }
            if lo == hi {
                lo = f(lo - 0.5);
                hi = f(hi + 0.5);
            }
            let scale = f(bins as f64 / f(hi - lo));
            let mut counts = vec![0.; bins];
            for &x in &a[0] {
                if x >= lo && x <= hi {
                    let b = (f(f(x - lo) * scale) as usize).min(bins - 1);
                    counts[b] += 1.;
                }
            }
            let edges = (0..=bins)
                .map(|i| f(lo + f(f(f(hi - lo) * i as f64) / bins as f64)))
                .collect();
            vec![counts, edges]
        }
        17 => {
            let m = u(0);
            let n = u(1);
            let k = u(2);
            let t = u(12);
            let size = u(13);
            let mut out = vec![0.; size];
            let mut row = vec![0.; n];
            if m * n > 0 {
                for b in 0..size / (m * n) {
                    for i in 0..m {
                        row.fill(0.);
                        let a0 = u(4) + b * u(5) + i * u(6);
                        for kk in 0..k {
                            let av = a[0][a0 + kk * u(7)];
                            let b0 = u(8) + b * u(9) + kk * u(10);
                            let mut j = 0;
                            #[cfg(target_arch = "wasm32")]
                            if t == 0 && u(11) == 1 {
                                unsafe {
                                    use core::arch::wasm32::*;
                                    while j + 1 < n {
                                        let prev = v128_load(row.as_ptr().add(j) as *const v128);
                                        let bv =
                                            v128_load(a[1].as_ptr().add(b0 + j) as *const v128);
                                        v128_store(
                                            row.as_mut_ptr().add(j) as *mut v128,
                                            f64x2_add(prev, f64x2_mul(f64x2_splat(av), bv)),
                                        );
                                        GROUPS += 1;
                                        j += 2;
                                    }
                                }
                            }
                            while j < n {
                                let bv = a[1][b0 + j * u(11)];
                                row[j] = if t == 0 {
                                    row[j] + av * bv
                                } else {
                                    round(
                                        row[j] + (uint(av).wrapping_mul(uint(bv)) as i32) as f64,
                                        t,
                                    )
                                };
                                j += 1;
                            }
                        }
                        for j in 0..n {
                            out[(b * m + i) * n + j] = round(row[j], t);
                        }
                    }
                }
            }
            vec![out]
        }
        18 => {
            let n = u(0);
            let l = u(1);
            let lines = u(2);
            let half = n / 2;
            let stride = half / l;
            let mut re = vec![0.; n * lines];
            let mut im = vec![0.; n * lines];
            for line in 0..lines {
                let base = line * n;
                for j in 0..half {
                    let k = j % l;
                    let wr = a[2][2 * k * stride];
                    let wi = a[2][2 * k * stride + 1] * if u(3) == 1 { -1. } else { 1. };
                    let ar = a[0][base + j];
                    let ai = a[1][base + j];
                    let br0 = a[0][base + j + half];
                    let bi0 = a[1][base + j + half];
                    let br = f(f(wr * br0) - f(wi * bi0));
                    let bi = f(f(wr * bi0) + f(wi * br0));
                    let dest = base + 2 * j - k;
                    re[dest] = f(ar + br);
                    im[dest] = f(ai + bi);
                    re[dest + l] = f(ar - br);
                    im[dest + l] = f(ai - bi);
                }
            }
            vec![re, im]
        }
        19 => {
            let n = u(0);
            let m = u(1);
            let length = u(2);
            let start = u(3);
            let lines = u(4);
            let mut out = vec![0.; length * lines];
            for t in 0..out.len() {
                let line = t / length;
                let k = t % length + start;
                let first = k.saturating_sub(m - 1);
                let last = k.min(n - 1);
                let mut sum = 0.;
                for j in first..=last {
                    sum = f(sum + a[0][line * n + j] * a[1][k - j]);
                }
                out[t] = sum;
            }
            vec![out]
        }
        20 => {
            let h = u(0);
            let w = u(1);
            let kh = u(2);
            let kw = u(3);
            let oh = u(4);
            let ow = u(5);
            let mut out = vec![0.; oh * ow * u(8)];
            for t in 0..out.len() {
                let b = t / (oh * ow);
                let y = (t / ow) % oh + u(6);
                let x = t % ow + u(7);
                let mut sum = 0.;
                for i in 0..kh {
                    if y < i || y - i >= h {
                        continue;
                    }
                    for j in 0..kw {
                        if x < j || x - j >= w {
                            continue;
                        }
                        sum = f(sum + a[0][(b * h + y - i) * w + x - j] * a[1][i * kw + j]);
                    }
                }
                out[t] = sum;
            }
            vec![out]
        }
        21 | 22 => {
            let mut out = vec![0.; u(0)];
            for row in 0..out.len() {
                let mut sum = 0.;
                for k in a[0][row] as usize..a[0][row + 1] as usize {
                    if id == 21 {
                        sum = f(sum + a[2][k] * a[3][a[1][k] as usize]);
                    } else if a[1][k] == row as f64 {
                        sum = f(sum + a[2][k]);
                    }
                }
                out[row] = sum;
            }
            vec![out]
        }
        23 => {
            let mut out = vec![0.; u(0)];
            let mut word = [0u32; 4];
            for i in 0..out.len() {
                let lane = i & 3;
                if lane == 0 {
                    let block = (i / 4) as u32;
                    let low = (p[1] as u32).wrapping_add(block);
                    let high = (p[2] as u32).wrapping_add(if low < (p[1] as u32) { 1 } else { 0 });
                    word = [low, high, p[6] as u32, 0];
                    let mut k0 = p[4] as u32;
                    let mut k1 = p[5] as u32;
                    for _ in 0..10 {
                        let p0 = 0xd2511f53u64 * word[0] as u64;
                        let p1 = 0xcd9e8d57u64 * word[2] as u64;
                        word = [
                            (p1 >> 32) as u32 ^ word[1] ^ k0,
                            p1 as u32,
                            (p0 >> 32) as u32 ^ word[3] ^ k1,
                            p0 as u32,
                        ];
                        k0 = k0.wrapping_add(0x9e3779b9);
                        k1 = k1.wrapping_add(0xbb67ae85);
                    }
                }
                let unit = |x: u32| f((x >> 8) as f64 * 5.9604644775390625e-8);
                let value = word[lane];
                out[i] = match u(3) {
                    1 => f(p[8] + f(f(p[9] - p[8]) * unit(value))),
                    2 => {
                        let pair = lane & 2;
                        let u1 = f(((word[pair] >> 8) + 1) as f64 * 5.9604644775390625e-8);
                        let u2 = unit(word[pair + 1]);
                        let radius = f(unsafe { math(16, f(-2. * f(math(19, u1, 0.))), 0.) });
                        let angle = f(f(2. * std::f64::consts::PI) * u2);
                        let z = f(radius
                            * f(unsafe { math(if lane & 1 == 1 { 21 } else { 22 }, angle, 0.) }));
                        f(p[8] + f(p[9] * z))
                    }
                    3 => round(
                        p[10] + (((value as u64 * (p[7] as u64)) >> 32) as u32 as i32) as f64,
                        1,
                    ),
                    _ => value as f64,
                };
            }
            vec![out]
        }
        _ => unreachable!(),
    }
}

static mut INPUT: Vec<f64> = Vec::new();
static mut OUTPUT: Vec<Vec<f64>> = Vec::new();
static mut GROUPS: usize = 0;
#[no_mangle]
pub unsafe extern "C" fn groups() -> usize {
    GROUPS
}
#[no_mangle]
pub unsafe extern "C" fn reserve(n: usize) -> *mut f64 {
    INPUT.resize(n, 0.);
    INPUT.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn run(id: usize) -> usize {
    GROUPS = 0;
    let count = INPUT[0] as usize;
    let mut at = 1;
    let mut arrays = Vec::with_capacity(count);
    for _ in 0..count {
        let n = INPUT[at] as usize;
        at += 1;
        arrays.push(INPUT[at..at + n].to_vec());
        at += n;
    }
    OUTPUT = execute(id, &arrays[0], &arrays[1..]);
    OUTPUT.len()
}
#[no_mangle]
pub unsafe extern "C" fn output(i: usize) -> *const f64 {
    OUTPUT[i].as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn length(i: usize) -> usize {
    OUTPUT[i].len()
}
#[no_mangle]
pub unsafe extern "C" fn release() {
    INPUT = Vec::new();
    OUTPUT = Vec::new();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conversions() {
        assert_eq!(round(4294967295., 1), -1.);
        assert_eq!(cast(3e9, 0, 1), 2147483647.);
        assert_eq!(op(4, -7., 2., 0., 1, 1), -4.);
        assert_eq!(op(5, -7., 3., 0., 1, 1), 2.);
    }
    #[test]
    fn ordered_sum() {
        assert_eq!(
            execute(
                4,
                &[0., 0., 1.],
                &[vec![1e16, 1., -1e16], vec![3.], vec![0.]]
            ),
            vec![vec![0.]]
        );
    }
    #[test]
    fn stable_radix() {
        assert_eq!(
            execute(9, &[0., 32., 0.], &[vec![2., -0., 0., 2., -1.]]),
            vec![vec![4., 1., 2., 0., 3.]]
        );
    }
}
