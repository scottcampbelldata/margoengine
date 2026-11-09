#![cfg_attr(target_arch = "wasm32", no_std)]
// Clean room from Joy (1999), classical RK4 and the studies in docs/clean-room.md, batch 171.
// The TypeScript facade validates dimensions, lengths and allocation budgets before entering this ABI.
// One reservation per fresh instance. There is no allocator, retained host state or shared memory.
#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn reserve(bytes: usize) -> usize {
    unsafe extern "C" {
        static __heap_base: u8;
    }
    let start = (&raw const __heap_base) as usize;
    let pages = (start + bytes).div_ceil(65536);
    let current = core::arch::wasm32::memory_size::<0>();
    if pages > current && core::arch::wasm32::memory_grow::<0>(pages - current) == usize::MAX {
        return 0;
    }
    start
}

/// NaNs mark missing data. Infinities are malformed, including overflow on conversion to float32 upstream.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn validate(data: *const f32, start: usize, end: usize) -> u32 {
    for i in start..end {
        if unsafe { *data.add(i) }.is_infinite() {
            return 0;
        }
    }
    1
}

struct Field<'a> {
    dims: [usize; 3],
    bounds: &'a [f64],
    times: &'a [f64],
    values: &'a [f32], // frame-major, then planar u, v, w; x fastest
}

impl Field<'_> {
    fn frame(&self, frame: usize, p: [f64; 3]) -> Option<[f64; 3]> {
        let mut base = [0; 3];
        let mut fraction = [0.0; 3];
        for axis in 0..3 {
            let (lo, hi) = (self.bounds[2 * axis], self.bounds[2 * axis + 1]);
            if !p[axis].is_finite() || p[axis] < lo || p[axis] > hi {
                return None;
            }
            if self.dims[axis] > 1 {
                let f = ((p[axis] - lo) / (hi - lo)) * (self.dims[axis] - 1) as f64;
                // Domain checks make f nonnegative, so truncation is floor without a libm dependency.
                base[axis] = (f as usize).min(self.dims[axis] - 2);
                fraction[axis] = f - base[axis] as f64;
            }
        }
        let [nx, ny, nz] = self.dims;
        let samples = nx * ny * nz;
        let mut result = [0.0; 3];
        for z in 0..if nz > 1 { 2 } else { 1 } {
            for y in 0..2 {
                for x in 0..2 {
                    let weight = (if x == 0 {
                        1.0 - fraction[0]
                    } else {
                        fraction[0]
                    }) * (if y == 0 {
                        1.0 - fraction[1]
                    } else {
                        fraction[1]
                    }) * (if nz == 1 {
                        1.0
                    } else if z == 0 {
                        1.0 - fraction[2]
                    } else {
                        fraction[2]
                    });
                    if weight == 0.0 {
                        continue;
                    }
                    let index = base[0] + x + nx * (base[1] + y + ny * (base[2] + z));
                    for (component, out) in result.iter_mut().enumerate() {
                        let v = self.values[(frame * 3 + component) * samples + index] as f64;
                        if !v.is_finite() {
                            return None;
                        }
                        *out += weight * v;
                    }
                }
            }
        }
        Some(result)
    }

    fn sample(&self, p: [f64; 3], time: f64) -> Option<[f64; 3]> {
        if self.times.len() == 1 {
            return self.frame(0, p);
        }
        if time < self.times[0] || time > *self.times.last()? {
            return None;
        }
        // Exact frame times use only that frame: a missing sample in an inactive neighbour cannot poison it.
        let upper = self.times.partition_point(|&t| t <= time);
        let lower = upper - 1;
        let a = self.frame(lower, p)?;
        if self.times[lower] == time {
            return Some(a);
        }
        let b = self.frame(upper, p)?;
        let t = (time - self.times[lower]) / (self.times[upper] - self.times[lower]);
        Some(core::array::from_fn(|c| a[c] * (1.0 - t) + b[c] * t))
    }

    fn step(&self, p: [f64; 3], time: f64, next: f64) -> Option<[f64; 3]> {
        let h = next - time;
        let offset = |v: [f64; 3], scale: f64| core::array::from_fn(|c| p[c] + scale * v[c]);
        let k1 = self.sample(p, time)?;
        let k2 = self.sample(offset(k1, h / 2.0), time + h / 2.0)?;
        let k3 = self.sample(offset(k2, h / 2.0), time + h / 2.0)?;
        let k4 = self.sample(offset(k3, h), next)?;
        let result =
            core::array::from_fn(|c| p[c] + h * (k1[c] + 2.0 * k2[c] + 2.0 * k3[c] + k4[c]) / 6.0);
        self.sample(result, next)?;
        Some(result)
    }
}

