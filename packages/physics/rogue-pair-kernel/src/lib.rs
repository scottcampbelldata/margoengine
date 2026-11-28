#![no_std]
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_mul, f64x2_neg, f64x2_sub, v128, v128_load, v128_store,
};
use core::ops::{Add, Mul, Neg, Sub};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Job {
    basis: *const f64,
    coefficients: *const f64,
    tile: *mut f64,
    answer: *mut [f64; 3],
    work: *mut Work,
    components: usize,
    total_pairs: usize,
    start: usize,
    count: usize,
    mode: u32,
}

#[repr(C)]
struct Work {
    tiles: u32,
    pairs: u32,
    paired_pairs: u32,
}

const _: [(); 40] = [(); core::mem::size_of::<Job>()];
const _: [(); 12] = [(); core::mem::size_of::<Work>()];

struct Cursor {
    i: usize,
    j: usize,
}

impl Cursor {
    fn new(n: usize, pair: usize) -> Self {
        let row = |i| i * (2 * n - i + 1) / 2;
        let mut lo = 0;
        let mut hi = n;
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if row(mid) > pair {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Self {
            i: lo,
            j: lo + pair - row(lo),
        }
    }

    fn advance(&mut self, n: usize) {
        self.j += 1;
        if self.j == n {
            self.i += 1;
            self.j = self.i;
        }
    }
}

#[derive(Clone, Copy)]
struct Pair(v128);

impl Add for Pair {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self(f64x2_add(self.0, rhs.0))
    }
}

impl Sub for Pair {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self(f64x2_sub(self.0, rhs.0))
    }
}

impl Mul for Pair {
    type Output = Self;
    fn mul(self, rhs: Self) -> Self {
        Self(f64x2_mul(self.0, rhs.0))
    }
}

impl Neg for Pair {
    type Output = Self;
    fn neg(self) -> Self {
        Self(f64x2_neg(self.0))
    }
}

/// Second-order sum and difference harmonics, Dalzell (1999), doi:10.1016/S0141-1187(99)00008-5;
/// Adcock and Draper (2015), Eqs. (2) and (3). Each lane is a distinct upper-triangular pair.
/// Keep the products and additions in the same grouping as the TypeScript query path.
fn contribution<T, const SLOPES: bool, const ENVELOPE: bool>(
    i: impl Fn(usize) -> T,
    j: impl Fn(usize) -> T,
    bp: T,
    bm: T,
) -> [T; 3]
where
    T: Copy + Add<Output = T> + Sub<Output = T> + Mul<Output = T> + Neg<Output = T>,
{
    let ri = i(2);
    let qi = i(3);
    let rj = j(2);
    let qj = j(3);
    let rr = ri * rj;
    let qq = qi * qj;
    let height = bp * (rr - qq) + bm * (rr + qq);
    if !SLOPES {
        return [height; 3];
    }
    let both = qi * rj + ri * qj;
    let cross = ri * qj - qi * rj;
    let slope = |axis: usize| {
        let ki = i(axis);
        let kj = j(axis);
        let phase = -bp * (ki + kj) * both + bm * (ki - kj) * cross;
        if ENVELOPE {
            let derivative = 4 + 2 * axis;
            let dr = i(derivative) * rj + ri * j(derivative);
            let dq = i(derivative + 1) * qj + qi * j(derivative + 1);
            phase + (bp * (dr - dq) + bm * (dr + dq))
        } else {
            phase
        }
    };
    [height, slope(0), slope(1)]
}

impl Job {
    fn valid(&self) -> bool {
        self.components > 0
            && self.count > 0
            && self.start <= self.total_pairs
            && self.count <= self.total_pairs - self.start
            && self.mode <= 2
    }

