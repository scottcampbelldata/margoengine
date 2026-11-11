//! glTF meshopt decoding with WebAssembly SIMD, for `@margoengine/decoders/meshopt-simd`. Written from Appendix A and B of
//! the KHR_meshopt_compression specification and from Margo's own TypeScript decoder (`src/meshopt.ts`), whose output it
//! matches byte for byte. Every decode returns 0, or 1 on a stream it will not read: the caller then runs the TypeScript
//! decoder, which reports what is wrong, so the two share their error messages as well as their output.
use core::arch::wasm32::*;

unsafe extern "C" {
    static __heap_base: u8;
}

/// First free byte of the module's memory.
#[unsafe(no_mangle)]
pub extern "C" fn heap_base() -> usize {
    &raw const __heap_base as usize
}

const GROUP_MAX_BYTES: usize = 24;
const WIDTHS_V0: [u8; 4] = [0, 2, 4, 8];
const WIDTHS_V1: [[u8; 4]; 2] = [[0, 1, 2, 4], [1, 2, 4, 8]];

#[repr(align(16))]
struct Lanes([u8; 256 * 256]);

#[inline(always)]
unsafe fn load(at: *const u8) -> v128 {
    unsafe { v128_load(at as *const v128) }
}

/// Stores 16 deltas, replacing the marked ones with the bytes after the packed codes; returns the position after those.
#[inline(always)]
unsafe fn patch(values: v128, sentinel: u8, out: *mut u8, src: &[u8], mut escape: usize) -> usize {
    let mut marks = i8x16_bitmask(i8x16_eq(values, u8x16_splat(sentinel)));
    unsafe {
        v128_store(out as *mut v128, values);
        while marks != 0 {
            let lane = marks.trailing_zeros() as usize;
            *out.add(lane) = *src.get_unchecked(escape);
            escape += 1;
            marks &= marks - 1;
        }
    }
    escape
}

/// One group of 16 deltas. The caller has checked that GROUP_MAX_BYTES can be read at `pos`.
#[inline(always)]
unsafe fn read_group(src: &[u8], pos: usize, bits: u8, out: *mut u8) -> usize {
    unsafe {
        let at = src.as_ptr().add(pos);
        match bits {
            0 => {
                v128_store(out as *mut v128, u8x16_splat(0));
                pos
            }
            8 => {
                v128_store(out as *mut v128, v128_load(at as *const v128));
                pos + 16
            }
            1 => {
                // First bit lowest, 8 deltas a byte.
                let bytes = u16x8_splat((at as *const u16).read_unaligned());
                let spread = i8x16_shuffle::<0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1>(bytes, bytes);
                let select = u8x16(1, 2, 4, 8, 16, 32, 64, 128, 1, 2, 4, 8, 16, 32, 64, 128);
                let set = v128_and(i8x16_eq(v128_and(spread, select), select), u8x16_splat(1));
                patch(set, 1, out, src, pos + 2)
            }
            2 => {
                // Highest pair first, 4 deltas a byte.
                let bytes = u32x4_splat((at as *const u32).read_unaligned());
                let three = u8x16_splat(3);
                let a = u8x16_shr(bytes, 6);
                let b = v128_and(u8x16_shr(bytes, 4), three);
                let c = v128_and(u8x16_shr(bytes, 2), three);
                let d = v128_and(bytes, three);
                let ab = i8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 0, 0, 0, 0, 0, 0, 0, 0>(a, b);
                let cd = i8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 0, 0, 0, 0, 0, 0, 0, 0>(c, d);
                let values = i16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(ab, cd);
                patch(values, 3, out, src, pos + 4)
            }
            _ => {
                // High nibble first, 2 deltas a byte.
                let bytes = v128_load64_zero(at as *const u64);
                let high = u8x16_shr(bytes, 4);
                let low = v128_and(bytes, u8x16_splat(15));
                let values = i8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23>(high, low);
                patch(values, 15, out, src, pos + 8)
            }
        }
    }
}

