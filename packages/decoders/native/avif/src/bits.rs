use crate::{Error, Result};

/// MSB-first AV1 syntax reader. Arithmetic-coded tiles use the separate entropy reader.
#[derive(Clone)]
pub struct Bits<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Bits<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }
    pub fn position(&self) -> usize {
        self.position
    }
    pub fn remaining(&self) -> usize {
        self.bytes.len() * 8 - self.position
    }
    pub fn read(&mut self, count: u32) -> Result<u32> {
        if count > 32 {
            return Err(Error::Invalid);
        }
        if count as usize > self.remaining() {
            return Err(Error::Truncated);
        }
        let mut value = 0;
        let stop = self.position + count as usize;
        while self.position < stop {
            let offset = self.position & 7;
            let take = (stop - self.position).min(8 - offset);
            let shift = 8 - offset - take;
            value = (value << take)
                | ((self.bytes[self.position >> 3] as u32 >> shift) & ((1 << take) - 1));
            self.position += take;
        }
        Ok(value)
    }
    pub fn flag(&mut self) -> Result<bool> {
        Ok(self.read(1)? != 0)
    }
    pub fn signed(&mut self, count: u32) -> Result<i32> {
        if count == 0 || count > 32 {
            return Err(Error::Invalid);
        }
        let value = self.read(count)?;
        Ok(((value as i64) - (((value >> (count - 1)) as i64) << count)) as i32)
    }
    pub fn uvlc(&mut self) -> Result<u32> {
        let mut leading = 0;
        while !self.flag()? {
            leading += 1;
            if leading == 32 {
                return Ok(u32::MAX);
            }
        }
        Ok(((1_u64 << leading) - 1 + self.read(leading)? as u64) as u32)
    }
    /// Non-symmetric unsigned integer in 0..n, including the zero-bit n=1 case.
    pub fn ns(&mut self, n: u32) -> Result<u32> {
        if n == 0 {
            return Err(Error::Invalid);
        }
        let width = 32 - n.leading_zeros();
        let cutoff = (1_u64 << width) - n as u64;
        let value = self.read(width - 1)?;
        if (value as u64) < cutoff {
            Ok(value)
        } else {
            Ok(((value as u64 * 2) - cutoff + self.read(1)? as u64) as u32)
        }
    }
    pub fn align(&mut self) -> Result<()> {
        let count = (8 - self.position % 8) % 8;
        if self.read(count as u32)? != 0 {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    pub fn trailing(&mut self) -> Result<()> {
        if !self.flag()? {
            return Err(Error::Invalid);
        }
        while self.remaining() > 0 {
            let count = self.remaining().min(32) as u32;
            if self.read(count)? != 0 {
                return Err(Error::Invalid);
            }
        }
        Ok(())
    }
}

/// AV1's eight-byte LEB128 permits non-minimal encodings but only 32-bit values.
pub fn leb128(bytes: &[u8], at: &mut usize) -> Result<u32> {
    let mut value = 0_u64;
    for shift in (0..56).step_by(7) {
        let byte = *bytes.get(*at).ok_or(Error::Truncated)?;
        *at += 1;
        value |= ((byte & 127) as u64) << shift;
        if byte & 128 == 0 {
            return u32::try_from(value).map_err(|_| Error::Invalid);
        }
    }
    Err(Error::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crossing_bytes_and_signed_extremes() {
        let mut b = Bits::new(&[0xb6, 0x17, 0xff, 0xff, 0xff, 0xff]);
        assert_eq!(b.read(3), Ok(5));
        assert_eq!(b.read(9), Ok(353));
        assert_eq!(b.read(4), Ok(7));
        assert_eq!(b.signed(32), Ok(-1));
        assert_eq!(b.read(1), Err(Error::Truncated));
        assert_eq!(Bits::new(&[0x80, 0, 0, 0]).signed(32), Ok(i32::MIN));
    }
    #[test]
    fn leb128_limits_and_nonminimal_encodings() {
        for (bytes, expected) in [
            (vec![0], Ok(0)),
            (vec![0x80, 0], Ok(0)),
            (vec![0xff, 0xff, 0xff, 0xff, 0x0f], Ok(u32::MAX)),
            (vec![0xff, 0xff, 0xff, 0xff, 0x10], Err(Error::Invalid)),
            (vec![0x80; 8], Err(Error::Invalid)),
            (vec![0x80], Err(Error::Truncated)),
            (vec![0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0], Ok(0)),
        ] {
            assert_eq!(leb128(&bytes, &mut 0), expected);
        }
    }
    #[test]
    fn nonsymmetric_all_codewords() {
        for n in 1_u32..=257 {
            let width = 32 - n.leading_zeros();
            let cutoff = (1 << width) - n;
            for expected in 0..n {
                let (value, count) = if expected < cutoff {
                    (expected, width - 1)
                } else {
                    (expected + cutoff, width)
                };
                let bytes = ((value as u64) << (32 - count)).to_be_bytes();
                let bytes = &bytes[4..];
                let mut bits = Bits::new(bytes);
                assert_eq!(bits.ns(n), Ok(expected));
                assert_eq!(bits.position(), count as usize);
            }
        }
    }
    #[test]
    fn alignment_and_trailing_bits_are_validated() {
        let mut b = Bits::new(&[0xa0]);
        b.read(3).unwrap();
        assert_eq!(b.align(), Ok(()));
        assert_eq!(Bits::new(&[0x80, 0, 0]).trailing(), Ok(()));
        assert_eq!(Bits::new(&[0x80, 1]).trailing(), Err(Error::Invalid));
        assert_eq!(Bits::new(&[0]).trailing(), Err(Error::Invalid));
    }
}
