// Mann (1994), Part IB §1.3, equation (1.7): one 3D Fourier transform per wind component. Mixed-radix
// Stockham (1966, doi:10.1145/1464182.1464209), keeping the scalar K17 plan and arithmetic order.
use core::arch::wasm32::{f64x2, f64x2_add, f64x2_mul, f64x2_splat, i64x2_shuffle, v128};
use margoengine_physics_kernel_common::pinned::{cos, sin};
use std::cell::RefCell;

const TWO_PI: f64 = 6.283185307179586;

struct Rotation {
    real: v128,
    imaginary: v128,
}

impl Rotation {
    fn new(cosine: f64, sine: f64) -> Self {
        Self {
            real: f64x2(cosine, sine),
            imaginary: f64x2(-sine, cosine),
        }
    }

    #[inline]
    fn apply(&self, value: v128) -> v128 {
        let real = f64x2_mul(i64x2_shuffle::<0, 0>(value, value), self.real);
        let imaginary = f64x2_mul(i64x2_shuffle::<1, 1>(value, value), self.imaginary);
        f64x2_add(real, imaginary)
    }
}

struct Stage {
    sequences: usize,
    span: usize,
    radix: usize,
    roots: [usize; 25],
}

struct Axis {
    stages: Vec<Stage>,
    forward: Vec<Rotation>,
    inverse: Vec<Rotation>,
    a: Vec<v128>,
    b: Vec<v128>,
    products_per_line: u64,
}

fn zeros(length: usize) -> Option<Vec<v128>> {
    let mut values = Vec::new();
    values.try_reserve_exact(length).ok()?;
    values.resize(length, f64x2_splat(0.0));
    Some(values)
}

impl Axis {
    fn new(n: usize) -> Option<Self> {
        let mut stages = Vec::new();
        let mut length = n;
        let mut products_per_line = 0;
        for radix in [2, 3, 5] {
            while length % radix == 0 {
                let sequences = n / length;
                let span = length / radix;
                let mut roots = [0; 25];
                for k in 0..radix {
                    for j in 0..radix {
                        roots[k * radix + j] = ((j * k) % radix) * (n / radix);
                    }
                }
                stages.push(Stage {
                    sequences,
                    span,
                    radix,
                    roots,
                });
                length = span;
                // Each output word performs radix complex rotations and the final stage rotation.
                products_per_line += n as u64 * (radix + 1) as u64;
            }
        }
        if length != 1 {
            return None;
        }
        let (mut forward, mut inverse) = (Vec::new(), Vec::new());
        forward.try_reserve_exact(n).ok()?;
        inverse.try_reserve_exact(n).ok()?;
        for j in 0..n {
            let angle = (TWO_PI * j as f64) / n as f64;
            let (c, s) = (cos(angle), sin(angle));
            forward.push(Rotation::new(c, -s));
            inverse.push(Rotation::new(c, s));
        }
        Some(Self {
            stages,
            forward,
            inverse,
            a: zeros(n)?,
            b: zeros(n)?,
            products_per_line,
        })
    }

    fn transform(&mut self, grid: &mut [v128], inverse: bool, offset: usize, stride: usize) -> u64 {
        let (mut source, mut destination) = (&mut self.a, &mut self.b);
        for (i, value) in source.iter_mut().enumerate() {
            *value = grid[offset + i * stride];
        }
        let twiddles = if inverse {
            &self.inverse
        } else {
            &self.forward
        };
        for &Stage {
            sequences,
            span,
            radix,
            ref roots,
        } in &self.stages
        {
            for q in 0..sequences {
                for j in 0..span {
                    for (k, root_row) in roots[..radix * radix].chunks_exact(radix).enumerate() {
                        let mut sum = f64x2_splat(0.0);
                        for (l, &root) in root_row.iter().enumerate() {
                            let value = source[q + sequences * (j + span * l)];
                            sum = f64x2_add(sum, twiddles[root].apply(value));
                        }
                        // j < span and k < radix, so the exponent is always below the axis length.
                        destination[q + sequences * (k + radix * j)] =
                            twiddles[j * k * sequences].apply(sum);
                    }
                }
            }
            core::mem::swap(&mut source, &mut destination);
        }
        let scale = f64x2_splat(if inverse {
            1.0 / source.len() as f64
        } else {
            1.0
        });
        for (i, &value) in source.iter().enumerate() {
            grid[offset + i * stride] = f64x2_mul(value, scale);
        }
        self.products_per_line
    }
}

struct Plan {
    cells: [usize; 3],
    axes: [Axis; 3],
    grid: Vec<v128>,
}

impl Plan {
    fn transform(&mut self, inverse: bool) -> u64 {
        let [nx, ny, nz] = self.cells;
        let [x, y, z] = &mut self.axes;
        let mut products = 0;
        for k in 0..nz {
            for j in 0..ny {
                products += x.transform(&mut self.grid, inverse, nx * (j + ny * k), 1);
            }
        }
        if ny > 1 {
            for k in 0..nz {
                for i in 0..nx {
                    products += y.transform(&mut self.grid, inverse, i + nx * ny * k, nx);
                }
            }
        }
        if nz > 1 {
            for j in 0..ny {
                for i in 0..nx {
                    products += z.transform(&mut self.grid, inverse, i + nx * j, nx * ny);
                }
            }
        }
        products
    }
}

thread_local! {
    static PLAN: RefCell<Option<Plan>> = const { RefCell::new(None) };
}

#[unsafe(no_mangle)]
pub extern "C" fn mann_fft_init(nx: usize, ny: usize, nz: usize) -> i32 {
    let cells = [nx, ny, nz];
    if cells.iter().any(|&n| !(1..=1 << 24).contains(&n)) {
        return 1;
    }
    let Some(count) = nx.checked_mul(ny).and_then(|n| n.checked_mul(nz)) else {
        return 1;
    };
    let Some((x, y, z)) = Axis::new(nx)
        .zip(Axis::new(ny))
        .zip(Axis::new(nz))
        .map(|((x, y), z)| (x, y, z))
    else {
        return 1;
    };
    let Some(grid) = zeros(count) else { return 1 };
    PLAN.with(|plan| {
        *plan.borrow_mut() = Some(Plan {
            cells,
            axes: [x, y, z],
            grid,
        })
    });
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn mann_fft_buffer() -> *mut f64 {
    PLAN.with(|plan| {
        plan.borrow_mut()
            .as_mut()
            .map_or(std::ptr::null_mut(), |plan| plan.grid.as_mut_ptr().cast())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mann_fft_transform(inverse: u32) -> f64 {
    PLAN.with(|plan| {
        plan.borrow_mut()
            .as_mut()
            .map_or(-1.0, |plan| plan.transform(inverse != 0) as f64)
    })
}
