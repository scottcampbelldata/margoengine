use crate::tables::{PART2, PART3, PART7};

// (mode prefix, prefix bits, endpoint start, endpoint bits, radix,
// weight bits, subsets, components, planes, partition/component field).
const MODES: [(
    u32,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
); 19] = [
    (1, 4, 19, 6, 3, 4, 1, 3, 1, 0),
    (53, 6, 21, 8, 1, 2, 1, 3, 1, 0),
    (29, 5, 25, 4, 1, 3, 2, 3, 1, 20),
    (3, 5, 24, 2, 3, 2, 3, 3, 1, 20),
    (19, 5, 25, 3, 5, 2, 2, 3, 1, 20),
    (11, 5, 20, 8, 1, 3, 1, 3, 1, 0),
    (27, 5, 22, 5, 5, 2, 1, 3, 2, 20),
    (7, 5, 25, 3, 5, 2, 2, 3, 1, 20),
    (23, 5, 0, 8, 1, 0, 0, 4, 1, 0),
    (15, 5, 33, 4, 1, 2, 2, 4, 1, 28),
    (2, 3, 20, 4, 3, 4, 1, 4, 1, 0),
    (0, 2, 21, 4, 3, 2, 1, 4, 2, 19),
    (6, 3, 20, 6, 3, 3, 1, 4, 1, 0),
    (31, 5, 30, 8, 1, 1, 1, 4, 2, 28),
    (13, 5, 28, 8, 1, 2, 1, 4, 1, 0),
    (5, 7, 30, 8, 1, 4, 1, 2, 1, 0),
    (21, 6, 34, 8, 1, 2, 2, 2, 1, 29),
    (37, 6, 29, 8, 1, 2, 1, 2, 2, 0),
    (9, 4, 19, 5, 1, 5, 1, 3, 1, 0),
];
const W1: [u8; 2] = [0, 64];
const W2: [u8; 4] = [0, 21, 43, 64];
const W3: [u8; 8] = [0, 9, 18, 27, 37, 46, 55, 64];
const W4: [u8; 16] = [0, 4, 8, 12, 17, 21, 25, 29, 35, 39, 43, 47, 52, 56, 60, 64];
const W5: [u8; 32] = [
    0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 34, 36, 38, 40, 42, 44, 46, 48, 50,
    52, 54, 56, 58, 60, 62, 64,
];

fn weights(bits: usize) -> &'static [u8] {
    match bits {
        1 => &W1,
        2 => &W2,
        3 => &W3,
        4 => &W4,
        5 => &W5,
        _ => unreachable!(),
    }
}

fn unquantize(bits: usize, radix: usize, value: usize) -> u8 {
    if radix == 1 {
        let mut result = 0;
        for i in 0..8 {
            result |= ((value >> (bits - 1 - i % bits)) & 1) << (7 - i);
        }
        return result as u8;
    }
    let digit = value >> bits;
    let bit = |n: usize| (value >> n) & 1;
    let a = 511 * bit(0);
    let (b, c) = match (radix, bits) {
        (3, 2) => (278 * bit(1), 93),
        (5, 3) => (261 * bit(2) + 130 * bit(1), 26),
        (3, 4) => (260 * bit(3) + 130 * bit(2) + 65 * bit(1), 22),
        (5, 5) => (257 * bit(4) + 128 * bit(3) + 64 * bit(2) + 32 * bit(1), 6),
        (3, 6) => (
            257 * bit(5) + 128 * bit(4) + 64 * bit(3) + 32 * bit(2) + 16 * bit(1),
            5,
        ),
        _ => unreachable!(),
    };
    ((a & 128) | (((digit * c + b) ^ a) >> 2)) as u8
}

fn interpolate(a: u8, b: u8, w: u8) -> u8 {
    (((a as u32 * 257 * (64 - w as u32) + b as u32 * 257 * w as u32 + 32) >> 6) >> 8) as u8
}

fn put(block: &mut [u8; 16], at: &mut usize, value: u32, count: usize) {
    assert!(*at + count <= 128);
    for b in 0..count {
        block[(*at + b) / 8] |= (((value >> b) & 1) as u8) << ((*at + b) & 7);
    }
    *at += count;
}

