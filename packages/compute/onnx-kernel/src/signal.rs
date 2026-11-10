use crate::attrs::{floating, input, optional, same_type, Attrs};
use crate::tensor::{axis, elements, product, Number, Result, Tensor};
use std::f64::consts::{PI, TAU};
pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "DFT" | "STFT" | "HannWindow" | "HammingWindow" | "BlackmanWindow" | "MelWeightMatrix"
    )
}
fn mul(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
}
fn pow2(x: &mut [[f64; 2]], inverse: bool) {
    let n = x.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n / 2;
        while j & bit != 0 {
            j ^= bit;
            bit /= 2;
        }
        j ^= bit;
        if i < j {
            x.swap(i, j);
        }
    }
    let mut width = 2;
    while width <= n {
        for start in (0..n).step_by(width) {
            for k in 0..width / 2 {
                let angle = (if inverse { TAU } else { -TAU }) * k as f64 / width as f64;
                let w = [angle.cos(), angle.sin()];
                let a = x[start + k];
                let b = mul(x[start + k + width / 2], w);
                x[start + k] = [a[0] + b[0], a[1] + b[1]];
                x[start + k + width / 2] = [a[0] - b[0], a[1] - b[1]];
            }
        }
        width *= 2;
    }
    if inverse {
        for v in x {
            v[0] /= n as f64;
            v[1] /= n as f64;
        }
    }
}
fn fft(x: &mut [[f64; 2]], inverse: bool) -> Result<()> {
    let n = x.len();
    if n == 0 {
        return Ok(());
    }
    if n.is_power_of_two() {
        pow2(x, inverse);
        return Ok(());
    }
    let m = (2 * n - 1).next_power_of_two();
    elements(&[m, 2])?;
    let mut a = vec![[0.; 2]; m];
    let mut b = vec![[0.; 2]; m];
    let sign = if inverse { 1. } else { -1. };
    for j in 0..n {
        let phase = sign * PI * ((j as u64 * j as u64) % (2 * n) as u64) as f64 / n as f64;
        let w = [phase.cos(), phase.sin()];
        a[j] = mul(x[j], w);
        b[j] = [w[0], -w[1]];
        if j > 0 {
            b[m - j] = b[j];
        }
    }
    pow2(&mut a, false);
    pow2(&mut b, false);
    for j in 0..m {
        a[j] = mul(a[j], b[j]);
    }
    pow2(&mut a, true);
    for j in 0..n {
        let phase = sign * PI * ((j as u64 * j as u64) % (2 * n) as u64) as f64 / n as f64;
        x[j] = mul(a[j], [phase.cos(), phase.sin()]);
        if inverse {
            x[j][0] /= n as f64;
            x[j][1] /= n as f64;
        }
    }
    Ok(())
}
fn integer(t: &Tensor) -> Result<i64> {
    if !matches!(t.kind, 6 | 7) || !t.shape.is_empty() {
        return Err(
            "signal size/axis input must be an integer scalar; repair its dtype/shape".into(),
        );
    }
    Ok(t.get(0).i())
}
fn length(n: i64) -> Result<usize> {
    if n <= 0 || n > i32::MAX as i64 {
        return Err("signal length must be positive and supported; use a valid length".into());
    }
    elements(&[n as usize, 2])?;
    Ok(n as usize)
}
pub fn execute(
    op: &str,
    inputs: &[Option<Tensor>],
    a: &Attrs,
    version: u32,
) -> Result<Vec<Tensor>> {
    if op.ends_with("Window") {
        let n = length(integer(input(inputs, 0)?)?)?;
        let periodic = a.flag("periodic", true)?;
        let kind = a.int("output_datatype", 1)? as u32;
        let mut y = Tensor::zeros(kind, vec![n])?;
        y.numeric()?;
        let (a0, a1, a2) = match op {
            "HannWindow" => (0.5, 0.5, 0.),
            "HammingWindow" => (0.54347825f32 as f64, 0.45652175f32 as f64, 0.),
            _ => (((1f32 - 0.16f32) / 2.) as f64, 0.5, (0.16f32 / 2.) as f64),
        };
        let denominator = if periodic { n } else { n - 1 };
        for j in 0..n {
            let value = if n == 1 {
                1.
            } else {
                let angle = TAU * j as f64 / denominator as f64;
                a0 - a1 * angle.cos() + a2 * (2. * angle).cos()
            };
            y.set(j, Number::F(value));
        }
        return Ok(vec![y]);
    }
    if op == "MelWeightMatrix" {
        let bins = length(integer(input(inputs, 0)?)?)?;
        let n = length(integer(input(inputs, 1)?)?)?;
        let rate = integer(input(inputs, 2)?)?;
        let lo = input(inputs, 3)?;
        let hi = input(inputs, 4)?;
        floating(lo)?;
        same_type(lo, hi)?;
        if !lo.shape.is_empty() || !hi.shape.is_empty() {
            return Err("MelWeightMatrix frequency bounds must be scalars; repair inputs".into());
        }
        let (lo, hi) = (lo.get(0).f(), hi.get(0).f());
        if rate <= 0
            || !lo.is_finite()
            || !hi.is_finite()
            || lo < 0.
            || hi <= lo
            || hi > rate as f64 / 2.
        {
            return Err(
                "MelWeightMatrix needs 0<=lower<upper<=sample_rate/2; repair bounds".into(),
            );
        }
        let kind = a.int("output_datatype", 1)? as u32;
        let mut y = Tensor::zeros(kind, vec![n / 2 + 1, bins])?;
        y.numeric()?;
        let mel = |hz: f64| 2595. * (1. + hz / 700.).log10();
        let low = mel(lo);
        let step = (mel(hi) - low) / (bins + 2) as f64;
        // ONNX's published conformance convention spaces bins+2 intervals and floors
        // inverse-mel frequencies onto DFT bin indices before constructing triangles.
        let points: Vec<_> = (0..bins + 2)
            .map(|j| {
                (((n + 1) as f64 * 700. * (10f64.powf((low + j as f64 * step) / 2595.) - 1.)
                    / rate as f64)
                    .floor() as usize)
                    .min(n / 2)
            })
            .collect();
        for col in 0..bins {
            let left = points[col];
            let center = points[col + 1];
            let right = points[col + 2];
            for row in left..=center {
                let value = if center == left {
                    1.
                } else {
                    (row - left) as f64 / (center - left) as f64
                };
                y.set(row * bins + col, Number::F(value));
            }
            if right > center {
                for row in center..right {
                    y.set(
                        row * bins + col,
                        Number::F((right - row) as f64 / (right - center) as f64),
                    );
                }
            }
        }
        return Ok(vec![y]);
    }
    let x = input(inputs, 0)?;
    floating(x)?;
    let rank = x.shape.len();
    if rank < 2 || !matches!(x.shape[rank - 1], 1 | 2) {
        return Err(
            "DFT/STFT input needs final real/imag dimension of length 1 or 2; repair input shape"
                .into(),
        );
    }
    let components = x.shape[rank - 1];
    let onesided = a.flag("onesided", op == "STFT")?;
    if op == "STFT" {
        if rank != 3 || (onesided && components != 1) {
            return Err("STFT needs rank-three input and onesided requires a real signal; repair shape or flags".into());
        }
        let step = length(integer(input(inputs, 1)?)?)?;
        let window = optional(inputs, 2);
        if let Some(w) = window {
            same_type(x, w)?;
            if w.shape.len() != 1 {
                return Err("STFT window must be one-dimensional; repair window".into());
            }
        }
        let n = if let Some(t) = optional(inputs, 3) {
            length(integer(t)?)?
        } else {
            length(window.map_or(x.shape[1], |w| w.size()) as i64)?
        };
        if window.is_some_and(|w| w.size() != n) {
            return Err("STFT window length differs from frame_length; repair input".into());
        }
        let frames = if x.shape[1] < n {
            0
        } else {
            (x.shape[1] - n) / step + 1
        };
        let bins = if onesided { n / 2 + 1 } else { n };
        let mut y = Tensor::zeros(x.kind, vec![x.shape[0], frames, bins, 2])?;
        for b in 0..x.shape[0] {
            for frame in 0..frames {
                let mut line = vec![[0.; 2]; n];
                for j in 0..n {
                    let at = (b * x.shape[1] + frame * step + j) * components;
                    let w = window.map_or(1., |w| w.get(j).f());
                    line[j] = [
                        x.get(at).f() * w,
                        if components == 2 {
                            x.get(at + 1).f() * w
                        } else {
                            0.
                        },
                    ];
                }
                fft(&mut line, false)?;
                for j in 0..bins {
                    for c in 0..2 {
                        y.set(
                            ((b * frames + frame) * bins + j) * 2 + c,
                            Number::F(line[j][c]),
                        );
                    }
                }
            }
        }
        return Ok(vec![y]);
    }
    let inverse = a.flag("inverse", false)?;
    if onesided && !inverse && components != 1 || onesided && inverse && components != 2 {
        return Err(
            "onesided DFT needs real forward or complex inverse input; repair signal type".into(),
        );
    }
    let d = axis(
        if version < 20 {
            a.int("axis", 1)?
        } else if let Some(t) = optional(inputs, 2) {
            if t.kind != 7 {
                return Err("DFT axis must be int64; repair dtype".into());
            }
            integer(t)?
        } else {
            -2
        },
        rank,
    )?;
    if d == rank - 1 {
        return Err(
            "DFT axis cannot be the real/imag component dimension; choose a signal axis".into(),
        );
    }
    let n = if let Some(t) = optional(inputs, 1) {
        length(integer(t)?)?
    } else {
        length(if onesided && inverse {
            2 * x.shape[d].saturating_sub(1)
        } else {
            x.shape[d]
        } as i64)?
    };
    let bins = if onesided && !inverse { n / 2 + 1 } else { n };
    let out_components = if onesided && inverse { 1 } else { 2 };
    let mut shape = x.shape.clone();
    shape[d] = bins;
    shape[rank - 1] = out_components;
    let mut y = Tensor::zeros(x.kind, shape)?;
    let inner = product(&x.shape[d + 1..rank - 1])?;
    let outer = product(&x.shape[..d])?;
    for p in 0..outer {
        for q in 0..inner {
            let mut line = vec![[0.; 2]; n];
            let available = x.shape[d].min(if onesided && inverse { n / 2 + 1 } else { n });
            for j in 0..available {
                let at = ((p * x.shape[d] + j) * inner + q) * components;
                line[j] = [
                    x.get(at).f(),
                    if components == 2 {
                        x.get(at + 1).f()
                    } else {
                        0.
                    },
                ];
            }
            if onesided && inverse {
                line[0][1] = 0.;
                if n % 2 == 0 {
                    line[n / 2][1] = 0.;
                }
                for j in 1..n.div_ceil(2) {
                    line[n - j] = [line[j][0], -line[j][1]];
                }
            }
            fft(&mut line, inverse)?;
            for j in 0..bins {
                for c in 0..out_components {
                    y.set(
                        ((p * bins + j) * inner + q) * out_components + c,
                        Number::F(line[j][c]),
                    );
                }
            }
        }
    }
    Ok(vec![y])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_fft_matches_defining_sum_and_roundtrips() {
        for n in [1, 2, 3, 5, 7, 8, 16, 31, 65] {
            let original: Vec<_> = (0..n)
                .map(|j| [(j as f64 * 0.7).sin(), (j as f64 * 0.3).cos()])
                .collect();
            let mut actual = original.clone();
            fft(&mut actual, false).unwrap();
            for k in 0..n {
                let mut expected = [0.; 2];
                for j in 0..n {
                    let angle = -TAU * (j * k) as f64 / n as f64;
                    let v = mul(original[j], [angle.cos(), angle.sin()]);
                    expected[0] += v[0];
                    expected[1] += v[1];
                }
                for c in 0..2 {
                    assert!((actual[k][c] - expected[c]).abs() < 1e-11);
                }
            }
            fft(&mut actual, true).unwrap();
            for j in 0..n {
                for c in 0..2 {
                    assert!((actual[j][c] - original[j][c]).abs() < 1e-12);
                }
            }
        }
    }
}