/// Undoes the zigzag of 16 bytes and sums them left to right, starting from `first`.
#[inline(always)]
fn running_sum(deltas: v128, first: u8) -> v128 {
    let mut sum = v128_xor(u8x16_shr(deltas, 1), i8x16_neg(v128_and(deltas, u8x16_splat(1))));
    let zero = u8x16_splat(0);
    sum = i8x16_add(sum, i8x16_shuffle::<16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14>(sum, zero));
    sum = i8x16_add(sum, i8x16_shuffle::<16, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13>(sum, zero));
    sum = i8x16_add(sum, i8x16_shuffle::<16, 16, 16, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11>(sum, zero));
    sum = i8x16_add(sum, i8x16_shuffle::<16, 16, 16, 16, 16, 16, 16, 16, 0, 1, 2, 3, 4, 5, 6, 7>(sum, zero));
    i8x16_add(sum, u8x16_splat(first))
}

/// Writes four byte lanes of 16 elements as 16 runs of 4 bytes, `size` bytes apart.
#[inline(always)]
unsafe fn store_channel(a: v128, b: v128, c: v128, d: v128, out: *mut u8, size: usize) {
    let ab_low = i8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23>(a, b);
    let ab_high = i8x16_shuffle::<8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31>(a, b);
    let cd_low = i8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23>(c, d);
    let cd_high = i8x16_shuffle::<8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31>(c, d);
    let parts = [
        i16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(ab_low, cd_low),
        i16x8_shuffle::<4, 12, 5, 13, 6, 14, 7, 15>(ab_low, cd_low),
        i16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(ab_high, cd_high),
        i16x8_shuffle::<4, 12, 5, 13, 6, 14, 7, 15>(ab_high, cd_high),
    ];
    unsafe {
        for (i, part) in parts.iter().enumerate() {
            let at = out.add(i * 4 * size);
            (at as *mut u32).write_unaligned(u32x4_extract_lane::<0>(*part));
            (at.add(size) as *mut u32).write_unaligned(u32x4_extract_lane::<1>(*part));
            (at.add(size * 2) as *mut u32).write_unaligned(u32x4_extract_lane::<2>(*part));
            (at.add(size * 3) as *mut u32).write_unaligned(u32x4_extract_lane::<3>(*part));
        }
    }
}

#[inline(always)]
fn unzig8(v: u8) -> u8 {
    (v >> 1) ^ 0u8.wrapping_sub(v & 1)
}

#[inline(always)]
fn unzig16(v: u16) -> u16 {
    (v >> 1) ^ 0u16.wrapping_sub(v & 1)
}

