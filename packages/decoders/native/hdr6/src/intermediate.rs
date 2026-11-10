//! UASTC HDR 6x6i, independent implementation of Geldreich's stream specification v1.2.
use crate::{
    Error, Result,
    astc::{self, Block},
    ise::{self, Bits},
    tables,
};
fn remap(values: &[usize], from: usize, to: usize, cem: usize) -> Vec<usize> {
    if from == to {
        return values.to_vec();
    }
    let unq: Vec<_> = values
        .iter()
        .map(|&v| ise::unquant(v, from, false))
        .collect();
    let direct = cem == 11 && ((unq[4] >> 7) | (unq[5] >> 7) << 1) == 3;
    unq.into_iter()
        .enumerate()
        .map(|(i, v)| {
            let mask = if direct || (cem == 11 && i == 0) {
                0
            } else if cem == 11 && i < 4 || cem == 7 && i == 0 {
                192
            } else {
                224
            };
            ise::quant(v, to, false, mask)
        })
        .collect()
}
fn physical(logical: &Block, mode: usize, legacy: bool) -> Result<[u8; 16]> {
    if logical.solid.is_some() {
        return astc::pack(logical);
    }
    let row = tables::MODES[mode];
    let mut b = logical.clone();
    b.endpoint_levels = row[7];
    b.weight_levels = row[8];
    let count = if row[1] == 7 { 4 } else { 6 };
    b.endpoints.clear();
    for values in logical.endpoints.chunks(count) {
        b.endpoints.extend(remap(
            values,
            logical.endpoint_levels,
            b.endpoint_levels,
            row[1],
        ));
    }
    b.weights = logical
        .weights
        .iter()
        .map(|&v| {
            if logical.weight_levels == b.weight_levels {
                v
            } else {
                ise::quant(
                    ise::unquant(v, logical.weight_levels, true),
                    b.weight_levels,
                    true,
                    0,
                )
            }
        })
        .collect();
    if !b.dual && b.width == 2 && b.height == 2 {
        let weights: Vec<_> = b
            .weights
            .iter()
            .map(|&v| ise::unquant(v, b.weight_levels, true))
            .collect();
        b.weights = (0..16)
            .map(|i| {
                ise::quant(
                    astc::infill(&weights, 2, 2, i % 4, i / 4, 4, 0, 1, legacy),
                    b.weight_levels,
                    true,
                    0,
                )
            })
            .collect();
        b.width = 4;
        b.height = 4;
    }
    astc::pack(&b)
}
pub fn decode(bytes: &[u8], width: usize, height: usize) -> Result<Vec<u8>> {
    if width == 0
        || height == 0
        || width > 32768
        || height > 32768
        || width.checked_mul(height).is_none_or(|n| n > 67_108_864)
    {
        return Err(Error::Limit);
    }
    let mut bits = Bits::new(bytes);
    let version = bits.read(16)?;
    if version != 0xabcd && version != 0xabce {
        return Err(Error::Invalid);
    }
    if bits.read(16)? != width || bits.read(16)? != height {
        return Err(Error::Invalid);
    }
    let columns = width.div_ceil(6);
    let total = columns * height.div_ceil(6);
    // Only five logical rows are needed. Output blocks are separate, so a run can cross row boundaries.
    let mut history = vec![(Block::default(), 0usize); columns * 5];
    let mut out = Vec::with_capacity(total * 16);
    let mut at = 0;
    while at < total {
        let command = if bits.read(1)? != 0 {
            3
        } else if bits.read(1)? != 0 {
            2
        } else if bits.read(1)? != 0 {
            1
        } else {
            0
        };
        let x = at % columns;
        let y = at / columns;
        if command == 0 {
            if at == 0 {
                return Err(Error::Invalid);
            }
            let mut n = 0;
            let mut done = false;
            for shift in (0..30).step_by(5) {
                let packet = bits.read(6)?;
                n |= (packet & 31) << shift;
                if packet & 32 == 0 {
                    done = true;
                    break;
                }
            }
            if !done || n + 1 > total - at {
                return Err(Error::Invalid);
            }
            let previous = history[(at - 1) % history.len()].clone();
            let block: Vec<_> = out[out.len() - 16..].to_vec();
            for _ in 0..=n {
                let pos = at % history.len();
                history[pos] = previous.clone();
                out.extend(&block);
                at += 1;
            }
            continue;
        }
        let (mut b, mode) = if command == 1 {
            let mut color = [0u16; 4];
            for v in &mut color[..3] {
                *v = bits.read(15)? as u16;
                if *v >= 0x7c00 {
                    return Err(Error::Invalid);
                }
            }
            color[3] = 0x3c00;
            (
                Block {
                    solid: Some(color),
                    ..Block::default()
                },
                0,
            )
        } else if command == 2 {
            let delta = bits.read(5)?;
            let (dx, dy) = if delta < 4 {
                (-1 - delta as isize, 0)
            } else {
                (
                    3 - ((delta - 4) % 8) as isize,
                    -1 - ((delta - 4) / 8) as isize,
                )
            };
            let px = x as isize + dx;
            let py = y as isize + dy;
            if px < 0 || px >= columns as isize || py < 0 {
                return Err(Error::Invalid);
            }
            let pos = py as usize * columns + px as usize;
            if pos >= at {
                return Err(Error::Invalid);
            }
            let previous = history[pos % history.len()].clone();
            if previous.0.solid.is_some() || previous.0.partitions == 0 {
                return Err(Error::Invalid);
            }
            previous
        } else {
            let mode = bits.truncated(75)?;
            let endpoint_mode = bits.truncated(5)?;
            let row = tables::MODES[mode];
            let cem = row[1];
            let count = if cem == 7 { 4 } else { 6 };
            let mut b = Block {
                width: row[3],
                height: row[4],
                weight_levels: row[6],
                dual: row[0] != 0,
                channel: row[9],
                partitions: row[2],
                seed: 0,
                modes: vec![cem; row[2]],
                endpoint_levels: row[5],
                ..Block::default()
            };
            if endpoint_mode == 0 {
                b.seed = match b.partitions {
                    2 => tables::SEEDS2[bits.truncated(tables::SEEDS2.len())?],
                    3 => tables::SEEDS3[bits.truncated(tables::SEEDS3.len())?],
                    _ => 0,
                };
                b.endpoints = ise::read(&mut bits, count * b.partitions, b.endpoint_levels, true)?;
            } else {
                if b.partitions != 1 {
                    return Err(Error::Invalid);
                }
                let left = endpoint_mode % 2 == 1;
                if left && x == 0 || !left && y == 0 {
                    return Err(Error::Invalid);
                }
                let previous = &history[(at - if left { 1 } else { columns }) % history.len()].0;
                if previous.solid.is_some() || previous.modes.first() != Some(&cem) {
                    return Err(Error::Invalid);
                }
                if endpoint_mode < 3 {
                    b.endpoint_levels = previous.endpoint_levels;
                    b.endpoints = previous.endpoints[..count].to_vec();
                } else {
                    b.endpoints = remap(
                        &previous.endpoints[..count],
                        previous.endpoint_levels,
                        b.endpoint_levels,
                        cem,
                    );
                    let mut rank: Vec<_> = (0..b.endpoint_levels).collect();
                    rank.sort_by_key(|&v| ise::unquant(v, b.endpoint_levels, false));
                    for value in &mut b.endpoints {
                        let old = rank
                            .iter()
                            .position(|&v| v == *value)
                            .ok_or(Error::Invalid)? as isize;
                        let next = old + bits.read(5)? as isize - 16;
                        if next < 0 || next >= rank.len() as isize {
                            return Err(Error::Invalid);
                        }
                        *value = rank[next as usize];
                    }
                }
            }
            (b, mode)
        };
        if b.solid.is_none() {
            b.weights = ise::read(
                &mut bits,
                b.width * b.height * if b.dual { 2 } else { 1 },
                b.weight_levels,
                true,
            )?;
        }
        out.extend(physical(&b, mode, version == 0xabcd)?);
        let pos = at % history.len();
        history[pos] = (b, mode);
        at += 1;
    }
    if bits.read(16)? != 0xa742 || bytes.len() * 8 - bits.at > 7 {
        return Err(Error::Invalid);
    }
    if bits.read(bytes.len() * 8 - bits.at)? != 0 {
        return Err(Error::Invalid);
    }
    Ok(out)
}
