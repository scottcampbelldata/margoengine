// Clean room implementation of the existing sciviz marching-cubes contract.
// The caller supplies cubes.ts's derived case table, also used by the GPU path.

#[unsafe(no_mangle)]
pub extern "C" fn allocate(words: usize) -> *mut u32 {
    Box::into_raw(vec![0; words].into_boxed_slice()) as *mut u32
}

/// The caller releases exactly a buffer returned by allocate, once, with its original length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(ptr: *mut u32, words: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            ptr, words,
        )))
    }
}

fn corner(c: usize) -> [usize; 3] {
    [c & 1, (c >> 1) & 1, c >> 2]
}

fn mask(field: &[f32], base: usize, nx: usize, ny: usize, level: f32) -> u32 {
    let mut mask = 0;
    for c in 0..8 {
        let p = corner(c);
        if field[base + p[0] + nx * (p[1] + ny * p[2])] > level {
            mask |= 1 << c;
        }
    }
    mask
}

/// Four neighbouring x cells, with eight vector comparisons instead of 32 scalar comparisons.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
unsafe fn masks4(field: &[f32], base: usize, nx: usize, ny: usize, level: f32) -> [u32; 4] {
    use std::arch::wasm32::*;
    let mut masks = u32x4_splat(0);
    for c in 0..8 {
        let p = corner(c);
        let values = unsafe {
            v128_load(field.as_ptr().add(base + p[0] + nx * (p[1] + ny * p[2])) as *const v128)
        };
        masks = v128_or(
            masks,
            v128_and(f32x4_gt(values, f32x4_splat(level)), u32x4_splat(1 << c)),
        );
    }
    [
        u32x4_extract_lane::<0>(masks),
        u32x4_extract_lane::<1>(masks),
        u32x4_extract_lane::<2>(masks),
        u32x4_extract_lane::<3>(masks),
    ]
}

fn classify_cells(
    field: &[f32],
    counts: &[u32],
    cases: &mut [u32],
    nx: usize,
    ny: usize,
    level: f32,
    start: usize,
    end: usize,
) -> u32 {
    let mut total = 0;
    let mut cell = start;
    while cell < end {
        let x = cell % (nx - 1);
        let y = (cell / (nx - 1)) % (ny - 1);
        let z = cell / ((nx - 1) * (ny - 1));
        let base = x + nx * (y + ny * z);
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        if end - cell >= 4 && nx - 1 - x >= 4 {
            let masks = unsafe { masks4(field, base, nx, ny, level) };
            for k in 0..4 {
                cases[cell + k] = masks[k];
                total += counts[masks[k] as usize];
            }
            cell += 4;
            continue;
        }
        let m = mask(field, base, nx, ny, level);
        cases[cell] = m;
        total += counts[m as usize];
        cell += 1;
    }
    total
}

/// Validated, non-overlapping allocations and cell ranges are supplied by fallback.ts.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn classify(
    field: *const f32,
    counts: *const u32,
    cases: *mut u32,
    nx: usize,
    ny: usize,
    nz: usize,
    level: f32,
    start: usize,
    end: usize,
) -> u32 {
    unsafe {
        classify_cells(
            std::slice::from_raw_parts(field, nx * ny * nz),
            std::slice::from_raw_parts(counts, 256),
            std::slice::from_raw_parts_mut(cases, (nx - 1) * (ny - 1) * (nz - 1)),
            nx,
            ny,
            level,
            start,
            end,
        )
    }
}

fn at(field: &[f32], p: [i32; 3], dims: [usize; 3]) -> f32 {
    let q: [usize; 3] = std::array::from_fn(|a| p[a].clamp(0, dims[a] as i32 - 1) as usize);
    field[q[0] + dims[0] * (q[1] + dims[1] * q[2])]
}