/// Decodes `count` elements of `size` bytes, codec version 0 or 1.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn decode_attributes(source: *const u8, length: usize, target: *mut u8, count: usize, size: usize) -> i32 {
    let src = unsafe { core::slice::from_raw_parts(source, length) };
    if size < 1 || size > 256 || size % 4 != 0 || length < 1 + size {
        return 1;
    }
    let header = src[0];
    if header >> 4 != 0xa || header & 15 > 1 {
        return 1;
    }
    let v1 = header & 15 == 1;
    let channels = size >> 2;
    if v1 && length < 1 + size + channels {
        return 1;
    }
    let tail_size = if v1 { (size + channels).max(24) } else { size.max(32) };
    let baseline_at = length - size - if v1 { channels } else { 0 };
    let modes_at = length - channels;
    let mut prev = [0u8; 256];
    prev[..size].copy_from_slice(&src[baseline_at..baseline_at + size]);
    let block_max = ((8192 / size) & !15).min(256);
    let mut lanes = Lanes([0; 256 * 256]);
    let rows = lanes.0.as_mut_ptr();
    let mut pos = 1;
    let mut checked_modes = false;
    let mut start = 0;
    while start < count {
        let n = (count - start).min(block_max);
        let groups = (n + 15) >> 4;
        let mut control_at = 0;
        if v1 {
            if pos + channels > length {
                return 1;
            }
            control_at = pos;
            pos += channels;
        }
        for lane in 0..size {
            let row = unsafe { rows.add(lane * 256) };
            let mut widths = WIDTHS_V0;
            if v1 {
                let control = (src[control_at + (lane >> 2)] >> ((lane & 3) * 2)) & 3;
                if control == 2 {
                    unsafe { core::ptr::write_bytes(row, 0, groups * 16) };
                    continue;
                }
                if control == 3 {
                    if length - pos < n + GROUP_MAX_BYTES {
                        return 1;
                    }
                    unsafe { core::ptr::copy_nonoverlapping(src.as_ptr().add(pos), row, n) };
                    pos += n;
                    continue;
                }
                widths = WIDTHS_V1[control as usize];
            }
            let header_bytes = (groups + 3) >> 2;
            if pos + header_bytes > length {
                return 1;
            }
            let header_at = pos;
            pos += header_bytes;
            for g in 0..groups {
                if length - pos < GROUP_MAX_BYTES {
                    return 1;
                }
                let code = (src[header_at + (g >> 2)] >> ((g & 3) * 2)) & 3;
                pos = unsafe { read_group(src, pos, widths[code as usize], row.add(g * 16)) };
            }
        }
        if v1 && !checked_modes {
            for c in 0..channels {
                if src[modes_at + c] & 3 == 3 {
                    return 1;
                }
            }
            checked_modes = true;
        }
        for c in 0..channels {
            let base = c * 4;
            let mode = if v1 { src[modes_at + c] } else { 0 };
            let out = unsafe { target.add(start * size + base) };
            match mode & 3 {
                0 => unsafe { bytes_channel(rows, &mut prev, base, n, size, out) },
                1 => unsafe { words_channel(rows, &mut prev, base, n, size, out) },
                _ => unsafe { xor_channel(rows, &mut prev, base, n, size, out, mode >> 4) },
            }
        }
        start += n;
    }
    (length - pos != tail_size) as i32
}

unsafe fn bytes_channel(rows: *const u8, prev: &mut [u8; 256], base: usize, n: usize, size: usize, out: *mut u8) {
    let whole = n & !15;
    unsafe {
        let lane = [rows.add(base * 256), rows.add((base + 1) * 256), rows.add((base + 2) * 256), rows.add((base + 3) * 256)];
        let mut i = 0;
        while i < whole {
            let a = running_sum(load(lane[0].add(i)), prev[base]);
            let b = running_sum(load(lane[1].add(i)), prev[base + 1]);
            let c = running_sum(load(lane[2].add(i)), prev[base + 2]);
            let d = running_sum(load(lane[3].add(i)), prev[base + 3]);
            prev[base] = u8x16_extract_lane::<15>(a);
            prev[base + 1] = u8x16_extract_lane::<15>(b);
            prev[base + 2] = u8x16_extract_lane::<15>(c);
            prev[base + 3] = u8x16_extract_lane::<15>(d);
            store_channel(a, b, c, d, out.add(i * size), size);
            i += 16;
        }
        while i < n {
            for k in 0..4 {
                let v = prev[base + k].wrapping_add(unzig8(*lane[k].add(i)));
                prev[base + k] = v;
                *out.add(i * size + k) = v;
            }
            i += 1;
        }
    }
}

unsafe fn words_channel(rows: *const u8, prev: &mut [u8; 256], base: usize, n: usize, size: usize, out: *mut u8) {
    for i in 0..n {
        for k in [0, 2] {
            let at = base + k;
            unsafe {
                let delta = unzig16(*rows.add(at * 256 + i) as u16 | (*rows.add((at + 1) * 256 + i) as u16) << 8);
                let v = (prev[at] as u16 | (prev[at + 1] as u16) << 8).wrapping_add(delta);
                prev[at] = v as u8;
                prev[at + 1] = (v >> 8) as u8;
                *out.add(i * size + k) = v as u8;
                *out.add(i * size + k + 1) = (v >> 8) as u8;
            }
        }
    }
}