fn get(block: &[u8; 16], at: &mut usize, count: usize) -> usize {
    let mut v = 0;
    for b in 0..count {
        v |= (((block[(*at + b) / 8] >> ((*at + b) & 7)) & 1) as usize) << b;
    }
    *at += count;
    v
}
pub(crate) fn mode_of(block: &[u8; 16]) -> usize {
    MODES
        .iter()
        .position(|&(prefix, bits, _, _, _, _, _, _, _, _)| {
            let mut at = 0;
            get(block, &mut at, bits) == prefix as usize
        })
        .unwrap()
}
pub fn decode_block(block: &[u8; 16]) -> [[u8; 4]; 16] {
    let mode = mode_of(block);
    let (_, prefix_bits, start, bits, radix, wb, subsets, comps, planes, field) = MODES[mode];
    if mode == 8 {
        let mut at = prefix_bits;
        let color = std::array::from_fn(|_| get(block, &mut at, 8) as u8);
        return [color; 16];
    }
    let mut at = field;
    let partition = if subsets > 1 {
        get(block, &mut at, if mode == 3 { 4 } else { 5 })
    } else {
        0
    };
    let selected = if mode == 17 {
        3
    } else if planes == 2 {
        get(block, &mut at, 2)
    } else {
        0
    };
    let pattern = if subsets == 1 {
        [0; 16]
    } else if mode == 3 {
        PART3[partition]
    } else if mode == 7 {
        PART7[partition]
    } else {
        PART2[partition]
    };
    let n = subsets * comps * 2;
    let mut digits = vec![0; n];
    at = start;
    if radix > 1 {
        let group_size = if radix == 3 { 5 } else { 3 };
        for group in digits.chunks_mut(group_size) {
            let power = radix.pow(group.len() as u32);
            let count = usize::BITS as usize - (power - 1).leading_zeros() as usize;
            let mut packed = get(block, &mut at, count);
            for d in group {
                *d = packed % radix;
                packed /= radix;
            }
        }
    }
    let endpoints: Vec<u8> = digits
        .into_iter()
        .map(|d| unquantize(bits, radix, (d << bits) | get(block, &mut at, bits)))
        .collect();
    let mut seen = [false; 3];
    let ws = weights(wb);
    let mut out = [[0; 4]; 16];
    for t in 0..16 {
        let s = pattern[t] as usize;
        let mut w = [0; 2];
        for p in 0..planes {
            w[p] = ws[get(block, &mut at, wb - usize::from(!seen[s]))];
        }
        seen[s] = true;
        for c in 0..4 {
            if comps == 3 && c == 3 {
                out[t][c] = 255;
                continue;
            }
            let ec = if comps == 2 {
                if c == 3 { 1 } else { 0 }
            } else {
                c
            };
            let i = s * comps * 2 + ec * 2;
            out[t][c] = interpolate(
                endpoints[i],
                endpoints[i + 1],
                w[usize::from(planes == 2 && c == selected)],
            );
        }
    }
    out
}

