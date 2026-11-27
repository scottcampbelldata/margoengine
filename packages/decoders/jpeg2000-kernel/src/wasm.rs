//! The Wasm interface: one input buffer in, one owned result out. A result is six little-endian 32-bit words (its length
//! in bytes, an error code, width, height, depth and the truncated flag) followed, when the code is 0, by width x height
//! RGBA samples of depth / 8 bytes each. The error codes are `Error::code`.
use crate::{Error, Result, decode, jp2};

/// The bytes before a result's samples.
const HEADER: usize = 24;
/// The largest input accepted.
const MAX_INPUT: usize = 1 << 30;

/// An input buffer of `length` bytes for the caller to fill, or null when it cannot be held.
#[unsafe(no_mangle)]
pub extern "C" fn jpeg2000_alloc(length: usize) -> *mut u8 {
    if length == 0 || length > MAX_INPUT {
        return std::ptr::null_mut();
    }
    let mut data = Vec::new();
    if data.try_reserve_exact(length).is_err() {
        return std::ptr::null_mut();
    }
    data.resize(length, 0u8);
    Box::into_raw(data.into_boxed_slice()) as *mut u8
}

/// Releases an input buffer or a result of `length` bytes.
///
/// # Safety
/// `pointer` is null, or came from this module with that length and has not been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jpeg2000_free(pointer: *mut u8, length: usize) {
    if !pointer.is_null() {
        // SAFETY: the caller passes a boxed slice of this length that this module leaked.
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length)) });
    }
}

/// Decodes a JP2 file or a raw codestream and returns its result.
///
/// # Safety
/// `pointer` and `length` name an input buffer of this module.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jpeg2000_decode(
    pointer: *const u8,
    length: usize,
    reduce: u32,
    layers: u32,
    depth: u32,
    max_pixels: u32,
) -> *mut u8 {
    // SAFETY: the caller passes a live input buffer.
    let input = unsafe { std::slice::from_raw_parts(pointer, length) };
    let out = result(run(input, reduce, layers, depth, max_pixels));
    Box::into_raw(out.into_boxed_slice()) as *mut u8
}

/// The picture and whether its stream was cut short.
fn run(input: &[u8], reduce: u32, layers: u32, depth: u32, max_pixels: u32) -> Result<(jp2::Rgba, bool)> {
    if depth != 8 && depth != 16 {
        return Err(Error::Invalid);
    }
    let file = if jp2::is_jp2(input) { Some(jp2::parse(input)?) } else { None };
    let stream = match &file {
        Some(f) => &input[f.codestream.clone()],
        None => input,
    };
    let opts = decode::Options {
        reduce,
        layers,
        // RGBA's four samples for every pixel allowed.
        max_samples: max_pixels as u64 * 4,
        max_pixels: max_pixels as u64,
    };
    let image = decode::decode(stream, &opts)?;
    Ok((jp2::rgba(&image, file.as_ref(), depth)?, image.truncated))
}

