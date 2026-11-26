use super::{Grid, Words, backward, flow, forward, transport};

#[derive(Clone, Copy)]
struct Complex(f64, f64);

impl Complex {
    fn add(self, b: Self) -> Self {
        Self(self.0 + b.0, self.1 + b.1)
    }
    fn scale(self, b: f64) -> Self {
        Self(self.0 * b, self.1 * b)
    }
    fn mul(self, b: Self) -> Self {
        Self(self.0 * b.0 - self.1 * b.1, self.0 * b.1 + self.1 * b.0)
    }
    fn divide(self, b: Self) -> Self {
        self.mul(Self(b.0, -b.1))
            .scale(1.0 / (b.0 * b.0 + b.1 * b.1))
    }
}

// The Phillips two-layer inversion separates the vertically averaged and thickness modes.
fn coefficients(laplace: f64, thickness: f64) -> (f64, f64) {
    (0.5 * (laplace + thickness), 0.5 * (laplace - thickness))
}

fn streamfunction(
    grid: Grid,
    pv: &Words,
    psi: &mut Words,
    a: &mut Words,
    b: &mut Words,
    modes: &Words,
    table: &[f64],
) {
    let n = grid.nx * grid.nz;
    forward(grid, &pv[..n], a, table);
    forward(grid, &pv[n..], b, table);
    for i in 0..n {
        let (same, other) = coefficients(modes[i], modes[n + i]);
        for at in [2 * i, 2 * i + 1] {
            let left = a[at];
            let right = b[at];
            a[at] = same * left + other * right;
            b[at] = other * left + same * right;
        }
    }
    backward(grid, &mut psi[..n], a, table);
    backward(grid, &mut psi[n..], b, table);
}

struct WindShear {
    lower: [f64; 2],
    upper: [f64; 2],
    beta: f64,
    stretching: f64,
    cfl_bound: f64,
}

fn linear_step(
    grid: Grid,
    pv: &mut Words,
    a: &mut Words,
    b: &mut Words,
    modes: &Words,
    table: &[f64],
    shear: &WindShear,
    dt: f64,
) {
    let n = grid.nx * grid.nz;
    forward(grid, &pv[..n], a, table);
    forward(grid, &pv[n..], b, table);
    for i in 1..n {
        let k = modes[2 * n + i];
        let l = modes[3 * n + i];
        let lower = k * shear.lower[0] + l * shear.lower[1];
        let upper = k * shear.upper[0] + l * shear.upper[1];
        let stretching = shear.stretching * (lower - upper);
        let bg_lower = k * shear.beta + stretching;
        let bg_upper = k * shear.beta - stretching;
        let (same, other) = coefficients(modes[i], modes[n + i]);
        let scale = 0.5 * dt;
        let m00 = scale * (lower + bg_lower * same);
        let m01 = scale * bg_lower * other;
        let m10 = scale * bg_upper * other;
        let m11 = scale * (upper + bg_upper * same);
        let at = 2 * i;
        let q1 = Complex(a[at], a[at + 1]);
        let q2 = Complex(b[at], b[at + 1]);
        // Crank–Nicolson on ∂t q = -i M q retains propagating modes and the growing shear branch.
        let r1 = q1.mul(Complex(1.0, -m00)).add(q2.mul(Complex(0.0, -m01)));
        let r2 = q2.mul(Complex(1.0, -m11)).add(q1.mul(Complex(0.0, -m10)));
        let determinant = Complex(1.0 - m00 * m11 + m01 * m10, m00 + m11);
        let next1 = r1
            .mul(Complex(1.0, m11))
            .add(r2.mul(Complex(0.0, -m01)))
            .divide(determinant);
        let next2 = r2
            .mul(Complex(1.0, m00))
            .add(r1.mul(Complex(0.0, -m10)))
            .divide(determinant);
        a[at] = next1.0;
        a[at + 1] = next1.1;
        b[at] = next2.0;
        b[at + 1] = next2.1;
    }
    backward(grid, &mut pv[..n], a, table);
    backward(grid, &mut pv[n..], b, table);
}

