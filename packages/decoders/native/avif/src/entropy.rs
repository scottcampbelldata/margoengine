use crate::bits::Bits;
use crate::{Error, Result};

/// An ascending 15-bit cumulative distribution and the spec's saturating adaptation count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cdf {
    thresholds: Vec<u16>,
    count: u8,
}
impl Cdf {
    pub fn new(thresholds: &[u16]) -> Result<Self> {
        if !(2..=16).contains(&thresholds.len())
            || thresholds.last() != Some(&32768)
            || thresholds.windows(2).any(|pair| pair[0] > pair[1])
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            thresholds: thresholds.to_vec(),
            count: 0,
        })
    }
    pub fn thresholds(&self) -> &[u16] {
        &self.thresholds
    }
    fn adapt(&mut self, symbol: usize) {
        let n = self.thresholds.len();
        let rate = 3
            + u32::from(self.count > 15)
            + u32::from(self.count > 31)
            + (usize::BITS - 1 - n.leading_zeros()).min(2);
        for (i, value) in self.thresholds[..n - 1].iter_mut().enumerate() {
            if i < symbol {
                *value -= *value >> rate;
            } else {
                *value += (32768 - *value) >> rate;
            }
        }
        self.count = (self.count + 1).min(32);
    }
}

/// AV1's multi-symbol arithmetic reader, with bounded virtual zero padding.
/// The tile slice is its entire input. No read can borrow bytes from another tile.
pub struct Entropy<'a> {
    bits: Bits<'a>,
    data: &'a [u8],
    range: u32,
    value: u32,
    remaining: i64,
    consumed: usize,
    update: bool,
}
impl<'a> Entropy<'a> {
    pub fn new(data: &'a [u8], update: bool) -> Result<Self> {
        if data.is_empty() {
            return Err(Error::Truncated);
        }
        let mut bits = Bits::new(data);
        let count = (data.len() * 8).min(15) as u32;
        let value = 32767 ^ (bits.read(count)? << (15 - count));
        Ok(Self {
            bits,
            data,
            range: 32768,
            value,
            remaining: data.len() as i64 * 8 - 15,
            consumed: 0,
            update,
        })
    }
    fn symbol(&mut self, cdf: &[u16]) -> Result<usize> {
        let n = cdf.len();
        let mut upper = self.range;
        let mut selected = None;
        for (symbol, threshold) in cdf.iter().enumerate() {
            let lower = ((self.range >> 8) * ((32768 - *threshold as u32) >> 6) >> 1)
                + 4 * (n - symbol - 1) as u32;
            if self.value >= lower {
                self.value -= lower;
                self.range = upper - lower;
                selected = Some(symbol);
                break;
            }
            upper = lower;
        }
        let symbol = selected.ok_or(Error::Invalid)?;
        let shift = self.range.leading_zeros() - 16;
        let count = shift.min(self.remaining.max(0) as u32);
        let incoming = self.bits.read(count)? << (shift - count);
        self.range <<= shift;
        self.value = incoming ^ (((self.value + 1) << shift) - 1);
        self.remaining -= shift as i64;
        self.consumed += shift as usize;
        if self.remaining < -14 {
            return Err(Error::Truncated);
        }
        Ok(symbol)
    }
    pub fn read(&mut self, cdf: &mut Cdf) -> Result<usize> {
        let symbol = self.symbol(&cdf.thresholds)?;
        if self.update {
            cdf.adapt(symbol);
        }
        Ok(symbol)
    }
    pub fn flag(&mut self) -> Result<bool> {
        Ok(self.symbol(&[16384, 32768])? != 0)
    }
    pub fn literal(&mut self, count: u32) -> Result<u32> {
        if count > 32 {
            return Err(Error::Invalid);
        }
        let mut value = 0;
        for _ in 0..count {
            value = value * 2 + u32::from(self.flag()?);
        }
        Ok(value)
    }
    pub fn ns(&mut self, n: u32) -> Result<u32> {
        if n == 0 {
            return Err(Error::Invalid);
        }
        let width = 32 - n.leading_zeros();
        let cutoff = (1_u64 << width) - n as u64;
        let value = self.literal(width - 1)?;
        if (value as u64) < cutoff {
            Ok(value)
        } else {
            Ok((value as u64 * 2 - cutoff + u64::from(self.flag()?)) as u32)
        }
    }
    pub fn golomb(&mut self) -> Result<u32> {
        let mut leading = 0;
        while !self.flag()? {
            leading += 1;
            if leading > 20 {
                return Err(Error::Invalid);
            }
        }
        Ok((1 << leading) - 1 + self.literal(leading)?)
    }
    pub fn subexp(&mut self, symbols: u32, k: u32) -> Result<u32> {
        if symbols == 0 || symbols > 65536 || k > 16 {
            return Err(Error::Invalid);
        }
        let mut i = 0;
        let mut consumed = 0;
        loop {
            let bits = if i == 0 { k } else { k + i - 1 };
            if bits > 16 {
                return Err(Error::Invalid);
            }
            let count = 1 << bits;
            if symbols <= consumed + 3 * count {
                return Ok(consumed + self.ns(symbols - consumed)?);
            }
            if !self.flag()? {
                return Ok(consumed + self.literal(bits)?);
            }
            consumed += count;
            i += 1;
        }
    }
    pub fn signed_subexp(&mut self, low: i32, high: i32, k: u32, reference: i32) -> Result<i32> {
        if high <= low || reference < low || reference >= high {
            return Err(Error::Invalid);
        }
        let count = (high as i64 - low as i64) as u32;
        let value = self.subexp(count, k)?;
        let mut origin = (reference - low) as u32;
        let flipped = origin * 2 > count;
        if flipped {
            origin = count - 1 - origin;
        }
        let recentered = if value > 2 * origin {
            value
        } else if value & 1 != 0 {
            origin - value.div_ceil(2)
        } else {
            origin + value / 2
        };
        Ok(low
            + if flipped {
                (count - 1 - recentered) as i32
            } else {
                recentered as i32
            })
    }
    pub fn finish(&self) -> Result<()> {
        let pos = self.consumed;
        if pos >= self.data.len() * 8 {
            return Err(Error::Truncated);
        }
        let mask = 0x80 >> (pos & 7);
        let byte = self.data[pos >> 3];
        if byte & mask == 0
            || byte & (mask - 1) != 0
            || self.data[(pos >> 3) + 1..].iter().any(|value| *value != 0)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boolean_codewords_and_termination() {
        // Minimum-probability rounding makes the zero interval slightly smaller than half.
        for (byte, expected) in [(0x20, false), (0xc0, true)] {
            let bytes = [byte];
            let mut e = Entropy::new(&bytes, false).unwrap();
            assert_eq!(e.flag(), Ok(expected));
            assert_eq!(e.finish(), Ok(()));
        }
        let bytes = [0x80];
        let mut e = Entropy::new(&bytes, false).unwrap();
        assert_eq!(e.finish(), Ok(()));
        assert_eq!(e.flag(), Ok(true));
        assert_eq!(e.finish(), Err(Error::Invalid));
    }
    #[test]
    fn initial_symbol_intervals_cover_every_15_bit_codeword() {
        // Independently enumerate each integer code interval at initialization.
        let thresholds = [8192, 16384, 24576, 32768];
        let boundaries = [0, 8180, 16376, 24572, 32768];
        for code in 0_u32..32768 {
            let bytes = (code as u16 * 2).to_be_bytes();
            let expected = boundaries
                .windows(2)
                .position(|b| b[0] <= code && code < b[1])
                .unwrap();
            let mut e = Entropy::new(&bytes, false).unwrap();
            assert_eq!(e.read(&mut Cdf::new(&thresholds).unwrap()), Ok(expected));
        }
    }
    #[test]
    fn adaptation_count_saturates_and_can_be_disabled() {
        let mut cdf = Cdf::new(&[8192, 16384, 24576, 32768]).unwrap();
        let bytes = [0; 128];
        let mut e = Entropy::new(&bytes, true).unwrap();
        e.read(&mut cdf).unwrap();
        assert_eq!(cdf.thresholds(), &[8960, 16896, 24832, 32768]);
        for _ in 0..40 {
            e.read(&mut cdf).unwrap();
        }
        assert_eq!(cdf.count, 32);
        let frozen = cdf.clone();
        let mut e = Entropy::new(&bytes, false).unwrap();
        for _ in 0..20 {
            e.read(&mut cdf).unwrap();
        }
        assert_eq!(cdf, frozen);
    }
    #[test]
    fn padding_cannot_conceal_truncation_or_termination_errors() {
        assert!(matches!(Entropy::new(&[], true), Err(Error::Truncated)));
        let bytes = [0];
        let mut e = Entropy::new(&bytes, false).unwrap();
        assert_eq!(e.literal(7), Ok(0));
        assert_eq!(e.flag(), Err(Error::Truncated));
        assert_eq!(
            Entropy::new(&[0x80, 0, 1], false).unwrap().finish(),
            Err(Error::Invalid)
        );
        assert!(Cdf::new(&[30000, 10000, 32768]).is_err());
        assert!(Cdf::new(&[1, 2]).is_err());
    }
}
