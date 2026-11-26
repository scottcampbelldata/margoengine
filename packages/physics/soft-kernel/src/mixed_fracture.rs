//! Isotropic displacement correlation on matching material lips. Avecillas-Leon et al.
//! (2025), Eqs. 20–22, give the mode factors. Okada and Kamibeppu (2005), Eq. 5,
//! converts them to energy. Reeder (2006), Eq. 6 with exponent 1, supplies mixed toughness.
use crate::World;
use crate::fem::{
    CRACK_FRONT_MASK, CRACK_FRONT_SHIFT, NONE, NUCLEATED_TET, TORN_TET, UNREPRESENTABLE_TET,
};
use crate::math::sqrt64;
use crate::tensile_nucleation::EDGES;
use crate::vertex_block::{Vec3, cross, dot};

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn unit(u: Vec3) -> Option<Vec3> {
    let length = sqrt64(dot(u, u));
    (length > 0.0).then(|| u.map(|x| x / length))
}

fn orientation([a, b, c, d]: [Vec3; 4]) -> f64 {
    dot(sub(b, a), cross(sub(c, a), sub(d, a)))
}

fn energies(jump: Vec3, radius: f64, shear_modulus: f64, lame: f64) -> Vec3 {
    let e_prime = 4.0 * shear_modulus * (lame + shear_modulus) / (lame + 2.0 * shear_modulus);
    let scale = core::f64::consts::PI / (32.0 * radius);
    let opening = jump[0].max(0.0);
    [
        scale * e_prime * opening * opening,
        scale * e_prime * jump[1] * jump[1],
        2.0 * scale * shear_modulus * jump[2] * jump[2],
    ]
}

fn use_of_toughness(energy: Vec3, toughness: Vec3) -> f64 {
    let total: f64 = energy.into_iter().sum();
    if total <= 0.0 {
        return 0.0;
    }
    total / dot(energy.map(|component| component / total), toughness)
}

impl World {
    fn rest_position(&self, particle: usize) -> Vec3 {
        [
            self.rx[particle] as f64,
            self.ry[particle] as f64,
            self.rz[particle] as f64,
        ]
    }

    fn current_position(&self, particle: usize) -> Vec3 {
        [
            self.x[particle] as f64,
            self.y[particle] as f64,
            self.z[particle] as f64,
        ]
    }

    fn fracture_corners(&self, cell: usize) -> [usize; 4] {
        self.fem.p.each_ref().map(|column| column[cell] as usize)
    }

    fn uninverted(&self, cell: usize) -> bool {
        let corners = self.fracture_corners(cell);
        let rest = orientation(corners.map(|p| self.rest_position(p)));
        let current = orientation(corners.map(|p| self.current_position(p)));
        rest * current > 0.0
    }

    /// Find both physical lips incident to the same material edge. Their detached particles
    /// must occupy the identical rest material point on opposite sides of the crack.
    fn matched_lips(
        &self,
        a: usize,
        b: usize,
        origin: Vec3,
        along: Vec3,
        advance: Vec3,
        normal: Vec3,
    ) -> Option<(usize, usize, f64)> {
        let length = dot(sub(self.rest_position(b), origin), along);
        let mut lips = [None, None];
        let mut row = self.fem.fracture_heads[a];
        while row != NONE {
            let cell = (row / 4) as usize;
            row = self.fem.fracture_links[row as usize];
            let corners = self.fracture_corners(cell);
            let Some(other) = corners.iter().position(|&p| p == b) else {
                continue;
            };
            let first = corners.iter().position(|&p| p == a)?;
            for opposite in 0..4 {
                if opposite == first || opposite == other || self.fem.nb[opposite][cell] != NONE {
                    continue;
                }
                let particle = corners[6 - first - other - opposite];
                let offset = sub(self.rest_position(particle), origin);
                let radius = -dot(advance, offset);
                let sample = dot(along, offset);
                let off_plane = dot(normal, offset).abs();
                let roundoff = f64::from(f32::EPSILON) * dot(offset, offset);
                if !(radius > 0.0
                    && sample >= 0.0
                    && sample <= length
                    && off_plane * off_plane <= roundoff * f64::from(f32::EPSILON))
                {
                    continue;
                }
                let side = usize::from(
                    dot(normal, sub(self.rest_position(corners[opposite]), origin)) < 0.0,
                );
                if lips[side].is_some_and(|(previous, _)| previous != particle) {
                    return None;
                }
                lips[side] = Some((particle, radius));
            }
        }
        let (positive, radius) = lips[0]?;
        let (negative, _) = lips[1]?;
        (positive != negative && self.rest_position(positive) == self.rest_position(negative))
            .then_some((positive, negative, radius))
    }

