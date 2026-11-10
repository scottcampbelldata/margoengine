//! Clean-room Basis encoder draft. Wire data comes from Khronos KTX2 appendix D
//! and the UASTC LDR 4x4 specification. No implementation source was consulted.
mod etc1s;
mod hints;
mod tables;
mod uastc;
mod zstd;

pub use uastc::{encode_block, encode_mode};

/// Own input/output allocations across the Wasm ABI, with the exact length used
/// again for deallocation. No mutable global heap or shared result slot.
#[unsafe(no_mangle)]
pub extern "C" fn allocate(length: usize) -> *mut u8 {
    let buffer = vec![0u8; length].into_boxed_slice();
    Box::into_raw(buffer) as *mut u8
}

/// # Safety
/// `pointer` and `length` must be an outstanding allocation from `allocate`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(pointer: *mut u8, length: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )))
    };
}

/// # Safety
/// Input and output must be disjoint, live allocations of `blocks * 64` and
/// `blocks * 16` bytes. Every block is sixteen RGBA8 texels in raster order.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn encode_uastc(
    input: *const u8,
    output: *mut u8,
    blocks: usize,
    level: u32,
    perceptual: u32,
) -> u32 {
    let Some(input_length) = blocks.checked_mul(64) else {
        return 1;
    };
    let Some(output_length) = blocks.checked_mul(16) else {
        return 1;
    };
    if level > 4 {
        return 1;
    }
    let pixels = unsafe { std::slice::from_raw_parts(input, input_length) };
    let result = unsafe { std::slice::from_raw_parts_mut(output, output_length) };
    for (block, destination) in pixels.chunks_exact(64).zip(result.chunks_exact_mut(16)) {
        let rgba: [[u8; 4]; 16] =
            std::array::from_fn(|i| block[i * 4..i * 4 + 4].try_into().unwrap());
        let mut block = if perceptual != 0 {
            uastc::encode_block_metric(&rgba, level, [54, 183, 19, 256])
        } else {
            encode_block(&rgba, level)
        };
        hints::apply(&mut block);
        destination.copy_from_slice(&block);
    }
    0
}

/// Forced mode/partition path for exhaustive independent conformance checks.
/// # Safety
/// Input/output allocations must hold 64/16 bytes respectively, disjoint.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn encode_uastc_mode(
    input: *const u8,
    output: *mut u8,
    mode: u32,
    partition: u32,
    component: u32,
) -> u32 {
    let block = unsafe { std::slice::from_raw_parts(input, 64) };
    let rgba = std::array::from_fn(|i| block[i * 4..i * 4 + 4].try_into().unwrap());
    let Some(mut result) = encode_mode(
        &rgba,
        mode as usize,
        partition as usize,
        component as usize,
        2,
    ) else {
        return 1;
    };
    hints::apply(&mut result.0);
    unsafe { std::slice::from_raw_parts_mut(output, 16) }.copy_from_slice(&result.0);
    0
}

/// Fits independent ETC1S blocks, before shared codebook training.
/// # Safety
/// Disjoint input/output allocations contain `blocks * 64`/`blocks * 8` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn encode_etc1s(
    input: *const u8,
    output: *mut u8,
    blocks: usize,
    effort: u32,
) -> u32 {
    let Some(input_length) = blocks.checked_mul(64) else {
        return 1;
    };
    let Some(output_length) = blocks.checked_mul(8) else {
        return 1;
    };
    if effort > 6 {
        return 1;
    }
    let pixels = unsafe { std::slice::from_raw_parts(input, input_length) };
    let result = unsafe { std::slice::from_raw_parts_mut(output, output_length) };
    for (block, destination) in pixels.chunks_exact(64).zip(result.chunks_exact_mut(8)) {
        let rgba = std::array::from_fn(|i| block[i * 4..i * 4 + 4].try_into().unwrap());
        let (endpoint, selectors, _) = etc1s::fit(&rgba, effort);
        destination[..4].copy_from_slice(&endpoint);
        destination[4..].copy_from_slice(&selectors.to_le_bytes());
    }
    0
}

