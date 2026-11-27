//! ONNX 8-bit and 4-bit float storage, written from the ONNX technical pages
//! (https://onnx.ai/onnx/technical/float8.html and float4.html), the Cast
//! operator's conversion tables, Micikevicius et al., "FP8 Formats for Deep
//! Learning", 2022 (https://arxiv.org/abs/2209.05433) and the OCP Microscaling
//! (MX) specification's E8M0 scale type.

pub const E4M3FN: u32 = 17;
pub const E4M3FNUZ: u32 = 18;
pub const E5M2: u32 = 19;
pub const E5M2FNUZ: u32 = 20;
pub const E2M1: u32 = 23;
pub const E8M0: u32 = 24;
pub const E2M3: u32 = 27;
pub const E3M2: u32 = 28;

/// FLOAT8E8M0 rounding named by Cast's `round_mode`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Round {
    Up,
    Down,
    Nearest,
}

struct Format {
    mantissa: u32,
    bias: i32,
    /// Largest finite magnitude code.
    max: u32,
    /// True when negative zero is the single NaN (the FNUZ formats).
    unsigned_zero: bool,
}

fn format(kind: u32) -> Format {
    let (mantissa, bias, max, unsigned_zero) = match kind {
        E4M3FN => (3, 7, 0x7e, false),
        E4M3FNUZ => (3, 8, 0x7f, true),
        E5M2 => (2, 15, 0x7b, false),
        _ => (2, 16, 0x7f, true),
    };
    Format {
        mantissa,
        bias,
        max,
        unsigned_zero,
    }
}

/// The 6-bit MX formats: finite only, sign in bit 5, subnormals below the smallest exponent.
fn six(kind: u32) -> (u32, i32) {
    if kind == E2M3 {
        (3, 1)
    } else {
        (2, 3)
    }
}

pub fn decode(kind: u32, byte: u8) -> f64 {
    if matches!(kind, E2M3 | E3M2) {
        let (mantissa, bias) = six(kind);
        let code = (byte & 31) as u32;
        let (e, m) = (code >> mantissa, code & ((1 << mantissa) - 1));
        let step = 2f64.powi(-(mantissa as i32));
        let sign = if byte & 32 != 0 { -1. } else { 1. };
        return sign
            * if e == 0 {
                m as f64 * step * 2f64.powi(1 - bias)
            } else {
                (1. + m as f64 * step) * 2f64.powi(e as i32 - bias)
            };
    }
    if kind == E2M1 {
        let code = byte & 15;
        let (exponent, m) = (((code >> 1) & 3) as i32, (code & 1) as f64);
        let sign = if code & 8 != 0 { -1. } else { 1. };
        return sign
            * if exponent == 0 {
                m * 0.5
            } else {
                (1. + m * 0.5) * 2f64.powi(exponent - 1)
            };
    }
    if kind == E8M0 {
        return if byte == 255 {
            f64::NAN
        } else {
            2f64.powi(byte as i32 - 127)
        };
    }
    let f = format(kind);
    if f.unsigned_zero && byte == 0x80 {
        return f64::NAN;
    }
    let sign = if byte & 0x80 != 0 { -1. } else { 1. };
    let code = (byte & 0x7f) as u32;
    if code > f.max {
        return if kind == E5M2 && code == 0x7c {
            sign * f64::INFINITY
        } else {
            f64::NAN
        };
    }
    let (e, m) = (code >> f.mantissa, code & ((1 << f.mantissa) - 1));
    let step = 2f64.powi(-(f.mantissa as i32));
    sign * if e == 0 {
        m as f64 * step * 2f64.powi(1 - f.bias)
    } else {
        (1. + m as f64 * step) * 2f64.powi(e as i32 - f.bias)
    }
}

/// Binary exponent of a positive finite normal f64.
fn exponent(a: f64) -> i32 {
    ((a.to_bits() >> 52) & 0x7ff) as i32 - 1023
}

