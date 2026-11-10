use crate::attrs::{floating, input, optional, same_type, Attrs};
use crate::tensor::{broadcast, broadcast_index, Number, Result, Tensor};
use std::cmp::Ordering;

pub static mut SIMD_GROUPS: u64 = 0;
#[cfg(target_arch = "wasm32")]
fn simd_prefix(op: &str, a: &Tensor, b: &Tensor, out: &mut Tensor) -> usize {
    if !matches!(op, "Add" | "Sub" | "Mul")
        || a.kind != b.kind
        || a.kind != out.kind
        || !(a.shape == out.shape || a.size() == 1)
        || !(b.shape == out.shape || b.size() == 1)
    {
        return 0;
    }
    let bytes = match a.kind {
        1 | 6 | 12 => 4,
        7 | 11 | 13 => 8,
        4 | 5 => 2,
        2 | 3 if op != "Mul" => 1,
        _ => return 0,
    };
    let lanes = 16 / bytes;
    let mut at = 0;
    let n = out.size();
    unsafe {
        use core::arch::wasm32::*;
        let constant = |t: &Tensor| match t.kind {
            1 => f32x4_splat(t.get(0).f() as f32),
            11 => f64x2_splat(t.get(0).f()),
            7 | 13 => i64x2_splat(t.get(0).u() as i64),
            6 | 12 => i32x4_splat(t.get(0).u() as i32),
            4 | 5 => i16x8_splat(t.get(0).u() as i16),
            _ => i8x16_splat(t.get(0).u() as i8),
        };
        let av = if a.size() == 1 {
            Some(constant(a))
        } else {
            None
        };
        let bv = if b.size() == 1 {
            Some(constant(b))
        } else {
            None
        };
        let data = std::sync::Arc::make_mut(&mut out.data);
        while at + lanes <= n {
            let x = av.unwrap_or_else(|| v128_load(a.data.as_ptr().add(at * bytes) as *const v128));
            let y = bv.unwrap_or_else(|| v128_load(b.data.as_ptr().add(at * bytes) as *const v128));
            let v = match (a.kind, op) {
                (1, "Add") => f32x4_add(x, y),
                (1, "Sub") => f32x4_sub(x, y),
                (1, _) => f32x4_mul(x, y),
                (11, "Add") => f64x2_add(x, y),
                (11, "Sub") => f64x2_sub(x, y),
                (11, _) => f64x2_mul(x, y),
                (7 | 13, "Add") => i64x2_add(x, y),
                (7 | 13, "Sub") => i64x2_sub(x, y),
                (7 | 13, _) => i64x2_mul(x, y),
                (6 | 12, "Add") => i32x4_add(x, y),
                (6 | 12, "Sub") => i32x4_sub(x, y),
                (6 | 12, _) => i32x4_mul(x, y),
                (4 | 5, "Add") => i16x8_add(x, y),
                (4 | 5, "Sub") => i16x8_sub(x, y),
                (4 | 5, _) => i16x8_mul(x, y),
                (_, "Add") => i8x16_add(x, y),
                _ => i8x16_sub(x, y),
            };
            v128_store(data.as_mut_ptr().add(at * bytes) as *mut v128, v);
            SIMD_GROUPS += 1;
            at += lanes;
        }
    }
    at
}
#[cfg(not(target_arch = "wasm32"))]
fn simd_prefix(_op: &str, _a: &Tensor, _b: &Tensor, _out: &mut Tensor) -> usize {
    0
}

// erf(x) = sign(x) P(1/2,x^2). NIST DLMF 8.7 (power series) and 8.9
// (continued fraction); ordered f64 arithmetic, with no float32 approximation.
pub fn erf(x: f64) -> f64 {
    if x == 0. || x.is_nan() {
        return x;
    }
    let a = x.abs();
    if a >= 27. {
        return x.signum();
    }
    if a < 1e-8 {
        return x * std::f64::consts::FRAC_2_SQRT_PI;
    }
    let z = a * a;
    let scale = a * (-z - 0.572364942924700087).exp();
    let value = if z < 1.5 {
        let mut term = 2.;
        let mut sum = term;
        let mut at = 0.5;
        for _ in 0..256 {
            at += 1.;
            term *= z / at;
            sum += term;
            if term.abs() < sum.abs() * f64::EPSILON {
                break;
            }
        }
        sum * scale
    } else {
        1. - gamma_q_half(z, scale)
    };
    x.signum() * value
}

