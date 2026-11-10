//! Standalone scalar/SIMD contract probe. Not included in the distributed decoder.
#[path = "../native/avif/src/lib.rs"]
mod implementation;
pub use implementation::*;

fn transform_type(value: u32) -> Option<transform::Tx> {
    use transform::Tx::*;
    [DctDct, AdstDct, DctAdst, AdstAdst, FlipadstDct, DctFlipadst,
        FlipadstFlipadst, AdstFlipadst, FlipadstAdst, Identity,
        VDct, HDct, VAdst, HAdst, VFlipadst, HFlipadst].get(value as usize).copied()
}
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn probe_alloc() -> *mut i32 {
    Box::into_raw(vec![0_i32; 4096].into_boxed_slice()).cast()
}
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn probe_free(pointer: *mut i32) {
    unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, 4096))); }
}
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn probe(pointer: *mut i32, size: u32, tx: u32, depth: u32, lossless: u32) -> u32 {
    let size = size as usize;
    if size >= 19 { return 0; }
    let Some(tx) = transform_type(tx) else { return 0; };
    let length = transform::WIDTHS[size] * transform::HEIGHTS[size];
    let input = unsafe { std::slice::from_raw_parts_mut(pointer, length) };
    match transform::inverse(input, size, tx, depth, lossless != 0) {
        Ok(values) => { input.copy_from_slice(&values); length as u32 },
        Err(_) => 0,
    }
}
#[cfg(not(target_arch = "wasm32"))]
fn main() {
    use std::io::{self, Write};
    let mut out = io::BufWriter::new(io::stdout().lock());
    for size in 0..19 {
        for tx in 0..16 {
            for depth in [8, 10, 12] {
                let w = transform::WIDTHS[size]; let h = transform::HEIGHTS[size];
                let input: Vec<i32> = (0..w * h).map(|i| ((i * 17 + (i / w) * 29 + 11 * size + tx as usize * 7) % 1009) as i32 - 504).collect();
                let values = transform::inverse(&input, size, transform_type(tx).unwrap(), depth, false);
                let length = values.as_ref().map_or(0, Vec::len);
                out.write_all(&(length as u32).to_le_bytes()).unwrap();
                if let Ok(values) = values {
                    for value in values { out.write_all(&value.to_le_bytes()).unwrap(); }
                }
            }
        }
    }
}