/// Nearest-even conversion with the Cast tables' saturating or non-saturating
/// treatment of values past the largest finite magnitude.
pub fn encode(kind: u32, x: f64, saturate: bool, round: Round) -> u8 {
    if kind == E2M1 {
        // ONNX leaves NaN unspecified for this finite-only format; it becomes +0.
        if x.is_nan() {
            return 0;
        }
        let sign = if x.is_sign_negative() { 8u8 } else { 0 };
        let a = x.abs().min(6.);
        let code = if a < 1. {
            (a * 2.).round_ties_even() as u8
        } else {
            let e = exponent(a);
            let q = (a / 2f64.powi(e) * 2.).round_ties_even() as i32;
            // q is 2..4; q == 4 carries into the next exponent.
            (2 * e + q) as u8
        };
        return sign | code.min(7);
    }
    if matches!(kind, E2M3 | E3M2) {
        // ONNX leaves NaN unspecified for these finite-only formats; it becomes +0.
        if x.is_nan() {
            return 0;
        }
        let (mantissa, bias) = six(kind);
        let sign = if x.is_sign_negative() { 32u8 } else { 0 };
        let a = x.abs().min(64.);
        let code = if a < 2f64.powi(1 - bias) {
            (a * 2f64.powi(bias - 1 + mantissa as i32)).round_ties_even() as i64
        } else {
            let e = exponent(a);
            let q = (a / 2f64.powi(e) * (1u32 << mantissa) as f64).round_ties_even() as i64;
            (((e + bias - 1) as i64) << mantissa) + q
        };
        return sign | code.min(31) as u8;
    }
    if kind == E8M0 {
        // ONNX leaves negative inputs and -0 unspecified; negatives become NaN.
        if x.is_nan() || x < 0. {
            return 255;
        }
        let (low, high) = (2f64.powi(-127), 2f64.powi(127));
        if x < low || x > high {
            return match (saturate, x < low) {
                (false, _) => 255,
                (true, true) => 0,
                (true, false) => 254,
            };
        }
        // f32 subnormals do not occur: 2^-127 is a normal f64.
        let e = exponent(x);
        let base = 2f64.powi(e);
        let up = match round {
            Round::Up => x > base,
            Round::Down => false,
            Round::Nearest => x >= base * 1.5,
        };
        return (e + 127 + up as i32).min(254) as u8;
    }
    let f = format(kind);
    let negative = x.is_sign_negative();
    let sign = if negative { 0x80u8 } else { 0 };
    if x.is_nan() {
        return if f.unsigned_zero {
            0x80
        } else {
            sign | if kind == E5M2 { 0x7e } else { 0x7f }
        };
    }
    let a = x.abs();
    let code = if a.is_infinite() {
        u32::MAX
    } else if a < 2f64.powi(1 - f.bias) {
        (a * 2f64.powi(f.bias - 1 + f.mantissa as i32)).round_ties_even() as u32
    } else {
        let e = exponent(a);
        let q = (a / 2f64.powi(e) * (1u32 << f.mantissa) as f64).round_ties_even() as i64;
        // q includes the implicit bit, so one biased exponent step is already in it.
        (((e + f.bias - 1) as i64) << f.mantissa).saturating_add(q) as u32
    };
    if code > f.max {
        return if saturate {
            sign | f.max as u8
        } else if f.unsigned_zero {
            0x80
        } else if kind == E5M2 {
            sign | 0x7c
        } else {
            sign | 0x7f
        };
    }
    if code == 0 && f.unsigned_zero {
        0
    } else {
        sign | code as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_finite_code_round_trips_and_limits_match_the_tables() {
        for kind in [E4M3FN, E4M3FNUZ, E5M2, E5M2FNUZ, E8M0] {
            for byte in 0..=255u8 {
                let value = decode(kind, byte);
                if value.is_finite() {
                    assert_eq!(encode(kind, value, true, Round::Up), byte, "{kind} {byte}");
                }
            }
        }
        for byte in 0..16u8 {
            assert_eq!(encode(E2M1, decode(E2M1, byte), true, Round::Up), byte);
        }
        assert_eq!(decode(E4M3FN, 0x7e), 448.);
        assert_eq!(decode(E4M3FNUZ, 0x7f), 240.);
        assert_eq!(decode(E5M2, 0x7b), 57344.);
        assert_eq!(decode(E5M2FNUZ, 0x7f), 57344.);
        assert_eq!(decode(E4M3FN, 1), 2f64.powi(-9));
        assert_eq!(decode(E4M3FNUZ, 1), 2f64.powi(-10));
        assert_eq!(decode(E5M2, 1), 2f64.powi(-16));
        assert_eq!(decode(E5M2FNUZ, 1), 2f64.powi(-17));
    }
    #[test]
    fn six_bit_formats_round_trip_and_saturate() {
        for kind in [E2M3, E3M2] {
            for byte in 0..64u8 {
                assert_eq!(encode(kind, decode(kind, byte), true, Round::Up), byte);
            }
        }
        assert_eq!(decode(E2M3, 31), 7.5);
        assert_eq!(decode(E3M2, 31), 28.);
        assert_eq!(decode(E2M3, 1), 0.125);
        assert_eq!(decode(E3M2, 1), 0.0625);
        assert_eq!(decode(E3M2, encode(E3M2, 25., true, Round::Up)), 24.);
        assert_eq!(encode(E2M3, f64::INFINITY, false, Round::Up), 31);
    }
    #[test]
    fn saturating_and_non_saturating_casts() {
        let inf = f64::INFINITY;
        assert_eq!(encode(E4M3FN, inf, true, Round::Up), 0x7e);
        assert_eq!(encode(E4M3FN, -inf, false, Round::Up), 0xff);
        assert_eq!(encode(E4M3FNUZ, -inf, true, Round::Up), 0xff);
        assert_eq!(encode(E4M3FNUZ, inf, false, Round::Up), 0x80);
        assert_eq!(encode(E5M2, inf, false, Round::Up), 0x7c);
        assert_eq!(encode(E5M2, inf, true, Round::Up), 0x7b);
        // 464 is halfway from 448 to the next step and rounds to the even 448; above it overflows.
        assert_eq!(encode(E4M3FN, 464., false, Round::Up), 0x7e);
        assert_eq!(encode(E4M3FN, 464.1, false, Round::Up), 0x7f);
        assert_eq!(encode(E4M3FNUZ, -0., true, Round::Up), 0);
        assert_eq!(encode(E5M2, -0., true, Round::Up), 0x80);
        for (x, value) in [(0.25, 0.), (0.75, 1.), (2.5, 2.), (3.5, 4.), (5., 4.), (100., 6.)] {
            assert_eq!(decode(E2M1, encode(E2M1, x, true, Round::Up)), value, "{x}");
        }
        assert_eq!(decode(E8M0, encode(E8M0, 5., true, Round::Up)), 8.);
        assert_eq!(decode(E8M0, encode(E8M0, 5., true, Round::Down)), 4.);
        assert_eq!(decode(E8M0, encode(E8M0, 6., true, Round::Nearest)), 8.);
        assert_eq!(decode(E8M0, encode(E8M0, 5.9, true, Round::Nearest)), 4.);
        assert_eq!(encode(E8M0, inf, true, Round::Up), 254);
        assert_eq!(encode(E8M0, 0., true, Round::Up), 0);
        assert_eq!(encode(E8M0, 0., false, Round::Up), 255);
    }
}
