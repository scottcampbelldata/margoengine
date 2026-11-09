use crate::{Error, Result};

fn invert(p: [i64; 2], center: i64) -> [i64; 2] {
    let signs = if p[0] >= 0 && p[1] >= 0 {
        [1, 1]
    } else if p[0] <= 0 && p[1] <= 0 {
        [-1, -1]
    } else {
        [if p[0] > 0 { 1 } else { -1 }, if p[1] > 0 { 1 } else { -1 }]
    };
    let corner = [signs[0] * center, signs[1] * center];
    let p = [2 * p[0] - corner[0], 2 * p[1] - corner[1]];
    let p = if signs[0] * signs[1] >= 0 {
        [-p[1], -p[0]]
    } else {
        [p[1], p[0]]
    };
    [(p[0] + corner[0]) / 2, (p[1] + corner[1]) / 2]
}
fn rotate(p: [i64; 2], n: u32) -> [i64; 2] {
    match n % 4 {
        1 => [p[1], -p[0]],
        2 => [-p[0], -p[1]],
        3 => [-p[1], p[0]],
        _ => p,
    }
}
pub(crate) fn correction(prediction: [i32; 2], correction: [i32; 2], max: i32) -> Result<[i32; 2]> {
    correction_impl(prediction, correction, max, true)
}
pub(crate) fn legacy_correction(
    prediction: [i32; 2],
    correction: [i32; 2],
    max: i32,
) -> Result<[i32; 2]> {
    correction_impl(prediction, correction, max, false)
}
fn correction_impl(
    prediction: [i32; 2],
    correction: [i32; 2],
    max: i32,
    canonical: bool,
) -> Result<[i32; 2]> {
    if max < 3 || !(max as u32 + 1).is_power_of_two() || max > (1 << 30) - 1 {
        return Err(Error::Invalid);
    }
    let max = i64::from(max);
    let center = (max - 1) / 2;
    let mut pred = [
        i64::from(prediction[0]) - center,
        i64::from(prediction[1]) - center,
    ];
    let diamond = pred[0].abs() + pred[1].abs() <= center;
    if !diamond {
        pred = invert(pred, center);
    }
    let bottom = (pred[0] == 0 && pred[1] == 0) || (pred[0] < 0 && pred[1] <= 0);
    let rotation = if pred[0] == 0 {
        if pred[1] == 0 {
            0
        } else if pred[1] > 0 {
            3
        } else {
            1
        }
    } else if pred[0] > 0 {
        if pred[1] >= 0 { 2 } else { 1 }
    } else if pred[1] <= 0 {
        0
    } else {
        3
    };
    if canonical && !bottom {
        pred = rotate(pred, rotation);
    }
    let mut out = [0_i64; 2];
    for i in 0..2 {
        if correction[i] < 0 || i64::from(correction[i]) > max {
            return Err(Error::Invalid);
        }
        out[i] = pred[i] + i64::from(correction[i]);
        if out[i] > center {
            out[i] -= max;
        } else if out[i] < -center {
            out[i] += max;
        }
    }
    if canonical && !bottom {
        out = rotate(out, 4 - rotation);
    }
    if !diamond {
        out = invert(out, center);
    }
    Ok([(out[0] + center) as i32, (out[1] + center) as i32])
}

pub(crate) fn unit(s: i32, t: i32, bits: u8) -> Result<[f32; 3]> {
    if !(2..=30).contains(&bits) {
        return Err(Error::Invalid);
    }
    let max = (1_i32 << bits) - 2;
    if !(0..=max).contains(&s) || !(0..=max).contains(&t) {
        return Err(Error::Invalid);
    }
    // E11 candidate: an algebraically equivalent octahedral unfolding. Every
    // operation rounds to f32. Subtraction order on the negative hemisphere
    // preserves the oracle's +0 without an input-specific zero repair.
    let scale = 2_f32 / max as f32;
    let mut y = s as f32 * scale - 1.0;
    let mut z = t as f32 * scale - 1.0;
    let x = 1.0 - y.abs() - z.abs();
    if x < 0.0 {
        let old_y = y;
        y = if old_y < 0.0 {
            z.abs() - 1.0
        } else {
            1.0 - z.abs()
        };
        z = if z < 0.0 {
            old_y.abs() - 1.0
        } else {
            1.0 - old_y.abs()
        };
    }
    let norm = x * x + y * y + z * z;
    if norm < 1e-6 {
        return Ok([0.0; 3]);
    }
    let reciprocal = 1_f32 / norm.sqrt();
    Ok([x * reciprocal, y * reciprocal, z * reciprocal])
}
