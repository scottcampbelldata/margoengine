//! Owned, length-prefixed Wasm ABI. The module is instantiated only inside a decoder worker.
#[unsafe(no_mangle)]
pub extern "C" fn avif_alloc(length: usize) -> *mut u8 {
    if length == 0 || length > 512 << 20 {
        return std::ptr::null_mut();
    }
    let mut data = Vec::new();
    if data.try_reserve_exact(length).is_err() {
        return std::ptr::null_mut();
    }
    data.resize(length, 0u8);
    Box::into_raw(data.into_boxed_slice()) as *mut u8
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn avif_free(pointer: *mut u8, length: usize) {
    if !pointer.is_null() {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                pointer, length,
            )));
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn avif_run(
    pointer: *const u8,
    length: usize,
    pixels: u32,
    memory: u32,
) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(pointer, length) };
    let result = crate::image::decode(
        input,
        crate::image::Limits {
            pixels: pixels as u64,
            memory: memory as usize,
        },
    );
    let mut out = vec![0u8; 48];
    match result {
        Ok(image) => {
            let fields = [
                image.width as u32,
                image.height as u32,
                image.depth,
                image.color.primaries,
                image.color.transfer,
                image.color.matrix,
                u32::from(image.color.full_range),
                image.icc.len() as u32,
                u32::from(image.color.monochrome)
                    | (u32::from(image.color.sub_x) << 1)
                    | (u32::from(image.color.sub_y) << 2)
                    | (image.color.position << 3),
            ];
            for (i, value) in fields.iter().enumerate() {
                out[8 + i * 4..12 + i * 4].copy_from_slice(&value.to_le_bytes());
            }
            for value in image.rgba {
                out.extend_from_slice(&value.to_le_bytes());
            }
            out.extend_from_slice(&image.icc);
        }
        Err(error) => out[4..8].copy_from_slice(&(error as u32 + 1).to_le_bytes()),
    }
    let length = out.len() as u32;
    out[..4].copy_from_slice(&length.to_le_bytes());
    Box::into_raw(out.into_boxed_slice()) as *mut u8
}
