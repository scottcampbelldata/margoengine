use super::Bits;
use crate::{Error, Result};

#[test]
fn bit_windows_match_independent_bit_reference_at_every_alignment_and_width() {
    let bytes = [0x93, 0x6a, 0xfe, 0x10, 0x47, 0x85, 0xbc, 0x2d, 0x01];
    for length in 0..=bytes.len() {
        let input = &bytes[..length];
        for offset in 0..=length * 8 {
            for width in 0..=33 {
                let mut actual = Bits::new(input);
                for _ in 0..offset {
                    actual.read(1).unwrap();
                }
                let before = actual.used_bytes();
                let expected: Result<u32> = if width > 32 {
                    Err(Error::Invalid)
                } else if offset + width as usize > length * 8 {
                    Err(Error::Truncated)
                } else {
                    let mut value = 0;
                    for bit in 0..width as usize {
                        let at = offset + bit;
                        value |= u32::from((input[at / 8] >> (at % 8)) & 1) << bit;
                    }
                    Ok(value)
                };
                assert_eq!(actual.read(width), expected, "{length}/{offset}/{width}");
                assert_eq!(
                    actual.used_bytes(),
                    if expected.is_ok() {
                        (offset + width as usize).div_ceil(8)
                    } else {
                        before
                    }
                );
                // Read one more bit to prove exact cursor position, not only
                // the rounded byte count, including after rejected reads.
                let next = offset + if expected.is_ok() { width as usize } else { 0 };
                let expected_next = if next < length * 8 {
                    Ok(u32::from((input[next / 8] >> (next % 8)) & 1))
                } else {
                    Err(Error::Truncated)
                };
                assert_eq!(actual.read(1), expected_next);
            }
        }
    }
}