unsafe fn xor_channel(rows: *const u8, prev: &mut [u8; 256], base: usize, n: usize, size: usize, out: *mut u8, rotate: u8) {
    let mut value = u32::from_le_bytes([prev[base], prev[base + 1], prev[base + 2], prev[base + 3]]);
    for i in 0..n {
        unsafe {
            let delta = *rows.add(base * 256 + i) as u32
                | (*rows.add((base + 1) * 256 + i) as u32) << 8
                | (*rows.add((base + 2) * 256 + i) as u32) << 16
                | (*rows.add((base + 3) * 256 + i) as u32) << 24;
            value ^= delta.rotate_right(rotate as u32);
            (out.add(i * size) as *mut u32).write_unaligned(value);
        }
    }
    prev[base..base + 4].copy_from_slice(&value.to_le_bytes());
}

struct Reader<'a> {
    src: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    /// None past the end of the stream: such a stream ends in an error whatever follows.
    #[inline(always)]
    fn varint(&mut self) -> Option<u32> {
        let (mut value, mut shift) = (0u32, 0u32);
        for _ in 0..5 {
            let byte = *self.src.get(self.pos)?;
            self.pos += 1;
            value |= ((byte & 127) as u32) << shift;
            shift += 7;
            if byte < 128 {
                break;
            }
        }
        Some(value)
    }
}

/// Writes one index; false (the stream is damaged) when a 16-bit output would have to drop its high bits.
#[inline(always)]
unsafe fn put(out: *mut u8, wide: bool, at: usize, value: u32) -> bool {
    unsafe {
        if wide {
            (out as *mut u32).add(at).write_unaligned(value);
        } else if value > 0xffff {
            return false;
        } else {
            (out as *mut u16).add(at).write_unaligned(value as u16);
        }
    }
    true
}

/// Decodes a triangle list, codec version 0 or 1. `wide` is 1 for 32-bit output.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn decode_triangles(source: *const u8, length: usize, target: *mut u8, count: usize, wide: i32) -> i32 {
    let src = unsafe { core::slice::from_raw_parts(source, length) };
    if count % 3 != 0 {
        return 1;
    }
    let triangles = count / 3;
    if length < 1 + triangles + 16 || src[0] >> 4 != 0xe || src[0] & 15 > 1 {
        return 1;
    }
    let fifo_limit = if src[0] & 15 == 1 { 13 } else { 15 };
    let tail = length - 16;
    let mut edge_a = [u32::MAX; 16];
    let mut edge_b = [u32::MAX; 16];
    let mut verts = [u32::MAX; 16];
    let (mut edge_head, mut vert_head) = (0usize, 0usize);
    let (mut next, mut last) = (0u32, 0u32);
    let mut data = Reader { src, pos: 1 + triangles };
    let wide = wide != 0;

    macro_rules! push_edge {
        ($a:expr, $b:expr) => {
            edge_a[edge_head] = $a;
            edge_b[edge_head] = $b;
            edge_head = (edge_head + 1) & 15;
        };
    }
    macro_rules! push_vertex {
        ($v:expr) => {
            verts[vert_head] = $v;
            vert_head = (vert_head + 1) & 15;
        };
    }
    macro_rules! vertex {
        ($i:expr) => {
            verts[vert_head.wrapping_sub(1).wrapping_sub($i as usize) & 15]
        };
    }
    macro_rules! explicit {
        () => {{
            let Some(v) = data.varint() else { return 1 };
            last = last.wrapping_add(if v & 1 != 0 { !(v >> 1) } else { v >> 1 });
            last
        }};
    }
    macro_rules! take_next {
        () => {{
            let v = next;
            next = next.wrapping_add(1);
            v
        }};
    }

    for t in 0..triangles {
        if data.pos > tail {
            return 1;
        }
        let code = src[1 + t];
        let (hi, lo) = ((code >> 4) as usize, code & 15);
        let (a, b, c);
        if hi < 15 {
            let e = edge_head.wrapping_sub(1).wrapping_sub(hi) & 15;
            a = edge_a[e];
            b = edge_b[e];
            if lo == 0 {
                c = take_next!();
                push_vertex!(c);
            } else if lo < fifo_limit {
                c = vertex!(lo);
            } else if lo < 15 {
                c = if lo == 13 { last.wrapping_sub(1) } else { last.wrapping_add(1) };
                last = c;
                push_vertex!(c);
            } else {
                c = explicit!();
                push_vertex!(c);
            }
            push_edge!(c, b);
            push_edge!(a, c);
        } else {
            let (z, w);
            if lo < 14 {
                let aux = src[tail + lo as usize];
                z = aux >> 4;
                w = aux & 15;
                a = take_next!();
            } else {
                let Some(&aux) = src.get(data.pos) else { return 1 };
                data.pos += 1;
                if aux == 0 {
                    next = 0;
                }
                z = aux >> 4;
                w = aux & 15;
                a = if lo == 14 { take_next!() } else { explicit!() };
            }
            b = if z == 0 {
                take_next!()
            } else if z < 15 {
                vertex!(z - 1)
            } else {
                explicit!()
            };
            c = if w == 0 {
                take_next!()
            } else if w < 15 {
                vertex!(w - 1)
            } else {
                explicit!()
            };
            push_edge!(b, a);
            push_edge!(c, b);
            push_edge!(a, c);
            push_vertex!(a);
            if z == 0 || z == 15 {
                push_vertex!(b);
            }
            if w == 0 || w == 15 {
                push_vertex!(c);
            }
        }
        if unsafe { !(put(target, wide, t * 3, a) & put(target, wide, t * 3 + 1, b) & put(target, wide, t * 3 + 2, c)) } {
            return 1;
        }
    }
    (data.pos != tail) as i32
}

