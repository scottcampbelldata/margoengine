// Seeber et al. (2024), equations 30–33 and 47, with the Bažant–Oh crack band regularization.
use crate::World;
use crate::math::sqrt64;

const AXES: [usize; 3] = [0, 1, 2];
const SHEAR: [usize; 3] = [6, 7, 8];

fn element_length(volume: f32) -> f64 {
    let determinant = 6.0 * volume as f64;
    let exponent = ((determinant.to_bits() >> 52) & 2047) as i32 - 1023;
    // Positive representable rest volumes are normal in f64. The exponent gives a seed within
    // a factor two of the cube root; six Newton updates bring it to the stored precision.
    let mut root = f64::from_bits(((exponent.div_euclid(3) + 1023) as u64) << 52);
    for _ in 0..6 {
        root = (2.0 * root + determinant / (root * root)) / 3.0;
    }
    root
}

fn inverse([xx, yy, zz, xy, xz, yz]: [f64; 6]) -> [f64; 6] {
    let [x, y, z] = [sqrt64(xx * yy), sqrt64(xx * zz), sqrt64(yy * zz)];
    let [a, b, c] = [xy / x, xz / y, yz / z];
    let det = 1.0 + 2.0 * a * b * c - a * a - b * b - c * c;
    [
        (1.0 - c * c) / (det * xx),
        (1.0 - b * b) / (det * yy),
        (1.0 - a * a) / (det * zz),
        (b * c - a) / (det * x),
        (a * c - b) / (det * y),
        (a * b - c) / (det * z),
    ]
}

impl World {
    pub fn set_crack_band(&mut self, first: usize, count: usize, critical_lengths: [f32; 6]) {
        if count == 0 || (critical_lengths[0] == 0.0 && self.fem.crack_band.is_empty()) {
            return;
        }
        let mut state = [0.0; 17];
        state[..6].copy_from_slice(&critical_lengths);
        let cells = &mut self.fem.crack_band;
        cells.resize(self.fem.count.max(first + count));
        cells[first..first + count].fill(state);
    }

    pub(crate) fn evolve_crack_band(
        &mut self,
        t: usize,
        loads: [f32; 9],
        compression: u32,
        toughness: f32,
    ) -> Option<f32> {
        let state = self.fem.crack_band.get_mut(t)?;
        if state[0] <= 0.0 {
            return None;
        }
        let length = element_length(self.fem.vol0[t]);
        let already_split = state[16] != 0.0;
        state[15] = compression as f32;
        let mut ratio = 0.0f32;
        for axis in AXES {
            for channel in [axis, SHEAR[axis]] {
                let energy = if channel == axis { axis } else { axis + 3 };
                let beta = state[energy] as f64 / length;
                let k = (loads[channel] / toughness) as f64;
                let damage = if k <= 1.0 {
                    0.0
                } else if k >= beta {
                    1.0
                } else {
                    1.0 - (beta - k) / ((beta - 1.0) * k)
                };
                state[6 + channel] = state[6 + channel].max(damage as f32);
                if !already_split && state[6 + channel] == 1.0 {
                    // Keep reporting fully separated material until the tear scheduler lets it split.
                    ratio = ratio.max((k / beta).max(1.0 + f32::EPSILON as f64) as f32);
                }
            }
            let k = (loads[3 + axis] / toughness).max(1.0);
            state[9 + axis] = state[9 + axis].max(1.0 - 1.0 / k);
        }
        Some(ratio)
    }