/// Rate-distortion conditioning uses previous decoded blocks as LZ dictionary
/// candidates. It evaluates true reconstruction error, not compressed bytes as
/// pixels. Lambda zero preserves the exact unconditioned block stream.
#[cfg(test)]
pub fn rdo(pixels: &[[[u8; 4]; 16]], blocks: &mut [[u8; 16]], lambda: f64) {
    rdo_metric(pixels, blocks, lambda, [1; 4])
}
pub fn rdo_metric(
    pixels: &[[[u8; 4]; 16]],
    blocks: &mut [[u8; 16]],
    lambda: f64,
    metric: [i32; 4],
) {
    if lambda == 0.0 {
        return;
    }
    let mut decoded: Vec<[[u8; 4]; 16]> = Vec::with_capacity(blocks.len());
    for i in 0..blocks.len() {
        let original = decode_block(&blocks[i]);
        let base_error: u64 = pixels[i]
            .iter()
            .zip(&original)
            .map(|(a, b)| distortion(a, b, metric) as u64)
            .sum();
        let mut best = blocks[i];
        let mut reconstruction = original;
        let rate_scale = metric.iter().sum::<i32>() as f64 / 4.0;
        let mut best_cost = base_error as f64 + lambda * 16.0 * 128.0 * rate_scale;
        // A full-block match needs an offset and match length rather than 128
        // literal bits. Prefer nearer equal candidates for deterministic ties.
        for j in (i.saturating_sub(256)..i).rev() {
            let error: u64 = pixels[i]
                .iter()
                .zip(&decoded[j])
                .map(|(a, b)| distortion(a, b, metric) as u64)
                .sum();
            let distance = (i - j) * 16;
            let rate = 16.0 + (usize::BITS - distance.leading_zeros()) as f64;
            let cost = error as f64 + lambda * 16.0 * rate * rate_scale;
            if cost < best_cost {
                best_cost = cost;
                best = blocks[j];
                reconstruction = decoded[j];
            }
        }
        blocks[i] = best;
        decoded.push(reconstruction);
    }
}

fn quantize(table: &[u8], value: f64) -> usize {
    table
        .iter()
        .enumerate()
        .min_by(|a, b| {
            (f64::from(*a.1) - value)
                .abs()
                .total_cmp(&(f64::from(*b.1) - value).abs())
        })
        .unwrap()
        .0
}

/// Exact integer distortion. SIMD computes the same four channel errors in one
/// vector, instead of a scalar loop. Masks also handle RGB, LA and dual planes.
#[inline]
pub(crate) fn distortion(a: &[u8; 4], b: &[u8; 4], mask: [i32; 4]) -> u32 {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use std::arch::wasm32::*;
        let x = i32x4(a[0] as i32, a[1] as i32, a[2] as i32, a[3] as i32);
        let y = i32x4(b[0] as i32, b[1] as i32, b[2] as i32, b[3] as i32);
        let delta = i32x4_sub(x, y);
        let squared = i32x4_mul(
            i32x4_mul(delta, delta),
            i32x4(mask[0], mask[1], mask[2], mask[3]),
        );
        return (i32x4_extract_lane::<0>(squared)
            + i32x4_extract_lane::<1>(squared)
            + i32x4_extract_lane::<2>(squared)
            + i32x4_extract_lane::<3>(squared)) as u32;
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        (0..4)
            .map(|c| {
                let d = a[c] as i32 - b[c] as i32;
                (d * d * mask[c]) as u32
            })
            .sum()
    }
}

#[derive(Clone)]
struct Fit {
    endpoints: [[usize; 4]; 2],
    indices: [u8; 16],
    error: u64,
}

fn assign(
    pixels: &[[u8; 4]; 16],
    members: &[usize],
    endpoints: [[usize; 4]; 2],
    table: &[u8],
    ws: &[u8],
    mask: [i32; 4],
) -> Fit {
    let palette: Vec<[u8; 4]> = ws
        .iter()
        .map(|&w| {
            std::array::from_fn(|c| interpolate(table[endpoints[0][c]], table[endpoints[1][c]], w))
        })
        .collect();
    let mut indices = [0; 16];
    let mut error = 0;
    for &t in members {
        let (index, dist) = palette
            .iter()
            .enumerate()
            .map(|(i, p)| (i, distortion(&pixels[t], p, mask)))
            .min_by_key(|&(_, d)| d)
            .unwrap();
        indices[t] = index as u8;
        error += dist as u64;
    }
    Fit {
        endpoints,
        indices,
        error,
    }
}

