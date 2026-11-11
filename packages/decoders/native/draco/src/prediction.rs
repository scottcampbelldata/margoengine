use crate::{
    Budget, Error, Result,
    edgebreaker::{Mapping, NONE, Topology, next, prev},
    traversal::{Group, Sequence},
};

pub(crate) struct Mesh<'a, 'b> {
    pub topology: &'a Topology<'b>,
    pub mapping: &'a Mapping,
    pub sequence: &'a Sequence,
    pub group: Group,
}
impl Mesh<'_, '_> {
    fn corners(&self) -> &[usize] {
        if self.group.corner {
            &self.mapping.attributes[self.group.data_id as usize].corners
        } else {
            &self.topology.corners
        }
    }
    fn position(&self, corner: usize, parent: &[i32]) -> Result<[i64; 3]> {
        let point = *self
            .mapping
            .corner_to_point
            .get(corner)
            .ok_or(Error::Invalid)?;
        let values = parent.get(point * 3..point * 3 + 3).ok_or(Error::Invalid)?;
        Ok([
            i64::from(values[0]),
            i64::from(values[1]),
            i64::from(values[2]),
        ])
    }
    fn entry_position(&self, entry: usize, parent: &[i32]) -> Result<[i64; 3]> {
        self.position(
            *self
                .sequence
                .entry_corner
                .get(entry)
                .ok_or(Error::Invalid)?,
            parent,
        )
    }
    fn opposite(&self, corner: usize) -> usize {
        if corner == NONE
            || (self.group.corner
                && self.mapping.attributes[self.group.data_id as usize].seam[corner])
        {
            NONE
        } else {
            self.topology.opp(corner)
        }
    }
    fn swing(&self, corner: usize, left: bool) -> usize {
        if left {
            next(self.opposite(next(corner)))
        } else {
            prev(self.opposite(prev(corner)))
        }
    }
    pub fn parallelogram(
        &self,
        id: usize,
        components: usize,
        data: &[i32],
        prediction: &mut [i32],
    ) -> bool {
        let corner = self.sequence.entry_corner[id];
        self.parallelogram_at(id, corner, components, data, prediction)
    }
    fn parallelogram_at(
        &self,
        id: usize,
        corner: usize,
        components: usize,
        data: &[i32],
        prediction: &mut [i32],
    ) -> bool {
        let opposite = self.opposite(corner);
        if opposite == NONE {
            return false;
        }
        let corners = self.corners();
        let o = self.sequence.vertex_entry[corners[opposite]];
        let n = self.sequence.vertex_entry[corners[next(opposite)]];
        let p = self.sequence.vertex_entry[corners[prev(opposite)]];
        if o >= id || n >= id || p >= id {
            return false;
        }
        for c in 0..components {
            // E12 extension: valid +/-1e9 inputs distinguish wrapping int32
            // predictor arithmetic from widened arithmetic before clamping.
            prediction[c] = data[n * components + c]
                .wrapping_add(data[p * components + c])
                .wrapping_sub(data[o * components + c]);
        }
        true
    }

    pub fn multi(
        &self,
        id: usize,
        components: usize,
        data: &[i32],
        budget: &mut Budget,
        sum: &mut [i32],
        scratch: &mut [i32],
    ) -> Result<bool> {
        let start = self.sequence.entry_corner[id];
        let mut corner = start;
        sum.fill(0);
        let mut count = 0_i32;
        while corner != NONE {
            budget.steps(1)?;
            let prediction = &mut scratch[..components];
            if self.parallelogram_at(id, corner, components, data, prediction) {
                count = count.checked_add(1).ok_or(Error::Overflow)?;
                for c in 0..components {
                    sum[c] = sum[c].wrapping_add(prediction[c]);
                }
            }
            corner = self.swing(corner, false);
            if corner == start {
                break;
            }
        }
        if count == 0 {
            return Ok(false);
        }
        for value in &mut sum[..components] {
            *value /= count;
        }
        Ok(true)
    }