/// Decodes an index sequence. `wide` is 1 for 32-bit output.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn decode_sequence(source: *const u8, length: usize, target: *mut u8, count: usize, wide: i32) -> i32 {
    let src = unsafe { core::slice::from_raw_parts(source, length) };
    if length < 1 + count + 4 || src[0] >> 4 != 0xd || src[0] & 15 > 1 {
        return 1;
    }
    let tail = length - 4;
    let mut baselines = [0u32; 2];
    let mut data = Reader { src, pos: 1 };
    for i in 0..count {
        if data.pos >= tail {
            return 1;
        }
        let Some(v) = data.varint() else { return 1 };
        let which = (v & 1) as usize;
        let delta = if v & 2 != 0 { !(v >> 2) } else { v >> 2 };
        baselines[which] = baselines[which].wrapping_add(delta);
        if unsafe { !put(target, wide != 0, i, baselines[which]) } {
            return 1;
        }
    }
    (data.pos != tail) as i32
}

const ROUND_BIAS: f32 = 12582912.0;

#[inline(always)]
fn round_even(v: f32) -> i32 {
    ((v + ROUND_BIAS) - ROUND_BIAS) as i32
}

#[inline(always)]
unsafe fn read16(at: *const u8) -> i32 {
    unsafe { (at as *const i16).read_unaligned() as i32 }
}

#[inline(always)]
unsafe fn write16(at: *mut u8, v: i32) {
    unsafe { (at as *mut i16).write_unaligned(v as i16) }
}