fn gradient(field: &[f32], p: [i32; 3], dims: [usize; 3]) -> [f32; 3] {
    std::array::from_fn(|a| {
        let mut plus = p;
        let mut minus = p;
        plus[a] += 1;
        minus[a] -= 1;
        // Central inside, one-sided at the grid's faces: scale each to the two samples a central difference spans.
        let span = (plus[a].min(dims[a] as i32 - 1) - minus[a].max(0)).max(1) as f32;
        (at(field, plus, dims) - at(field, minus, dims)) * (2.0 / span)
    })
}

fn edge(e: u32) -> [usize; 2] {
    let bit = 1 << (e / 4);
    let a = (0..8)
        .filter(|c| c & bit == 0)
        .nth((e % 4) as usize)
        .unwrap();
    [a, a | bit]
}

/// Writes position.xyzw and gradient.xyzw per vertex, in GPU cell/table order.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn generate(
    field: *const f32,
    counts: *const u32,
    edges: *const u32,
    cases: *const u32,
    output: *mut f32,
    nx: usize,
    ny: usize,
    nz: usize,
    stride: usize,
    level: f32,
    start: usize,
    end: usize,
    first: usize,
) -> usize {
    let dims = [nx, ny, nz];
    let field = unsafe { std::slice::from_raw_parts(field, nx * ny * nz) };
    let counts = unsafe { std::slice::from_raw_parts(counts, 256) };
    let edges = unsafe { std::slice::from_raw_parts(edges, 256 * stride) };
    let cases = unsafe { std::slice::from_raw_parts(cases, (nx - 1) * (ny - 1) * (nz - 1)) };
    let mut vertex = first * 3;
    for cell in start..end {
        let base = [
            cell % (nx - 1),
            (cell / (nx - 1)) % (ny - 1),
            cell / ((nx - 1) * (ny - 1)),
        ];
        let mask = cases[cell] as usize;
        for k in 0..counts[mask] as usize * 3 {
            let ends = edge(edges[mask * stride + k]);
            let pa: [i32; 3] = std::array::from_fn(|a| (base[a] + corner(ends[0])[a]) as i32);
            let pb: [i32; 3] = std::array::from_fn(|a| (base[a] + corner(ends[1])[a]) as i32);
            let va = at(field, pa, dims);
            let vb = at(field, pb, dims);
            let t = ((level - va) / (vb - va)).clamp(0.0, 1.0);
            let ga = gradient(field, pa, dims);
            let gb = gradient(field, pb, dims);
            let mut v = [0.0; 8];
            for a in 0..3 {
                v[a] = (pa[a] as f32 * (1.0 - t) + pb[a] as f32 * t) / (dims[a] - 1) as f32;
                v[a + 4] = -(ga[a] * (1.0 - t) + gb[a] * t);
            }
            v[3] = 1.0;
            unsafe { std::ptr::copy_nonoverlapping(v.as_ptr(), output.add(vertex * 8), 8) };
            vertex += 1;
        }
    }
    vertex / 3
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classification_uses_x_fastest_and_strict_greater() {
        for m in 0..256_u32 {
            let field: Vec<f32> = (0..8)
                .map(|c| if m & (1 << c) == 0 { -1.0 } else { 1.0 })
                .collect();
            assert_eq!(mask(&field, 0, 2, 2, 0.0), m);
        }
        assert_eq!(mask(&[0.0; 8], 0, 2, 2, 0.0), 0);
    }
    #[test]
    fn split_ranges_keep_global_cases() {
        let field: Vec<f32> = (0..7 * 3 * 2).map(|i| (i % 9) as f32).collect();
        let counts: Vec<u32> = (0..256).collect();
        let mut whole = vec![0; 12];
        let mut split = vec![0; 12];
        let total = classify_cells(&field, &counts, &mut whole, 7, 3, 4.0, 0, 12);
        let a = classify_cells(&field, &counts, &mut split, 7, 3, 4.0, 0, 5);
        let b = classify_cells(&field, &counts, &mut split, 7, 3, 4.0, 5, 12);
        assert_eq!(total, a + b);
        assert_eq!(whole, split);
    }
}