    fn coplanar_usage(
        &self,
        cell: usize,
        a: usize,
        b: usize,
        ahead: usize,
        toughness: Vec3,
    ) -> Option<f64> {
        let origin = self.rest_position(a);
        let along = unit(sub(self.rest_position(b), origin))?;
        let normal = unit(cross(along, sub(self.rest_position(ahead), origin)))?;
        let advance = cross(normal, along);
        let (positive, negative, radius) =
            self.matched_lips(a, b, origin, along, advance, normal)?;
        let position = self.current_position(a);
        let edge = unit(sub(self.current_position(b), position))?;
        let opening = unit(cross(edge, sub(self.current_position(ahead), position)))?;
        let slip = cross(opening, edge);
        let delta = sub(
            self.current_position(positive),
            self.current_position(negative),
        );
        let release = energies(
            [dot(opening, delta), dot(slip, delta), dot(edge, delta)],
            radius,
            self.fem.mu[cell] as f64,
            self.fem.lambda[cell] as f64,
        );
        Some(use_of_toughness(release, toughness))
    }

    pub(crate) fn coplanar_fracture(
        &mut self,
        first: usize,
        count: usize,
        first_particle: usize,
        particles: usize,
        threshold: f64,
        toughness: Vec3,
    ) -> u32 {
        let cells = first..first + count;
        if !cells
            .clone()
            .any(|row| self.fem.flags[row] & CRACK_FRONT_MASK != 0)
        {
            return if threshold > 0.0 {
                self.tensile_nucleation(first, count, threshold)
            } else {
                NONE
            };
        }
        self.fem.fracture_heads.resize(first_particle + particles);
        self.fem.fracture_heads[first_particle..first_particle + particles].fill(NONE);
        self.fem.fracture_links.resize(4 * (first + count));
        for row in cells.clone() {
            for (slot, particle) in self.fracture_corners(row).into_iter().enumerate() {
                let index = row * 4 + slot;
                self.fem.fracture_links[index] = self.fem.fracture_heads[particle];
                self.fem.fracture_heads[particle] = index as u32;
            }
        }
        let mut selected = NONE;
        let mut largest = 1.0;
        for row in cells {
            let flags = self.fem.flags[row];
            if flags & (NUCLEATED_TET | TORN_TET | UNREPRESENTABLE_TET) != 0
                || flags & CRACK_FRONT_MASK == 0
                || !self.uninverted(row)
            {
                continue;
            }
            let corners = self.fracture_corners(row);
            for (edge, (a, b, c, d)) in EDGES.into_iter().enumerate() {
                if flags & (1 << (CRACK_FRONT_SHIFT + edge as u32)) == 0 {
                    continue;
                }
                for (ahead, opposite) in [(c, d), (d, c)] {
                    let neighbor = self.fem.nb[opposite][row];
                    if neighbor == NONE || !self.uninverted(neighbor as usize) {
                        continue;
                    }
                    let Some(ratio) =
                        self.coplanar_usage(row, corners[a], corners[b], corners[ahead], toughness)
                    else {
                        continue;
                    };
                    if !(ratio.is_finite() && ratio > largest) {
                        continue;
                    }
                    largest = ratio;
                    selected = row as u32;
                    self.fem.fracture_edge = edge as u32;
                    self.fem.fracture_face = opposite as u32;
                    self.fem.fracture_axis = [0.0; 3];
                }
            }
        }
        selected
    }
}
