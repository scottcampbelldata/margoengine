//! Inverses of the published wrap and canonical octahedron transforms.
pub fn wrap(original: i32, prediction: i32, min: i32, max: i32) -> u32 {
    let range = max as i64 - min as i64 + 1;
    let mut c = original as i64 - prediction.clamp(min, max) as i64;
    if c < -(range / 2) {
        c += range;
    } else if c > (range - 1) / 2 {
        c -= range;
    }
    let c = c as i32;
    ((c as u32) << 1) ^ ((c >> 31) as u32)
}

fn invert(point: [i32; 2], center: i32) -> [i32; 2] {
    let [s, t] = point;
    let signs = if s >= 0 && t >= 0 {
        [1, 1]
    } else if s <= 0 && t <= 0 {
        [-1, -1]
    } else {
        [if s > 0 { 1 } else { -1 }, if t > 0 { 1 } else { -1 }]
    };
    let a = s * 2 - signs[0] * center;
    let b = t * 2 - signs[1] * center;
    let [a, b] = if signs[0] * signs[1] >= 0 {
        [-b, -a]
    } else {
        [b, a]
    };
    [(a + signs[0] * center) / 2, (b + signs[1] * center) / 2]
}

fn rotate(point: [i32; 2], n: u8) -> [i32; 2] {
    let [s, t] = point;
    match n {
        1 => [t, -s],
        2 => [-s, -t],
        3 => [-t, s],
        _ => point,
    }
}

pub fn normal(original: [i32; 2], prediction: [i32; 2], bits: u8) -> [u32; 2] {
    let max = (1i32 << bits) - 1;
    let center = (max - 1) / 2;
    let mut pred = [prediction[0] - center, prediction[1] - center];
    let mut orig = [original[0] - center, original[1] - center];
    if pred[0].abs() + pred[1].abs() > center {
        pred = invert(pred, center);
        orig = invert(orig, center);
    }
    let rotation = if pred[0] == 0 {
        if pred[1] > 0 {
            3
        } else if pred[1] < 0 {
            1
        } else {
            0
        }
    } else if pred[0] > 0 {
        if pred[1] >= 0 {
            2
        } else {
            1
        }
    } else if pred[1] <= 0 {
        0
    } else {
        3
    };
    pred = rotate(pred, rotation);
    orig = rotate(orig, rotation);
    std::array::from_fn(|i| (orig[i] - pred[i]).rem_euclid(max) as u32)
}

pub struct MeshPredictor<'a> {
    pub topology: &'a crate::topology::Topology,
    pub corner_data: Vec<usize>,
}

fn next(c: usize) -> usize {
    c / 3 * 3 + (c + 1) % 3
}
fn previous(c: usize) -> usize {
    c / 3 * 3 + (c + 2) % 3
}

impl<'a> MeshPredictor<'a> {
    pub fn new(topology: &'a crate::topology::Topology) -> Self {
        debug_assert_eq!(topology.encoded_vertex_count, topology.boundary_vertices.len());
        let mut vertex_data = vec![usize::MAX; topology.points];
        for (i, &c) in topology.attribute_corners.iter().enumerate() {
            vertex_data[topology.corner_vertices[c] as usize] = i;
        }
        let corner_data = topology
            .corner_vertices
            .iter()
            .map(|&v| vertex_data[v as usize])
            .collect();
        Self {
            topology,
            corner_data,
        }
    }

    pub fn parallelogram(
        &self,
        id: usize,
        c: usize,
        values: &[i32],
        width: usize,
    ) -> Option<Vec<i32>> {
        let opposite = self.topology.opposite_corners[c];
        if opposite < 0 {
            return None;
        }
        let c = opposite as usize;
        let [a, b, d] = [c, next(c), previous(c)].map(|c| self.corner_data[c]);
        if a >= id || b >= id || d >= id {
            return None;
        }
        Some(
            (0..width)
                .map(|k| {
                    values[b * width + k]
                        .wrapping_add(values[d * width + k])
                        .wrapping_sub(values[a * width + k])
                })
                .collect(),
        )
    }

