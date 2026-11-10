//! ASTC physical blocks, independently implemented from Khronos Data Format 1.3 section 23.
use crate::{
    Error, Result,
    ise::{self, Bits},
};
#[derive(Clone, Debug, Default)]
pub struct Block {
    pub width: usize,
    pub height: usize,
    pub weight_levels: usize,
    pub dual: bool,
    pub channel: usize,
    pub partitions: usize,
    pub seed: usize,
    pub modes: Vec<usize>,
    pub endpoint_levels: usize,
    pub endpoints: Vec<usize>,
    pub weights: Vec<usize>,
    pub solid: Option<[u16; 4]>,
}
pub fn mode(code: usize) -> Result<(usize, usize, usize, bool)> {
    let low = code & 3;
    let r = (code >> 4) & 1;
    let a = (code >> 5) & 3;
    let mut high = code >> 9 & 1;
    let mut dual = code >> 10 != 0;
    let (w, h, rho) = if low != 0 {
        let rho = r + 2 * low;
        let b = (code >> 7) & 3;
        let (w, h) = match (code >> 2) & 3 {
            0 => (b + 4, a + 2),
            1 => (b + 8, a + 2),
            2 => (a + 2, b + 8),
            _ => {
                if code & 256 == 0 {
                    (a + 2, (b & 1) + 6)
                } else {
                    ((b & 1) + 2, a + 2)
                }
            }
        };
        (w, h, rho)
    } else {
        let rho = r + 2 * ((code >> 2) & 3);
        let (w, h) = match (code >> 7) & 3 {
            0 => (12, a + 2),
            1 => (a + 2, 12),
            2 => {
                high = 0;
                dual = false;
                (a + 6, ((code >> 9) & 3) + 6)
            }
            _ => match a {
                0 => (6, 10),
                1 => (10, 6),
                _ => return Err(Error::Invalid),
            },
        };
        (w, h, rho)
    };
    if rho < 2 {
        return Err(Error::Invalid);
    }
    let index = rho - 2 + 6 * high;
    let levels = ise::LEVELS[index];
    let count = w * h * if dual { 2 } else { 1 };
    let bits = ise::size(count, levels);
    if w > 6 || h > 6 || count > 64 || !(24..=96).contains(&bits) {
        return Err(Error::Invalid);
    }
    Ok((w, h, levels, dual))
}
pub fn pack(block: &Block) -> Result<[u8; 16]> {
    let mut out = [0u8; 16];
    if let Some(color) = block.solid {
        out[..8].copy_from_slice(&[0xfc, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        for (i, c) in color.into_iter().enumerate() {
            out[8 + i * 2..10 + i * 2].copy_from_slice(&c.to_le_bytes());
        }
        return Ok(out);
    }
    let code = (0..2048)
        .find(|&c| {
            mode(c).ok() == Some((block.width, block.height, block.weight_levels, block.dual))
        })
        .ok_or(Error::Invalid)?;
    ise::set(&mut out, 0, 11, code);
    ise::set(&mut out, 11, 2, block.partitions - 1);
    let endpoint_at = if block.partitions == 1 {
        ise::set(&mut out, 13, 4, block.modes[0]);
        17
    } else {
        ise::set(&mut out, 13, 10, block.seed);
        ise::set(&mut out, 23, 6, block.modes[0] << 2);
        29
    };
    let weight_bits = ise::size(block.weights.len(), block.weight_levels);
    if block.dual {
        ise::set(&mut out, 128 - weight_bits - 2, 2, block.channel);
    }
    let available = 128 - weight_bits - endpoint_at - if block.dual { 2 } else { 0 };
    let endpoint_levels = ise::LEVELS
        .iter()
        .rev()
        .copied()
        .find(|&l| l >= 6 && ise::size(block.endpoints.len(), l) <= available)
        .ok_or(Error::Invalid)?;
    if endpoint_levels != block.endpoint_levels {
        return Err(Error::Invalid);
    }
    ise::write(&mut out, endpoint_at, &block.endpoints, endpoint_levels)?;
    let mut weights = [0u8; 16];
    ise::write(&mut weights, 0, &block.weights, block.weight_levels)?;
    for i in 0..weight_bits {
        ise::set(
            &mut out,
            127 - i,
            1,
            ((weights[i / 8] >> (i % 8)) & 1) as usize,
        );
    }
    Ok(out)
}
pub fn unpack(bytes: &[u8]) -> Result<Block> {
    if bytes.len() != 16 {
        return Err(Error::Truncated);
    }
    let mut bits = Bits::new(bytes);
    let code = bits.read(11)?;
    if code & 511 == 508 {
        if code & 1024 == 0 || bytes[1] & 8 == 0 {
            return Err(Error::Invalid);
        }
        let mut extent = Bits {
            data: bytes,
            at: 12,
        };
        let mut e = [0; 4];
        for v in &mut e {
            *v = extent.read(13)?;
        }
        if e != [8191; 4] && (e[0] >= e[1] || e[2] >= e[3]) {
            return Err(Error::Invalid);
        }
        let hdr = code & 512 != 0;
        let mut color = [0; 4];
        for (i, c) in color.iter_mut().enumerate() {
            let v = u16::from_le_bytes([bytes[8 + i * 2], bytes[9 + i * 2]]);
            if hdr && v & 0x7c00 == 0x7c00 {
                return Err(Error::Invalid);
            }
            *c = if hdr { v } else { unorm_half(v as usize) };
        }
        return Ok(Block {
            solid: Some(color),
            ..Block::default()
        });
    }
    let (width, height, weight_levels, dual) = mode(code)?;
    let partitions = bits.read(2)? + 1;
    if partitions == 4 && dual {
        return Err(Error::Invalid);
    }
    let n = width * height * if dual { 2 } else { 1 };
    let weight_bits = ise::size(n, weight_levels);
    let mut top = 128 - weight_bits;
    let mut seed = 0;
    let mut modes = Vec::new();
    if partitions == 1 {
        modes.push(bits.read(4)?);
    } else {
        seed = bits.read(10)?;
        let cem = bits.read(6)?;
        if cem & 3 == 0 {
            modes = vec![cem >> 2; partitions];
        } else {
            let extra = 3 * partitions - 4;
            top -= extra;
            let more = Bits {
                data: bytes,
                at: top,
            }
            .read(extra)?;
            let cem = cem | (more << 6);
            let class = (cem & 3) - 1;
            for p in 0..partitions {
                modes.push(
                    4 * (class + ((cem >> (2 + p)) & 1)) + ((cem >> (2 + partitions + 2 * p)) & 3),
                );
            }
        }
    }
    let channel = if dual {
        top -= 2;
        Bits {
            data: bytes,
            at: top,
        }
        .read(2)?
    } else {
        0
    };
    let count: usize = modes.iter().map(|&m| 2 * (m / 4 + 1)).sum();
    if count > 18 || top < bits.at {
        return Err(Error::Invalid);
    }
    let endpoint_levels = ise::LEVELS
        .iter()
        .rev()
        .copied()
        .find(|&l| l >= 6 && ise::size(count, l) <= top - bits.at)
        .ok_or(Error::Invalid)?;
    let endpoints = ise::read(&mut bits, count, endpoint_levels, false)?;
    let rev: Vec<_> = bytes.iter().rev().map(|v| v.reverse_bits()).collect();
    let weights = ise::read(&mut Bits::new(&rev), n, weight_levels, false)?;
    Ok(Block {
        width,
        height,
        weight_levels,
        dual,
        channel,
        partitions,
        seed,
        modes,
        endpoint_levels,
        endpoints,
        weights,
        solid: None,
    })
}
pub fn infill(
    weights: &[usize],
    w: usize,
    h: usize,
    x: usize,
    y: usize,
    edge: usize,
    plane: usize,
    planes: usize,
    legacy: bool,
) -> usize {
    let scale = (1024 + edge / 2) / (edge - 1);
    let gx = (scale * x * (w - 1) + 32) >> 6;
    let gy = (scale * y * (h - 1) + 32) >> 6;
    let fx = gx & 15;
    let fy = gy & 15;
    let br = (fx * fy + 8) >> 4;
    let factors = [16 + br - fx - fy, fx - br, fy - br, br];
    let mut total = 8;
    for (i, factor) in factors.into_iter().enumerate() {
        if factor == 0 {
            continue;
        }
        let source = if legacy {
            usize::from((x + i % 2) + (y + i / 2) * w < w * h)
        } else {
            (gx / 16 + i % 2) + (gy / 16 + i / 2) * w
        };
        total += weights[source * planes + plane] * factor;
    }
    total >> 4
}
pub fn partition(seed: usize, x: usize, y: usize, n: usize) -> usize {
    let seed = seed + (n - 1) * 1024;
    let mut hash = seed as u32;
    hash ^= hash >> 15;
    hash = hash.wrapping_sub(hash << 17);
    hash = hash.wrapping_add(hash << 7);
    hash = hash.wrapping_add(hash << 4);
    hash ^= hash >> 5;
    hash = hash.wrapping_add(hash << 16);
    hash ^= hash >> 7;
    hash ^= hash >> 3;
    hash ^= hash << 6;
    hash ^= hash >> 17;
    let first = if seed & 1 != 0 {
        if seed & 2 != 0 { 4 } else { 5 }
    } else {
        if n == 3 { 6 } else { 5 }
    };
    let second = if seed & 1 != 0 {
        if n == 3 { 6 } else { 5 }
    } else {
        if seed & 2 != 0 { 4 } else { 5 }
    };
    let mut best = 0;
    let mut score = 0;
    for p in 0..n {
        let a = ((hash >> (8 * p)) & 15) as usize;
        let b = ((hash >> (8 * p + 4)) & 15) as usize;
        let value =
            (((a * a) >> first) * x + ((b * b) >> second) * y + (hash >> (14 - 4 * p)) as usize)
                & 63;
        if p == 0 || value > score {
            best = p;
            score = value;
        }
    }
    best
}
fn signed(v: i32, bits: usize) -> i32 {
    (v << (32 - bits)) >> (32 - bits)
}
fn route(fields: &mut [i32], extras: &[i32], map: &[(usize, usize)]) {
    for (&v, &(field, bit)) in extras.iter().zip(map) {
        fields[field] |= v << bit;
    }
}
pub fn endpoints(mode: usize, v: &[usize]) -> ([[i32; 4]; 2], [bool; 4]) {
    let mut v: Vec<_> = v.iter().map(|&v| v as i32).collect();
    let mut e = [[0, 0, 0, 255]; 2];
    let hdr = matches!(mode, 2 | 3 | 7 | 11 | 14 | 15);
    let mut flags = [hdr; 4];
    if mode == 14 {
        flags[3] = false;
    }
    if hdr {
        e[0][3] = 0x780;
        e[1][3] = 0x780;
    }
    match mode {
        0 | 1 | 2 | 3 | 4 | 5 => {
            let (a, b) = match mode {
                1 => {
                    let a = (v[0] >> 2) | (v[1] & 192);
                    (a, (a + (v[1] & 63)).min(255))
                }
                2 => {
                    if v[1] >= v[0] {
                        (v[0] * 16, v[1] * 16)
                    } else {
                        (v[1] * 16 + 8, v[0] * 16 - 8)
                    }
                }
                3 => {
                    let s = if v[0] & 128 != 0 { 2 } else { 1 };
                    let mask = if s == 2 { 31 } else { 15 };
                    let a = ((v[1] & !mask) << 4) | ((v[0] & 127) << s);
                    (a, (a + ((v[1] & mask) << s)).min(4095))
                }
                5 => {
                    for i in [0, 2] {
                        let a = v[i] / 2 | (v[i + 1] & 128);
                        let b = signed((v[i + 1] >> 1) & 63, 6);
                        v[i] = a;
                        v[i + 1] = b;
                    }
                    (v[0], v[0] + v[1])
                }
                _ => (v[0], v[1]),
            };
            e[0][..3].fill(a);
            e[1][..3].fill(b);
            if mode == 4 {
                e[0][3] = v[2];
                e[1][3] = v[3];
            }
            if mode == 5 {
                e[0][3] = v[2];
                e[1][3] = v[2] + v[3];
            }
        }
        6 | 10 => {
            for c in 0..3 {
                e[0][c] = v[c] * v[3] >> 8;
                e[1][c] = v[c];
            }
            if mode == 10 {
                e[0][3] = v[4];
                e[1][3] = v[5];
            }
        }
        8 | 9 | 12 | 13 => {
            let delta = mode & 1 != 0;
            let channels = if mode >= 12 { 4 } else { 3 };
            for c in 0..channels {
                let a = v[c * 2];
                let b = v[c * 2 + 1];
                e[0][c] = if delta { a / 2 | (b & 128) } else { a };
                e[1][c] = if delta {
                    e[0][c] + signed((b >> 1) & 63, 6)
                } else {
                    b
                };
            }
            if e[1][..3].iter().sum::<i32>() < e[0][..3].iter().sum::<i32>() {
                for p in &mut e {
                    p[0] = (p[0] + p[2]) >> 1;
                    p[1] = (p[1] + p[2]) >> 1;
                }
                e.swap(0, 1);
            }
        }
        7 => {
            let code = (v[0] >> 6) | ((v[1] >> 7) << 2) | ((v[2] >> 7) << 3);
            let (major, m) = if code < 12 {
                (code >> 2, code & 3)
            } else if code < 15 {
                (code & 3, 4)
            } else {
                (0, 5)
            };
            let mut f = [v[0] & 63, v[1] & 31, v[2] & 31, v[3] & 31];
            let x = [
                v[1] >> 6 & 1,
                v[1] >> 5 & 1,
                v[2] >> 6 & 1,
                v[2] >> 5 & 1,
                v[3] >> 7,
                v[3] >> 6 & 1,
                v[3] >> 5 & 1,
            ];
            let maps = [
                [(0, 9), (0, 8), (0, 7), (0, 10), (0, 6), (3, 6), (3, 5)],
                [(0, 8), (1, 5), (0, 7), (2, 5), (0, 6), (0, 10), (0, 9)],
                [(0, 9), (0, 8), (0, 7), (0, 6), (3, 7), (3, 6), (3, 5)],
                [(0, 8), (1, 5), (0, 7), (2, 5), (0, 6), (3, 6), (3, 5)],
                [(1, 6), (1, 5), (2, 6), (2, 5), (0, 6), (0, 7), (3, 5)],
                [(1, 6), (1, 5), (2, 6), (2, 5), (0, 6), (3, 6), (3, 5)],
            ];
            route(&mut f, &x, &maps[m as usize]);
            let shift = [1, 1, 2, 3, 4, 5][m as usize];
            for a in &mut f {
                *a <<= shift;
            }
            if m != 5 {
                f[1] = f[0] - f[1];
                f[2] = f[0] - f[2];
            }
            f.swap(0, major as usize);
            for c in 0..3 {
                e[1][c] = f[c];
                e[0][c] = f[c] - f[3];
            }
        }
        11 | 14 | 15 => {
            let major = (v[4] >> 7) | ((v[5] >> 7) << 1);
            if major == 3 {
                e[0][..3].copy_from_slice(&[v[0] << 4, v[2] << 4, (v[4] & 127) << 5]);
                e[1][..3].copy_from_slice(&[v[1] << 4, v[3] << 4, (v[5] & 127) << 5]);
            } else {
                let m = ((v[1] >> 7) | ((v[2] >> 7) << 1) | ((v[3] >> 7) << 2)) as usize;
                let mut f = [
                    v[0] | ((v[1] & 64) << 2),
                    v[2] & 63,
                    v[3] & 63,
                    v[1] & 63,
                    v[4] & 31,
                    v[5] & 31,
                ];
                let x = [
                    v[2] >> 6 & 1,
                    v[3] >> 6 & 1,
                    v[4] >> 6 & 1,
                    v[5] >> 6 & 1,
                    v[4] >> 5 & 1,
                    v[5] >> 5 & 1,
                ];
                let maps = [
                    [(1, 6), (2, 6), (4, 6), (5, 6), (4, 5), (5, 5)],
                    [(1, 6), (2, 6), (1, 7), (2, 7), (4, 5), (5, 5)],
                    [(0, 9), (3, 6), (4, 6), (5, 6), (4, 5), (5, 5)],
                    [(1, 6), (2, 6), (0, 9), (3, 6), (4, 5), (5, 5)],
                    [(1, 6), (2, 6), (1, 7), (2, 7), (0, 9), (0, 10)],
                    [(0, 9), (0, 10), (3, 7), (3, 6), (4, 5), (5, 5)],
                    [(1, 6), (2, 6), (0, 11), (3, 6), (0, 9), (0, 10)],
                    [(0, 9), (0, 10), (0, 11), (3, 6), (4, 5), (5, 5)],
                ];
                route(&mut f, &x, &maps[m]);
                let d = [7, 6, 7, 6, 5, 6, 5, 6][m];
                f[4] = signed(f[4], d);
                f[5] = signed(f[5], d);
                for a in &mut f {
                    *a <<= (m / 2) ^ 3;
                }
                e[0][..3].copy_from_slice(&[
                    f[0] - f[3],
                    f[0] - f[1] - f[3] - f[4],
                    f[0] - f[2] - f[3] - f[5],
                ]);
                e[1][..3].copy_from_slice(&[f[0], f[0] - f[1], f[0] - f[2]]);
                for p in &mut e {
                    p.swap(0, major as usize);
                }
            }
            if mode == 14 {
                e[0][3] = v[6];
                e[1][3] = v[7];
            }
            if mode == 15 {
                let m = (v[6] >> 7) | ((v[7] >> 7) << 1);
                let a = v[6] & 127;
                let b = v[7] & 127;
                if m == 3 {
                    e[0][3] = a << 5;
                    e[1][3] = b << 5;
                } else {
                    let a = (a | ((b << (m + 1)) & 0x780)) << (4 - m);
                    let delta = signed(b & (63 >> m), (6 - m) as usize) << (4 - m);
                    e[0][3] = a;
                    e[1][3] = a + delta;
                }
            }
        }
        _ => unreachable!(),
    }
    for p in &mut e {
        for c in 0..4 {
            p[c] = p[c].clamp(0, if flags[c] { 4095 } else { 255 });
        }
    }
    (e, flags)
}
fn unorm_half(v: usize) -> u16 {
    if v == 65535 {
        return 0x3c00;
    }
    if v == 0 {
        return 0;
    }
    if v < 4 {
        return (v * 256) as u16;
    }
    let high = v.ilog2() as usize;
    let exponent = high as i32 - 1;
    if exponent <= 0 {
        return (v * 256) as u16;
    }
    let mantissa = if high >= 10 {
        v >> (high - 10)
    } else {
        v << (10 - high)
    };
    ((exponent as usize) * 1024 + (mantissa & 1023)) as u16
}
fn half_value(bits: u16) -> f64 {
    if bits & 32768 != 0 {
        return 0.;
    }
    let e = (bits >> 10) & 31;
    let m = bits & 1023;
    if e == 0 {
        m as f64 * 2f64.powi(-24)
    } else {
        (1. + m as f64 / 1024.) * 2f64.powi(e as i32 - 15)
    }
}
fn rgb9(half: &[u16], raw: Option<&[usize]>, round: bool) -> u32 {
    if round {
        let v: Vec<_> = half[..3]
            .iter()
            .map(|&v| half_value(v).min(65408.))
            .collect();
        let max = v.iter().copied().fold(0., f64::max);
        let mut e = max.log2().floor().max(-16.) as i32 + 16;
        let mut scale = 2f64.powi(e - 24);
        if (max / scale + 0.5).floor() == 512. {
            e += 1;
            scale *= 2.;
        }
        return ((e as u32) << 27)
            | ((v[0] / scale + 0.5).floor() as u32)
            | ((v[1] / scale + 0.5).floor() as u32) << 9
            | ((v[2] / scale + 0.5).floor() as u32) << 18;
    }
    if let Some(raw) = raw {
        let mut rgb = [raw[0], raw[1], raw[2]];
        let mut leading =
            (rgb[0] | rgb[1] | rgb[2] | 1).leading_zeros() as usize - (usize::BITS as usize - 17);
        if rgb.contains(&65535) {
            leading = 0;
            for v in &mut rgb {
                if *v == 65535 {
                    *v = 65536;
                }
            }
        }
        return ((16 - leading) as u32) << 27
            | (((rgb[0] << leading) >> 8) & 511) as u32
            | ((((rgb[1] << leading) >> 8) & 511) as u32) << 9
            | ((((rgb[2] << leading) >> 8) & 511) as u32) << 18;
    }
    let exponents: Vec<_> = half[..3].iter().map(|v| v >> 10).collect();
    let max = *exponents.iter().max().unwrap();
    let e = if max == 0 {
        (half[0] | half[1] | half[2]) >> 9 & 1
    } else {
        max + 1
    };
    let mut out = (e as u32) << 27;
    for c in 0..3 {
        let m = (half[c] & 1023) | if exponents[c] == 0 { 0 } else { 1024 };
        let shift = if max == 0 {
            e
        } else {
            max - exponents[c].max(1) + 2
        };
        out |= ((m as u32) >> shift) << (c * 9);
    }
    out
}
pub fn pixels(block: &Block, shared: bool) -> Result<Vec<u16>> {
    if let Some(color) = block.solid {
        let values = if shared {
            let p = rgb9(&color, None, true);
            vec![p as u16, (p >> 16) as u16]
        } else {
            color.to_vec()
        };
        return Ok((0..36).flat_map(|_| values.clone()).collect());
    }
    let mut ends = Vec::new();
    let mut offset = 0;
    for &m in &block.modes {
        let count = 2 * (m / 4 + 1);
        let v: Vec<_> = block.endpoints[offset..offset + count]
            .iter()
            .map(|&v| ise::unquant(v, block.endpoint_levels, false))
            .collect();
        ends.push(endpoints(m, &v));
        offset += count;
    }
    let weights: Vec<_> = block
        .weights
        .iter()
        .map(|&v| ise::unquant(v, block.weight_levels, true))
        .collect();
    let planes = if block.dual { 2 } else { 1 };
    let mut out = Vec::with_capacity(144);
    for y in 0..6 {
        for x in 0..6 {
            let part = if block.partitions == 1 {
                0
            } else {
                partition(block.seed, x, y, block.partitions)
            };
            let (e, flags) = &ends[part];
            let mut halves = [0; 4];
            let mut raw = [0; 4];
            for c in 0..4 {
                let plane = usize::from(block.dual && c == block.channel);
                let weight = infill(
                    &weights,
                    block.width,
                    block.height,
                    x,
                    y,
                    6,
                    plane,
                    planes,
                    false,
                ) as i32;
                let scale = if flags[c] { 16 } else { 257 };
                let value = ((e[0][c] * (64 - weight) + e[1][c] * weight) * scale + 32) / 64;
                let half = if flags[c] {
                    let exponent = value >> 11;
                    let m = value & 2047;
                    let mt = if m < 512 {
                        m * 3
                    } else if m >= 1536 {
                        m * 5 - 2048
                    } else {
                        m * 4 - 512
                    };
                    ((exponent * 1024 + (mt >> 3)) as u16).min(0x7bff)
                } else {
                    unorm_half(value as usize)
                };
                halves[c] = half;
                raw[c] = value as usize;
            }
            if shared {
                let p = rgb9(&halves, if !flags[0] { Some(&raw) } else { None }, false);
                out.extend([p as u16, (p >> 16) as u16]);
            } else {
                out.extend(halves);
            }
        }
    }
    Ok(out)
}