    pub fn constrained(
        &self,
        id: usize,
        components: usize,
        data: &[i32],
        flags: &[Vec<bool>; 4],
        positions: &mut [usize; 4],
        budget: &mut Budget,
        sum: &mut [i32],
        scratch: &mut [i32],
    ) -> Result<bool> {
        let start = self.sequence.entry_corner[id];
        let mut corner = start;
        let mut left = true;
        let predictions = &mut scratch[..4 * components];
        let mut count = 0;
        while corner != NONE {
            budget.steps(1)?;
            if self.parallelogram_at(
                id,
                corner,
                components,
                data,
                &mut predictions[count * components..(count + 1) * components],
            ) {
                count += 1;
                if count == 4 {
                    break;
                }
            }
            corner = self.swing(corner, left);
            if corner == start {
                break;
            }
            if corner == NONE && left {
                left = false;
                corner = self.swing(start, false);
            }
        }
        if count == 0 {
            return Ok(false);
        }
        let context = count - 1;
        sum.fill(0);
        let mut used = 0;
        for prediction in predictions[..count * components].chunks_exact(components) {
            let crease = *flags[context]
                .get(positions[context])
                .ok_or(Error::Invalid)?;
            positions[context] += 1;
            if !crease {
                used += 1;
                for c in 0..components {
                    sum[c] = sum[c].wrapping_add(prediction[c]);
                }
            }
        }
        if used == 0 {
            return Ok(false);
        }
        for value in &mut sum[..components] {
            *value /= used;
        }
        Ok(true)
    }

    pub fn tex_coords(
        &self,
        id: usize,
        data: &[i32],
        parent: &[i32],
        orientations: &mut Vec<bool>,
    ) -> Result<[i32; 2]> {
        let corner = self.sequence.entry_corner[id];
        let n = self.sequence.vertex_entry[self.corners()[next(corner)]];
        let p = self.sequence.vertex_entry[self.corners()[prev(corner)]];
        if p < id && n < id {
            let nuv = [i64::from(data[n * 2]), i64::from(data[n * 2 + 1])];
            let puv = [i64::from(data[p * 2]), i64::from(data[p * 2 + 1])];
            if puv == nuv {
                return Ok([data[p * 2], data[p * 2 + 1]]);
            }
            let tip = self.entry_position(id, parent)?;
            let np = self.entry_position(n, parent)?;
            let pp = self.entry_position(p, parent)?;
            let pn = sub(pp, np);
            let norm2 = dot(pn, pn)?;
            if norm2 != 0 {
                let cn = sub(tip, np);
                let product = dot(cn, pn)?;
                let duv = [puv[0] - nuv[0], puv[1] - nuv[1]];
                let mut xuv = [0_i64; 2];
                for c in 0..2 {
                    xuv[c] = narrow(
                        i128::from(duv[c]) * i128::from(product)
                            + i128::from(nuv[c]) * i128::from(norm2),
                    )?;
                }
                let mut displacement = [0_i64; 3];
                for c in 0..3 {
                    let projected =
                        narrow(i128::from(pn[c]) * i128::from(product) / i128::from(norm2))?;
                    displacement[c] = tip[c] - (np[c] + projected);
                }
                let distance2 = dot(displacement, displacement)?;
                // E12 UV arithmetic: the spec's uint64 IntSqrt argument is
                // formed modulo 2^64. q20 right triangles distinguish this
                // from a widened product; two held-out scales confirm it.
                let radicand = (distance2 as u64).wrapping_mul(norm2 as u64);
                let length = i64::try_from(int_sqrt(radicand)).map_err(|_| Error::Overflow)?;
                let orientation = orientations.pop().ok_or(Error::Invalid)?;
                let mut result = [0_i32; 2];
                for c in 0..2 {
                    let perpendicular = if c == 0 { duv[1] } else { -duv[0] };
                    let cross = i128::from(perpendicular) * i128::from(length);
                    let value = (i128::from(xuv[c]) + if orientation { cross } else { -cross })
                        / i128::from(norm2);
                    result[c] = i32::try_from(value).map_err(|_| Error::Overflow)?;
                }
                return Ok(result);
            }
        }
        // The published fallback gives the next entry priority; otherwise it
        // uses the preceding decoded entry (the first entry predicts zero).
        let source = if n < id {
            n
        } else if id > 0 {
            id - 1
        } else {
            return Ok([0, 0]);
        };
        Ok([data[source * 2], data[source * 2 + 1]])
    }