    pub fn neighbors(&self, start: usize) -> Vec<usize> {
        let mut corners = Vec::new();
        let mut corner = start;
        let mut left = true;
        loop {
            corners.push(corner);
            let across =
                self.topology.opposite_corners[if left { next(corner) } else { previous(corner) }];
            if across < 0 {
                if !left {
                    break;
                }
                left = false;
                let across = self.topology.opposite_corners[previous(start)];
                if across < 0 {
                    break;
                }
                corner = previous(across as usize);
            } else {
                corner = if left {
                    next(across as usize)
                } else {
                    previous(across as usize)
                };
            }
            if corner == start {
                break;
            }
        }
        corners
    }

    /// Candidate payloads include their prediction method and auxiliary data.
    pub fn integer_candidates(
        &self,
        values: &[i32],
        width: usize,
        min: i32,
        max: i32,
        full: bool,
    ) -> Vec<Vec<u8>> {
        let mut parallelogram = Vec::with_capacity(values.len());
        let mut multi = Vec::with_capacity(values.len());
        let mut flags: [Vec<bool>; 4] = std::array::from_fn(|_| Vec::new());
        for (id, &corner) in self.topology.attribute_corners.iter().enumerate() {
            let fallback = if id == 0 {
                vec![0; width]
            } else {
                values[(id - 1) * width..id * width].to_vec()
            };
            let predicted = self
                .parallelogram(id, corner, values, width)
                .unwrap_or_else(|| fallback.clone());
            for k in 0..width {
                parallelogram.push(wrap(values[id * width + k], predicted[k], min, max));
            }
            if !full {
                continue;
            }
            let predictions: Vec<Vec<i32>> = self
                .neighbors(corner)
                .into_iter()
                .filter_map(|c| self.parallelogram(id, c, values, width))
                .take(4)
                .collect();
            // Choose the least correction magnitude among every subset, including the difference fallback.
            let mut best_prediction = fallback;
            let mut best_mask = 0;
            let score = |prediction: &[i32]| -> u64 {
                (0..width)
                    .map(|k| wrap(values[id * width + k], prediction[k], min, max) as u64)
                    .sum()
            };
            let mut best_score = score(&best_prediction);
            for mask in 1u32..1 << predictions.len() {
                let count = mask.count_ones() as i32;
                let candidate: Vec<i32> = (0..width)
                    .map(|k| {
                        let sum = predictions
                            .iter()
                            .enumerate()
                            .filter(|(i, _)| mask & (1 << i) != 0)
                            .fold(0i32, |sum, (_, p)| sum.wrapping_add(p[k]));
                        sum / count
                    })
                    .collect();
                let cost = score(&candidate);
                if cost < best_score {
                    best_score = cost;
                    best_mask = mask;
                    best_prediction = candidate;
                }
            }
            if !predictions.is_empty() {
                for i in 0..predictions.len() {
                    flags[predictions.len() - 1].push(best_mask & (1 << i) == 0);
                }
            }
            for k in 0..width {
                multi.push(wrap(values[id * width + k], best_prediction[k], min, max));
            }
        }
        let mut p = vec![1, 1, 1];
        p.extend(crate::entropy::symbols(&parallelogram, width));
        p.extend(min.to_le_bytes());
        p.extend(max.to_le_bytes());
        if !full {
            return vec![p];
        }
        let mut m = vec![4, 1, 1];
        m.extend(crate::entropy::symbols(&multi, width));
        for flag in flags {
            crate::entropy::varint(&mut m, flag.len() as u64);
            if !flag.is_empty() {
                m.extend(crate::topology::binary(&flag));
            }
        }
        m.extend(min.to_le_bytes());
        m.extend(max.to_le_bytes());
        vec![p, m]
    }

