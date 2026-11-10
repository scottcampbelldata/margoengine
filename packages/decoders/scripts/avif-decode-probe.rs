//! Test-only Wasm raw-plane ABI for independent YUV digests. Never shipped.
#[path = "../native/avif/src/lib.rs"]
mod implementation;
pub use implementation::*;
#[unsafe(no_mangle)]
pub extern "C" fn probe_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; length].into_boxed_slice()) as *mut u8
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn probe_free(pointer: *mut u8, length: usize) {
    unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length))); }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn probe_run(pointer: *const u8, length: usize) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(pointer, length) };
    let mut result = vec![0u8; 8];
    match container::File::parse(input).and_then(|file| file.item_data(file.primary, input.len())).and_then(|bytes| decode::obus(&bytes, 1 << 26)) {
        Ok(decoded) => {
            for plane in decoded.planes { for value in plane.data {
                if decoded.sequence.color.depth == 8 { result.push(value as u8); }
                else { result.extend_from_slice(&value.to_le_bytes()); }
            } }
        }
        Err(error) => result[4..8].copy_from_slice(&(error as u32 + 1).to_le_bytes()),
    }
    let length = result.len() as u32;
    result[..4].copy_from_slice(&length.to_le_bytes());
    Box::into_raw(result.into_boxed_slice()) as *mut u8
}
