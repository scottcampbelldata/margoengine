use crate::bits::leb128;
use crate::{Error, Result};

#[derive(Debug)]
pub struct Obu<'a> {
    pub kind: u8,
    pub temporal_id: u8,
    pub spatial_id: u8,
    pub payload: &'a [u8],
}

/// Iterate low-overhead OBUs without copying or trusting an advertised allocation size.
pub struct Obus<'a> {
    data: &'a [u8],
    position: usize,
    failed: bool,
    sample: bool,
}
impl<'a> Obus<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            position: 0,
            failed: false,
            sample: false,
        }
    }
    /// ISOBMFF samples may omit the final OBU size; configOBUs may not.
    pub fn sample(data: &'a [u8]) -> Self {
        Self {
            sample: true,
            ..Self::new(data)
        }
    }
    fn read(&mut self) -> Result<Obu<'a>> {
        let header = self.data[self.position];
        self.position += 1;
        if header & 0x81 != 0 || (header & 2 == 0 && !self.sample) {
            return Err(Error::Invalid);
        }
        let mut temporal_id = 0;
        let mut spatial_id = 0;
        if header & 4 != 0 {
            let extension = *self.data.get(self.position).ok_or(Error::Truncated)?;
            self.position += 1;
            if extension & 7 != 0 {
                return Err(Error::Invalid);
            }
            temporal_id = extension >> 5;
            spatial_id = (extension >> 3) & 3;
        }
        let size = if header & 2 != 0 {
            leb128(self.data, &mut self.position)? as usize
        } else {
            self.data.len() - self.position
        };
        let end = self.position.checked_add(size).ok_or(Error::Limit)?;
        let payload = self.data.get(self.position..end).ok_or(Error::Truncated)?;
        self.position = end;
        Ok(Obu {
            kind: (header >> 3) & 15,
            temporal_id,
            spatial_id,
            payload,
        })
    }
}
impl<'a> Iterator for Obus<'a> {
    type Item = Result<Obu<'a>>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.position == self.data.len() {
            return None;
        }
        let result = self.read();
        self.failed = result.is_err();
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsized_sample_obu_consumes_the_remainder_once() {
        for bytes in [
            &[0x12, 0, 0x78, 0x12, 0][..],
            &[0x12, 0, 0x7c, 0x48, 0x12, 0],
        ] {
            let all = Obus::sample(bytes).collect::<Result<Vec<_>>>().unwrap();
            assert_eq!(all.len(), 2);
            assert_eq!(all[1].kind, 15);
            assert_eq!(all[1].payload, &[0x12, 0]);
        }
        assert_eq!(Obus::sample(&[0x10]).next().unwrap().unwrap().payload, &[]);
        assert!(matches!(
            Obus::sample(&[0x7c]).next().unwrap(),
            Err(Error::Truncated)
        ));
        assert!(matches!(
            Obus::sample(&[0x7a, 3, 0]).next().unwrap(),
            Err(Error::Truncated)
        ));
    }
    #[test]
    fn payload_and_extension_boundaries() {
        let bytes = [0x12, 0, 0x2e, 0x48, 2, 0x11, 0x80];
        let all = Obus::new(&bytes).collect::<Result<Vec<_>>>().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].kind, 2);
        assert_eq!(all[1].temporal_id, 2);
        assert_eq!(all[1].spatial_id, 1);
        assert_eq!(all[1].payload, &[0x11, 0x80]);
        for bytes in [&[0x82][..], &[0x08], &[0x0e], &[0x0e, 1, 0], &[0x0a, 5, 0]] {
            let mut obus = Obus::new(bytes);
            assert!(obus.next().unwrap().is_err());
            assert!(obus.next().is_none());
        }
    }
}
