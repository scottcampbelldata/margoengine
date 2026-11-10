//! Private owned-buffer ABI. Length-prefixed results belong to the JS caller.
use crate::{decode_mode, transcode};
#[unsafe(no_mangle)]
pub extern "C" fn hdr6_alloc(length: usize) -> *mut u8 {
    if length == 0 || length > 512 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    let mut v = Vec::<u8>::new();
    if v.try_reserve_exact(length).is_err() {
        return std::ptr::null_mut();
    }
    v.resize(length, 0);
    Box::into_raw(v.into_boxed_slice()) as *mut u8
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hdr6_free(ptr: *mut u8, length: usize) {
    if !ptr.is_null() {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                ptr, length,
            )));
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hdr6_run(
    ptr: *const u8,
    length: usize,
    width: usize,
    height: usize,
    intermediate: u32,
    pixels: u32,
) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, length) };
    let blocks = if intermediate != 0 {
        transcode(input, width, height)
    } else {
        Ok(input.to_vec())
    };
    let result = blocks.and_then(|data| {
        if pixels != 0 {
            decode_mode(&data, width, height, pixels == 2)
                .map(|v| v.into_iter().flat_map(u16::to_le_bytes).collect())
        } else {
            Ok(data)
        }
    });
    let mut out = vec![0; 8];
    match result {
        Ok(data) => out.extend(data),
        Err(error) => out[4..8].copy_from_slice(&(error as u32 + 1).to_le_bytes()),
    };
    let size = out.len();
    out[..4].copy_from_slice(&(size as u32).to_le_bytes());
    Box::into_raw(out.into_boxed_slice()) as *mut u8
}
