// Shapes of the 2D kernel. Every shape is a convex core of up to eight vertices grown by a radius: a circle is one
// vertex, a capsule two, a segment two with no radius, a polygon three to eight (rounded when its radius is above 0).
// Polygons are built by gift wrapping (Jarvis, "On the identification of the convex hull of a finite set of points in
// the plane", Information Processing Letters 2(1), 1973), which needs no sort and no allocation, so it runs in the
// Wasm build as it does natively.
use crate::math::{V2, v2};

/// The most vertices a polygon keeps.
pub const MAX_VERTICES: usize = 8;
/// The distance the solver lets shapes sink into each other before it pushes back, and the scale of every length
/// tolerance below, in metres.
pub const LINEAR_SLOP: f32 = 0.005;
/// Points closer than this are one point to a polygon.
pub const WELD: f32 = 0.5 * LINEAR_SLOP;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ShapeError {
    /// A number that is not finite, or a radius below 0.
    NotFinite,
    /// Fewer than three points that are not all on one line, after welding.
    Degenerate,
    /// The hull has more than `MAX_VERTICES` corners.
    TooManyVertices,
}

/// A convex core and its radius. Polygon vertices run counter-clockwise and `normals[i]` is the outward unit normal of
/// the edge from `vertices[i]` to the next. A two-vertex core has two edges, there and back, with opposite normals.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Core {
    pub count: usize,
    pub vertices: [V2; MAX_VERTICES],
    pub normals: [V2; MAX_VERTICES],
    pub radius: f32,
}

const fn empty() -> Core {
    Core { count: 0, vertices: [V2::ZERO; MAX_VERTICES], normals: [V2::ZERO; MAX_VERTICES], radius: 0.0 }
}

fn finite(v: V2) -> bool {
    v.x.is_finite() && v.y.is_finite()
}

impl Core {
    pub fn circle(center: V2, radius: f32) -> Result<Core, ShapeError> {
        if !finite(center) || !radius.is_finite() || radius < 0.0 {
            return Err(ShapeError::NotFinite);
        }
        let mut core = empty();
        core.count = 1;
        core.vertices[0] = center;
        core.radius = radius;
        Ok(core)
    }

    /// The points within `radius` of the segment from `a` to `b`; a circle when the two ends weld into one.
    pub fn capsule(a: V2, b: V2, radius: f32) -> Result<Core, ShapeError> {
        if !finite(a) || !finite(b) || !radius.is_finite() || radius < 0.0 {
            return Err(ShapeError::NotFinite);
        }
        let (unit, length) = b.sub(a).normalize();
        if length <= WELD {
            return Core::circle(a.lerp(b, 0.5), radius);
        }
        let mut core = empty();
        core.count = 2;
        core.vertices[0] = a;
        core.vertices[1] = b;
        core.normals[0] = unit.right();
        core.normals[1] = unit.left();
        core.radius = radius;
        Ok(core)
    }

    pub fn segment(a: V2, b: V2) -> Result<Core, ShapeError> {
        let core = Core::capsule(a, b, 0.0)?;
        if core.count < 2 { Err(ShapeError::Degenerate) } else { Ok(core) }
    }

    /// A box of half extents `hx` and `hy` about `center`, turned by the rotation (c, s), with rounded corners of `radius`.
    pub fn rect(hx: f32, hy: f32, center: V2, c: f32, s: f32, radius: f32) -> Result<Core, ShapeError> {
        let corner = |x: f32, y: f32| v2(c * x - s * y + center.x, s * x + c * y + center.y);
        Core::polygon(&[corner(-hx, -hy), corner(hx, -hy), corner(hx, hy), corner(-hx, hy)], radius)
    }

    /// The convex hull of `points`, grown by `radius`. Points within `WELD` of a hull corner merge into it, and a corner
    /// whose edges turn by less than the weld across their length is dropped, so a hull never holds a sliver edge.
    pub fn polygon(points: &[V2], radius: f32) -> Result<Core, ShapeError> {
        if !radius.is_finite() || radius < 0.0 || points.iter().any(|p| !finite(*p)) {
            return Err(ShapeError::NotFinite);
        }
        if points.len() < 3 {
            return Err(ShapeError::Degenerate);
        }
        // Start at the lowest x (then lowest y), which is always a corner.
        let mut start = 0;
        for (i, p) in points.iter().enumerate() {
            let s = points[start];
            if p.x < s.x || (p.x == s.x && p.y < s.y) {
                start = i;
            }
        }
        // Room for near-collinear corners, which the pass after the wrap drops.
        let mut hull = [V2::ZERO; 2 * MAX_VERTICES + 1];
        let mut count = 0;
        let mut current = start;
        loop {
            if count > 2 * MAX_VERTICES {
                return Err(ShapeError::TooManyVertices);
            }
            hull[count] = points[current];
            count += 1;
            // The next corner: the point with every other point on its left, the farthest one when several line up.
            let here = points[current];
            let mut next = usize::MAX;
            for (i, p) in points.iter().enumerate() {
                if p.sub(here).length_squared() <= WELD * WELD {
                    continue;
                }
                if next == usize::MAX {
                    next = i;
                    continue;
                }
                let (to_next, to_p) = (points[next].sub(here), p.sub(here));
                let turn = to_next.cross(to_p);
                if turn < 0.0 || (turn == 0.0 && to_p.length_squared() > to_next.length_squared()) {
                    next = i;
                }
            }
            if next == usize::MAX {
                return Err(ShapeError::Degenerate);
            }
            if points[next].sub(points[start]).length_squared() <= WELD * WELD || next == start {
                break;
            }
            current = next;
        }
        // Drop corners that sit within the weld of the line through their neighbours.
        let mut kept = [V2::ZERO; 2 * MAX_VERTICES + 1];
        let mut n = 0;
        for i in 0..count {
            let (prev, here, next) = (hull[(i + count - 1) % count], hull[i], hull[(i + 1) % count]);
            let (unit, length) = next.sub(prev).normalize();
            if length > 0.0 && unit.cross(here.sub(prev)).abs() <= WELD {
                continue;
            }
            kept[n] = here;
            n += 1;
        }
        if n < 3 {
            return Err(ShapeError::Degenerate);
        }
        if n > MAX_VERTICES {
            return Err(ShapeError::TooManyVertices);
        }
        let mut core = empty();
        core.count = n;
        core.radius = radius;
        for i in 0..n {
            core.vertices[i] = kept[i];
            core.normals[i] = kept[(i + 1) % n].sub(kept[i]).normalize().0.right();
        }
        Ok(core)
    }

    /// The core's vertex farthest along `direction`.
    pub fn support(&self, direction: V2) -> usize {
        let mut best = 0;
        for i in 1..self.count {
            if self.vertices[i].dot(direction) > self.vertices[best].dot(direction) {
                best = i;
            }
        }
        best
    }

    /// The two ends of edge `i`.
    #[inline]
    pub fn edge(&self, i: usize) -> (V2, V2) {
        (self.vertices[i], self.vertices[(i + 1) % self.count])
    }

    /// The number of edges: none for a circle, two for a capsule or segment, one a vertex for a polygon.
    #[inline]
    pub fn edges(&self) -> usize {
        if self.count == 1 { 0 } else { self.count }
    }
}
