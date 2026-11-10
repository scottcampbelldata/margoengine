//! Encoded RGB conversion from ITU-T H.273 (2024), equations 14-22 and 39-84.
use crate::{Error, Result};
pub fn solve(m: [[f64; 3]; 3], b: [f64; 3]) -> [f64; 3] {
    let mut a = [[0.0; 4]; 3];
    for y in 0..3 {
        a[y][..3].copy_from_slice(&m[y]);
        a[y][3] = b[y];
    }
    for c in 0..3 {
        let mut pivot = c;
        for y in c + 1..3 {
            if a[y][c].abs() > a[pivot][c].abs() {
                pivot = y;
            }
        }
        a.swap(c, pivot);
        let d = a[c][c];
        for x in c..4 {
            a[c][x] /= d;
        }
        for y in 0..3 {
            if y != c {
                let v = a[y][c];
                for x in c..4 {
                    a[y][x] -= v * a[c][x];
                }
            }
        }
    }
    [a[0][3], a[1][3], a[2][3]]
}
pub fn weights(matrix: u32, primaries: u32) -> Result<(f64, f64)> {
    Ok(match matrix {
        1 => (0.2126, 0.0722),
        4 => (0.30, 0.11),
        2 | 5 | 6 => (0.299, 0.114),
        7 => (0.212, 0.087),
        9 | 10 => (0.2627, 0.0593),
        0 | 8 | 11 | 14 => (0.0, 0.0),
        12 | 13 => {
            let (p, white) = match primaries {
                1 => (
                    [[0.640, 0.330], [0.300, 0.600], [0.150, 0.060]],
                    [0.3127, 0.3290],
                ),
                4 => (
                    [[0.670, 0.330], [0.210, 0.710], [0.140, 0.080]],
                    [0.310, 0.316],
                ),
                5 => (
                    [[0.640, 0.330], [0.290, 0.600], [0.150, 0.060]],
                    [0.3127, 0.3290],
                ),
                6 | 7 => (
                    [[0.630, 0.340], [0.310, 0.595], [0.155, 0.070]],
                    [0.3127, 0.3290],
                ),
                8 => (
                    [[0.681, 0.319], [0.243, 0.692], [0.145, 0.049]],
                    [0.310, 0.316],
                ),
                9 => (
                    [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]],
                    [0.3127, 0.3290],
                ),
                10 => ([[1.0, 0.0], [0.0, 1.0], [0.0, 0.0]], [1.0 / 3.0, 1.0 / 3.0]),
                11 => (
                    [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]],
                    [0.314, 0.351],
                ),
                12 => (
                    [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]],
                    [0.3127, 0.3290],
                ),
                22 => (
                    [[0.630, 0.340], [0.295, 0.605], [0.155, 0.077]],
                    [0.3127, 0.3290],
                ),
                _ => return Err(Error::Unsupported),
            };
            let m = [
                p.map(|v| v[0]),
                p.map(|v| v[1]),
                p.map(|v| 1.0 - v[0] - v[1]),
            ];
            let s = solve(
                m,
                [
                    white[0] / white[1],
                    1.0,
                    (1.0 - white[0] - white[1]) / white[1],
                ],
            );
            (s[0] * p[0][1], s[2] * p[2][1])
        }
        _ => return Err(Error::Unsupported),
    })
}
/// OETF/EOTF pairs retain encoded values; they do not apply an output display profile.
fn transfer(v: f64, tc: u32, inverse: bool) -> Result<f64> {
    let sign = v.signum();
    let x = v.abs();
    if tc == 12 && v < 0.0 {
        return Ok(if inverse {
            if v >= -0.02025 {
                v / 4.5
            } else {
                -0.25 * ((-4.0 * v + 0.099) / 1.099).powf(1.0 / 0.45)
            }
        } else if v >= -0.0045 {
            4.5 * v
        } else {
            -0.25 * (1.099 * (-4.0 * v).powf(0.45) - 0.099)
        });
    }
    let result = match tc {
        1 | 6 | 11 | 12 | 14 | 15 => {
            let (alpha, beta) = if tc == 14 || tc == 15 {
                (1.09929682680944, 0.018053968510807)
            } else {
                (1.099, 0.018)
            };
            if inverse {
                if x < 4.5 * beta {
                    x / 4.5
                } else {
                    ((x + alpha - 1.0) / alpha).powf(1.0 / 0.45)
                }
            } else if x < beta {
                4.5 * x
            } else {
                alpha * x.powf(0.45) - (alpha - 1.0)
            }
        }
        4 | 5 => x.powf(if inverse {
            if tc == 4 { 2.2 } else { 2.8 }
        } else if tc == 4 {
            1.0 / 2.2
        } else {
            1.0 / 2.8
        }),
        7 => {
            if inverse {
                if x < 0.0912 {
                    x / 4.0
                } else {
                    ((x + 0.1115) / 1.1115).powf(1.0 / 0.45)
                }
            } else if x < 0.0228 {
                4.0 * x
            } else {
                1.1115 * x.powf(0.45) - 0.1115
            }
        }
        8 => x,
        9 | 10 => {
            let power = if tc == 9 { 2.0 } else { 2.5 };
            if inverse {
                if x == 0.0 {
                    0.0
                } else {
                    10f64.powf((x - 1.0) * power)
                }
            } else if x < 10f64.powf(-power) {
                0.0
            } else {
                1.0 + x.log10() / power
            }
        }
        13 => {
            if inverse {
                if x <= 0.04045 {
                    x / 12.92
                } else {
                    ((x + 0.055) / 1.055).powf(2.4)
                }
            } else if x <= 0.0031308 {
                12.92 * x
            } else {
                1.055 * x.powf(1.0 / 2.4) - 0.055
            }
        }
        16 => {
            let (m1, m2, c1, c2, c3) = (
                2610.0 / 16384.0,
                2523.0 / 32.0,
                3424.0 / 4096.0,
                2413.0 / 128.0,
                2392.0 / 128.0,
            );
            if inverse {
                let t = x.powf(1.0 / m2);
                ((t - c1).max(0.0) / (c2 - c3 * t)).max(0.0).powf(1.0 / m1)
            } else {
                let t = x.powf(m1);
                ((c1 + c2 * t) / (1.0 + c3 * t)).powf(m2)
            }
        }
        17 => {
            if inverse {
                x.powf(2.6) * (52.37 / 48.0)
            } else {
                (x * (48.0 / 52.37)).powf(1.0 / 2.6)
            }
        }
        18 => {
            let (a, b, c) = (0.17883277, 0.28466892, 0.55991073);
            if inverse {
                if x <= 0.5 {
                    x * x / 3.0
                } else {
                    (((x - c) / a).exp() + b) / 12.0
                }
            } else if x <= 1.0 / 12.0 {
                (3.0 * x).sqrt()
            } else {
                a * (12.0 * x - b).ln() + c
            }
        }
        _ => return Err(Error::Unsupported),
    };
    Ok(sign * result)
}
pub fn convert(
    y: f64,
    cb: f64,
    cr: f64,
    matrix: u32,
    tc: u32,
    kr: f64,
    kb: f64,
) -> Result<[f64; 3]> {
    Ok(match matrix {
        8 => [y - cb + cr, y + cb, y - cb - cr],
        10 | 13 => {
            let r = y + 2.0
                * cr
                * if cr <= 0.0 {
                    transfer(1.0 - kr, tc, false)?
                } else {
                    1.0 - transfer(kr, tc, false)?
                };
            let b = y + 2.0
                * cb
                * if cb <= 0.0 {
                    transfer(1.0 - kb, tc, false)?
                } else {
                    1.0 - transfer(kb, tc, false)?
                };
            let g = (transfer(y, tc, true)?
                - kr * transfer(r, tc, true)?
                - kb * transfer(b, tc, true)?)
                / (1.0 - kr - kb);
            [r, transfer(g, tc, false)?, b]
        }
        11 => [2.0 * cr + 0.991902 * y, y, (2.0 * cb + y) / 0.986566],
        14 => {
            let chroma = if tc == 18 {
                [[3625.0, -7465.0, 3840.0], [9500.0, -9212.0, -288.0]]
            } else {
                [[6610.0, -13613.0, 7003.0], [17933.0, -17390.0, -543.0]]
            };
            let lms = solve(
                [
                    [0.5, 0.5, 0.0],
                    chroma[0].map(|v| v / 4096.0),
                    chroma[1].map(|v| v / 4096.0),
                ],
                [y, cb, cr],
            );
            let linear = [
                transfer(lms[0], tc, true)?,
                transfer(lms[1], tc, true)?,
                transfer(lms[2], tc, true)?,
            ];
            let rgb = solve(
                [
                    [1688.0 / 4096.0, 2146.0 / 4096.0, 262.0 / 4096.0],
                    [683.0 / 4096.0, 2951.0 / 4096.0, 462.0 / 4096.0],
                    [99.0 / 4096.0, 309.0 / 4096.0, 3688.0 / 4096.0],
                ],
                linear,
            );
            [
                transfer(rgb[0], tc, false)?,
                transfer(rgb[1], tc, false)?,
                transfer(rgb[2], tc, false)?,
            ]
        }
        _ => {
            let r = y + 2.0 * (1.0 - kr) * cr;
            let b = y + 2.0 * (1.0 - kb) * cb;
            [r, (y - kr * r - kb * b) / (1.0 - kr - kb), b]
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn derived_coefficients_and_transfer_inverses_follow_h273() {
        let (r, b) = weights(12, 9).unwrap();
        assert!((r - 0.262700212).abs() < 1e-9);
        assert!((b - 0.059301716).abs() < 1e-9);
        for tc in [1, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18] {
            for x in [0.01, 0.10, 0.5, 1.0] {
                assert!(
                    (transfer(transfer(x, tc, false).unwrap(), tc, true).unwrap() - x).abs() < 2e-7,
                    "transfer {tc}"
                );
            }
        }
        for tc in [16, 18] {
            for y in [0.0, 0.1, 0.5, 1.0] {
                // PQ's continuous OETF maps zero luminance to c1^m2, below one 16-bit code step.
                let expected = if tc == 16 && y == 0.0 {
                    (3424.0_f64 / 4096.0).powf(2523.0 / 32.0)
                } else {
                    y
                };
                for value in convert(y, 0.0, 0.0, 14, tc, 0.0, 0.0).unwrap() {
                    assert!((value - expected).abs() < 2e-7);
                }
            }
        }
    }
}
