// Conservative advancement for two finite segments with linearly moving endpoints.
use super::{
    Capsule, Material, Segment, SegmentContact, State, V, edge_response, nearest_segments,
};

#[derive(Clone, Copy)]
struct Motion {
    from: Segment,
    first: V,
    second: V,
}

impl Motion {
    fn new(from: Segment, to: Segment) -> Self {
        Self {
            from,
            first: to.start.subtract(from.start),
            second: to.point(1.0).subtract(from.point(1.0)),
        }
    }

    fn at(self, time: f64) -> Segment {
        Segment {
            start: self.from.start.add(self.first.scale(time)),
            edge: self
                .from
                .edge
                .add(self.second.subtract(self.first).scale(time)),
        }
    }

    fn approach(self, drift: V, direction: V) -> f64 {
        self.first
            .subtract(drift)
            .dot(direction)
            .max(self.second.subtract(drift).dot(direction))
    }

    fn speed(self, drift: V) -> f64 {
        self.first
            .subtract(drift)
            .length()
            .max(self.second.subtract(drift).length())
    }
}

pub(crate) fn contact(
    old_a: V,
    old_b: V,
    a: &State,
    b: &State,
    ma: &Material,
    mb: &Material,
    old_body: &Capsule,
    body: &Capsule,
) -> Option<SegmentContact> {
    let strand = Segment::new(a.position, b.position);
    let axis = Segment::new(body.start, body.end);
    let (s, t, normal) = crossing(
        Segment::new(old_a, old_b),
        strand,
        Segment::new(old_body.start, old_body.end),
        axis,
        ma.radius + old_body.radius.max(body.radius),
    )?;
    let capsule_axis = axis.point(t);
    // Carry the impact normal forward as a unilateral contact plane on the moving capsule.
    let gap = strand.point(s).subtract(capsule_axis).dot(normal);
    edge_response(
        s,
        ma.radius + body.radius - gap,
        normal,
        capsule_axis.add(normal.scale(body.radius)),
        ma,
        mb,
    )
}

pub(crate) fn crossing(
    previous_first: Segment,
    first: Segment,
    previous_second: Segment,
    second: Segment,
    radius: f64,
) -> Option<(f64, f64, V)> {
    let moving_strand = Motion::new(previous_first, first);
    let moving_axis = Motion::new(previous_second, second);
    let drift = moving_strand
        .first
        .add(moving_strand.second)
        .add(moving_axis.first)
        .add(moving_axis.second)
        .scale(0.25);
    // Translation of the whole query does not change its distance.
    let bound = moving_strand.speed(drift) + moving_axis.speed(drift);
    if bound == 0.0 {
        return None;
    }

    let mut time = 0.0;
    let (seed_s, seed_t, seed) = nearest_segments(moving_strand.from, moving_axis.from);
    let scale = radius
        .max(moving_strand.from.edge.length())
        .max(moving_axis.from.edge.length())
        .max(bound);
    // Account for one part per million of the thickness and the rounding of long edges.
    let tolerance = (radius / 1048576.0).max(64.0 * f64::EPSILON * scale);
    let initial = seed.length() - radius;
    if initial < -tolerance {
        return None;
    }
    let mut witness = (seed_s, seed_t, seed);
    loop {
        let (_, _, offset) = witness;
        let length = offset.length();
        let gap = (offset.dot(offset) - radius * radius) / (length + radius);
        if gap <= tolerance {
            break;
        }
        // All four endpoints stay on their side of the current separating plane for this
        // interval. Projecting the endpoint speeds avoids tiny steps for tangential motion.
        let normal = offset.scale(1.0 / length);
        let approach = moving_strand.approach(drift, normal.scale(-1.0))
            + moving_axis.approach(drift, normal)
            + 16.0 * f64::EPSILON * bound;
        if approach <= 0.0 || gap > approach * (1.0 - time) {
            return None;
        }
        let step = gap / approach;
        let next = time + 0.9 * step;
        if next <= time {
            break;
        }
        time = next;
        witness = nearest_segments(moving_strand.at(time), moving_axis.at(time));
    }
    let (s, t, offset) = witness;
    let at_hit = moving_strand.at(time);
    let fallback = at_hit.edge.cross(V::X).direction(V::Y);
    let normal = offset.direction(fallback);
    Some((s, t, normal))
}
