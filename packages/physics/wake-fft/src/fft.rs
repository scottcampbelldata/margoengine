// Mixed-radix Stockham autosort (Stockham 1966, doi:10.1145/1464182.1464209), using the same decimation-in-frequency
// stage order and pinned twiddles as the scalar kernel and the TypeScript FFT. One f64x2 carries a complex value.
use core::arch::wasm32::{
    f64x2, f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat, i64x2_shuffle, v128,
};
use margoengine_physics_kernel_common::pinned::{cos, sin};

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
    roots: Vec<usize>,
    rotations: Vec<usize>,
}

struct Axis {
    stages: Vec<Stage>,
    forward: Vec<Rotation>,
    inverse: Vec<Rotation>,
    a: Vec<v128>,
    b: Vec<v128>,
}

impl Axis {
    fn new(n: usize) -> Option<Self> {
        let mut stages = Vec::new();
        let mut length = n;
        for radix in [2, 3, 5] {
            while length % radix == 0 {
                let sequences = n / length;
                let span = length / radix;
                // These indices depend only on the plan. Hoist both integer remainders out of the butterflies.
                let roots = (0..radix)
                    .flat_map(|k| (0..radix).map(move |j| ((j * k) % radix) * (n / radix)))
                    .collect();
                let rotations = (0..span)
                    .flat_map(|j| (0..radix).map(move |k| ((j * k) * sequences) % n))
                    .collect();
                stages.push(Stage {
                    sequences,
                    span,
                    radix,
                    roots,
                    rotations,
                });
                length = span;
            }
        }
        if length != 1 {
            return None;
        }
        let (forward, inverse) = (0..n)
            .map(|j| {
                let angle = (TWO_PI * j as f64) / n as f64;
                let (c, s) = (cos(angle), sin(angle));
                (Rotation::new(c, -s), Rotation::new(c, s))
            })
            .unzip();
        let zero = f64x2_splat(0.0);
        Some(Self {
            stages,
            forward,
            inverse,
            a: vec![zero; n],
            b: vec![zero; n],
        })
    }

    fn transform(&mut self, grid: &mut [v128], inverse: bool, offset: usize, stride: usize) {
        let (mut source, mut destination) = (&mut self.a, &mut self.b);
        for (i, value) in source.iter_mut().enumerate() {
            *value = grid[offset + i * stride];
        }
        let twiddles = if inverse {
            &self.inverse
        } else {
            &self.forward
        };
        for Stage {
            sequences,
            span,
            radix,
            roots,
            rotations,
        } in &self.stages
        {
            let (sequences, span, radix) = (*sequences, *span, *radix);
            for q in 0..sequences {
                for j in 0..span {
                    for (k, roots) in roots.chunks_exact(radix).enumerate() {
                        let mut sum = f64x2_splat(0.0);
                        for (l, &root) in roots.iter().enumerate() {
                            let value = source[q + sequences * (j + span * l)];
                            sum = f64x2_add(sum, twiddles[root].apply(value));
                        }
                        destination[q + sequences * (k + radix * j)] =
                            twiddles[rotations[k + radix * j]].apply(sum);
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
    }
}

pub struct WakeFft2 {
    nx: usize,
    nz: usize,
    x: Axis,
    z: Axis,
    full: Vec<v128>,
}

impl WakeFft2 {
    pub fn new(nx: usize, nz: usize) -> Option<Self> {
        if nx % 2 != 0 {
            return None;
        }
        Some(Self {
            nx,
            nz,
            x: Axis::new(nx)?,
            z: Axis::new(nz)?,
            full: vec![f64x2_splat(0.0); nx * nz],
        })
    }

    pub fn forward(&mut self, words: &mut [f64]) {
        let (nx, nz) = (self.nx, self.nz);
        let half = nx / 2 + 1;
        for (slot, value) in self.full.iter_mut().zip(words.iter()) {
            *slot = f64x2(*value, 0.0);
        }
        self.transform(false);
        for z in 0..nz {
            for x in 0..half {
                let complex = self.full[x + nx * z];
                words[2 * (x + half * z)] = f64x2_extract_lane::<0>(complex);
                words[2 * (x + half * z) + 1] = f64x2_extract_lane::<1>(complex);
            }
        }
    }

    pub fn inverse(&mut self, words: &mut [f64]) {
        let (nx, nz) = (self.nx, self.nz);
        let half = nx / 2 + 1;
        for z in 0..nz {
            for x in 0..nx {
                let mirrored = x >= half;
                let (sx, sz) = if mirrored {
                    (nx - x, (nz - z) % nz)
                } else {
                    (x, z)
                };
                let source = 2 * (sx + half * sz);
                let imaginary = words[source + 1];
                self.full[x + nx * z] =
                    f64x2(words[source], if mirrored { -imaginary } else { imaginary });
            }
        }
        self.transform(true);
        for (output, &value) in words.iter_mut().zip(self.full.iter()) {
            *output = f64x2_extract_lane::<0>(value);
        }
    }

    fn transform(&mut self, inverse: bool) {
        for z in 0..self.nz {
            self.x.transform(&mut self.full, inverse, self.nx * z, 1);
        }
        for x in 0..self.nx {
            self.z.transform(&mut self.full, inverse, x, self.nx);
        }
    }
}