/// One bounded chunk. Output xyzt for each accepted step; state retains the last accepted xyzt.
/// Low two result bits: 0=more, 1=end, 2=invalid sample/domain, 3=non-advancing time; upper bits=count.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn trace(
    values: *const f32,
    dimensions: *const u32,
    bounds: *const f64,
    times: *const f64,
    frames: usize,
    state: *mut f64,
    output: *mut f64,
    to: f64,
    step: f64,
    limit: usize,
) -> u32 {
    let dims = unsafe { core::slice::from_raw_parts(dimensions, 3) };
    let dims = [dims[0] as usize, dims[1] as usize, dims[2] as usize];
    let field = Field {
        dims,
        bounds: unsafe { core::slice::from_raw_parts(bounds, 6) },
        times: unsafe { core::slice::from_raw_parts(times, frames) },
        values: unsafe {
            core::slice::from_raw_parts(values, dims.iter().product::<usize>() * 3 * frames)
        },
    };
    let state = unsafe { core::slice::from_raw_parts_mut(state, 4) };
    if field
        .sample([state[0], state[1], state[2]], state[3])
        .is_none()
    {
        return 2;
    }
    let direction = if to >= state[3] { 1.0 } else { -1.0 };
    for count in 0..limit {
        if state[3] == to {
            return ((count as u32) << 2) | 1;
        }
        let mut next = if (to - state[3]).abs() <= step {
            to
        } else {
            state[3] + direction * step
        };
        // Do not integrate across a kink in the piecewise-linear temporal interpolant in one RK4 step.
        if frames > 1 && direction > 0.0 {
            let i = field.times.partition_point(|&t| t <= state[3]);
            if let Some(&t) = field.times.get(i) {
                next = next.min(t);
            }
        } else if frames > 1 {
            let i = field.times.partition_point(|&t| t < state[3]);
            if i > 0 {
                next = next.max(field.times[i - 1]);
            }
        }
        if next == state[3] {
            return ((count as u32) << 2) | 3;
        }
        let Some(p) = field.step([state[0], state[1], state[2]], state[3], next) else {
            return ((count as u32) << 2) | 2;
        };
        state.copy_from_slice(&[p[0], p[1], p[2], next]);
        unsafe { core::slice::from_raw_parts_mut(output.add(count * 4), 4) }.copy_from_slice(state);
    }
    ((limit as u32) << 2) | u32::from(state[3] == to)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporal_kink_and_physical_velocity() {
        let values = [
            vec![1.0; 4],
            vec![0.0; 8],
            vec![3.0; 4],
            vec![0.0; 8],
            vec![1.0; 4],
            vec![0.0; 8],
        ]
        .concat();
        let f = Field {
            dims: [2, 2, 1],
            bounds: &[-10.0, 10.0, -10.0, 10.0, 0.0, 0.0],
            times: &[0.0, 1.0, 2.0],
            values: &values,
        };
        assert_eq!(f.sample([0.0; 3], 0.5), Some([2.0, 0.0, 0.0]));
        assert_eq!(f.step([0.0; 3], 0.0, 1.0), Some([2.0, 0.0, 0.0]));
        assert!(f.sample([11.0, 0.0, 0.0], 0.0).is_none());
    }
    #[test]
    fn inactive_nan_and_plane_domain() {
        let mut values = vec![0.0; 24];
        values[12] = f32::NAN;
        let f = Field {
            dims: [2, 2, 1],
            bounds: &[0.0, 1.0, 0.0, 1.0, 0.0, 0.0],
            times: &[0.0, 1.0],
            values: &values,
        };
        assert_eq!(f.sample([0.0; 3], 0.0), Some([0.0; 3]));
        assert!(f.sample([0.0; 3], 0.5).is_none());
        assert_eq!(f.sample([1.0, 1.0, 0.0], 0.5), Some([0.0; 3]));
        assert!(f.sample([0.5, 0.5, 1.0], 0.0).is_none());
    }
}
