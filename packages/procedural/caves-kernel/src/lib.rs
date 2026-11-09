// Clean room from Johnson et al. 2010 (Moore cave rules) and Gartner/Zehmakan
// 2017 (synchronous majority/tie retention). Separable integer box sums are exact.
fn evolve(
    a: &[u8],
    w: usize,
    h: usize,
    d: usize,
    steps: usize,
    birth: u32,
    survival: u32,
    direct: bool,
) -> (Vec<u8>, u32) {
    let n = w * h * d;
    let inner = (w - 2) * (h - 2) * if d == 1 { 1 } else { d - 2 };
    let naive = inner * if d == 1 { 9 } else { 27 };
    let separated = 3 * (w - 2) * h * d
        + if d == 1 {
            4 * inner
        } else {
            3 * (w - 2) * (h - 2) * d + 4 * inner
        };
    let use_direct = direct || separated >= naive;
    let mut current = a.to_vec();
    let mut next = a.to_vec();
    let mut xsum = if use_direct { vec![] } else { vec![0u8; n] };
    let mut ysum = if use_direct || d == 1 {
        vec![]
    } else {
        vec![0u8; n]
    };
    for _ in 0..steps {
        if !use_direct {
            for z in 0..d {
                for y in 0..h {
                    for x in 1..w - 1 {
                        let p = (z * h + y) * w + x;
                        xsum[p] = current[p - 1] + current[p] + current[p + 1];
                    }
                }
            }
            if d > 1 {
                for z in 0..d {
                    for y in 1..h - 1 {
                        for x in 1..w - 1 {
                            let p = (z * h + y) * w + x;
                            ysum[p] = xsum[p - w] + xsum[p] + xsum[p + w];
                        }
                    }
                }
            }
        }
        let zr = if d == 1 { 0..1 } else { 1..d - 1 };
        for z in zr {
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    let p = (z * h + y) * w + x;
                    let centre = current[p] as u32;
                    let count = if use_direct {
                        let mut sum = 0;
                        let dz = if d == 1 { 0..=0 } else { -1..=1 };
                        for zz in dz {
                            for yy in -1..=1 {
                                for xx in -1..=1 {
                                    if xx != 0 || yy != 0 || zz != 0 {
                                        sum += current[(p as isize
                                            + xx
                                            + yy * w as isize
                                            + zz * (w * h) as isize)
                                            as usize]
                                            as u32;
                                    }
                                }
                            }
                        }
                        sum
                    } else if d == 1 {
                        (xsum[p - w] + xsum[p] + xsum[p + w]) as u32 - centre
                    } else {
                        (ysum[p - w * h] + ysum[p] + ysum[p + w * h]) as u32 - centre
                    };
                    next[p] = u8::from(count >= if centre == 1 { survival } else { birth });
                }
            }
        }
        std::mem::swap(&mut current, &mut next);
    }
    (
        current,
        (steps * if use_direct { naive } else { separated }) as u32,
    )
}
#[unsafe(no_mangle)]
pub extern "C" fn allocate(length: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; length].into_boxed_slice()) as *mut u8
}
/// Input allocation remains caller-owned. Output has four little-endian u32 fields then binary cells.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn generate(
    w: usize,
    h: usize,
    d: usize,
    seed: u32,
    steps: usize,
    fill: f64,
    border: u8,
    birth: u32,
    survival: u32,
    input: *const u8,
) -> *mut u8 {
    let n = w
        .checked_mul(h)
        .and_then(|v| v.checked_mul(d))
        .unwrap_or(usize::MAX);
    if !(3..=1024).contains(&w)
        || !(3..=1024).contains(&h)
        || !(d == 1 || (3..=256).contains(&d))
        || n > 1048576
        || steps > 64
        || n * steps > 16777216
        || !fill.is_finite()
        || !(0.0..=1.0).contains(&fill)
        || border > 1
        || birth > if d == 1 { 8 } else { 26 }
        || survival > if d == 1 { 8 } else { 26 }
    {
        let mut error = vec![0u8; 16];
        error[0..4].copy_from_slice(&16u32.to_le_bytes());
        return Box::into_raw(error.into_boxed_slice()) as *mut u8;
    }
    let source = if input.is_null() {
        None
    } else {
        Some(unsafe { std::slice::from_raw_parts(input, n) })
    };
    let mut cells = vec![border; n];
    let mut state = seed;
    for z in 0..d {
        for y in 0..h {
            for x in 0..w {
                let p = (z * h + y) * w + x;
                // Advance for every grid cell so a seed has an unambiguous X-fastest stream.
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                if x > 0 && x + 1 < w && y > 0 && y + 1 < h && (d == 1 || (z > 0 && z + 1 < d)) {
                    cells[p] = if let Some(s) = source {
                        u8::from(s[p] != 0)
                    } else {
                        u8::from((state as f64) / 4294967296.0 < fill)
                    };
                }
            }
        }
    }
    let (result, reads) = evolve(&cells, w, h, d, steps, birth, survival, false);
    let naive = (w - 2)
        * (h - 2)
        * (if d == 1 { 1 } else { d - 2 })
        * steps
        * (if d == 1 { 9 } else { 27 });
    let mut out = vec![0u8; n + 16];
    for (i, v) in [(n + 16) as u32, reads, naive as u32, 0].iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    out[16..].copy_from_slice(&result);
    Box::into_raw(out.into_boxed_slice()) as *mut u8
}
/// Release exactly one allocation returned by allocate/generate.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(pointer: *mut u8, length: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separated_equals_direct_for_asymmetric_binary_grids_and_every_threshold() {
        for (w, h, d) in [(3, 3, 1), (3, 3, 3), (31, 27, 1), (19, 17, 13)] {
            let mut state = 7u32;
            let a: Vec<_> = (0..w * h * d)
                .map(|_| {
                    state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                    (state >> 31) as u8
                })
                .collect();
            for threshold in 0..=if d == 1 { 8 } else { 26 } {
                let (actual, reads) = evolve(&a, w, h, d, 7, threshold, threshold / 2, false);
                // Compare both algorithms from the identical original grid.
                let (expected, naive) = evolve(&a, w, h, d, 7, threshold, threshold / 2, true);
                assert_eq!(actual, expected);
                assert!(reads <= naive);
                if w > 3 {
                    assert!(reads < naive);
                }
            }
        }
    }
    #[test]
    fn invalid_dimensions_do_not_allocate_large_buffers() {
        for (w, h, d) in [
            (0, 48, 1),
            (1025, 48, 1),
            (64, 48, 2),
            (1024, 1024, 256),
            (usize::MAX, 3, 3),
        ] {
            unsafe {
                let p = generate(w, h, d, 1, 5, 0.45, 1, 5, 4, std::ptr::null());
                let header = std::slice::from_raw_parts(p, 16);
                let length = u32::from_le_bytes(header[0..4].try_into().unwrap());
                assert_eq!(
                    length, 16,
                    "error result retains its allocation size for release"
                );
                assert!(header[4..].iter().all(|v| *v == 0));
                release(p, length as usize);
            }
        }
    }
}