fn gamma_q_half(z: f64, scale: f64) -> f64 {
    let mut b = z + 0.5;
    let mut c = 1e300;
    let mut d = 1. / b;
    let mut h = d;
    for i in 1..=256 {
        let an = -(i as f64) * (i as f64 - 0.5);
        b += 2.;
        d = an * d + b;
        if d.abs() < 1e-300 {
            d = 1e-300;
        }
        c = b + an / c;
        if c.abs() < 1e-300 {
            c = 1e-300;
        }
        d = 1. / d;
        let delta = d * c;
        h *= delta;
        if (delta - 1.).abs() <= f64::EPSILON {
            break;
        }
    }
    scale * h
}

pub fn erfc(x: f64) -> f64 {
    if x.is_nan() {
        return x;
    }
    if x < 0. {
        return 2. - erfc(-x);
    }
    if x >= 40. {
        return 0.;
    }
    let z = x * x;
    if z < 1.5 {
        1. - erf(x)
    } else {
        gamma_q_half(z, x * (-z - 0.572364942924700087).exp())
    }
}
pub fn minimum(a: Number, b: Number) -> Number {
    match a.cmp(b) {
        Some(Ordering::Less) => a,
        Some(Ordering::Greater) => b,
        Some(Ordering::Equal) => {
            if matches!(a, Number::F(_)) && a.f() == 0. {
                Number::F(if a.f().is_sign_negative() || b.f().is_sign_negative() {
                    -0.
                } else {
                    0.
                })
            } else {
                a
            }
        }
        None => Number::F(f64::NAN),
    }
}
pub fn maximum(a: Number, b: Number) -> Number {
    match a.cmp(b) {
        Some(Ordering::Greater) => a,
        Some(Ordering::Less) => b,
        Some(Ordering::Equal) => {
            if matches!(a, Number::F(_)) && a.f() == 0. {
                Number::F(if a.f().is_sign_positive() || b.f().is_sign_positive() {
                    0.
                } else {
                    -0.
                })
            } else {
                a
            }
        }
        None => Number::F(f64::NAN),
    }
}

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "Abs"
            | "Acos"
            | "Acosh"
            | "Asin"
            | "Asinh"
            | "Atan"
            | "Atanh"
            | "Ceil"
            | "Cos"
            | "Cosh"
            | "Elu"
            | "Erf"
            | "Exp"
            | "Floor"
            | "HardSigmoid"
            | "HardSwish"
            | "LeakyRelu"
            | "Log"
            | "Mish"
            | "Neg"
            | "Not"
            | "Reciprocal"
            | "Relu"
            | "Round"
            | "Selu"
            | "Sigmoid"
            | "Sign"
            | "Sin"
            | "Sinh"
            | "Softplus"
            | "Softsign"
            | "Sqrt"
            | "Tan"
            | "Tanh"
            | "ThresholdedRelu"
            | "Gelu"
            | "IsInf"
            | "IsNaN"
            | "BitwiseNot"
            | "Add"
            | "Sub"
            | "Mul"
            | "Div"
            | "Mod"
            | "Pow"
            | "PRelu"
            | "Equal"
            | "Greater"
            | "GreaterOrEqual"
            | "Less"
            | "LessOrEqual"
            | "And"
            | "Or"
            | "Xor"
            | "BitwiseAnd"
            | "BitwiseOr"
            | "BitwiseXor"
            | "BitShift"
            | "Mean"
            | "Min"
            | "Max"
            | "Sum"
            | "Clip"
            | "Where"
    )
}
fn binary(op: &str, a: Number, b: Number, fmod: bool, direction: &str) -> Result<Number> {
    let flag = |v| Number::U(if v { 1 } else { 0 });
    Ok(match op {
        "Add" | "Sum" | "Mean" => a.add(b),
        "Sub" => a.sub(b),
        "Mul" => a.mul(b),
        "Min" => minimum(a, b),
        "Max" => maximum(a, b),
        "Div" => match a {
            Number::F(x) => Number::F(x / b.f()),
            Number::I(x) => {
                let d = b.i();
                if d == 0 {
                    return Err("integer division by zero; supply nonzero divisors".into());
                }
                Number::I(x.wrapping_div(d))
            }
            Number::U(x) => {
                let d = b.u();
                if d == 0 {
                    return Err("integer division by zero; supply nonzero divisors".into());
                }
                Number::U(x / d)
            }
        },
        "Mod" => match a {
            Number::F(x) => {
                let y = b.f();
                let r = x % y;
                Number::F(if fmod {
                    r
                } else if r == 0. {
                    0f64.copysign(y)
                } else if (r < 0.) != (y < 0.) {
                    r + y
                } else {
                    r
                })
            }
            Number::I(x) => {
                let y = b.i();
                if y == 0 {
                    return Err("integer modulo by zero; supply nonzero divisors".into());
                }
                let r = x.wrapping_rem(y);
                Number::I(if !fmod && r != 0 && ((r < 0) != (y < 0)) {
                    r.wrapping_add(y)
                } else {
                    r
                })
            }
            Number::U(x) => {
                let y = b.u();
                if y == 0 {
                    return Err("integer modulo by zero; supply nonzero divisors".into());
                }
                Number::U(x % y)
            }
        },
        "Pow" => match (a, b) {
            (Number::I(x), Number::I(e)) if e >= 0 => Number::I(pow_i(x, e as u64)),
            (Number::I(x), Number::U(e)) => Number::I(pow_i(x, e)),
            (Number::U(x), Number::I(e)) if e >= 0 => Number::U(pow_u(x, e as u64)),
            (Number::U(x), Number::U(e)) => Number::U(pow_u(x, e)),
            _ => Number::F(a.f().powf(b.f())),
        },
        "PRelu" => {
            if a.f() < 0. {
                a.mul(b)
            } else {
                a
            }
        }
        "Equal" => flag(a.cmp(b) == Some(Ordering::Equal)),
        "Greater" => flag(a.cmp(b) == Some(Ordering::Greater)),
        "GreaterOrEqual" => flag(matches!(
            a.cmp(b),
            Some(Ordering::Greater | Ordering::Equal)
        )),
        "Less" => flag(a.cmp(b) == Some(Ordering::Less)),
        "LessOrEqual" => flag(matches!(a.cmp(b), Some(Ordering::Less | Ordering::Equal))),
        "And" => flag(a.nonzero() && b.nonzero()),
        "Or" => flag(a.nonzero() || b.nonzero()),
        "Xor" => flag(a.nonzero() != b.nonzero()),
        "BitwiseAnd" => Number::U(a.u() & b.u()),
        "BitwiseOr" => Number::U(a.u() | b.u()),
        "BitwiseXor" => Number::U(a.u() ^ b.u()),
        "BitShift" => {
            let shift = b.u();
            Number::U(if shift >= 64 {
                0
            } else if direction == "LEFT" {
                a.u().wrapping_shl(shift as u32)
            } else {
                a.u().wrapping_shr(shift as u32)
            })
        }
        _ => {
            return Err(format!(
                "unknown binary operator {op}; use an implemented ONNX operator"
            ))
        }
    })
}
fn pow_u(mut a: u64, mut b: u64) -> u64 {
    let mut v = 1u64;
    while b > 0 {
        if b & 1 != 0 {
            v = v.wrapping_mul(a);
        }
        b >>= 1;
        if b > 0 {
            a = a.wrapping_mul(a);
        }
    }
    v
}
fn pow_i(a: i64, b: u64) -> i64 {
    pow_u(a as u64, b) as i64
}