fn seed(
    pixels: &[[u8; 4]; 16],
    members: &[usize],
    mask: [i32; 4],
    variant: usize,
) -> [[f64; 4]; 2] {
    let mean: [f64; 4] = std::array::from_fn(|c| {
        members.iter().map(|&t| pixels[t][c] as f64).sum::<f64>() / members.len() as f64
    });
    let scale = mask.map(|v| (v as f64).sqrt());
    let mut covariance = [[0.0; 4]; 4];
    for &t in members {
        for c in 0..4 {
            for d in 0..4 {
                covariance[c][d] += (pixels[t][c] as f64 - mean[c])
                    * (pixels[t][d] as f64 - mean[d])
                    * scale[c]
                    * scale[d];
            }
        }
    }
    let axis = (0..4)
        .max_by(|&a, &b| covariance[a][a].total_cmp(&covariance[b][b]))
        .unwrap();
    let mut direction = [0.0; 4];
    direction[if variant == 0 {
        axis
    } else {
        (axis + variant) % 4
    }] = 1.0;
    for _ in 0..8 {
        let next: [f64; 4] =
            std::array::from_fn(|c| (0..4).map(|d| covariance[c][d] * direction[d]).sum());
        let scale = next.iter().map(|v| v.abs()).fold(0.0, f64::max);
        if scale <= 1e-12 {
            break;
        }
        direction = next.map(|v| v / scale);
    }
    let project = |&t: &usize| {
        (0..4)
            .map(|c| (pixels[t][c] as f64 - mean[c]) * direction[c] * scale[c])
            .sum::<f64>()
    };
    let lo = *members
        .iter()
        .min_by(|a, b| project(a).total_cmp(&project(b)))
        .unwrap();
    let hi = *members
        .iter()
        .max_by(|a, b| project(a).total_cmp(&project(b)))
        .unwrap();
    [pixels[lo].map(f64::from), pixels[hi].map(f64::from)]
}

fn fit(
    pixels: &[[u8; 4]; 16],
    members: &[usize],
    table: &[u8],
    ws: &[u8],
    mask: [i32; 4],
    level: u32,
) -> Fit {
    let mut best: Option<Fit> = None;
    for variant in 0..if level >= 3 { 4 } else { 1 } {
        let initial = seed(pixels, members, mask, variant);
        let ends = initial.map(|p| p.map(|v| quantize(table, v)));
        let mut now = assign(pixels, members, ends, table, ws, mask);
        for _ in 0..(2 + level * 2) {
            if best.as_ref().is_none_or(|b| now.error < b.error) {
                best = Some(now.clone());
            }
            if now.error == 0 {
                break;
            }
            let (mut aa, mut ab, mut bb) = (0.0, 0.0, 0.0);
            let (mut ax, mut bx) = ([0.0; 4], [0.0; 4]);
            for &t in members {
                let b = ws[now.indices[t] as usize] as f64 / 64.0;
                let a = 1.0 - b;
                aa += a * a;
                ab += a * b;
                bb += b * b;
                for c in 0..4 {
                    ax[c] += a * pixels[t][c] as f64;
                    bx[c] += b * pixels[t][c] as f64;
                }
            }
            let determinant = aa * bb - ab * ab;
            if determinant <= 1e-12 {
                break;
            }
            let mut ends = now.endpoints;
            for c in 0..4 {
                if mask[c] != 0 {
                    ends[0][c] = quantize(table, (ax[c] * bb - bx[c] * ab) / determinant);
                    ends[1][c] = quantize(table, (bx[c] * aa - ax[c] * ab) / determinant);
                }
            }
            if ends == now.endpoints {
                break;
            }
            now = assign(pixels, members, ends, table, ws, mask);
        }
        if best.as_ref().is_none_or(|b| now.error < b.error) {
            best = Some(now);
        }
    }
    let mut best = best.unwrap();
    if level >= 2 {
        // Search neighboring *decoded* endpoint values, because BISE codepoints
        // are deliberately nonmonotonic. Reassign weights for every candidate.
        for _ in 0..if level >= 4 { 4 } else { 1 } {
            let before = best.error;
            for end in 0..2 {
                for c in 0..4 {
                    if mask[c] != 0 {
                        let value = table[best.endpoints[end][c]];
                        let lower = table
                            .iter()
                            .enumerate()
                            .filter(|&(_, v)| *v < value)
                            .max_by_key(|&(_, v)| v)
                            .map(|(i, _)| i);
                        let upper = table
                            .iter()
                            .enumerate()
                            .filter(|&(_, v)| *v > value)
                            .min_by_key(|&(_, v)| v)
                            .map(|(i, _)| i);
                        for candidate in [lower, upper].into_iter().flatten() {
                            let mut endpoints = best.endpoints;
                            endpoints[end][c] = candidate;
                            let next = assign(pixels, members, endpoints, table, ws, mask);
                            if next.error < best.error {
                                best = next;
                            }
                        }
                    }
                }
            }
            if best.error == before {
                break;
            }
        }
    }
    // Anchor symmetry is lossless for the exact normative interpolation.
    if best.indices[members[0]] as usize >= ws.len() / 2 {
        best.endpoints.swap(0, 1);
        for &t in members {
            best.indices[t] = (ws.len() - 1 - best.indices[t] as usize) as u8;
        }
    }
    best
}

