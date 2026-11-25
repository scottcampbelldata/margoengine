//! The reader module of the shared-memory prototype (docs/physics-framework.md, section 3): it reads the source module's
//! positions port in place, with no copy, and writes into its own region how far each particle lies below a water level,
//! weighted by a static table. Its sums use a fixed partition into chunks, each summed in index order, and the chunk
//! sums are added in chunk order, so the total is the same bits whatever number of threads did the chunks.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// A weight per particle by index mod 8: read-only static data in the module's window.
static WEIGHT: [f32; 8] = [1.0, 0.875, 0.75, 0.625, 0.5, 0.625, 0.75, 0.875];

/// For particles `lo..hi` of the port at `port` (`stride` f32 words each, y at word 1), writes into `out[i]` the depth
/// below `level`, weighted, or 0 above it.
///
/// # Safety
/// `port` must hold `hi * stride` words and `out` `hi` words of the shared memory; no other call writes `out[lo..hi]`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reader_depth(port: *const f32, stride: u32, lo: u32, hi: u32, level: f32, out: *mut f32) {
    for i in lo as usize..hi as usize {
        // SAFETY: the caller's bounds.
        let y = unsafe { *port.add(i * stride as usize + 1) };
        let depth = level - y;
        unsafe { *out.add(i) = if depth > 0.0 { depth * WEIGHT[i & 7] } else { 0.0 } };
    }
}

/// Writes the sum of each chunk `c` in `first..last` of `out` (chunks of `chunk` words, the last one shorter, `n` in
/// all) into `sums[c]`, adding in index order.
///
/// # Safety
/// `out` must hold `n` words and `sums` `last` words; no other call writes `sums[first..last]`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reader_chunk_sums(out: *const f32, n: u32, chunk: u32, first: u32, last: u32, sums: *mut f32) {
    for c in first..last {
        let (lo, hi) = (c * chunk, ((c + 1) * chunk).min(n));
        let mut s = 0.0f32;
        for i in lo..hi {
            s += unsafe { *out.add(i as usize) };
        }
        unsafe { *sums.add(c as usize) = s };
    }
}

/// The sum of `count` chunk sums, in chunk order.
///
/// # Safety
/// `sums` must hold `count` words.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reader_total(sums: *const f32, count: u32) -> f32 {
    let mut s = 0.0f32;
    for c in 0..count as usize {
        s += unsafe { *sums.add(c) };
    }
    s
}
