use core::arch::wasm32::{f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, v128, v128_load};
use core::num::NonZeroUsize;

#[repr(C)]
struct Work {
    rows: u32,
    paired_rows: u32,
    layer_rows: u32,
}

#[repr(C)]
struct Publication {
    count: usize,
    data: *const f64,
    diagnostic: *const f64,
    output: *mut [f64; 12],
    layers: *const f64,
    work: *mut Work,
}

impl Publication {
    unsafe fn row(&self, i: usize, derived: [f64; 4]) -> bool {
        let n = self.count;
        let d = |column| unsafe { *self.diagnostic.add(column * n + i) };
        let q = |column| unsafe { *self.data.add(column * n + i) };
        let [sea_temp, temp, east_ivt, north_ivt] = derived;
        let pressure = d(3);
        let row = [
            pressure,
            d(1),
            d(2),
            d(4),
            sea_temp,
            temp,
            q(1),
            q(2),
            q(3),
            d(5),
            east_ivt,
            north_ivt,
        ];
        if pressure <= 0.0 || row.iter().any(|value| !value.is_finite()) {
            return false;
        }
        unsafe { self.output.add(i).write(row) };
        true
    }

    unsafe fn pair(&self, i: usize) -> bool {
        let n = self.count;
        let load = |p: *const f64| unsafe { v128_load(p.cast::<v128>()) };
        let d = |column| unsafe { load(self.diagnostic.add(column * n + i)) };
        let q = unsafe { load(self.data.add(n + i)) };
        let anomaly = if self.layers.is_null() {
            f64x2_splat(0.0)
        } else {
            unsafe { load(self.layers.add(4 * n + i)) }
        };
        let sea_temp = f64x2_add(d(6), anomaly);
        let temp = f64x2_add(d(7), anomaly);
        let east_ivt = f64x2_mul(q, d(1));
        let north_ivt = f64x2_mul(q, d(2));
        unsafe {
            self.row(i, extract::<0>(sea_temp, temp, east_ivt, north_ivt))
                && self.row(i + 1, extract::<1>(sea_temp, temp, east_ivt, north_ivt))
        }
    }

    unsafe fn tail(&self, i: usize) -> bool {
        let n = self.count;
        let d = |column| unsafe { *self.diagnostic.add(column * n + i) };
        let q = unsafe { *self.data.add(n + i) };
        let anomaly = if self.layers.is_null() {
            0.0
        } else {
            unsafe { *self.layers.add(4 * n + i) }
        };
        unsafe { self.row(i, [d(6) + anomaly, d(7) + anomaly, q * d(1), q * d(2)]) }
    }
}

fn extract<const LANE: usize>(a: v128, b: v128, c: v128, d: v128) -> [f64; 4] {
    [
        f64x2_extract_lane::<LANE>(a),
        f64x2_extract_lane::<LANE>(b),
        f64x2_extract_lane::<LANE>(c),
        f64x2_extract_lane::<LANE>(d),
    ]
}

// Source fields are immutable throughout this phase. Pair-aligned destinations
// and work records are disjoint, and the caller publishes only after all join.
#[unsafe(no_mangle)]
unsafe extern "C" fn synoptic_publish_phase(
    job: *const Publication,
    stage: u32,
    part: usize,
    participants: usize,
) -> u32 {
    if stage != 0 || !matches!(participants, 1 | 2 | 4) || part >= participants {
        return 1;
    }
    let stride =
        NonZeroUsize::new(participants).unwrap_or_else(|| core::arch::wasm32::unreachable());
    let job = unsafe { &*job };
    let pairs = job.count / 2;
    let lo = 2 * (part * pairs / stride.get());
    let hi = 2 * ((part + 1) * pairs / stride.get());
    for i in (lo..hi).step_by(2) {
        if !unsafe { job.pair(i) } {
            return 2;
        }
    }
    let tail = part + 1 == participants && hi < job.count;
    if tail && !unsafe { job.tail(hi) } {
        return 2;
    }
    let rows = (hi - lo) as u32 + u32::from(tail);
    unsafe {
        job.work.add(part).write(Work {
            rows,
            paired_rows: (hi - lo) as u32,
            layer_rows: if job.layers.is_null() { 0 } else { rows },
        });
    }
    0
}