    pub fn uv_candidate(
        &self,
        values: &[i32],
        positions: &[[i32; 3]],
        min: i32,
        max: i32,
    ) -> Option<Vec<u8>> {
        let mut symbols = Vec::with_capacity(values.len());
        let mut orientations = Vec::new();
        let score = |id: usize, p: [i32; 2]| -> u64 {
            (0..2)
                .map(|k| wrap(values[id * 2 + k], p[k], min, max) as u64)
                .sum()
        };
        for (id, &c) in self.topology.attribute_corners.iter().enumerate() {
            let (n, p) = (self.corner_data[next(c)], self.corner_data[previous(c)]);
            let fallback = if n < id {
                [values[n * 2], values[n * 2 + 1]]
            } else if id > 0 {
                [values[(id - 1) * 2], values[(id - 1) * 2 + 1]]
            } else {
                [0, 0]
            };
            let prediction = if n < id && p < id {
                let nuv = [values[n * 2], values[n * 2 + 1]];
                let puv = [values[p * 2], values[p * 2 + 1]];
                if nuv == puv {
                    nuv
                } else {
                    let pn: [i128; 3] = std::array::from_fn(|k| {
                        positions[previous(c)][k] as i128 - positions[next(c)][k] as i128
                    });
                    let cn: [i128; 3] = std::array::from_fn(|k| {
                        positions[c][k] as i128 - positions[next(c)][k] as i128
                    });
                    let norm: i128 = pn.iter().map(|v| v * v).sum();
                    let dot: i128 = pn.iter().zip(cn).map(|(a, b)| a * b).sum();
                    if norm == 0 {
                        fallback
                    } else {
                        let cx: [i128; 3] = std::array::from_fn(|k| cn[k] - pn[k] * dot / norm);
                        let cx_norm: i128 = cx.iter().map(|v| v * v).sum();
                        let squared = u64::try_from(cx_norm * norm).ok()?;
                        let root = integer_sqrt(squared) as i128;
                        let delta = [
                            puv[0] as i128 - nuv[0] as i128,
                            puv[1] as i128 - nuv[1] as i128,
                        ];
                        let x = [
                            nuv[0] as i128 * norm + delta[0] * dot,
                            nuv[1] as i128 * norm + delta[1] * dot,
                        ];
                        let cross = [delta[1] * root, -delta[0] * root];
                        for v in x.into_iter().chain(cross) {
                            i64::try_from(v).ok()?;
                        }
                        let a = std::array::from_fn(|k| ((x[k] + cross[k]) / norm) as i32);
                        let b = std::array::from_fn(|k| ((x[k] - cross[k]) / norm) as i32);
                        if score(id, a) <= score(id, b) {
                            orientations.push(true);
                            a
                        } else {
                            orientations.push(false);
                            b
                        }
                    }
                }
            } else {
                fallback
            };
            for k in 0..2 {
                symbols.push(wrap(values[id * 2 + k], prediction[k], min, max));
            }
        }
        let mut out = vec![5, 1, 1];
        out.extend(crate::entropy::symbols(&symbols, 2));
        out.extend((orientations.len() as u32).to_le_bytes());
        let mut last = true;
        let flags: Vec<bool> = orientations
            .into_iter()
            .rev()
            .map(|v| {
                let same = v == last;
                last = v;
                same
            })
            .collect();
        out.extend(crate::topology::binary(&flags));
        out.extend(min.to_le_bytes());
        out.extend(max.to_le_bytes());
        Some(out)
    }