/// OCTAHEDRAL filter in place.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn filter_octahedral(data: *mut u8, count: usize, stride: usize) {
    let wide = stride == 8;
    let max: f32 = if wide { 32767.0 } else { 127.0 };
    let step = if wide { 2 } else { 1 };
    let get = |at: *const u8| unsafe { if wide { read16(at) } else { *(at as *const i8) as i32 } };
    let set = |at: *mut u8, v: i32| unsafe {
        if wide {
            write16(at, v)
        } else {
            *at = v as u8
        }
    };
    for i in 0..count {
        unsafe {
            let at = data.add(i * stride);
            let mut x = get(at);
            let mut y = get(at.add(step));
            let one = get(at.add(2 * step));
            let z = one - x.abs() - y.abs();
            if z < 0 {
                x += if x >= 0 { z } else { -z };
                y += if y >= 0 { z } else { -z };
            }
            let (fx, fy, fz) = (x as f32, y as f32, z as f32);
            let length = fx * fx + (fy * fy + fz * fz);
            if length == 0.0 {
                set(at, 0);
                set(at.add(step), 0);
                set(at.add(2 * step), 0);
                continue;
            }
            let scale = max / length.sqrt();
            set(at, round_even(fx * scale));
            set(at.add(step), round_even(fy * scale));
            set(at.add(2 * step), round_even(fz * scale));
        }
    }
}

/// QUATERNION filter in place.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn filter_quaternion(data: *mut u8, count: usize) {
    let range = (32767.0f64 / core::f64::consts::SQRT_2) as f32;
    for i in 0..count {
        unsafe {
            let at = data.add(i * 8);
            let (x, y, z) = (read16(at) as f32, read16(at.add(2)) as f32, read16(at.add(4)) as f32);
            let packed = read16(at.add(6));
            let largest = (packed & 3) as usize;
            let one = (packed | 3) as f32;
            let w_squared = 2.0 * (one * one) - (x * x + (y * y + z * z));
            let w = w_squared.max(0.0).sqrt();
            let scale = range / one;
            write16(at.add(((largest + 1) & 3) * 2), round_even(x * scale));
            write16(at.add(((largest + 2) & 3) * 2), round_even(y * scale));
            write16(at.add(((largest + 3) & 3) * 2), round_even(z * scale));
            write16(at.add(largest * 2), round_even(w * scale));
        }
    }
}

/// EXPONENTIAL filter in place, over `words` 32-bit values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn filter_exponential(data: *mut u8, words: usize) {
    for i in 0..words {
        unsafe {
            let at = data.add(i * 4) as *mut i32;
            let v = at.read_unaligned();
            let scale = f64::from_bits(((1023 + (v >> 24)) as u64) << 52);
            (at as *mut f32).write_unaligned((((v << 8) >> 8) as f64 * scale) as f32);
        }
    }
}

/// COLOR filter in place.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn filter_color(data: *mut u8, count: usize, stride: usize) {
    let wide = stride == 8;
    let max: f32 = if wide { 65535.0 } else { 255.0 };
    let step = if wide { 2 } else { 1 };
    let get_unsigned = |at: *const u8| unsafe { if wide { (at as *const u16).read_unaligned() as i32 } else { *at as i32 } };
    let get_signed = |at: *const u8| unsafe { if wide { read16(at) } else { *(at as *const i8) as i32 } };
    let set = |at: *mut u8, v: f32| unsafe {
        let bits = (v + ROUND_BIAS).to_bits();
        if wide {
            (at as *mut u16).write_unaligned(bits as u16)
        } else {
            *at = bits as u8
        }
    };
    for i in 0..count {
        unsafe {
            let at = data.add(i * stride);
            let luma = get_unsigned(at);
            let co = get_signed(at.add(step));
            let cg = get_signed(at.add(2 * step));
            let alpha = get_unsigned(at.add(3 * step));
            let mask: i32 = if alpha == 0 { 0 } else { ((1u64 << (32 - (alpha as u32).leading_zeros())) - 1) as i32 };
            let scale = max / mask as f32;
            set(at, (luma + co - cg) as f32 * scale);
            set(at.add(step), (luma + cg) as f32 * scale);
            set(at.add(2 * step), (luma - co - cg) as f32 * scale);
            set(at.add(3 * step), (((alpha << 1) & mask) | (alpha & 1)) as f32 * scale);
        }
    }
}
