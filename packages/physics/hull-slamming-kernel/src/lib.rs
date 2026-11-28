use std::f64::consts::PI;

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_mul, f64x2_splat, f64x2_sub,
};

const ANGLES: usize = 32;
const RECEIPT: usize = 4;

#[derive(Default)]
struct Work {
    bisections: u32,
    pairs: f64,
    comparisons: f64,
}

struct Bracket {
    low_width: f64,
    width: f64,
    low_height: f64,
    height: f64,
}

fn bracket(
    x: f64,
    heights: &[f64],
    half: &[f64],
    cursor: &mut usize,
    work: &mut Work,
) -> Option<Bracket> {
    if x <= 0.0 {
        return Some(Bracket {
            low_width: 0.0,
            width: 1.0,
            low_height: 0.0,
            height: 0.0,
        });
    }
    // The quadrature abscissae increase. The previous term's first match is a valid starting point.
    while let Some(&upper) = half.get(*cursor) {
        work.comparisons += 1.0;
        if upper >= x {
            let low_width = half[*cursor - 1];
            let low_height = heights[*cursor - 1];
            return Some(Bracket {
                low_width,
                width: upper - low_width,
                low_height,
                height: heights[*cursor] - low_height,
            });
        }
        *cursor += 1;
    }
    None
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn mean(c: f64, h: &[f64], b: &[f64], nodes: &[f64], work: &mut Work) -> Option<f64> {
    let mut sum = 0.0;
    let mut cursor = 1;
    for pair in nodes.chunks_exact(2) {
        let x = f64x2_mul(f64x2_splat(c), f64x2(pair[0], pair[1]));
        let left = bracket(f64x2_extract_lane::<0>(x), h, b, &mut cursor, work)?;
        let right = bracket(f64x2_extract_lane::<1>(x), h, b, &mut cursor, work)?;
        let fraction = f64x2_div(
            f64x2_sub(x, f64x2(left.low_width, right.low_width)),
            f64x2(left.width, right.width),
        );
        let values = f64x2_add(
            f64x2(left.low_height, right.low_height),
            f64x2_mul(fraction, f64x2(left.height, right.height)),
        );
        // Keep each original addition in chronological quadrature order.
        sum += f64x2_extract_lane::<0>(values);
        sum += f64x2_extract_lane::<1>(values);
        work.pairs += 1.0;
    }
    let result = sum / ANGLES as f64;
    result.is_finite().then_some(result)
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn mean(c: f64, h: &[f64], b: &[f64], nodes: &[f64], work: &mut Work) -> Option<f64> {
    let mut sum = 0.0;
    let mut cursor = 1;
    for &node in nodes {
        let x = c * node;
        let term = bracket(x, h, b, &mut cursor, work)?;
        sum += term.low_height + ((x - term.low_width) / term.width) * term.height;
    }
    let result = sum / ANGLES as f64;
    result.is_finite().then_some(result)
}

// Wagner's contact-width condition, Eq. (2.3) of Hulin et al., JFM 2022, evaluated at strip depths.
fn bake(h: &[f64], half: &[f64], nodes: &[f64], density: f64, output: &mut [f64]) -> Option<()> {
    if h.is_empty()
        || !density.is_finite()
        || density <= 0.0
        || h[0] != 0.0
        || half[0] != 0.0
        || !h.windows(2).all(|a| a[1].is_finite() && a[1] > a[0])
        || !half.windows(2).all(|a| a[1].is_finite() && a[1] >= a[0])
    {
        return None;
    }
    if h.len() == 1 {
        output.fill(0.0);
        return Some(());
    }
    let (wetted, record) = output.split_at_mut(h.len());
    let (slope, receipt) = record.split_at_mut(h.len());
    let widest = *half.last()?;
    let mut work = Work::default();
    let saturation = mean(widest, h, half, nodes, &mut work)?;
    wetted[0] = 0.0;
    for (entry, &depth) in wetted[1..].iter_mut().zip(&h[1..]) {
        if saturation <= depth {
            *entry = widest;
            continue;
        }
        let mut lo = 0.0;
        let mut hi = widest;
        for _ in 0..50 {
            let middle = (lo + hi) / 2.0;
            if mean(middle, h, half, nodes, &mut work)? < depth {
                lo = middle;
            } else {
                hi = middle;
            }
            work.bisections = work.bisections.checked_add(1)?;
        }
        *entry = (lo + hi) / 2.0;
    }
    let mass: Vec<_> = wetted
        .iter()
        .map(|&c| (density * PI * c * c) / 2.0)
        .collect();
    if !mass.iter().all(|m| m.is_finite()) {
        return None;
    }
    for (k, value) in slope.iter_mut().enumerate() {
        let a = k.saturating_sub(1);
        let b = (k + 1).min(h.len() - 1);
        *value = (mass[b] - mass[a]) / (h[b] - h[a]);
        if !value.is_finite() {
            return None;
        }
    }
    receipt.copy_from_slice(&[
        (h.len() - 1) as f64,
        f64::from(work.bisections),
        work.pairs,
        work.comparisons,
    ]);
    Some(())
}

#[unsafe(no_mangle)]
pub extern "C" fn slam_allocate(words: usize) -> *mut f64 {
    Box::into_raw(vec![0.0; words].into_boxed_slice()).cast::<f64>()
}

/// # Safety
/// Pass the pointer and length of an active allocation from slam_allocate.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn slam_free(pointer: *mut f64, words: usize) {
    let slice = std::ptr::slice_from_raw_parts_mut(pointer, words);
    drop(unsafe { Box::from_raw(slice) });
}

/// # Safety
/// Provide in-range f64 tables of the stated sizes. The output must be disjoint from each input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn slam_station(
    height: *const f64,
    half: *const f64,
    levels: usize,
    nodes: *const f64,
    density: f64,
    output: *mut f64,
) -> bool {
    let h = unsafe { std::slice::from_raw_parts(height, levels) };
    let b = unsafe { std::slice::from_raw_parts(half, levels) };
    let angle = unsafe { std::slice::from_raw_parts(nodes, ANGLES) };
    let result = unsafe { std::slice::from_raw_parts_mut(output, 2 * levels + RECEIPT) };
    bake(h, b, angle, density, result).is_some()
}