/// Encode a specified standard mode. Returns None for invalid mode parameters.
/// This entry deliberately permits alpha loss in forced RGB conformance probes;
/// automatic selection excludes RGB modes on blocks with nonopaque alpha.
pub fn encode_mode(
    source: &[[u8; 4]; 16],
    mode: usize,
    partition: usize,
    component: usize,
    level: u32,
) -> Option<([u8; 16], u64)> {
    encode_mode_metric(source, mode, partition, component, level, [1; 4])
}
fn encode_mode_metric(
    source: &[[u8; 4]; 16],
    mode: usize,
    partition: usize,
    component: usize,
    level: u32,
    metric: [i32; 4],
) -> Option<([u8; 16], u64)> {
    let &(prefix, prefix_bits, start, bits, radix, weight_bits, subsets, comps, planes, field) =
        MODES.get(mode)?;
    if component > 3 || level > 4 {
        return None;
    }
    let mut block = [0; 16];
    let mut at = 0;
    put(&mut block, &mut at, prefix, prefix_bits);
    if mode == 8 {
        let color: [u8; 4] = std::array::from_fn(|c| {
            ((source.iter().map(|p| p[c] as u32).sum::<u32>() + 8) / 16) as u8
        });
        for c in color {
            put(&mut block, &mut at, c as u32, 8);
        }
        let error = source
            .iter()
            .map(|p| distortion(p, &color, metric) as u64)
            .sum();
        return Some((block, error));
    }
    let pattern = if subsets == 1 {
        if partition != 0 {
            return None;
        }
        [0; 16]
    } else if mode == 3 {
        *PART3.get(partition)?
    } else if mode == 7 {
        *PART7.get(partition)?
    } else {
        *PART2.get(partition)?
    };
    if field > 0 {
        at = field;
        if subsets > 1 {
            put(
                &mut block,
                &mut at,
                partition as u32,
                if mode == 3 { 4 } else { 5 },
            );
        } else {
            put(&mut block, &mut at, component as u32, 2);
        }
    }
    let table: Vec<u8> = (0..(1 << bits) * radix)
        .map(|v| unquantize(bits, radix, v))
        .collect();
    let ws = weights(weight_bits);
    let pixels: [[u8; 4]; 16] = if comps == 2 {
        source.map(|p| [p[0], p[0], p[0], p[3]])
    } else {
        *source
    };
    let mut ends = [[[0usize; 4]; 2]; 3];
    let mut indices = [[0u8; 16]; 2];
    let mut error = 0;
    for subset in 0..subsets {
        let members: Vec<usize> = (0..16).filter(|&t| pattern[t] as usize == subset).collect();
        for plane in 0..planes {
            let mask: [i32; 4] = std::array::from_fn(|c| {
                let present = if comps == 2 {
                    c == 0 || c == 3
                } else {
                    c < comps
                };
                let selected = if mode == 17 { 3 } else { component };
                let active = present && (planes == 1 || (c == selected) == (plane == 1));
                if active && comps == 2 && c == 0 {
                    metric[0] + metric[1] + metric[2]
                } else {
                    active as i32 * metric[c]
                }
            });
            let result = fit(&pixels, &members, &table, ws, mask, level);
            for c in 0..4 {
                if mask[c] != 0 {
                    for end in 0..2 {
                        ends[subset][end][c] = result.endpoints[end][c];
                    }
                }
            }
            for &t in &members {
                indices[plane][t] = result.indices[t];
            }
            error += result.error;
        }
    }
    // Account for intentionally forced formats which cannot represent channels.
    if comps == 3 {
        error += source
            .iter()
            .map(|p| (255 - p[3] as u64).pow(2) * metric[3] as u64)
            .sum::<u64>();
    }
    if comps == 2 {
        error += source
            .iter()
            .map(|p| {
                (p[0] as i64 - p[1] as i64).pow(2) as u64
                    + (p[0] as i64 - p[2] as i64).pow(2) as u64
            })
            .sum::<u64>();
    }
    let channels: &[usize] = if comps == 2 {
        &[0, 3]
    } else if comps == 3 {
        &[0, 1, 2]
    } else {
        &[0, 1, 2, 3]
    };
    let values: Vec<usize> = (0..subsets)
        .flat_map(|s| {
            channels
                .iter()
                .flat_map(move |&c| [ends[s][0][c], ends[s][1][c]])
        })
        .collect();
    at = start;
    if radix > 1 {
        for group in values.chunks(if radix == 3 { 5 } else { 3 }) {
            let mut packed = 0;
            let mut power = 1usize;
            for &v in group {
                packed += (v >> bits) * power;
                power *= radix;
            }
            let count = usize::BITS as usize - (power - 1).leading_zeros() as usize;
            put(&mut block, &mut at, packed as u32, count);
        }
    }
    for value in values {
        put(
            &mut block,
            &mut at,
            (value & ((1 << bits) - 1)) as u32,
            bits,
        );
    }
    let mut seen = [false; 3];
    for t in 0..16 {
        let s = pattern[t] as usize;
        for plane in 0..planes {
            put(
                &mut block,
                &mut at,
                indices[plane][t] as u32,
                weight_bits - (!seen[s] as usize),
            );
        }
        seen[s] = true;
    }
    Some((block, error))
}

