// Margo-owned draft: same ordered integer erosion as biomes/erosion.ts.
// Direction, seen and lake share one byte. Filled/order become wear/deposit after the last route.
const ONE: i64 = 65536;
const LIMIT: i32 = 33554432;
const CELLS: usize = 4194304;
const DX: [i32; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ: [i32; 8] = [0, 1, 1, 1, 0, -1, -1, -1];
const SEEN: i8 = 32;
const LAKE: i8 = 16;
fn direction(value: i8) -> i32 {
    (value as i32 & 15) - 1
}
fn lake(value: i8) -> bool {
    value & LAKE != 0
}
fn scale(x: i64, k: i64) -> i64 {
    x / ONE * k + (x % ONE * k) / ONE
}

struct Work {
    nx: usize,
    nz: usize,
    h: Vec<i32>,
    filled: Vec<i32>,
    flags: Vec<i8>,
    order: Vec<i32>,
    area: Vec<i32>,
    heap: Vec<u64>,
}
impl Work {
    fn push(&mut self, cell: usize, level: i32, dir: i32, size: &mut usize) {
        self.filled[cell] = level;
        self.flags[cell] = SEEN | if level > self.h[cell] { LAKE } else { 0 } | (dir + 1) as i8;
        // Unsigned packed keys preserve the JS height/index ordering exactly, including negative heights.
        let key = ((level as i64 + LIMIT as i64) as u64) * CELLS as u64 + cell as u64;
        let mut at = *size;
        *size += 1;
        while at > 0 {
            let up = (at - 1) >> 1;
            if self.heap[up] <= key {
                break;
            }
            self.heap[at] = self.heap[up];
            at = up;
        }
        self.heap[at] = key;
    }
    fn route(&mut self, sea: Option<f64>) {
        self.flags.fill(0);
        self.area.fill(1);
        let mut size = 0usize;
        let mut head = 0usize;
        for z in 0..self.nz {
            for x in 0..self.nx {
                let cell = z * self.nx + x;
                if x == 0
                    || z == 0
                    || x + 1 == self.nx
                    || z + 1 == self.nz
                    || sea.is_some_and(|s| (self.h[cell] as f64) < s)
                {
                    self.push(cell, self.h[cell], -1, &mut size);
                }
            }
        }
        while size > 0 {
            let cell = (self.heap[0] & (CELLS as u64 - 1)) as usize;
            size -= 1;
            let last = self.heap[size];
            let mut at = 0;
            let mut child = 1;
            while child < size {
                if child + 1 < size && self.heap[child + 1] < self.heap[child] {
                    child += 1;
                }
                if self.heap[child] >= last {
                    break;
                }
                self.heap[at] = self.heap[child];
                at = child;
                child = 2 * at + 1;
            }
            self.heap[at] = last;
            self.order[head] = cell as i32;
            head += 1;
            let z = (cell / self.nx) as i32;
            let x = (cell % self.nx) as i32;
            for d in 0..8 {
                let u = x + DX[d];
                let v = z + DZ[d];
                if u < 0 || v < 0 || u >= self.nx as i32 || v >= self.nz as i32 {
                    continue;
                }
                let i = v as usize * self.nx + u as usize;
                if self.flags[i] & SEEN != 0 {
                    continue;
                }
                self.push(
                    i,
                    self.h[i].max(self.filled[cell]),
                    ((d + 4) & 7) as i32,
                    &mut size,
                );
            }
        }
        for q in (0..self.h.len()).rev() {
            let c = self.order[q] as usize;
            let d = direction(self.flags[c]);
            if d >= 0 {
                let p = (c as i64 + DZ[d as usize] as i64 * self.nx as i64 + DX[d as usize] as i64)
                    as usize;
                self.area[p] += self.area[c];
            }
        }
    }
    fn slide(&mut self, rate: i64, straight: i64, diagonal: i64, backward: bool) {
        let n = self.h.len();
        for q in 0..n {
            let c = if backward { n - 1 - q } else { q };
            let z = (c / self.nx) as i32;
            let x = (c % self.nx) as i32;
            let mut ex = [0i64; 8];
            let mut best = 0;
            let mut sum = 0;
            let mut steep = 0;
            for d in 0..8 {
                let u = x + DX[d];
                let v = z + DZ[d];
                if u < 0 || v < 0 || u >= self.nx as i32 || v >= self.nz as i32 {
                    continue;
                }
                let e = self.h[c] as i64
                    - self.h[v as usize * self.nx + u as usize] as i64
                    - if d & 1 == 1 { diagonal } else { straight };
                if e <= 0 {
                    continue;
                }
                ex[d] = e;
                sum += e;
                if e > best {
                    best = e;
                    steep = d;
                }
            }
            let amount = best * rate / ONE;
            if amount == 0 {
                continue;
            }
            let mut left = amount;
            for d in 0..8 {
                if ex[d] == 0 || d == steep {
                    continue;
                }
                let part = amount * ex[d] / sum;
                let p = (c as i64 + DZ[d] as i64 * self.nx as i64 + DX[d] as i64) as usize;
                self.h[p] += part as i32;
                left -= part;
            }
            let p = (c as i64 + DZ[steep] as i64 * self.nx as i64 + DX[steep] as i64) as usize;
            self.h[p] += left as i32;
            self.h[c] -= amount as i32;
        }
    }
    fn flow(
        &mut self,
        step: i64,
        capacity: i64,
        incision: i64,
        deposition: i64,
        load: &mut [i64],
    ) -> i64 {
        let diagonal = step * 92682 / ONE;
        load.fill(0);
        let mut out = 0;
        for q in (0..self.order.len()).rev() {
            let c = self.order[q] as usize;
            let d = direction(self.flags[c]);
            let mut carried = load[c];
            if d < 0 {
                out += carried;
                continue;
            }
            let d = d as usize;
            let p = (c as i64 + DZ[d] as i64 * self.nx as i64 + DX[d] as i64) as usize;
            if lake(self.flags[c]) {
                let settle = carried.min((self.filled[c] - self.h[c]) as i64);
                self.h[c] += settle as i32;
                carried -= settle;
            } else {
                let drop = (self.h[c] - self.h[p]) as i64;
                let tan = (drop * ONE)
                    .div_euclid(if d & 1 == 1 { diagonal } else { step })
                    .min(8 * ONE);
                let can = scale(scale(self.area[c] as i64 * step, tan), capacity);
                if carried < can {
                    let cut = drop.min(scale(can - carried, incision));
                    self.h[c] -= cut as i32;
                    carried += cut;
                } else if carried > can {
                    let z = (c / self.nx) as i32;
                    let x = (c % self.nx) as i32;
                    let mut low = i32::MAX;
                    for k in 0..8 {
                        let u = x - DX[k];
                        let v = z - DZ[k];
                        if u < 0 || v < 0 || u >= self.nx as i32 || v >= self.nz as i32 {
                            continue;
                        }
                        let i = v as usize * self.nx + u as usize;
                        if direction(self.flags[i]) == k as i32 && !lake(self.flags[i]) {
                            low = low.min(self.h[i]);
                        }
                    }
                    if low != i32::MAX {
                        let settle =
                            ((low - self.h[c]) as i64).min(scale(carried - can, deposition));
                        self.h[c] += settle as i32;
                        carried -= settle;
                    }
                }
            }
            load[p] += carried;
        }
        out
    }
}
pub struct ResultData {
    h: Vec<i32>,
    flow: Vec<i32>,
    dir: Vec<i8>,
    wear: Vec<i32>,
    deposit: Vec<i32>,
    outflow: i64,
    vector_blocks: usize,
}

// Heights stay in [-2^25,2^25], so a signed i32 difference and negation cannot overflow.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn differences(original: &[i32], h: &[i32], wear: &mut [i32], deposit: &mut [i32]) -> usize {
    use core::arch::wasm32::*;
    let blocks = h.len() / 4;
    let zero = i32x4_splat(0);
    for k in 0..blocks {
        let c = k * 4;
        let change = i32x4_sub(
            v128_load(h.as_ptr().add(c).cast()),
            v128_load(original.as_ptr().add(c).cast()),
        );
        v128_store(
            wear.as_mut_ptr().add(c).cast(),
            i32x4_max(i32x4_sub(zero, change), zero),
        );
        v128_store(deposit.as_mut_ptr().add(c).cast(), i32x4_max(change, zero));
    }
    for c in blocks * 4..h.len() {
        let change = h[c] - original[c];
        wear[c] = (-change).max(0);
        deposit[c] = change.max(0);
    }
    blocks
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn differences(original: &[i32], h: &[i32], wear: &mut [i32], deposit: &mut [i32]) -> usize {
    for c in 0..h.len() {
        let change = h[c] - original[c];
        wear[c] = (-change).max(0);
        deposit[c] = change.max(0);
    }
    0
}

#[no_mangle]
pub extern "C" fn allocate(n: usize) -> *mut i32 {
    if !(4..=CELLS).contains(&n) {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0i32; n].into_boxed_slice()) as *mut i32
}
/// Input remains caller-owned. Rates/thresholds are normalized by the TS facade using its fixed-point trig.
#[no_mangle]
pub unsafe extern "C" fn erode(
    input: *const i32,
    nx: usize,
    nz: usize,
    step: i64,
    rounds: u32,
    thermal: i64,
    straight: i64,
    diagonal: i64,
    capacity: i64,
    incision: i64,
    deposition: i64,
    sea: f64,
) -> *mut ResultData {
    let Some(n) = nx.checked_mul(nz) else {
        return std::ptr::null_mut();
    };
    if input.is_null()
        || nx < 2
        || nz < 2
        || n > CELLS
        || rounds > 1024
        || !(1..=1048576).contains(&step)
        || !(0..=ONE / 2).contains(&thermal)
        || !(0..=ONE).contains(&capacity)
        || !(0..=ONE).contains(&incision)
        || !(0..=ONE).contains(&deposition)
        || straight < 0
        || diagonal < 0
    {
        return std::ptr::null_mut();
    }
    let original = std::slice::from_raw_parts(input, n);
    if original.iter().any(|v| *v < -LIMIT || *v > LIMIT) {
        return std::ptr::null_mut();
    }
    let mut w = Work {
        nx,
        nz,
        h: original.to_vec(),
        filled: vec![0; n],
        flags: vec![0; n],
        order: vec![0; n],
        area: vec![0; n],
        heap: vec![0; n],
    };
    let mut load = if rounds != 0 && capacity != 0 && incision != 0 {
        vec![0i64; n]
    } else {
        Vec::new()
    };
    let sea = if sea.is_nan() { None } else { Some(sea) };
    let mut outflow = 0;
    for r in 0..rounds {
        if thermal != 0 {
            w.slide(thermal, straight, diagonal, r & 1 == 1);
        }
        if capacity != 0 && incision != 0 {
            w.route(sea);
            outflow += w.flow(step, capacity, incision, deposition, &mut load);
        }
    }
    w.route(sea);
    // Reuse two no-longer-needed arrays. No separately allocated wear/deposit arrays.
    let vector_blocks = differences(original, &w.h, &mut w.filled, &mut w.order);
    for value in &mut w.flags {
        *value = direction(*value) as i8;
    }
    Box::into_raw(Box::new(ResultData {
        h: w.h,
        flow: w.area,
        dir: w.flags,
        wear: w.filled,
        deposit: w.order,
        outflow,
        vector_blocks,
    }))
}
#[no_mangle]
pub unsafe extern "C" fn result_array(result: *const ResultData, field: u32) -> *const u8 {
    let r = &*result;
    match field {
        0 => r.h.as_ptr().cast(),
        1 => r.flow.as_ptr().cast(),
        2 => r.dir.as_ptr().cast(),
        3 => r.wear.as_ptr().cast(),
        4 => r.deposit.as_ptr().cast(),
        _ => std::ptr::null(),
    }
}
#[no_mangle]
pub unsafe extern "C" fn result_outflow(result: *const ResultData) -> f64 {
    (*result).outflow as f64
}
#[no_mangle]
pub unsafe extern "C" fn result_vector_blocks(result: *const ResultData) -> usize {
    (*result).vector_blocks
}
#[no_mangle]
pub unsafe extern "C" fn free_result(result: *mut ResultData) {
    drop(Box::from_raw(result));
}
#[no_mangle]
pub unsafe extern "C" fn free_input(input: *mut i32, n: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(input, n)));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_dimensions_before_reading_input() {
        unsafe {
            assert!(erode(
                std::ptr::null(),
                2049,
                2048,
                16000,
                1,
                16384,
                11200,
                15839,
                655,
                16384,
                32768,
                f64::NAN
            )
            .is_null());
        }
    }
    #[test]
    fn conserved_sediment_and_direction_flags_are_decoded() {
        let nx = 17;
        let nz = 19;
        let h: Vec<i32> = (0..nx * nz)
            .map(|i| 20000 + (i / nx) as i32 * 1800 + ((i % nx) as i32 - 8).abs() * 2500)
            .collect();
        unsafe {
            let r = erode(
                h.as_ptr(),
                nx,
                nz,
                16000,
                3,
                16384,
                11200,
                15839,
                655,
                16384,
                32768,
                f64::NAN,
            );
            assert!(!r.is_null());
            let r = Box::from_raw(r);
            assert!(r.dir.iter().all(|v| (-1..=7).contains(v)));
            assert_eq!(
                h.iter().map(|v| *v as i64).sum::<i64>()
                    - r.h.iter().map(|v| *v as i64).sum::<i64>(),
                r.outflow
            );
            assert_eq!(
                r.wear.iter().map(|v| *v as i64).sum::<i64>(),
                r.deposit.iter().map(|v| *v as i64).sum::<i64>() + r.outflow
            );
        }
    }
}
