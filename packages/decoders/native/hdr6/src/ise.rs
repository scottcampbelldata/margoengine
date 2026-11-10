//! Independent integer-sequence implementation from Khronos Data Format 1.3,
//! sections 23.12, 23.13 and 23.17. No implementation source was consulted.
use crate::{Error, Result};

pub const LEVELS: [usize; 21] = [
    2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192, 256,
];
pub fn shape(levels: usize) -> (usize, usize) {
    let bits = levels.trailing_zeros() as usize;
    (bits, levels >> bits)
}
pub fn size(n: usize, levels: usize) -> usize {
    let (bits, radix) = shape(levels);
    n * bits
        + match radix {
            3 => (n * 8).div_ceil(5),
            5 => (n * 7).div_ceil(3),
            _ => 0,
        }
}
pub struct Bits<'a> {
    pub data: &'a [u8],
    pub at: usize,
}
impl<'a> Bits<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }
    pub fn read(&mut self, n: usize) -> Result<usize> {
        if n > 30 || self.at + n > self.data.len() * 8 {
            return Err(Error::Truncated);
        }
        let mut value = 0;
        for bit in 0..n {
            value |=
                ((self.data[(self.at + bit) / 8] >> ((self.at + bit) % 8)) as usize & 1) << bit;
        }
        self.at += n;
        Ok(value)
    }
    pub fn truncated(&mut self, n: usize) -> Result<usize> {
        let bits = n.ilog2() as usize;
        let short = (1 << (bits + 1)) - n;
        let value = self.read(bits)?;
        Ok(if value < short {
            value
        } else {
            value * 2 + self.read(1)? - short
        })
    }
}
pub fn set(data: &mut [u8], at: usize, n: usize, value: usize) {
    for b in 0..n {
        data[(at + b) / 8] |= (((value >> b) & 1) as u8) << ((at + b) % 8);
    }
}
fn trits(t: usize) -> [usize; 5] {
    let (c, t3, t4) = if (t >> 2) & 7 == 7 {
        (((t >> 5) << 2) | (t & 3), 2, 2)
    } else if (t >> 5) & 3 == 3 {
        (t & 31, (t >> 7) & 1, 2)
    } else {
        (t & 31, (t >> 5) & 3, t >> 7)
    };
    let (t0, t1, t2) = if c & 3 == 3 {
        (
            ((c >> 2) & 1) & (!c >> 3 & 1) | ((c >> 3 & 1) << 1),
            c >> 4,
            2,
        )
    } else if (c >> 2) & 3 == 3 {
        (c & 3, 2, 2)
    } else {
        (
            (c & 1) & (!c >> 1 & 1) | ((c >> 1 & 1) << 1),
            (c >> 2) & 3,
            c >> 4,
        )
    };
    [t0, t1, t2, t3, t4]
}
fn quints(q: usize) -> [usize; 3] {
    if (q >> 1) & 3 == 3 && q >> 5 == 0 {
        return [
            4,
            4,
            ((q & 1) << 2) | (((q >> 4) & 1) & (!(q & 1))) << 1 | ((q >> 3) & 1) & (!(q & 1)),
        ];
    }
    let (c, q2) = if (q >> 1) & 3 == 3 {
        (((q >> 3) & 3) << 3 | ((!(q >> 5) & 3) << 1) | (q & 1), 4)
    } else {
        (q & 31, q >> 5)
    };
    if c & 7 == 5 {
        [c >> 3, 4, q2]
    } else {
        [c & 7, c >> 3, q2]
    }
}
pub fn read(b: &mut Bits<'_>, n: usize, levels: usize, intermediate: bool) -> Result<Vec<usize>> {
    let (bits, radix) = shape(levels);
    if radix == 1 {
        return (0..n).map(|_| b.read(bits)).collect();
    }
    let group = if radix == 3 { 5 } else { 3 };
    let widths: &[usize] = if radix == 3 {
        &[2, 2, 1, 2, 1]
    } else {
        &[3, 2, 2]
    };
    let mut out = vec![0; n];
    if intermediate {
        let mut packed = Vec::new();
        for start in (0..n).step_by(group) {
            packed.push(b.read(widths[..group.min(n - start)].iter().sum())?);
        }
        for (i, value) in out.iter_mut().enumerate() {
            let high = packed[i / group] % radix;
            packed[i / group] /= radix;
            *value = b.read(bits)? | (high << bits);
        }
        if packed.iter().any(|&v| v != 0) {
            return Err(Error::Invalid);
        }
    } else {
        for start in (0..n).step_by(group) {
            let count = group.min(n - start);
            let mut packed = 0;
            let mut offset = 0;
            for i in 0..count {
                out[start + i] = b.read(bits)?;
                packed |= b.read(widths[i])? << offset;
                offset += widths[i];
            }
            let high = if radix == 3 {
                trits(packed).to_vec()
            } else {
                quints(packed).to_vec()
            };
            for i in 0..count {
                out[start + i] |= high[i] << bits;
            }
        }
    }
    if out.iter().any(|&v| v >= levels) {
        return Err(Error::Invalid);
    }
    Ok(out)
}
pub fn write(data: &mut [u8], at: usize, values: &[usize], levels: usize) -> Result<()> {
    let (bits, radix) = shape(levels);
    let mut at = at;
    if radix == 1 {
        for &v in values {
            set(data, at, bits, v);
            at += bits;
        }
        return Ok(());
    }
    let group = if radix == 3 { 5 } else { 3 };
    let widths: &[usize] = if radix == 3 {
        &[2, 2, 1, 2, 1]
    } else {
        &[3, 2, 2]
    };
    for values in values.chunks(group) {
        let count = values.len();
        let used: usize = widths[..count].iter().sum();
        let code = (0..1 << used)
            .find(|&c| {
                let high = if radix == 3 {
                    trits(c).to_vec()
                } else {
                    quints(c).to_vec()
                };
                (0..group).all(|i| high[i] == if i < count { values[i] >> bits } else { 0 })
            })
            .ok_or(Error::Invalid)?;
        let mut offset = 0;
        for (i, &v) in values.iter().enumerate() {
            set(data, at, bits, v);
            at += bits;
            set(data, at, widths[i], code >> offset);
            at += widths[i];
            offset += widths[i];
        }
    }
    Ok(())
}
fn pattern(value: usize, pattern: &str) -> usize {
    pattern.bytes().fold(0, |v, c| {
        (v << 1)
            | if c == b'0' {
                0
            } else {
                (value >> (c - b'a')) & 1
            }
    })
}
pub fn unquant(v: usize, levels: usize, weight: bool) -> usize {
    let (bits, radix) = shape(levels);
    let max = if weight { 63 } else { 255 };
    let raw = if radix == 1 {
        let mut r = 0;
        for b in 0..if weight { 6 } else { 8 } {
            r = (r << 1) | ((v >> (bits - 1 - b % bits)) & 1);
        }
        r
    } else if bits == 0 {
        if radix == 3 {
            [0, 32, 63][v]
        } else {
            [0, 16, 32, 47, 63][v]
        }
    } else {
        let (factor, p) = if weight {
            match levels {
                6 => (50, "0000000"),
                10 => (28, "0000000"),
                12 => (23, "b000b0b"),
                20 => (13, "b0000b0"),
                24 => (11, "cb000cb"),
                _ => unreachable!(),
            }
        } else {
            match levels {
                6 => (204, "000000000"),
                10 => (113, "000000000"),
                12 => (93, "b000b0bb0"),
                20 => (54, "b0000bb00"),
                24 => (44, "cb000cbcb"),
                40 => (26, "cb0000cbc"),
                48 => (22, "dcb000dcb"),
                80 => (13, "dcb0000dc"),
                96 => (11, "edcb000ed"),
                160 => (6, "edcb0000e"),
                192 => (5, "fedcb000f"),
                _ => unreachable!(),
            }
        };
        let a = if v & 1 == 1 {
            if weight { 127 } else { 511 }
        } else {
            0
        };
        (a & (max + 1) / 2) | (((v >> bits) * factor + pattern(v, p)) ^ a) >> 2
    };
    raw + usize::from(weight && raw > 32)
}
pub fn quant(v: usize, levels: usize, weight: bool, preserve: usize) -> usize {
    (0..levels)
        .filter(|&i| (unquant(i, levels, weight) ^ v) & preserve == 0)
        .min_by_key(|&i| unquant(i, levels, weight).abs_diff(v))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_integer_sequence_range_roundtrips() {
        for levels in LEVELS {
            for n in 1..=64 {
                let values: Vec<_> = (0..n).map(|i| (i * 13 + 5) % levels).collect();
                let mut bytes = vec![0; size(n, levels).div_ceil(8)];
                write(&mut bytes, 0, &values, levels).unwrap();
                assert_eq!(
                    read(&mut Bits::new(&bytes), n, levels, false).unwrap(),
                    values,
                    "{levels} {n}"
                );
            }
        }
    }
    #[test]
    fn quantization_endpoints_and_inverse() {
        for levels in LEVELS {
            for weight in [false, true] {
                if (!weight && levels < 6) || (weight && levels > 32) {
                    continue;
                }
                let vals: Vec<_> = (0..levels).map(|v| unquant(v, levels, weight)).collect();
                assert_eq!(vals.iter().min(), Some(&0));
                assert_eq!(vals.iter().max(), Some(&if weight { 64 } else { 255 }));
                for (i, &v) in vals.iter().enumerate() {
                    assert_eq!(quant(v, levels, weight, 0), i);
                }
            }
        }
    }
    #[test]
    fn partial_trit_group_has_zero_unused_digits() {
        // Independent physical block from the real HDR6 corpus: the four high
        // digits are 0,0,0,2. Code 28 decodes those but invents a fifth digit 2;
        // canonical packing of a zero-padded group uses code 64 instead.
        let mut bytes = [0u8; 4];
        write(&mut bytes, 0, &[25, 16, 8, 86], 96).unwrap();
        let mut b = Bits::new(&bytes);
        let mut code = 0;
        let mut at = 0;
        for n in [2, 2, 1, 2] {
            b.read(5).unwrap();
            code |= b.read(n).unwrap() << at;
            at += n;
        }
        assert_eq!(code, 64);
    }
}
