// Sparse link-to-link contact. The cell width encloses two link extents plus their thickness.
use super::{
    Link, Material, Scratch, Segment, State, V, bucket, coordinate, nearest_segments, slot,
    slot_mut, sweep,
};

struct Pair {
    indices: [usize; 4],
    weights: [f64; 4],
    inverse_mass: f64,
    normal: V,
    overlap: f64,
}

impl Pair {
    fn load(
        nodes: &[State],
        mats: &[Material],
        scratch: &[Scratch],
        i: usize,
        j: usize,
        swept: bool,
    ) -> Option<Self> {
        let first = Segment::new(slot(nodes, i).position, slot(nodes, i + 1).position);
        let second = Segment::new(slot(nodes, j).position, slot(nodes, j + 1).position);
        let radius = slot(mats, i).radius + slot(mats, j).radius;
        let impact = if swept {
            let old_first = Segment::new(
                slot(scratch, i).old.position,
                slot(scratch, i + 1).old.position,
            );
            let old_second = Segment::new(
                slot(scratch, j).old.position,
                slot(scratch, j + 1).old.position,
            );
            sweep::crossing(old_first, first, old_second, second, radius)
        } else {
            None
        };
        let (s, t, normal, gap) = if let Some((s, t, n)) = impact {
            (s, t, n, first.point(s).subtract(second.point(t)).dot(n))
        } else {
            let (s, t, offset) = nearest_segments(first, second);
            let perpendicular = first.edge.cross(V::X).direction(V::Y);
            let n = offset.direction(first.edge.cross(second.edge).direction(perpendicular));
            (s, t, n, offset.length())
        };
        let overlap = radius - gap;
        if overlap < -radius / 1048576.0 {
            return None;
        }
        let indices = [i, i + 1, j, j + 1];
        let weights = [1.0 - s, s, t - 1.0, -t];
        let inverse_mass = indices
            .iter()
            .zip(weights)
            .map(|(&index, w)| slot(mats, index).inverse_mass * w * w)
            .sum();
        if inverse_mass == 0.0 {
            return None;
        }
        Some(Self {
            indices,
            weights,
            inverse_mass,
            normal,
            overlap,
        })
    }

    fn project(&self, nodes: &mut [State], mats: &[Material]) {
        if self.overlap <= 0.0 {
            return;
        }
        let correction = self.normal.scale(self.overlap / self.inverse_mass);
        for (&index, weight) in self.indices.iter().zip(self.weights) {
            let node = slot_mut(nodes, index);
            node.position = node
                .position
                .add(correction.scale(slot(mats, index).inverse_mass * weight));
        }
    }

    fn impulses(&self, nodes: &mut [State], mats: &[Material], scratch: &[Scratch], friction: f64) {
        let mut relative = V::ZERO;
        let mut incoming = V::ZERO;
        for (&index, weight) in self.indices.iter().zip(self.weights) {
            relative = relative.add(slot(nodes, index).velocity.scale(weight));
            incoming = incoming.add(slot(scratch, index).old.velocity.scale(weight));
        }
        let v_n = relative.dot(self.normal);
        let opposing = (-v_n / self.inverse_mass).max(0.0);
        let projected = ((v_n - incoming.dot(self.normal)) / self.inverse_mass).max(0.0);
        let tangent = relative.subtract(self.normal.scale(v_n));
        let speed = tangent.length();
        let sliding = if speed > 0.0 {
            tangent
                .scale(-((opposing + projected) * friction).min(speed / self.inverse_mass) / speed)
        } else {
            V::ZERO
        };
        let impulse = self.normal.scale(opposing).add(sliding);
        for (&index, weight) in self.indices.iter().zip(self.weights) {
            let node = slot_mut(nodes, index);
            node.velocity = node
                .velocity
                .add(impulse.scale(slot(mats, index).inverse_mass * weight));
        }
    }
}

fn midpoint(nodes: &[State], i: usize) -> V {
    slot(nodes, i)
        .position
        .add(slot(nodes, i + 1).position)
        .scale(0.5)
}

fn grid_span(nodes: &[State], mats: &[Material], scratch: &[Scratch], swept: bool) -> f64 {
    let mut extent: f64 = 0.0;
    let mut radius: f64 = 0.0;
    for (i, mat) in mats.iter().enumerate() {
        if mat.length == 0.0 {
            continue;
        }
        let p = midpoint(nodes, i);
        extent = extent.max(slot(nodes, i).position.subtract(p).length());
        extent = extent.max(slot(nodes, i + 1).position.subtract(p).length());
        if swept {
            extent = extent.max(slot(scratch, i).old.position.subtract(p).length());
            extent = extent.max(slot(scratch, i + 1).old.position.subtract(p).length());
        }
        radius = radius.max(mat.radius);
    }
    2.0 * (extent + radius) * (1.0 + 8.0 * f64::EPSILON)
}

pub(crate) fn run(
    nodes: &mut [State],
    mats: &[Material],
    scratch: &[Scratch],
    links: &mut [Link],
    buckets: &mut [i32],
    swept: bool,
    velocity_friction: Option<f64>,
) -> f64 {
    let size = grid_span(nodes, mats, scratch, swept);
    buckets.fill(-1);
    let mask = buckets.len() - 1;
    for (i, mat) in mats.iter().enumerate() {
        if mat.length == 0.0 {
            continue;
        }
        let p = midpoint(nodes, i);
        let (x, y, z) = (
            coordinate(p.x, size),
            coordinate(p.y, size),
            coordinate(p.z, size),
        );
        let head = slot_mut(buckets, bucket(x, y, z, mask));
        *slot_mut(links, i) = Link {
            next: *head,
            x,
            y,
            z,
        };
        *head = i as i32;
    }

    let mut candidates = 0.0;
    for (i, mat) in mats.iter().enumerate() {
        if mat.length == 0.0 {
            continue;
        }
        let source = slot(links, i);
        for dz in -1..=1 {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (x, y, z) = (
                        source.x.wrapping_add(dx),
                        source.y.wrapping_add(dy),
                        source.z.wrapping_add(dz),
                    );
                    let mut next = *slot(buckets, bucket(x, y, z, mask));
                    while next >= 0 {
                        let j = next as usize;
                        let link = slot(links, j);
                        next = link.next;
                        if j <= i + 1 || link.x != x || link.y != y || link.z != z {
                            continue;
                        }
                        candidates += 1.0;
                        if let Some(pair) = Pair::load(nodes, mats, scratch, i, j, swept) {
                            if let Some(friction) = velocity_friction {
                                pair.impulses(nodes, mats, scratch, friction);
                            } else {
                                pair.project(nodes, mats);
                            }
                        }
                    }
                }
            }
        }
    }
    candidates
}