pub fn execute(
    op: &str,
    inputs: &[Option<Tensor>],
    attrs: &Attrs,
    version: u32,
) -> Result<Vec<Tensor>> {
    let first = input(inputs, 0)?;
    if op == "Where" {
        if first.kind != 9 {
            return Err("Where condition must be bool; use Cast to bool".into());
        }
        let a = input(inputs, 1)?;
        let b = input(inputs, 2)?;
        same_type(a, b)?;
        let shape = broadcast(&broadcast(&a.shape, &b.shape)?, &first.shape)?;
        let mut out = Tensor::zeros(a.kind, shape.clone())?;
        for i in 0..out.size() {
            let source = if first
                .get(broadcast_index(i, &shape, &first.shape))
                .nonzero()
            {
                a
            } else {
                b
            };
            out.copy_element(i, source, broadcast_index(i, &shape, &source.shape));
        }
        return Ok(vec![out]);
    }
    if op == "Equal" && first.kind == 8 {
        let b = input(inputs, 1)?;
        same_type(first, b)?;
        let shape = broadcast(&first.shape, &b.shape)?;
        let mut out = Tensor::zeros(9, shape.clone())?;
        for i in 0..out.size() {
            let a = &first.strings.as_ref().unwrap()[broadcast_index(i, &shape, &first.shape)];
            let b = &b.strings.as_ref().unwrap()[broadcast_index(i, &shape, &b.shape)];
            out.set(i, Number::U((a == b) as u64));
        }
        return Ok(vec![out]);
    }
    first.numeric()?;
    if op == "Clip" {
        let lo = optional(inputs, 1);
        let hi = optional(inputs, 2);
        for t in [lo, hi].into_iter().flatten() {
            same_type(first, t)?;
            if t.size() != 1 {
                return Err("Clip min/max must be scalar tensors; supply a scalar bound".into());
            }
        }
        let mut out = Tensor::zeros(first.kind, first.shape.clone())?;
        let lower = lo.map(|v| v.get(0));
        let upper = hi.map(|v| v.get(0));
        let legacy_lo = attrs.float("min", f64::NEG_INFINITY)?;
        let legacy_hi = attrs.float("max", f64::INFINITY)?;
        for i in 0..out.size() {
            let mut x = first.get(i);
            if let Some(lo) = lower {
                x = maximum(x, lo);
            } else if version < 11 {
                x = maximum(x, Number::F(legacy_lo));
            }
            if let Some(hi) = upper {
                x = minimum(x, hi);
            } else if version < 11 {
                x = minimum(x, Number::F(legacy_hi));
            }
            out.set(i, x);
        }
        return Ok(vec![out]);
    }
    let binary_op = matches!(
        op,
        "Add"
            | "Sub"
            | "Mul"
            | "Div"
            | "Mod"
            | "Pow"
            | "PRelu"
            | "Equal"
            | "Greater"
            | "GreaterOrEqual"
            | "Less"
            | "LessOrEqual"
            | "And"
            | "Or"
            | "Xor"
            | "BitwiseAnd"
            | "BitwiseOr"
            | "BitwiseXor"
            | "BitShift"
            | "Mean"
            | "Min"
            | "Max"
            | "Sum"
    );
    if binary_op {
        let variadic = matches!(op, "Mean" | "Min" | "Max" | "Sum");
        if !variadic && inputs.len() != 2 {
            return Err(format!("{op} needs two inputs; supply both operands"));
        }
        let mut shape = first.shape.clone();
        let mut tensors = Vec::new();
        for index in 0..inputs.len() {
            let t = input(inputs, index)?;
            t.numeric()?;
            if op != "Pow" {
                same_type(first, t)?;
            }
            shape = broadcast(&shape, &t.shape)?;
            tensors.push(t);
        }
        if tensors.is_empty() {
            return Err("variadic operator needs an input; supply at least one tensor".into());
        }
        if matches!(op, "And" | "Or" | "Xor") && first.kind != 9 {
            return Err("logical operators require bool inputs; use Cast to bool".into());
        }
        if matches!(op, "Mean" | "Sum") {
            floating(first)?;
        }
        let is_float = matches!(first.kind, 1 | 10 | 11 | 16);
        let fmod = attrs.flag("fmod", false)?;
        if op == "Mod" && version < 28 && is_float && !fmod {
            return Err(
                "floating Mod before opset28 needs fmod=1; set fmod or export a newer opset".into(),
            );
        }
        let direction = attrs.string("direction", "RIGHT")?;
        if op == "BitShift"
            && (!matches!(direction, "LEFT" | "RIGHT") || !matches!(first.kind, 2 | 4 | 12 | 13))
        {
            return Err(
                "BitShift needs unsigned integers and LEFT or RIGHT; supply a valid direction/type"
                    .into(),
            );
        }
        if matches!(op, "BitwiseAnd" | "BitwiseOr" | "BitwiseXor" | "BitShift") && is_float {
            return Err("bit operations need integer tensors; cast their inputs".into());
        }
        let kind = if matches!(
            op,
            "Equal" | "Greater" | "GreaterOrEqual" | "Less" | "LessOrEqual" | "And" | "Or" | "Xor"
        ) {
            9
        } else {
            first.kind
        };
        let mut out = Tensor::zeros(kind, shape.clone())?;
        let prefix = if tensors.len() == 2 {
            simd_prefix(op, tensors[0], tensors[1], &mut out)
        } else {
            0
        };
        for i in prefix..out.size() {
            let mut value = first.get(broadcast_index(i, &shape, &first.shape));
            for t in tensors.iter().skip(1) {
                value = binary(
                    op,
                    value,
                    t.get(broadcast_index(i, &shape, &t.shape)),
                    fmod,
                    direction,
                )?;
            }
            if op == "Mean" {
                value = Number::F(value.f() / tensors.len() as f64);
            }
            out.set(i, value);
        }
        return Ok(vec![out]);
    }
    let kind = if matches!(op, "Not" | "IsInf" | "IsNaN") {
        9
    } else {
        first.kind
    };
    let mut out = Tensor::zeros(kind, first.shape.clone())?;
    if op == "Not" && first.kind != 9 {
        return Err("Not input must be bool; use Cast to bool".into());
    }
    if !matches!(op, "Abs" | "Neg" | "Relu" | "Sign" | "Not" | "BitwiseNot") {
        floating(first)?;
    }
    if op == "BitwiseNot" && matches!(first.kind, 1 | 10 | 11 | 16) {
        return Err("BitwiseNot needs integer input; cast the input".into());
    }
    let alpha = attrs.float(
        "alpha",
        match op {
            "Elu" => 1.,
            "LeakyRelu" => 0.01,
            "Selu" => 1.6732631921768188,
            "HardSigmoid" => 0.2,
            "ThresholdedRelu" => 1.,
            _ => 0.,
        },
    )?;
    let beta = attrs.float("beta", 0.5)?;
    let gamma = attrs.float("gamma", 1.0507010221481323)?;
    let detect_pos = attrs.flag("detect_positive", true)?;
    let detect_neg = attrs.flag("detect_negative", true)?;
    let approximate = attrs.string("approximate", "none")?;
    if op == "Gelu" && !matches!(approximate, "none" | "tanh") {
        return Err("Gelu approximate must be none or tanh; use a supported approximation".into());
    }
    for i in 0..out.size() {
        let a = first.get(i);
        let x = a.f();
        let f = |v| Number::F(v);
        let b = |v| Number::U(v as u64);
        let value = match op {
            "Abs" => match a {
                Number::I(v) => Number::I(v.wrapping_abs()),
                Number::U(v) => Number::U(v),
                _ => f(x.abs()),
            },
            "Neg" => match a {
                Number::I(v) => Number::I(v.wrapping_neg()),
                Number::U(v) => Number::U(v.wrapping_neg()),
                _ => f(-x),
            },
            "Relu" => maximum(
                a,
                match a {
                    Number::I(_) => Number::I(0),
                    Number::U(_) => Number::U(0),
                    _ => f(0.),
                },
            ),
            "Sign" => match a {
                Number::I(v) => Number::I(v.signum()),
                Number::U(v) => Number::U((v > 0) as u64),
                _ => f(if x > 0. {
                    1.
                } else if x < 0. {
                    -1.
                } else {
                    0.
                }),
            },
            "Not" => b(!a.nonzero()),
            "BitwiseNot" => Number::U(!a.u()),
            "IsInf" => b(x.is_infinite()
                && if x.is_sign_positive() {
                    detect_pos
                } else {
                    detect_neg
                }),
            "IsNaN" => b(x.is_nan()),
            "Acos" => f(x.acos()),
            "Acosh" => f(x.acosh()),
            "Asin" => f(x.asin()),
            "Asinh" => f(x.asinh()),
            "Atan" => f(x.atan()),
            "Atanh" => f(x.atanh()),
            "Ceil" => f(x.ceil()),
            "Cos" => f(x.cos()),
            "Cosh" => f(x.cosh()),
            "Erf" => f(erf(x)),
            "Exp" => f(x.exp()),
            "Floor" => f(x.floor()),
            "Log" => f(x.ln()),
            "Reciprocal" => f(1. / x),
            "Round" => f(x.round_ties_even()),
            "Sin" => f(x.sin()),
            "Sinh" => f(x.sinh()),
            "Sqrt" => f(x.sqrt()),
            "Tan" => f(x.tan()),
            "Tanh" => f(x.tanh()),
            "Sigmoid" => f(if x >= 0. {
                1. / (1. + (-x).exp())
            } else {
                let e = x.exp();
                e / (1. + e)
            }),
            "Softplus" => f(x.max(0.) + (-x.abs()).exp().ln_1p()),
            "Softsign" => f(x / (1. + x.abs())),
            "Elu" => f(if x >= 0. { x } else { alpha * x.exp_m1() }),
            "LeakyRelu" => f(if x >= 0. { x } else { alpha * x }),
            "ThresholdedRelu" => f(if x > alpha { x } else { 0. }),
            "Selu" => f(gamma * if x > 0. { x } else { alpha * x.exp_m1() }),
            "HardSigmoid" => f((alpha * x + beta).clamp(0., 1.)),
            "HardSwish" => f(x * ((x / 6. + 0.5).clamp(0., 1.))),
            "Mish" => f(x * (x.max(0.) + (-x.abs()).exp().ln_1p()).tanh()),
            "Gelu" => f(if approximate == "tanh" {
                0.5 * x
                    * (1.
                        + (std::f64::consts::FRAC_2_PI.sqrt() * (x + 0.044715 * x * x * x)).tanh())
            } else {
                0.5 * x * (1. + erf(x / std::f64::consts::SQRT_2))
            }),
            _ => {
                return Err(format!(
                    "unknown unary operator {op}; use a supported ONNX operator"
                ))
            }
        };
        out.set(i, value);
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    #[test]
    fn erf_f64_reference_and_symmetry() {
        for (x, w) in [
            (0.1, 0.11246291601828490),
            (0.5, 0.52049987781304654),
            (1., 0.84270079294971487),
            (1.5, 0.96610514647531076),
            (2., 0.99532226501895273),
            (3., 0.99997790950300141),
        ] {
            assert!((erf(x) - w).abs() < 3e-15, "{x}: {} != {w}", erf(x));
            assert_eq!(erf(-x), -erf(x));
        }
        assert_eq!(erf(-0.).to_bits(), (-0f64).to_bits());
        for x in [1e-100, 1e-300, f64::from_bits(1)] {
            assert_eq!(erf(x), x * std::f64::consts::FRAC_2_SQRT_PI);
        }
    }
    #[test]
    fn int64_broadcast_math_never_uses_f64() {
        let store = Store::new();
        let a = Attrs {
            entries: &[],
            store: &store,
        };
        let x = Tensor::vector_i64(&[9007199254740993, i64::MAX]).unwrap();
        let one = Tensor::vector_i64(&[1]).unwrap();
        let out = execute("Add", &[Some(x), Some(one)], &a, 18).unwrap();
        assert_eq!(out[0].get(0).i(), 9007199254740994);
        assert_eq!(out[0].get(1).i(), i64::MIN);
    }
}