/// # Safety
/// Input/output allocations hold `length`/`capacity` bytes and are disjoint.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn encode_zstd(
    input: *const u8,
    length: usize,
    output: *mut u8,
    capacity: usize,
) -> usize {
    let encoded = zstd::encode(unsafe { std::slice::from_raw_parts(input, length) });
    if encoded.len() > capacity {
        return 0;
    }
    unsafe { std::slice::from_raw_parts_mut(output, encoded.len()) }.copy_from_slice(&encoded);
    encoded.len()
}

/// # Safety
/// Disjoint buffers hold `blocks * 64` input and `blocks * 8` output bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn encode_etc1s_shared(
    input: *const u8,
    output: *mut u8,
    blocks: usize,
    quality: u32,
    effort: u32,
    perceptual: u32,
) -> u32 {
    unsafe { encode_etc1s_shared_mips(input,output,blocks,quality,effort,perceptual,std::ptr::null(),0) }
}

/// # Safety
/// Same disjoint pixel/output buffers as `encode_etc1s_shared`; dimensions is
/// `slices * 2` u32 values holding each mip/alpha slice's width and height.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn encode_etc1s_shared_mips(
    input:*const u8, output:*mut u8, blocks:usize, quality:u32, effort:u32,
    perceptual:u32, dimensions:*const u32, slices:usize,
) -> u32 {
    if slices > 64 || (slices > 0 && dimensions.is_null()) { return 1; }
    let mut dims=Vec::new(); let mut count=0usize;
    if slices > 0 {
        for pair in unsafe {std::slice::from_raw_parts(dimensions,slices*2)}.chunks_exact(2) {
            let w=pair[0] as usize; let h=pair[1] as usize;
            if w==0 || h==0 { return 1; }
            let Some(n)=w.div_ceil(4).checked_mul(h.div_ceil(4)) else { return 1; };
            let Some(total)=count.checked_add(n) else { return 1; }; count=total;
            dims.push([w,h]);
        }
        if count!=blocks { return 1; }
    }
    let Some(n) = blocks.checked_mul(64) else {
        return 1;
    };
    let Some(m) = blocks.checked_mul(8) else {
        return 1;
    };
    if !(1..=255).contains(&quality) || effort > 6 {
        return 1;
    }
    let input = unsafe { std::slice::from_raw_parts(input, n) };
    let pixels: Vec<[[u8; 4]; 16]> = input
        .chunks_exact(64)
        .map(|b| std::array::from_fn(|i| b[i * 4..i * 4 + 4].try_into().unwrap()))
        .collect();
    let out = unsafe { std::slice::from_raw_parts_mut(output, m) };
    for (destination, (endpoint, selectors)) in out.chunks_exact_mut(8).zip(etc1s::train_dimensions(
        &pixels,
        quality,
        effort,
        if perceptual != 0 {
            [54, 183, 19, 0]
        } else {
            [1, 1, 1, 0]
        },
        &dims,
    )) {
        destination[..4].copy_from_slice(&endpoint);
        destination[4..].copy_from_slice(&selectors.to_le_bytes());
    }
    0
}

/// # Safety
/// Disjoint buffers hold `blocks * 64` original pixels and `blocks * 16`
/// initialized UASTC bytes. The latter are modified in place.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn condition_uastc(
    input: *const u8,
    output: *mut u8,
    blocks: usize,
    lambda: f64,
    perceptual: u32,
) -> u32 {
    let Some(n) = blocks.checked_mul(64) else {
        return 1;
    };
    let Some(m) = blocks.checked_mul(16) else {
        return 1;
    };
    if !lambda.is_finite() || !(0.0..=10.0).contains(&lambda) {
        return 1;
    }
    let pixels: Vec<[[u8; 4]; 16]> = unsafe { std::slice::from_raw_parts(input, n) }
        .chunks_exact(64)
        .map(|b| std::array::from_fn(|i| b[i * 4..i * 4 + 4].try_into().unwrap()))
        .collect();
    let out = unsafe { std::slice::from_raw_parts_mut(output, m) };
    let mut encoded: Vec<[u8; 16]> = out
        .chunks_exact(16)
        .map(|b| b.try_into().unwrap())
        .collect();
    uastc::rdo_metric(
        &pixels,
        &mut encoded,
        lambda,
        if perceptual != 0 {
            [54, 183, 19, 256]
        } else {
            [1; 4]
        },
    );
    for (dest, block) in out.chunks_exact_mut(16).zip(encoded) {
        dest.copy_from_slice(&block);
    }
    0
}