    pub fn normal_candidate(
        &self,
        values: &[i32],
        positions: &[[i32; 3]],
        bits: u8,
    ) -> Option<Vec<u8>> {
        let center = (1i64 << (bits - 1)) - 1;
        let mut symbols = Vec::with_capacity(values.len());
        let mut flips = Vec::new();
        for (id, &corner) in self.topology.attribute_corners.iter().enumerate() {
            let mut normal = [0i128; 3];
            for c in self.neighbors(corner) {
                let a: [i128; 3] = std::array::from_fn(|k| {
                    positions[next(c)][k] as i128 - positions[c][k] as i128
                });
                let b: [i128; 3] = std::array::from_fn(|k| {
                    positions[previous(c)][k] as i128 - positions[c][k] as i128
                });
                for k in 0..3 {
                    normal[k] += a[(k + 1) % 3] * b[(k + 2) % 3] - a[(k + 2) % 3] * b[(k + 1) % 3];
                }
            }
            for &v in &normal {
                i64::try_from(v).ok()?;
            }
            let sum: i128 = normal.iter().map(|v| v.abs()).sum();
            if sum > 1 << 29 {
                let divisor = sum / (1 << 29);
                for n in &mut normal {
                    *n /= divisor;
                }
            }
            let sum: i128 = normal.iter().map(|v| v.abs()).sum();
            let integer = if sum == 0 {
                [center as i128, 0, 0]
            } else {
                let x = normal[0] * center as i128 / sum;
                let y = normal[1] * center as i128 / sum;
                let z = (center as i128 - x.abs() - y.abs()) * if normal[2] < 0 { -1 } else { 1 };
                [x, y, z]
            };
            let orig = [values[id * 2], values[id * 2 + 1]];
            let predict = |flip: bool| {
                let v = integer.map(|v| (v * if flip { -1 } else { 1 }) as i64);
                let (s, t) = if v[0] >= 0 {
                    (v[1] + center, v[2] + center)
                } else {
                    (
                        if v[1] < 0 {
                            v[2].abs()
                        } else {
                            2 * center - v[2].abs()
                        },
                        if v[2] < 0 {
                            v[1].abs()
                        } else {
                            2 * center - v[1].abs()
                        },
                    )
                };
                let [s, t] = canonical([s as i32, t as i32], (2 * center) as i32);
                normal_correction(orig, [s, t], bits)
            };
            let a = predict(false);
            let b = predict(true);
            if a.iter().map(|&v| v as u64).sum::<u64>() <= b.iter().map(|&v| v as u64).sum::<u64>()
            {
                symbols.extend(a);
                flips.push(false);
            } else {
                symbols.extend(b);
                flips.push(true);
            }
        }
        let mut out = vec![6, 3, 1];
        out.extend(crate::entropy::symbols(&symbols, 2));
        out.extend(((1i32 << bits) - 1).to_le_bytes());
        out.extend((center as i32).to_le_bytes());
        out.extend(crate::topology::binary(&flips));
        Some(out)
    }
}

fn normal_correction(original: [i32; 2], prediction: [i32; 2], bits: u8) -> [u32; 2] {
    normal(original, prediction, bits)
}

pub fn canonical(point: [i32; 2], limit: i32) -> [i32; 2] {
    let [mut s, mut t] = point;
    let center = limit / 2;
    if (s == 0 && (t == 0 || t == limit)) || (s == limit && t == 0) {
        s = limit;
        t = limit;
    } else if (s == 0 && t > center) || (s == limit && t < center) {
        t = limit - t;
    } else if (t == limit && s < center) || (t == 0 && s > center) {
        s = limit - s;
    }
    [s, t]
}

fn integer_sqrt(value: u64) -> u64 {
    if value == 0 {
        return 0;
    }
    let mut root = 1u64 << ((64 - value.leading_zeros()).div_ceil(2));
    loop {
        let next = (root + value / root) / 2;
        if next >= root {
            return root;
        }
        root = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wrap_inverse_including_full_unsigned_range() {
        for (min, max) in [(-1000, 9000), (0, 65535), (i32::MIN, i32::MAX)] {
            for value in [min, max, 0, min + 1, max - 1] {
                for prediction in [i32::MIN, min, 0, max, i32::MAX] {
                    let symbol = wrap(value, prediction, min, max);
                    let corr = ((symbol >> 1) as i64) ^ -((symbol & 1) as i64);
                    let range = max as i64 - min as i64 + 1;
                    let mut decoded = prediction.clamp(min, max) as i64 + corr;
                    if decoded < min as i64 {
                        decoded += range;
                    }
                    if decoded > max as i64 {
                        decoded -= range;
                    }
                    assert_eq!(decoded, value as i64);
                }
            }
        }
    }
}