    pub(crate) fn softened_stiffness(&self, t: usize, base: [f64; 9]) -> [f64; 9] {
        let Some(state) = self.fem.crack_band.get(t) else {
            return base;
        };
        if state[0] <= 0.0 {
            return base;
        }
        let compression = state[15] as u32;
        let normal = AXES.map(|i| {
            let offset = if compression & (1 << i) != 0 { 9 } else { 6 };
            1.0 - state[offset + i] as f64
        });
        let shear = SHEAR.map(|i| 1.0 - state[6 + i] as f64);
        if normal == [1.0; 3] && shear == [1.0; 3] {
            return base;
        }
        let [x, y, z] = normal.map(sqrt64);
        let [xx, yy, zz, xy, xz, yz] =
            inverse([base[0], base[1], base[2], base[3], base[4], base[5]]);
        // Diagonal damage adds compliance. Scale rows before inversion so a fully failed
        // direction has zero stiffness without an infinite compliance in the arithmetic.
        let [a, b, c, d, e, f] = inverse([xx, yy, zz, xy * x * y, xz * x * z, yz * y * z]);
        [
            a * normal[0],
            b * normal[1],
            c * normal[2],
            d * x * y,
            e * x * z,
            f * y * z,
            base[6] * shear[0],
            base[7] * shear[1],
            base[8] * shear[2],
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STIFFNESS: [f64; 9] = [10.0, 8.0, 6.0, 1.25, 0.75, 1.5, 5.0, 3.0, 2.0];

    #[test]
    fn fracture_energy_matches_both_cell_sizes_in_pure_shear() {
        let mut world = World::new();
        world.fem_reserve(2, 0, 0);
        world.fem.vol0[0] = 1.0 / 6.0;
        world.fem.vol0[1] = 0.125 / 6.0;
        world.set_crack_band(0, 2, [2.0; 6]);
        let strength = 0.4;
        let modulus = STIFFNESS[8];
        let energy = 0.5 * strength * (strength / modulus) * 2.0;
        for (t, length) in [1.0, 0.5].into_iter().enumerate() {
            let limit = 2.0 / length;
            let mut before = (0.0, 0.0);
            let mut work = 0.0;
            for k in [1.0, (1.0 + limit) * 0.5, limit] {
                let mut loads = [0.0; 9];
                loads[8] = k as f32;
                world.evolve_crack_band(t, loads, 0, 1.0);
                let strain = k * strength / modulus;
                let stress = world.softened_stiffness(t, STIFFNESS)[8] * strain;
                assert!(
                    (stress - strength * (limit - k) / (limit - 1.0)).abs()
                        <= strength * 8.0 * f32::EPSILON as f64
                );
                work += 0.5 * (before.1 + stress) * (strain - before.0);
                before = (strain, stress);
            }
            assert!((work * length - energy).abs() <= energy * 8.0 * f32::EPSILON as f64);
            world.evolve_crack_band(t, [0.0; 9], 0, 1.0);
            assert_eq!(world.softened_stiffness(t, STIFFNESS)[8], 0.0);
        }
    }

    #[test]
    fn closing_tensile_damage_recovers_the_compressive_tangent_until_compressive_yield() {
        let mut world = World::new();
        world.fem_reserve(1, 0, 0);
        world.fem.vol0[0] = 1.0 / 6.0;
        world.set_crack_band(0, 1, [2.0; 6]);
        let mut loads = [0.0; 9];
        loads[0] = 1.5;
        world.evolve_crack_band(0, loads, 0, 1.0);
        let weakened = world.softened_stiffness(0, STIFFNESS);
        assert!(weakened[0] < STIFFNESS[0]);
        world.evolve_crack_band(0, [0.0; 9], 1, 1.0);
        assert_eq!(world.softened_stiffness(0, STIFFNESS), STIFFNESS);
        loads[0] = 0.0;
        loads[3] = 2.0;
        world.evolve_crack_band(0, loads, 1, 1.0);
        let reduced = world.softened_stiffness(0, STIFFNESS);
        let undamaged_compliance = inverse(STIFFNESS[..6].try_into().unwrap());
        let reduced_compliance = inverse(reduced[..6].try_into().unwrap());
        assert!(
            (reduced_compliance[0] - 2.0 * undamaged_compliance[0]).abs() < 16.0 * f64::EPSILON
        );
        world.evolve_crack_band(0, [0.0; 9], 0, 1.0);
        assert_eq!(world.softened_stiffness(0, STIFFNESS), weakened);
    }
}