/// Advances layered potential vorticity and writes the lower relative vorticity for rain and surface weather.
/// The host supplies disjoint world arena regions and dimensions validated before their allocation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn advance_synoptic_layers(
    pv: *mut f64,
    output: *mut f64,
    work: *mut f64,
    lower_vorticity: *mut f64,
    modes: *const f64,
    twiddles: *const f64,
    base: *const f64,
    layered: *const f64,
) -> f64 {
    let base = Words::read(unsafe { core::slice::from_raw_parts(base, 16) });
    let layered = Words::read(unsafe { core::slice::from_raw_parts(layered, 5) });
    let grid = Grid {
        nx: base[0] as usize,
        nz: base[1] as usize,
        dx: base[2],
        dz: base[3],
    };
    let n = grid.nx * grid.nz;
    let shear = WindShear {
        lower: [base[5], base[6]],
        upper: [layered[0], layered[1]],
        beta: base[8],
        stretching: layered[2],
        cfl_bound: layered[3],
    };
    let pv = Words::write(unsafe { core::slice::from_raw_parts_mut(pv, 2 * n) });
    let mode = Words::read(unsafe { core::slice::from_raw_parts(modes, 4 * n) });
    let table = unsafe { core::slice::from_raw_parts(twiddles, 2 * grid.nx.max(grid.nz)) };
    let diag = Words::write(unsafe { core::slice::from_raw_parts_mut(output, 5 * n) });
    let work = Words::write(unsafe { core::slice::from_raw_parts_mut(work, 10 * n) });
    let lower = Words::write(unsafe { core::slice::from_raw_parts_mut(lower_vorticity, n) });
    // 4n FFT words, four face fields, and two SSP-RK stages. Split each borrowed range once.
    let (a, rest) = work
        .split_at_mut_checked(2 * n)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let a = Words::write(a);
    let (b, rest) = rest
        .split_at_mut_checked(2 * n)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (le, rest) = rest
        .split_at_mut_checked(n)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (ln, rest) = rest
        .split_at_mut_checked(n)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (ue, rest) = rest
        .split_at_mut_checked(n)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (un, rest) = rest
        .split_at_mut_checked(n)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let (first, second) = rest
        .split_at_mut_checked(n)
        .unwrap_or_else(|| core::arch::wasm32::unreachable());
    let b = Words::write(b);
    let mut remaining = base[4];
    let mut steps = 0.0;
    loop {
        streamfunction(
            grid,
            pv,
            Words::write(&mut diag[..2 * n]),
            a,
            b,
            mode,
            table,
        );
        let low_rate = flow(grid, &diag[..n], le, ln, [0.0, 0.0]);
        let upper_rate = flow(grid, &diag[n..2 * n], ue, un, [0.0, 0.0]);
        if remaining <= 0.0 {
            break;
        }
        let dt = remaining.min(0.4 / (low_rate.max(upper_rate) + shear.cfl_bound));
        if !dt.is_finite() || dt <= 0.0 || remaining - dt >= remaining {
            return f64::NAN;
        }
        for (start, east, north) in [(0, &*le, &*ln), (n, &*ue, &*un)] {
            let state = &mut pv[start..start + n];
            transport(grid, state, first, east, north, dt, true);
            transport(grid, first, second, east, north, dt, true);
            for (value, &candidate) in state.iter_mut().zip(second.iter()) {
                *value = 0.5 * (*value + candidate);
            }
        }
        linear_step(grid, pv, a, b, mode, table, &shear, dt);
        steps += 1.0;
        remaining -= dt;
    }
    let u = Words::read(ue);
    let v = Words::read(un);
    for i in 0..n {
        let (e, w, north, south) = grid.neighbours(i);
        let psi = diag[i];
        lower[i] = (diag[e] + diag[w] - 2.0 * psi) / (grid.dx * grid.dx)
            + (diag[north] + diag[south] - 2.0 * psi) / (grid.dz * grid.dz);
        diag[2 * n + i] = shear.upper[0] + 0.5 * (u[i] + u[w]);
        diag[3 * n + i] = shear.upper[1] + 0.5 * (v[i] + v[south]);
        diag[4 * n + i] = layered[4] * (diag[n + i] - psi);
    }
    steps
}