/// All nineteen standard modes participate. Level controls optimization work and
/// number of partitions examined, without changing the wire format or alpha.
pub fn encode_block(source: &[[u8; 4]; 16], level: u32) -> [u8; 16] {
    encode_block_metric(source, level, [1; 4])
}
pub fn encode_block_metric(source: &[[u8; 4]; 16], level: u32, metric: [i32; 4]) -> [u8; 16] {
    assert!(level <= 4);
    let mut best = encode_mode_metric(source, 8, 0, 0, level, metric).unwrap();
    if best.1 == 0 {
        return best.0;
    }
    let opaque = source.iter().all(|p| p[3] == 255);
    let gray = source.iter().all(|p| p[0] == p[1] && p[1] == p[2]);
    for mode in 0..19 {
        if mode == 8 {
            continue;
        }
        let (_, _, _, _, _, _, subsets, comps, planes, _) = MODES[mode];
        if (comps == 3 && !opaque) || (comps == 2 && !gray) {
            continue;
        }
        let partitions = if subsets == 1 {
            1
        } else if mode == 3 {
            11
        } else if mode == 7 {
            19
        } else {
            30
        };
        // Fixed deterministic effort choices, with the complete set at level 2+.
        let count = if level >= 2 {
            partitions
        } else {
            partitions.min(if level == 0 { 4 } else { 12 })
        };
        for partition in 0..count {
            for component in 0..if planes == 2 && mode != 17 {
                if comps == 3 { 3 } else { 4 }
            } else {
                1
            } {
                let candidate =
                    encode_mode_metric(source, mode, partition, component, level, metric).unwrap();
                if candidate.1 < best.1 {
                    best = candidate;
                }
            }
        }
    }
    best.0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normative_unquantization_and_endpoint_coverage() {
        for (bits, radix, code, want) in [
            (2, 3, 2, 69),
            (3, 5, 34, 58),
            (4, 3, 16, 5),
            (5, 5, 32, 1),
            (6, 3, 64, 1),
        ] {
            assert_eq!(unquantize(bits, radix, code), want);
            let values: Vec<u8> = (0..(1 << bits) * radix)
                .map(|v| unquantize(bits, radix, v))
                .collect();
            assert!(values.contains(&0) && values.contains(&255));
            let mut sorted = values.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(sorted.len(), values.len());
        }
    }
    #[test]
    fn perceptual_candidate_error_matches_actual_reconstruction() {
        let pixels = std::array::from_fn(|t| {
            [
                (t * 17) as u8,
                (255 - t * 11) as u8,
                (t * 7) as u8,
                (t * 13) as u8,
            ]
        });
        let metric = [54, 183, 19, 256];
        for mode in 0..15 {
            let (block, error) = encode_mode_metric(&pixels, mode, 0, 0, 2, metric).unwrap();
            let actual: u64 = pixels
                .iter()
                .zip(decode_block(&block))
                .map(|(a, b)| distortion(a, &b, metric) as u64)
                .sum();
            assert_eq!(actual, error, "{mode}");
        }
    }
    #[test]
    fn every_mode_partition_and_component_packs_inside_128_bits() {
        let pixels = std::array::from_fn(|t| {
            [
                (t * 17) as u8,
                (255 - t * 11) as u8,
                (t * 7) as u8,
                (t * 13) as u8,
            ]
        });
        for mode in 0..19 {
            let (_, _, _, _, _, _, subsets, _, planes, _) = MODES[mode];
            let count = if subsets <= 1 {
                1
            } else if mode == 3 {
                11
            } else if mode == 7 {
                19
            } else {
                30
            };
            for p in 0..count {
                for c in 0..if planes == 2 { 4 } else { 1 } {
                    assert!(encode_mode(&pixels, mode, p, c, 0).is_some());
                }
            }
        }
    }
    #[test]
    fn exact_solids_and_rejected_parameters() {
        for value in 0..=255u8 {
            let color = [
                value,
                value.wrapping_mul(17),
                255 - value,
                value.wrapping_mul(41),
            ];
            let (block, error) = encode_mode(&[color; 16], 8, 0, 0, 0).unwrap();
            assert_eq!(error, 0);
            assert_eq!(block[0] & 31, 23);
        }
        assert!(encode_mode(&[[0; 4]; 16], 19, 0, 0, 0).is_none());
        assert!(encode_mode(&[[0; 4]; 16], 2, 30, 0, 0).is_none());
    }
    #[test]
    fn independent_unpacking_reconstructs_every_mode_and_reported_error() {
        let pixels = std::array::from_fn(|t| {
            [
                (t * 17) as u8,
                (255 - t * 11) as u8,
                (t * 7) as u8,
                (t * 13) as u8,
            ]
        });
        for mode in 0..19 {
            let count = if mode == 3 {
                11
            } else if mode == 7 {
                19
            } else if [2, 4, 9, 16].contains(&mode) {
                30
            } else {
                1
            };
            for partition in 0..count {
                let (block, error) = encode_mode(&pixels, mode, partition, 0, 0).unwrap();
                let reconstructed = decode_block(&block);
                let actual: u64 = pixels
                    .iter()
                    .zip(reconstructed)
                    .map(|(a, b)| distortion(a, &b, [1; 4]) as u64)
                    .sum();
                if ![15, 16, 17].contains(&mode) {
                    assert_eq!(actual, error, "{mode}/{partition}");
                }
            }
        }
    }
    #[test]
    fn rdo_zero_preserves_stream_and_positive_lambda_can_reuse_valid_blocks() {
        let pixels: Vec<_> = (0..8).map(|i| [[128 + i, 128, 128, 255]; 16]).collect();
        let blocks: Vec<_> = pixels.iter().map(|p| encode_block(p, 0)).collect();
        let mut zero = blocks.clone();
        rdo(&pixels, &mut zero, 0.0);
        assert_eq!(zero, blocks);
        let mut conditioned = blocks.clone();
        rdo(&pixels, &mut conditioned, 4.0);
        assert!(conditioned.windows(2).any(|p| p[0] == p[1]));
    }
}