fn linear(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}
fn srgb(v: f64) -> f64 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}
/// Area filter with full source coverage for odd dimensions. Normal-map RGB
/// values are decoded to vectors, averaged, normalized, then re-encoded.
fn downsample(input: &[u8], width: usize, height: usize, color: bool, normal: bool) -> Vec<u8> {
    let w = (width / 2).max(1);
    let h = (height / 2).max(1);
    let mut result = vec![0; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let left = x as f64 * width as f64 / w as f64;
            let right = (x + 1) as f64 * width as f64 / w as f64;
            let top = y as f64 * height as f64 / h as f64;
            let bottom = (y + 1) as f64 * height as f64 / h as f64;
            let area = (right - left) * (bottom - top);
            let mut sum = [0.0; 4];
            for sy in top.floor() as usize..bottom.ceil() as usize {
                for sx in left.floor() as usize..right.ceil() as usize {
                    let weight = (right.min((sx + 1) as f64) - left.max(sx as f64))
                        * (bottom.min((sy + 1) as f64) - top.max(sy as f64))
                        / area;
                    for c in 0..4 {
                        let v = input[(sy * width + sx) * 4 + c] as f64 / 255.0;
                        sum[c] += if c < 3 && normal {
                            v * 2.0 - 1.0
                        } else if c < 3 && color {
                            linear(v)
                        } else {
                            v
                        } * weight;
                    }
                }
            }
            if normal {
                let length = sum[..3].iter().map(|v| v * v).sum::<f64>().sqrt();
                if length > 1e-15 {
                    for c in 0..3 {
                        sum[c] /= length;
                    }
                } else {
                    sum[..3].copy_from_slice(&[0.0, 0.0, 1.0]);
                }
                for c in 0..3 {
                    sum[c] = sum[c] * 0.5 + 0.5;
                }
            } else if color {
                for c in 0..3 {
                    sum[c] = srgb(sum[c]);
                }
            }
            for c in 0..4 {
                result[(y * w + x) * 4 + c] = (sum[c] * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    result
}
/// # Safety
/// Disjoint buffers hold width*height*4 source and max(1,width/2)*max(1,height/2)*4 destination bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mip_rgba(
    input: *const u8,
    output: *mut u8,
    width: usize,
    height: usize,
    color: u32,
    normal: u32,
) -> u32 {
    let Some(n) = width.checked_mul(height).and_then(|n| n.checked_mul(4)) else {
        return 1;
    };
    if width == 0 || height == 0 {
        return 1;
    }
    let result = downsample(
        unsafe { std::slice::from_raw_parts(input, n) },
        width,
        height,
        color != 0 && normal == 0,
        normal != 0,
    );
    unsafe { std::slice::from_raw_parts_mut(output, result.len()) }.copy_from_slice(&result);
    0
}
#[cfg(test)]
mod image_tests {
    use super::*;
    #[test]
    fn srgb_average_and_normal_renormalization() {
        let image = [0, 0, 0, 255, 255, 255, 255, 255];
        assert_eq!(downsample(&image, 2, 1, true, false), [188, 188, 188, 255]);
        assert_eq!(downsample(&image, 2, 1, false, false), [128, 128, 128, 255]);
        let normal = downsample(&[255, 128, 128, 255, 128, 255, 128, 255], 2, 1, false, true);
        let length = normal[..3]
            .iter()
            .map(|&c| (c as f64 / 127.5 - 1.0).powi(2))
            .sum::<f64>()
            .sqrt();
        assert!((length - 1.0).abs() < 0.01);
    }
    #[test]
    fn odd_image_averages_include_every_source_texel() {
        let input = [0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255];
        assert_eq!(downsample(&input, 3, 1, false, false), [85, 85, 85, 255]);
    }
}
