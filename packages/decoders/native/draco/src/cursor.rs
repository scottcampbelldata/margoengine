use crate::{Error, Result};

pub(crate) struct Cursor<'a> {
    pub data: &'a [u8],
    pub at: usize,
    pub version: u16,
}
impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            at: 0,
            version: 0x202,
        }
    }
    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or(Error::Overflow)?;
        let out = self.data.get(self.at..end).ok_or(Error::Truncated)?;
        self.at = end;
        Ok(out)
    }
    pub fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    pub fn le(&mut self, n: usize) -> Result<u32> {
        if !(1..=4).contains(&n) {
            return Err(Error::Invalid);
        }
        let mut value = 0;
        for (i, b) in self.take(n)?.iter().enumerate() {
            value |= u32::from(*b) << (i * 8);
        }
        Ok(value)
    }
    pub fn float(&mut self) -> Result<f32> {
        Ok(f32::from_bits(self.le(4)?))
    }
    pub fn var(&mut self, bits: u32) -> Result<u64> {
        if bits == 0 || bits > 64 {
            return Err(Error::Invalid);
        }
        let mut value = 0_u64;
        for shift in (0..bits).step_by(7) {
            let b = self.byte()?;
            let payload = u64::from(b & 127);
            if payload > (u64::MAX >> shift)
                || (bits < 64 && payload > (((1_u64 << bits) - 1) >> shift))
            {
                return Err(Error::Overflow);
            }
            value |= payload << shift;
            if b & 128 == 0 {
                return Ok(value);
            }
        }
        Err(Error::Overflow)
    }
    pub fn count(&mut self) -> Result<usize> {
        usize::try_from(self.var(32)?).map_err(|_| Error::Overflow)
    }
    pub fn legacy_count(&mut self) -> Result<usize> {
        if self.version < 0x200 {
            Ok(self.le(4)? as usize)
        } else {
            self.count()
        }
    }
    pub fn blob(&mut self, bits: u32) -> Result<&'a [u8]> {
        let n = usize::try_from(self.var(bits)?).map_err(|_| Error::Overflow)?;
        self.take(n)
    }
    pub fn fixed_blob(&mut self, bits: u32) -> Result<&'a [u8]> {
        if bits != 32 && bits != 64 {
            return Err(Error::Invalid);
        }
        let mut n = 0_u64;
        for (i, b) in self.take(bits as usize / 8)?.iter().enumerate() {
            n |= u64::from(*b) << (i * 8);
        }
        self.take(usize::try_from(n).map_err(|_| Error::Overflow)?)
    }
}

/// E1: low-bit-first, one continuous stream until the entire tagged payload ends.
pub(crate) struct Bits<'a> {
    data: &'a [u8],
    bit: usize,
}
impl<'a> Bits<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, bit: 0 }
    }
    pub fn read(&mut self, width: u32) -> Result<u32> {
        if width > 32 {
            return Err(Error::Invalid);
        }
        let end = self
            .bit
            .checked_add(width as usize)
            .ok_or(Error::Overflow)?;
        if end > self.data.len().checked_mul(8).ok_or(Error::Overflow)? {
            return Err(Error::Truncated);
        }
        if width == 0 {
            return Ok(0);
        }
        // A 32-bit value spans at most five bytes. Load each source byte once
        // instead of revisiting it for every bit; keep the cursor unchanged on
        // failure, including a final partial byte.
        let first = self.bit / 8;
        let mut value = 0_u64;
        for (i, byte) in self.data[first..end.div_ceil(8)].iter().enumerate() {
            value |= u64::from(*byte) << (i * 8);
        }
        value >>= self.bit % 8;
        self.bit = end;
        Ok(value as u32 & (u32::MAX >> (32 - width)))
    }
    pub fn used_bytes(&self) -> usize {
        self.bit.div_ceil(8)
    }
}

#[cfg(test)]
#[path = "bits.test.rs"]
mod tests;