    unsafe fn evaluate<const SLOPES: bool, const ENVELOPE: bool>(&self, lo: usize, hi: usize) {
        if hi == lo {
            return;
        }
        let n = self.components;
        let mut cursor = Cursor::new(n, self.start + lo);
        let mut at = lo;
        let bp = unsafe { self.coefficients.add(self.start) };
        let bm = unsafe { bp.add(self.total_pairs) };
        let basis = |axis, row| unsafe { *self.basis.add(axis * n + row) };
        while at + 1 < hi {
            let (i, j) = (cursor.i, cursor.j);
            cursor.advance(n);
            let left = |axis| Pair(f64x2(basis(axis, i), basis(axis, cursor.i)));
            let right = |axis| Pair(f64x2(basis(axis, j), basis(axis, cursor.j)));
            let [height, dx, dz] = unsafe {
                contribution::<_, SLOPES, ENVELOPE>(
                    left,
                    right,
                    Pair(v128_load(bp.add(at).cast())),
                    Pair(v128_load(bm.add(at).cast())),
                )
            };
            unsafe {
                v128_store(self.tile.add(at).cast(), height.0);
                if SLOPES {
                    v128_store(self.tile.add(self.count + at).cast(), dx.0);
                    v128_store(self.tile.add(2 * self.count + at).cast(), dz.0);
                }
            }
            at += 2;
            cursor.advance(n);
        }
        if at < hi {
            let [height, dx, dz] = unsafe {
                contribution::<_, SLOPES, ENVELOPE>(
                    |axis| basis(axis, cursor.i),
                    |axis| basis(axis, cursor.j),
                    *bp.add(at),
                    *bm.add(at),
                )
            };
            unsafe {
                self.tile.add(at).write(height);
                if SLOPES {
                    self.tile.add(self.count + at).write(dx);
                    self.tile.add(2 * self.count + at).write(dz);
                }
            }
        }
    }

    unsafe fn reduce<const SLOPES: bool, const ENVELOPE: bool>(&self) {
        let n = self.components;
        let mut cursor = Cursor::new(n, self.start);
        let [mut height, mut dx, mut dz] = unsafe { *self.answer };
        let read = |axis, i| unsafe { *self.basis.add(axis * n + i) };
        for at in 0..self.count {
            if cursor.i == cursor.j {
                height += read(2, cursor.i);
                if SLOPES {
                    let qi = read(3, cursor.i);
                    if ENVELOPE {
                        dx += read(4, cursor.i) - read(0, cursor.i) * qi;
                        dz += read(6, cursor.i) - read(1, cursor.i) * qi;
                    } else {
                        dx -= read(0, cursor.i) * qi;
                        dz -= read(1, cursor.i) * qi;
                    }
                }
            }
            unsafe {
                height += *self.tile.add(at);
                if SLOPES {
                    dx += *self.tile.add(self.count + at);
                    dz += *self.tile.add(2 * self.count + at);
                }
            }
            cursor.advance(n);
        }
        unsafe { self.answer.write([height, dx, dz]) };
    }
}

/// Safety: the private loader validates and stages all ranges, and each part owns disjoint rows.
#[unsafe(no_mangle)]
unsafe extern "C" fn rogue_pair_thread_phase(
    job: &Job,
    stage: u32,
    part: usize,
    parts: usize,
) -> u32 {
    if !job.valid() || stage != 0 || !matches!(parts, 1 | 2 | 4) || part >= parts {
        return 1;
    }
    let pairs = job.count / 2;
    let lo = 2 * (pairs * part / parts);
    let hi = if part + 1 == parts {
        job.count
    } else {
        2 * (pairs * (part + 1) / parts)
    };
    unsafe {
        match job.mode {
            0 => job.evaluate::<false, false>(lo, hi),
            1 => job.evaluate::<true, false>(lo, hi),
            _ => job.evaluate::<true, true>(lo, hi),
        }
        if hi > lo {
            let work = &mut *job.work.add(part);
            work.tiles += 1;
            work.pairs += (hi - lo) as u32;
            work.paired_pairs += ((hi - lo) / 2 * 2) as u32;
        }
    }
    0
}

/// Safety: the private loader joins all writers before calling the ordered reduction.
#[unsafe(no_mangle)]
unsafe extern "C" fn rogue_pair_reduce(job: &Job) -> u32 {
    if !job.valid() {
        return 1;
    }
    unsafe {
        match job.mode {
            0 => job.reduce::<false, false>(),
            1 => job.reduce::<true, false>(),
            _ => job.reduce::<true, true>(),
        }
    }
    0
}
