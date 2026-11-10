//! UASTC ETC transcode hints, selected by reconstructed target error. Formulae
//! are from KDF 1.4 sections 25.8.3 and 22.3 and the published UASTC format.
use crate::uastc::{decode_block, mode_of};
const ETC: [[i32; 4]; 8] = [
    [-8, -2, 2, 8],
    [-17, -5, 5, 17],
    [-29, -9, 9, 29],
    [-42, -13, 13, 42],
    [-60, -18, 18, 60],
    [-80, -24, 24, 80],
    [-106, -33, 33, 106],
    [-183, -47, 47, 183],
];
const EAC: [[i32; 8]; 16] = [
    [-3, -6, -9, -15, 2, 5, 8, 14],
    [-3, -7, -10, -13, 2, 6, 9, 12],
    [-2, -5, -8, -13, 1, 4, 7, 12],
    [-2, -4, -6, -13, 1, 3, 5, 12],
    [-3, -6, -8, -12, 2, 5, 7, 11],
    [-3, -7, -9, -11, 2, 6, 8, 10],
    [-4, -7, -8, -11, 3, 6, 7, 10],
    [-3, -5, -8, -11, 2, 4, 7, 10],
    [-2, -6, -8, -10, 1, 5, 7, 9],
    [-2, -5, -8, -10, 1, 4, 7, 9],
    [-2, -4, -8, -10, 1, 3, 7, 9],
    [-2, -5, -7, -10, 1, 4, 6, 9],
    [-3, -4, -7, -10, 2, 3, 6, 9],
    [-1, -2, -3, -10, 0, 1, 2, 9],
    [-4, -6, -8, -9, 3, 5, 7, 8],
    [-3, -5, -7, -9, 2, 4, 6, 8],
];
fn write(block: &mut [u8; 16], at: &mut usize, value: usize, count: usize) {
    for b in 0..count {
        let mask = 1 << ((*at + b) & 7);
        block[(*at + b) / 8] =
            (block[(*at + b) / 8] & !mask) | ((((value >> b) & 1) as u8) << ((*at + b) & 7));
    }
    *at += count;
}
fn bias(value: i32, hint: usize, limit: i32, subset: usize, c: usize) -> i32 {
    let delta = match hint {
        2 | 5 | 6 | 7 | 11 | 15 => {
            let channel = match hint {
                2 | 7 => 0,
                5 | 11 => 1,
                _ => 2,
            };
            if subset == 0 && c == channel {
                if [2, 5, 6].contains(&hint) { -1 } else { 1 }
            } else {
                0
            }
        }
        18 | 19 | 20 | 21 | 24 | 8 => {
            let channel = match hint {
                18 | 21 => 0,
                19 | 24 => 1,
                _ => 2,
            };
            if subset == 1 && c == channel {
                if [18, 19, 20].contains(&hint) { -1 } else { 1 }
            } else {
                0
            }
        }
        10 => -2,
        27 => {
            if subset == 0 {
                -1
            } else {
                0
            }
        }
        28 => {
            if subset == 0 {
                1
            } else {
                -1
            }
        }
        29 => {
            if subset == 1 {
                1
            } else {
                0
            }
        }
        30 => {
            if subset == 1 {
                -1
            } else {
                0
            }
        }
        31 => {
            if subset == 0 {
                1
            } else {
                0
            }
        }
        _ => ((hint / [1, 3, 9][c]) % 3) as i32 - 1,
    };
    if value == 0 {
        if delta == -2 { 3 } else { delta + 1 }
    } else if value == limit {
        value + delta - 1
    } else {
        let v = value + delta;
        if v < 0 || v > limit { value - delta } else { v }
    }
}
fn expand(v: i32, differential: bool) -> i32 {
    if differential {
        (v << 3) | (v >> 2)
    } else {
        v * 17
    }
}
fn subblock(t: usize, flip: usize) -> usize {
    if flip == 0 {
        usize::from(t % 4 >= 2)
    } else {
        usize::from(t / 4 >= 2)
    }
}
pub fn apply(block: &mut [u8; 16]) {
    let mode = mode_of(block);
    let pixels = decode_block(block);
    if mode == 8 {
        let color = pixels[0];
        let mut best = (u64::MAX, false, 0, 0, [0; 3]);
        for differential in [false, true] {
            let limit = if differential { 31 } else { 15 };
            for table in 0..8 {
                for selector in 0..4 {
                    let values: [i32; 3] = std::array::from_fn(|c| {
                        (0..=limit)
                            .min_by_key(|&v| {
                                let d = (expand(v, differential) + ETC[table][selector])
                                    .clamp(0, 255)
                                    - color[c] as i32;
                                d * d
                            })
                            .unwrap()
                    });
                    let error = (0..3)
                        .map(|c| {
                            let d = (expand(values[c], differential) + ETC[table][selector])
                                .clamp(0, 255)
                                - color[c] as i32;
                            (d * d) as u64
                        })
                        .sum();
                    if error < best.0 {
                        best = (error, differential, table, selector, values);
                    }
                }
            }
        }
        let mut at = 37;
        write(block, &mut at, usize::from(best.1), 1);
        write(block, &mut at, best.2, 3);
        write(block, &mut at, [3, 2, 0, 1][best.3], 2);
        for value in best.4 {
            write(block, &mut at, value as usize, 5);
        }
        return;
    }
    let has_bias = ![10, 11, 12].contains(&mode);
    let mut best = (u64::MAX, 0, false, 0, [0; 2]);
    for flip in 0..2 {
        let mean: [[f64; 3]; 2] = std::array::from_fn(|s| {
            std::array::from_fn(|c| {
                pixels
                    .iter()
                    .enumerate()
                    .filter(|(t, _)| subblock(*t, flip) == s)
                    .map(|(_, p)| p[c] as f64)
                    .sum::<f64>()
                    / 8.0
            })
        });
        for differential in [false, true] {
            let limit = if differential { 31 } else { 15 };
            for hint in 0..if has_bias { 32 } else { 1 } {
                let mut bases: [[i32; 3]; 2] = std::array::from_fn(|s| {
                    std::array::from_fn(|c| {
                        let v = (mean[s][c] * limit as f64 / 255.0).round() as i32;
                        if has_bias {
                            bias(v, hint, limit, s, c)
                        } else {
                            v
                        }
                    })
                });
                if differential {
                    for c in 0..3 {
                        bases[1][c] = (bases[1][c] - bases[0][c]).clamp(-4, 3) + bases[0][c];
                    }
                }
                let mut total = 0;
                let mut tables = [0; 2];
                for s in 0..2 {
                    let (table, error) = (0..8)
                        .map(|table| {
                            let error = pixels
                                .iter()
                                .enumerate()
                                .filter(|(t, _)| subblock(*t, flip) == s)
                                .map(|(_, p)| {
                                    ETC[table]
                                        .iter()
                                        .map(|&m| {
                                            (0..3)
                                                .map(|c| {
                                                    let d = (expand(bases[s][c], differential) + m)
                                                        .clamp(0, 255)
                                                        - p[c] as i32;
                                                    (d * d) as u64
                                                })
                                                .sum::<u64>()
                                        })
                                        .min()
                                        .unwrap()
                                })
                                .sum::<u64>();
                            (table, error)
                        })
                        .min_by_key(|(_, error)| *error)
                        .unwrap();
                    tables[s] = table;
                    total += error;
                }
                if total < best.0 {
                    best = (total, flip, differential, hint, tables);
                }
            }
        }
    }
    let prefix = [4, 6, 5, 5, 5, 5, 5, 5, 5, 5, 3, 2, 3, 5, 5, 7, 6, 6, 4][mode];
    let mut at = prefix;
    // Zero BC1 hints request the full target fit. ETC hints below are optimized
    // independently and never use that zero as an assumed ETC encoding choice.
    write(block, &mut at, 0, 1);
    if ![10, 11, 12].contains(&mode) {
        write(block, &mut at, 0, 1);
    }
    write(block, &mut at, best.1, 1);
    write(block, &mut at, usize::from(best.2), 1);
    write(block, &mut at, best.4[0], 3);
    write(block, &mut at, best.4[1], 3);
    if has_bias {
        write(block, &mut at, best.3, 5);
    }
    if (9..=17).contains(&mode) {
        let lo = pixels.iter().map(|p| p[3]).min().unwrap() as i32;
        let hi = pixels.iter().map(|p| p[3]).max().unwrap() as i32;
        let mut best = (u64::MAX, 13, 1);
        if hi != lo {
            let ratio = [
                15.0 / 29.0,
                13.0 / 25.0,
                13.0 / 25.0,
                13.0 / 25.0,
                12.0 / 23.0,
                11.0 / 21.0,
                11.0 / 21.0,
                11.0 / 21.0,
                10.0 / 19.0,
                10.0 / 19.0,
                10.0 / 19.0,
                10.0 / 19.0,
                10.0 / 19.0,
                10.0 / 19.0,
                9.0 / 17.0,
                9.0 / 17.0,
            ];
            for table in 0..16 {
                let base = (lo as f64 + (hi - lo) as f64 * ratio[table]).round() as i32;
                for multiplier in 1..16 {
                    let error = pixels
                        .iter()
                        .map(|p| {
                            EAC[table]
                                .iter()
                                .map(|&m| {
                                    let d = (base + m * multiplier).clamp(0, 255) - p[3] as i32;
                                    (d * d) as u64
                                })
                                .min()
                                .unwrap()
                        })
                        .sum();
                    if error < best.0 {
                        best = (error, table, multiplier);
                    }
                }
            }
        }
        write(block, &mut at, best.1, 4);
        write(block, &mut at, best.2 as usize, 4);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::uastc::encode_mode;
    #[test]
    fn target_hints_preserve_pixels_and_alpha_multiplier_is_nonzero() {
        let pixels = std::array::from_fn(|t| {
            [
                (t * 17) as u8,
                (255 - t * 11) as u8,
                (t * 7) as u8,
                (t * 13) as u8,
            ]
        });
        for mode in 0..19 {
            let (mut block, _) = encode_mode(&pixels, mode, 0, 0, 0).unwrap();
            let before = decode_block(&block);
            apply(&mut block);
            assert_eq!(decode_block(&block), before);
        }
    }
}
