//! Inverse of the published Draco 2.2 symbol/ANS decoding equations.
//! No implementation source was consulted.

pub fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        out.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    out.push(value as u8);
}

fn frequencies(values: &[u32], alphabet: usize, precision: u32) -> Vec<u32> {
    let mut counts = vec![0u64; alphabet];
    for &value in values {
        counts[value as usize] += 1;
    }
    let total = values.len().max(1) as u64;
    let mut probabilities: Vec<u32> = counts
        .iter()
        .map(|&n| {
            if n == 0 {
                0
            } else {
                ((n * precision as u64 + total / 2) / total).max(1) as u32
            }
        })
        .collect();
    let mut sum: i64 = probabilities.iter().map(|&p| p as i64).sum();
    // Allocate rounding error to frequent symbols, preserving every observed symbol.
    let mut order: Vec<usize> = (0..alphabet).filter(|&i| counts[i] != 0).collect();
    order.sort_unstable_by(|&a, &b| counts[b].cmp(&counts[a]).then(a.cmp(&b)));
    while sum != precision as i64 {
        for &i in &order {
            if sum == precision as i64 {
                break;
            }
            if sum < precision as i64 {
                probabilities[i] += 1;
                sum += 1;
            } else if probabilities[i] > 1 {
                probabilities[i] -= 1;
                sum -= 1;
            }
        }
    }
    probabilities
}

fn table(out: &mut Vec<u8>, probabilities: &[u32]) {
    varint(out, probabilities.len() as u64);
    let mut i = 0;
    while i < probabilities.len() {
        let p = probabilities[i];
        if p == 0 {
            let mut run = 1;
            while run < 64 && i + run < probabilities.len() && probabilities[i + run] == 0 {
                run += 1;
            }
            out.push((((run - 1) << 2) | 3) as u8);
            i += run;
        } else {
            let extra = if p < 64 {
                0
            } else if p < 16384 {
                1
            } else {
                2
            };
            out.push(((p & 63) << 2) as u8 | extra);
            for b in 0..extra {
                out.push((p >> (6 + b as u32 * 8)) as u8);
            }
            i += 1;
        }
    }
}

fn state_end(out: &mut Vec<u8>, state: u32, base: u32) {
    let value = state - base;
    let bytes = if value < 1 << 6 {
        1
    } else if value < 1 << 14 {
        2
    } else if value < 1 << 22 {
        3
    } else {
        4
    };
    for i in 0..bytes {
        out.push((value >> (i * 8)) as u8);
    }
    *out.last_mut().unwrap() |= (bytes - 1) << 6;
}

fn ans(values: &[u32], probabilities: &[u32], precision: u32) -> Vec<u8> {
    let base = precision * 4;
    let mut cumulative = Vec::with_capacity(probabilities.len());
    let mut sum = 0;
    for &p in probabilities {
        cumulative.push(sum);
        sum += p;
    }
    let mut state = base;
    let mut out = Vec::new();
    for &symbol in values.iter().rev() {
        let p = probabilities[symbol as usize];
        while state as u64 >= 1024 * p as u64 {
            out.push(state as u8);
            state >>= 8;
        }
        state = (state / p) * precision + state % p + cumulative[symbol as usize];
    }
    state_end(&mut out, state, base);
    out
}

fn tagged(values: &[u32], components: usize) -> Vec<u8> {
    let tags: Vec<u32> = values
        .chunks(components)
        .map(|row| (32 - row.iter().copied().max().unwrap_or(0).leading_zeros()).max(1))
        .collect();
    let probabilities = frequencies(
        &tags,
        tags.iter().copied().max().unwrap_or(0) as usize + 1,
        4096,
    );
    let encoded = ans(&tags, &probabilities, 4096);
    let mut out = vec![0];
    table(&mut out, &probabilities);
    varint(&mut out, encoded.len() as u64);
    out.extend(encoded);
    let mut bits = 0u64;
    let mut count = 0;
    for (row, &tag) in values.chunks(components).zip(&tags) {
        for &value in row {
            bits |= (value as u64) << count;
            count += tag;
            while count >= 8 {
                out.push(bits as u8);
                bits >>= 8;
                count -= 8;
            }
        }
    }
    if count > 0 {
        out.push(bits as u8);
    }
    out
}

fn raw(values: &[u32], max: u32) -> Vec<u8> {
    let bit_length = (32 - max.leading_zeros()).max(1);
    let precision = 1 << ((3 * bit_length / 2).clamp(12, 20));
    let probabilities = frequencies(values, max as usize + 1, precision);
    let encoded = ans(values, &probabilities, precision);
    let mut out = vec![1, bit_length as u8];
    table(&mut out, &probabilities);
    varint(&mut out, encoded.len() as u64);
    out.extend(encoded);
    out
}

pub fn symbols(values: &[u32], components: usize) -> Vec<u8> {
    if values.is_empty() {
        return Vec::new();
    }
    let tagged = tagged(values, components);
    let max = values.iter().copied().max().unwrap();
    // A sparse 32-bit alphabet must not allocate a table proportional to its range.
    if max >= 1 << 20 {
        return tagged;
    }
    let raw = raw(values, max);
    if raw.len() < tagged.len() {
        raw
    } else {
        tagged
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_high_precision_residuals_can_use_raw_ans() {
        // High quantization precision does not imply a high-entropy alphabet.
        // An isolated 18-bit correction must not force every zero into tagged bits.
        let mut values = vec![0; 100_000];
        values[500] = 131_071;
        let encoded = symbols(&values, 1);
        assert_eq!(encoded[0], 1);
        assert!(encoded.len() < tagged(&values, 1).len());
        assert_eq!(symbols(&[u32::MAX, 0], 1)[0], 0);
    }
    #[test]
    fn inverse_ans_equations_recover_symbols() {
        for values in [
            vec![0; 1000],
            (0..16000).map(|i| (i * i % 59) as u32).collect(),
        ] {
            let probs = frequencies(&values, 60, 4096);
            let bytes = ans(&values, &probs, 4096);
            let n = (bytes[bytes.len() - 1] >> 6) as usize + 1;
            let mut offset = bytes.len() - n;
            let mut state = 0;
            for i in 0..n {
                state |= (bytes[offset + i] as u32) << (i * 8);
            }
            state &= (1u32 << (n * 8 - 2)) - 1;
            state += 16384;
            for expected in values {
                while state < 16384 {
                    offset -= 1;
                    state = state * 256 + bytes[offset] as u32;
                }
                let rem = state % 4096;
                let mut cum = 0;
                let symbol = probs
                    .iter()
                    .position(|&p| {
                        if rem < cum + p {
                            true
                        } else {
                            cum += p;
                            false
                        }
                    })
                    .unwrap();
                assert_eq!(symbol as u32, expected);
                state = (state / 4096) * probs[symbol] + rem - cum;
            }
            assert_eq!(state, 16384);
            assert_eq!(offset, 0);
        }
    }
}