    /// Historical texture-coordinate predictor 3 (streams before version 2.0).
    /// The published specification describes only the portable predictor 5.
    /// E23 crafted black-box observations fix this one: the same projection
    /// geometry on float positions, every step rounded to float32, the offset
    /// from the projection taken from `cn - pn * s`, and the result rounded
    /// half up to an integer. Neighbour choice, fallback and orientation
    /// order follow the portable predictor.
    pub fn legacy_tex_coords(
        &self,
        id: usize,
        data: &[i32],
        parent: &[f32],
        skip_degenerate: bool,
        orientations: &mut Vec<bool>,
    ) -> Result<[i32; 2]> {
        let corner = self.sequence.entry_corner[id];
        let n = self.sequence.vertex_entry[self.corners()[next(corner)]];
        let p = self.sequence.vertex_entry[self.corners()[prev(corner)]];
        if p < id && n < id {
            // E24: equal neighbour values take the computed path too (no
            // early return), so values beyond 2^24 round through float32.
            let point = |entry: usize| -> Result<[f32; 3]> {
                let corner = *self
                    .sequence
                    .entry_corner
                    .get(entry)
                    .ok_or(Error::Invalid)?;
                let point = *self
                    .mapping
                    .corner_to_point
                    .get(corner)
                    .ok_or(Error::Invalid)?;
                let v = parent.get(point * 3..point * 3 + 3).ok_or(Error::Invalid)?;
                Ok([v[0], v[1], v[2]])
            };
            let (tip, np, pp) = (point(id)?, point(n)?, point(p)?);
            let pn = [pp[0] - np[0], pp[1] - np[1], pp[2] - np[2]];
            let cn = [tip[0] - np[0], tip[1] - np[1], tip[2] - np[2]];
            let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            let norm2 = dot(pn, pn);
            // E24: before version 1.2 coincident neighbours are not special
            // and 0/0 gives NaN. From 1.2 their projection and offset are
            // zero, so the float32 next value is predicted (orientation still
            // consumed, as on the computed path).
            {
                let degenerate = skip_degenerate && norm2 == 0.0;
                let (s, norm2) = if degenerate {
                    (0.0, 1.0)
                } else {
                    (dot(cn, pn) / norm2, norm2)
                };
                let disp = [cn[0] - pn[0] * s, cn[1] - pn[1] * s, cn[2] - pn[2] * s];
                let t = if degenerate {
                    0.0
                } else {
                    (dot(disp, disp) / norm2).sqrt()
                };
                let nuv = [data[n * 2] as f32, data[n * 2 + 1] as f32];
                let duv = [data[p * 2] as f32 - nuv[0], data[p * 2 + 1] as f32 - nuv[1]];
                let orientation = orientations.pop().ok_or(Error::Invalid)?;
                let mut result = [0_i32; 2];
                for c in 0..2 {
                    let projected = nuv[c] + s * duv[c];
                    let offset = t * if c == 0 { duv[1] } else { -duv[0] };
                    // E23: the opposite sense from the portable predictor.
                    let value = if orientation {
                        projected - offset
                    } else {
                        projected + offset
                    };
                    result[c] = round_half_up(value);
                }
                return Ok(result);
            }
        }
        let source = if n < id {
            n
        } else if id > 0 {
            id - 1
        } else {
            return Ok([0, 0]);
        };
        Ok([data[source * 2], data[source * 2 + 1]])
    }