/// A decode's outcome as the bytes the caller reads.
fn result(outcome: Result<(jp2::Rgba, bool)>) -> Vec<u8> {
    let (words, samples): ([u32; 5], &[u16]) = match &outcome {
        Ok((rgba, truncated)) => ([0, rgba.width, rgba.height, rgba.depth, u32::from(*truncated)], &rgba.data),
        Err(error) => ([error.code(), 0, 0, 0, 0], &[]),
    };
    let wide = words[3] == 16;
    let length = HEADER + samples.len() * if wide { 2 } else { 1 };
    let mut out = Vec::with_capacity(length);
    out.extend_from_slice(&(length as u32).to_le_bytes());
    for word in words {
        out.extend_from_slice(&word.to_le_bytes());
    }
    if wide {
        out.extend(samples.iter().flat_map(|s| s.to_le_bytes()));
    } else {
        out.extend(samples.iter().map(|&s| s as u8));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codestream::tests::{Writer, cod, siz};

    /// A 3 x 2 grey codestream of 8 bits whose one packet is empty: every sample is mid grey.
    fn grey() -> Vec<u8> {
        let mut b = Writer(Vec::new());
        b.marker(0xff4f);
        b.segment(0xff51, &siz(3, 2, 3, 2, &[(8, false, 1, 1)]));
        b.segment(0xff52, &cod(0, 1, 0, 0, true, None));
        b.segment(0xff5c, &[0x20, 8 << 3]);
        let mut sot = vec![0, 0];
        sot.extend_from_slice(&15u32.to_be_bytes());
        sot.extend_from_slice(&[0, 1]);
        b.segment(0xff90, &sot);
        b.marker(0xff93);
        b.0.push(0);
        b.marker(0xffd9);
        b.0
    }

    /// Calls the exported functions as a host does and returns the result's bytes.
    fn call(input: &[u8], reduce: u32, depth: u32, max_pixels: u32) -> Vec<u8> {
        let pointer = jpeg2000_alloc(input.len());
        assert!(!pointer.is_null());
        // SAFETY: the buffer was just allocated with the input's length, and the result's first word is its length.
        unsafe {
            std::ptr::copy_nonoverlapping(input.as_ptr(), pointer, input.len());
            let out = jpeg2000_decode(pointer, input.len(), reduce, 0, depth, max_pixels);
            let length = u32::from_le_bytes(std::slice::from_raw_parts(out, 4).try_into().unwrap()) as usize;
            let bytes = std::slice::from_raw_parts(out, length).to_vec();
            jpeg2000_free(pointer, input.len());
            jpeg2000_free(out, length);
            bytes
        }
    }

    fn words(bytes: &[u8]) -> Vec<u32> {
        bytes[..HEADER].chunks_exact(4).map(|w| u32::from_le_bytes(w.try_into().unwrap())).collect()
    }

    #[test]
    fn a_picture_comes_back_at_each_depth() {
        let out = call(&grey(), 0, 8, 6);
        assert_eq!(words(&out), vec![48, 0, 3, 2, 8, 0]);
        assert_eq!(out[HEADER..], [128, 128, 128, 255].repeat(6));
        let out = call(&grey(), 0, 16, 6);
        assert_eq!(words(&out), vec![72, 0, 3, 2, 16, 0]);
        // 128 of 255 spread over 16 bits.
        assert_eq!(out[HEADER..HEADER + 8], [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0xff, 0xff]);
    }

    #[test]
    fn a_jp2_file_is_unwrapped() {
        let bx = |kind: &[u8; 4], body: &[u8]| {
            let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            b.extend_from_slice(kind);
            b.extend_from_slice(body);
            b
        };
        let mut file = bx(b"jP  ", &[0x0d, 0x0a, 0x87, 0x0a]);
        file.extend(bx(b"ftyp", b"jp2 \0\0\0\0jp2 "));
        let mut header = bx(b"ihdr", &[0, 0, 0, 2, 0, 0, 0, 3, 0, 1, 7, 7, 0, 0]);
        header.extend(bx(b"colr", &[1, 0, 0, 0, 0, 0, 17]));
        file.extend(bx(b"jp2h", &header));
        file.extend(bx(b"jp2c", &grey()));
        assert_eq!(call(&file, 0, 8, 6), call(&grey(), 0, 8, 6));
    }

    #[test]
    fn failures_return_their_codes_and_no_samples() {
        let code = |bytes: Vec<u8>| {
            assert_eq!(bytes.len(), HEADER);
            words(&bytes)[1]
        };
        assert_eq!(code(call(&grey()[..10], 0, 8, 6)), Error::Truncated.code());
        assert_eq!(code(call(b"not a picture", 0, 8, 6)), Error::Invalid.code());
        assert_eq!(code(call(&grey(), 1, 8, 6)), Error::Invalid.code());
        assert_eq!(code(call(&grey(), 0, 12, 6)), Error::Invalid.code());
        assert_eq!(code(call(&grey(), 0, 8, 5)), Error::Limit.code());
    }

    #[test]
    fn empty_and_oversized_inputs_are_not_allocated() {
        assert!(jpeg2000_alloc(0).is_null());
        assert!(jpeg2000_alloc(MAX_INPUT + 1).is_null());
    }
}