    pub fn normal(
        &self,
        id: usize,
        parent: &[i32],
        flip: bool,
        max: i32,
        budget: &mut Budget,
    ) -> Result<[i32; 2]> {
        if !(3..=(1 << 30) - 1).contains(&max) || (max as u32 + 1).count_ones() != 1 {
            return Err(Error::Invalid);
        }
        let center = i64::from((max - 1) / 2);
        let start = self.sequence.entry_corner[id];
        let position = self.position(start, parent)?;
        let mut normal = [0_i64; 3];
        let mut corner = start;
        let mut left = true;
        while corner != NONE {
            budget.steps(1)?;
            let a = sub(self.position(next(corner), parent)?, position);
            let b = sub(self.position(prev(corner), parent)?, position);
            for (c, component) in normal.iter_mut().enumerate() {
                let next = (c + 1) % 3;
                let prev = (c + 2) % 3;
                *component = narrow(
                    i128::from(*component) + i128::from(a[next]) * i128::from(b[prev])
                        - i128::from(a[prev]) * i128::from(b[next]),
                )?;
            }
            corner = self.swing(corner, left);
            if corner == start {
                break;
            }
            if corner == NONE && left {
                left = false;
                corner = self.swing(start, false);
            }
        }
        let mut sum = normal.iter().map(|v| i128::from(*v).abs()).sum::<i128>();
        if sum > 1 << 29 {
            let divisor = sum / (1 << 29);
            for value in &mut normal {
                *value = narrow(i128::from(*value) / divisor)?;
            }
            sum = normal.iter().map(|v| i128::from(*v).abs()).sum();
        }
        if sum == 0 {
            normal = [center, 0, 0];
        } else {
            normal[0] = narrow(i128::from(normal[0]) * i128::from(center) / sum)?;
            normal[1] = narrow(i128::from(normal[1]) * i128::from(center) / sum)?;
            normal[2] = if normal[2] >= 0 {
                center - normal[0].abs() - normal[1].abs()
            } else {
                -(center - normal[0].abs() - normal[1].abs())
            };
        }
        if flip {
            for value in &mut normal {
                *value = -*value;
            }
        }
        let max = center * 2;
        let mut s = if normal[0] >= 0 {
            normal[1] + center
        } else if normal[1] < 0 {
            normal[2].abs()
        } else {
            max - normal[2].abs()
        };
        let mut t = if normal[0] >= 0 {
            normal[2] + center
        } else if normal[2] < 0 {
            normal[1].abs()
        } else {
            max - normal[1].abs()
        };
        if (s == 0 && (t == 0 || t == max)) || (s == max && t == 0) {
            s = max;
            t = max;
        } else if (s == 0 && t > center) || (s == max && t < center) {
            t = max - t;
        } else if (t == max && s < center) || (t == 0 && s > center) {
            s = max - s;
        }
        Ok([s as i32, t as i32])
    }
}

/// E24: half-up rounding to int32; NaN and values outside int32 give
/// `i32::MIN`, as the opaque decoder's conversion does.
fn round_half_up(value: f32) -> i32 {
    let rounded = (f64::from(value) + 0.5).floor();
    if rounded >= -2_147_483_648.0 && rounded < 2_147_483_648.0 {
        rounded as i32
    } else {
        i32::MIN
    }
}
fn narrow(value: i128) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Overflow)
}
fn sub(a: [i64; 3], b: [i64; 3]) -> [i64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [i64; 3], b: [i64; 3]) -> Result<i64> {
    narrow((0..3).map(|i| i128::from(a[i]) * i128::from(b[i])).sum())
}
fn int_sqrt(number: u64) -> u64 {
    if number == 0 {
        return 0;
    }
    let mut root = 1_u64 << (64 - number.leading_zeros()).div_ceil(2);
    loop {
        let next = (root + number / root) / 2;
        if next >= root {
            return root;
        }
        root = next;
    }
}
