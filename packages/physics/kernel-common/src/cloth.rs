// Cloth contacts: where the triangles of a cloth touch themselves or each other, found before they pass through, and what
// to push apart. Pure functions on slices, no allocation, only + - * / sqrt and compares (in f64 for the algebra), so a
// result is the same bit for bit in native and Wasm builds.
//
// Clean room, from the papers:
//   - R. Bridson, R. Fedkiw, J. Anderson, "Robust treatment of collisions, contact and friction for cloth animation",
//     SIGGRAPH 2002: the two kinds of proximity a triangle mesh has, point against triangle and edge against edge, each tested
//     for closeness to a thickness rather than for exact touching, so a thickness holds the cloth apart; vertices move in a
//     straight line from the start of the step to its end. (Their time of coplanarity, the root of a cubic, checked for
//     proximity at the root, misses a pair that comes within the thickness without ever becoming coplanar, which a dense
//     sampling of random steps found in the tests; the search here is by distance instead.)
//   - D. Harmon, E. Vouga, R. Tamstorf, E. Grinspun, "Robust treatment of simultaneous collisions", ACM Transactions on
//     Graphics 27(3), 2008: contacts that share vertices cannot be resolved one at a time; they are grouped (here by union-find
//     over their vertices) so a solver treats each connected group as one problem.
//   - B. Wang, Z. Ferguson, T. Schneider, X. Jiang, M. Attene, D. Panozzo, "A large-scale benchmark and an inclusion-based
//     algorithm for continuous collision detection", ACM Transactions on Graphics 40(5), 2021: a continuous test must not
//     miss a collision to rounding, and is checked on the cases that break earlier methods (coplanar motion, nearly parallel
//     edges, tiny thickness, degenerate triangles), which the tests of the kernel use. The search halves the interval of the
//     step and drops the halves that cannot hold a contact (an inclusion test, with a bound on how fast a distance can change
//     in place of their interval arithmetic of the root of the coplanarity cubic), and every comparison that decides a hit is
//     widened by rounding. It can report a hit early by rounding, never late.
//   - B. Mirtich, "Impulse-based dynamic simulation of rigid body systems", PhD thesis, UC Berkeley, 1996: conservative
//     advancement, the bound by which a distance changes no faster than the fastest vertices move.
//   - C. Ericson, "Real-Time Collision Detection" (2005), sections 5.1.5 and 5.1.9, for the closest point of a point to a
//     triangle and of two segments.
//   - Sweep and prune: D. Baraff 1992, along the axis of the first coordinate.

/// A point of a triangle meets it from the side the normal points to, or an edge crosses another.
pub const POINT_TRIANGLE: u32 = 0;
pub const EDGE_EDGE: u32 = 1;

/// One contact. `v` names the vertices: for a point against a triangle, the point then the triangle's three; for an edge
/// against an edge, the first edge's two then the second's two. `w` holds the weights of the touching points: for a point and
/// a triangle, the barycentric weights of the point on the triangle (a, b, c); for two edges, `w[0]` along the first edge and
/// `w[1]` along the second, from 0 to 1. `normal` is the unit direction the first primitive is to be pushed (the point away
/// from the triangle, the first edge away from the second). `time` is the fraction of the step at which they come within
/// the thickness: 0 for a pair that already is, 1 for one that only ends the step so. `depth` is how far inside the thickness
/// they are then. `zone` is the vertex that names the group of contacts connected through shared vertices.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct ClothContact {
    pub kind: u32,
    pub v: [u32; 4],
    pub w: [f32; 3],
    pub normal: [f32; 3],
    pub time: f32,
    pub depth: f32,
    pub zone: u32,
}

impl ClothContact {
    pub const EMPTY: ClothContact = ClothContact { kind: 0, v: [0; 4], w: [0.0; 3], normal: [0.0; 3], time: 0.0, depth: 0.0, zone: 0 };
}

/// What a search leaves out: the number of contacts, and whether more were found than the output had room for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Found {
    pub count: usize,
    pub overflow: bool,
}

/// Memory a search works in, from the caller: six numbers a triangle for its swept box, a word a triangle for the sweep order,
/// and a word a vertex for the groups.
pub struct Scratch<'a> {
    pub boxes: &'a mut [f32],
    pub order: &'a mut [u32],
    pub parent: &'a mut [u32],
}

type P = [f64; 3];

#[inline]
fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn add(a: P, b: P) -> P {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn mul(a: P, s: f64) -> P {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn dot(a: P, b: P) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn cross(a: P, b: P) -> P {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
fn root(x: f64) -> f64 {
    if x <= 0.0 { 0.0 } else { sqrt64(x) }
}

/// Square root of a positive f64 by Newton's method from a first guess made of the exponent's half, so that no library
/// function is needed: only + - * / and the bits of the number, the same in every build. Five steps leave full precision.
fn sqrt64(x: f64) -> f64 {
    if !(x > 0.0) || x == f64::INFINITY {
        return if x == f64::INFINITY { x } else { 0.0 };
    }
    let mut r = f64::from_bits((x.to_bits() >> 1) + 0x1ff8_0000_0000_0000);
    for _ in 0..6 {
        r = 0.5 * (r + x / r);
    }
    r
}

/// The point of triangle abc nearest p, and its barycentric weights (Ericson 5.1.5).
fn closest_on_triangle(p: P, a: P, b: P, c: P) -> (P, [f64; 3]) {
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return (a, [1.0, 0.0, 0.0]);
    }
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return (b, [0.0, 1.0, 0.0]);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return (add(a, mul(ab, v)), [1.0 - v, v, 0.0]);
    }
    let cp = sub(p, c);
    let (d5, d6) = (dot(ab, cp), dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return (c, [0.0, 0.0, 1.0]);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return (add(a, mul(ac, w)), [1.0 - w, 0.0, w]);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (add(b, mul(sub(c, b), w)), [0.0, 1.0 - w, w]);
    }
    let denominator = 1.0 / (va + vb + vc);
    let (v, w) = (vb * denominator, vc * denominator);
    (add(a, add(mul(ab, v), mul(ac, w))), [1.0 - v - w, v, w])
}

/// The nearest points of segments p1q1 and p2q2, as the parameters along each (Ericson 5.1.9), and the points.
fn closest_segments(p1: P, q1: P, p2: P, q2: P) -> (f64, f64, P, P) {
    let (d1, d2, r) = (sub(q1, p1), sub(q2, p2), sub(p1, p2));
    let (a, e, f) = (dot(d1, d1), dot(d2, d2), dot(d2, r));
    let tiny = 1e-30;
    let (mut s, mut t);
    if a <= tiny && e <= tiny {
        s = 0.0;
        t = 0.0;
    } else if a <= tiny {
        s = 0.0;
        t = (f / e).clamp(0.0, 1.0);
    } else {
        let c = dot(d1, r);
        if e <= tiny {
            t = 0.0;
            s = (-c / a).clamp(0.0, 1.0);
        } else {
            let b = dot(d1, d2);
            let denominator = a * e - b * b;
            s = if denominator > tiny * a * e { ((b * f - c * e) / denominator).clamp(0.0, 1.0) } else { 0.0 };
            t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
        }
    }
    (s, t, add(p1, mul(d1, s)), add(p2, mul(d2, t)))
}

fn at(s: P, e: P, t: f64) -> P {
    add(s, mul(sub(e, s), t))
}

/// How far to widen a comparison: rounding of the magnitudes the positions have, as Wang et al. widen theirs.
fn slack(scale: f64) -> f64 {
    1e-9 * (scale + 1.0)
}

/// The first time in [0, 1] at which `distance` is within `reach`, for a distance that changes by at most `speed` a unit of time
/// (every point of a moving primitive is a mix of its vertices, so the nearest distance of two of them moves no faster than their
/// fastest vertices together). An interval whose middle is further than reach plus what half the interval can change cannot hold
/// the contact and is dropped; the others are halved, earliest first, down to a width below rounding, where the start of the
/// interval is the time. Nothing within reach is missed, and nothing that stays further than reach plus rounding is reported
/// (Wang et al. 2021's inclusion, with the Lipschitz bound of conservative advancement, Mirtich 1996, as the bound).
fn first_within(distance: &dyn Fn(f64) -> f64, speed: f64, reach: f64) -> Option<f64> {
    let mut stack = [(0.0f64, 1.0f64); 80];
    let mut top = 1;
    while top > 0 {
        top -= 1;
        let (lo, hi) = stack[top];
        let half = 0.5 * (hi - lo);
        let mid = lo + half;
        if distance(mid) - half * speed > reach {
            continue;
        }
        if half < 1e-9 || top + 2 > stack.len() {
            return Some(lo);
        }
        // The right half goes under the left, so the left, the earlier, is looked at first.
        stack[top] = (mid, hi);
        stack[top + 1] = (lo, mid);
        top += 2;
    }
    None
}

fn travel(s: P, e: P) -> f64 {
    let d = sub(e, s);
    root(dot(d, d))
}

struct Hit {
    time: f64,
    weights: [f64; 3],
    normal: P,
    distance: f64,
}

/// The first time within the step a point comes within `h` of a triangle that is moving too, or None. A point already within
/// `h` at the start gives time 0.
fn point_triangle(s: [P; 4], e: [P; 4], h: f64, scale: f64) -> Option<Hit> {
    let reach = h + slack(scale);
    let measure = |t: f64| {
        let (p, a, b, c) = (at(s[0], e[0], t), at(s[1], e[1], t), at(s[2], e[2], t), at(s[3], e[3], t));
        let (q, w) = closest_on_triangle(p, a, b, c);
        let d = sub(p, q);
        (root(dot(d, d)), w, d, cross(sub(b, a), sub(c, a)))
    };
    let distance = |t: f64| measure(t).0;
    let speed = travel(s[0], e[0]) + [1, 2, 3].iter().fold(0.0f64, |m, &i| m.max(travel(s[i], e[i])));
    // The side the point starts on, from the triangle's normal at the start: it is pushed back to that side.
    let (_, _, _, n0) = measure(0.0);
    let side = if dot(sub(s[0], s[1]), n0) >= 0.0 { 1.0 } else { -1.0 };
    let floor = 1e-7 * (scale + 1.0);
    let unit = |d: f64, v: P, n: P| -> P {
        if d > floor {
            mul(v, 1.0 / d)
        } else {
            let l = root(dot(n, n));
            if l > 0.0 { mul(n, side / l) } else { [0.0, side, 0.0] }
        }
    };
    let t = first_within(&distance, speed, reach)?;
    let (d, w, v, n) = measure(t);
    Some(Hit { time: t, weights: w, normal: unit(d, v, n), distance: d })
}

/// As `point_triangle`, for two edges: `s` and `e` are the four ends, the first edge's then the second's.
fn edge_edge(s: [P; 4], e: [P; 4], h: f64, scale: f64) -> Option<Hit> {
    let reach = h + slack(scale);
    let measure = |t: f64| {
        let (a, b, c, d) = (at(s[0], e[0], t), at(s[1], e[1], t), at(s[2], e[2], t), at(s[3], e[3], t));
        let (u, v, p, q) = closest_segments(a, b, c, d);
        let gap = sub(p, q);
        (root(dot(gap, gap)), [u, v, 0.0], gap, cross(sub(b, a), sub(d, c)))
    };
    let distance = |t: f64| measure(t).0;
    let speed = travel(s[0], e[0]).max(travel(s[1], e[1])) + travel(s[2], e[2]).max(travel(s[3], e[3]));
    // Which way the first edge lies from the second at the start: along the edges' common perpendicular.
    let (_, _, _, n0) = measure(0.0);
    let side = if dot(sub(at(s[0], s[1], 0.5), at(s[2], s[3], 0.5)), n0) >= 0.0 { 1.0 } else { -1.0 };
    let floor = 1e-7 * (scale + 1.0);
    let unit = |d: f64, v: P, n: P| -> P {
        if d > floor {
            mul(v, 1.0 / d)
        } else {
            let l = root(dot(n, n));
            if l > 0.0 { mul(n, side / l) } else { [0.0, side, 0.0] }
        }
    };
    let t = first_within(&distance, speed, reach)?;
    let (d, w, v, n) = measure(t);
    Some(Hit { time: t, weights: w, normal: unit(d, v, n), distance: d })
}

fn point(x: &[f32], i: u32) -> P {
    let k = 3 * i as usize;
    [x[k] as f64, x[k + 1] as f64, x[k + 2] as f64]
}

fn extent(x0: &[f32], x1: &[f32], i: u32, lo: &mut [f32; 3], hi: &mut [f32; 3]) {
    for k in 0..3 {
        let (a, b) = (x0[3 * i as usize + k], x1[3 * i as usize + k]);
        let (l, h) = if a <= b { (a, b) } else { (b, a) };
        if l < lo[k] {
            lo[k] = l;
        }
        if h > hi[k] {
            hi[k] = h;
        }
    }
}

/// Orders contacts by kind, vertices, then time, so that equal ones are neighbours and a result never depends on the order the
/// search found them in (heap sort in place: no allocation, no recursion).
fn key(a: &ClothContact, b: &ClothContact) -> bool {
    (a.kind, a.v, a.time.to_bits()) < (b.kind, b.v, b.time.to_bits())
}
fn sift(c: &mut [ClothContact], mut root: usize, end: usize) {
    loop {
        let mut child = 2 * root + 1;
        if child >= end {
            return;
        }
        if child + 1 < end && key(&c[child], &c[child + 1]) {
            child += 1;
        }
        if key(&c[root], &c[child]) {
            c.swap(root, child);
            root = child;
        } else {
            return;
        }
    }
}
fn sort_contacts(c: &mut [ClothContact]) {
    let n = c.len();
    for i in (0..n / 2).rev() {
        sift(c, i, n);
    }
    for end in (1..n).rev() {
        c.swap(0, end);
        sift(c, 0, end);
    }
}

fn find(parent: &mut [u32], mut i: u32) -> u32 {
    while parent[i as usize] != i {
        parent[i as usize] = parent[parent[i as usize] as usize];
        i = parent[i as usize];
    }
    i
}

/// Every pair of triangles of a cloth, moving from `x0` to `x1` (packed x, y, z a vertex), that comes within `thickness` of
/// touching during the step: each vertex against the triangles it is not part of, and each edge against the edges it shares no
/// vertex with. `triangles` holds three vertex indices each. Contacts go into `out`, sorted and without repeats, grouped into
/// zones (Harmon et al. 2008); `Found` says how many, and whether the output was too small for all of them.
///
/// # Panics
/// When a vertex index is out of range, or the scratch is too small: six numbers a triangle in `boxes`, a word a triangle in
/// `order`, a word a vertex in `parent`.
pub fn find_contacts(x0: &[f32], x1: &[f32], triangles: &[u32], thickness: f32, scratch: &mut Scratch, out: &mut [ClothContact]) -> Found {
    let n = triangles.len() / 3;
    let vertices = x0.len() / 3;
    let mut found = Found { count: 0, overflow: false };
    if n == 0 {
        return found;
    }
    let h = thickness.max(0.0);
    // Swept box of each triangle, grown by the thickness.
    let mut scale = 0.0f64;
    for t in 0..n {
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for k in 0..3 {
            extent(x0, x1, triangles[3 * t + k], &mut lo, &mut hi);
        }
        for k in 0..3 {
            scratch.boxes[6 * t + k] = lo[k] - h;
            scratch.boxes[6 * t + 3 + k] = hi[k] + h;
            let m = if lo[k].abs() > hi[k].abs() { lo[k].abs() } else { hi[k].abs() };
            if m as f64 > scale {
                scale = m as f64;
            }
        }
        scratch.order[t] = t as u32;
    }
    // Sort by the low end of x, and sweep.
    let order = &mut scratch.order[..n];
    let boxes = &scratch.boxes;
    let less = |a: u32, b: u32| (boxes[6 * a as usize], a) < (boxes[6 * b as usize], b);
    // Heap sort of the order.
    let sift_o = |order: &mut [u32], mut root: usize, end: usize| loop {
        let mut child = 2 * root + 1;
        if child >= end {
            return;
        }
        if child + 1 < end && less(order[child], order[child + 1]) {
            child += 1;
        }
        if less(order[root], order[child]) {
            order.swap(root, child);
            root = child;
        } else {
            return;
        }
    };
    for i in (0..n / 2).rev() {
        sift_o(order, i, n);
    }
    for end in (1..n).rev() {
        order.swap(0, end);
        sift_o(order, 0, end);
    }
    let h64 = h as f64;
    let mut count = 0usize;
    for i in 0..n {
        let a = order[i] as usize;
        let reach = boxes[6 * a + 3];
        for &bi in order.iter().skip(i + 1) {
            let b = bi as usize;
            if boxes[6 * b] > reach {
                break;
            }
            if (0..3).any(|k| boxes[6 * a + k] > boxes[6 * b + 3 + k] || boxes[6 * b + k] > boxes[6 * a + 3 + k]) {
                continue;
            }
            let (ta, tb) = ([triangles[3 * a], triangles[3 * a + 1], triangles[3 * a + 2]], [triangles[3 * b], triangles[3 * b + 1], triangles[3 * b + 2]]);
            let mut record = |c: ClothContact| {
                if count < out.len() {
                    out[count] = c;
                    count += 1;
                } else {
                    found.overflow = true;
                }
            };
            // Points of each against the other.
            for (pv, tri) in [(ta, tb), (tb, ta)] {
                for &v in pv.iter() {
                    if tri.contains(&v) {
                        continue;
                    }
                    let s = [point(x0, v), point(x0, tri[0]), point(x0, tri[1]), point(x0, tri[2])];
                    let e = [point(x1, v), point(x1, tri[0]), point(x1, tri[1]), point(x1, tri[2])];
                    if let Some(hit) = point_triangle(s, e, h64, scale) {
                        record(ClothContact {
                            kind: POINT_TRIANGLE,
                            v: [v, tri[0], tri[1], tri[2]],
                            w: [hit.weights[0] as f32, hit.weights[1] as f32, hit.weights[2] as f32],
                            normal: [hit.normal[0] as f32, hit.normal[1] as f32, hit.normal[2] as f32],
                            time: hit.time as f32,
                            depth: (h64 - hit.distance).max(0.0) as f32,
                            zone: 0,
                        });
                    }
                }
            }
            // Edges against edges, none that share a vertex.
            for i0 in 0..3 {
                let (a0, a1) = (ta[i0], ta[(i0 + 1) % 3]);
                for i1 in 0..3 {
                    let (b0, b1) = (tb[i1], tb[(i1 + 1) % 3]);
                    if a0 == b0 || a0 == b1 || a1 == b0 || a1 == b1 {
                        continue;
                    }
                    let s = [point(x0, a0), point(x0, a1), point(x0, b0), point(x0, b1)];
                    let e = [point(x1, a0), point(x1, a1), point(x1, b0), point(x1, b1)];
                    if let Some(hit) = edge_edge(s, e, h64, scale) {
                        record(ClothContact {
                            kind: EDGE_EDGE,
                            v: [a0, a1, b0, b1],
                            w: [hit.weights[0] as f32, hit.weights[1] as f32, 0.0],
                            normal: [hit.normal[0] as f32, hit.normal[1] as f32, hit.normal[2] as f32],
                            time: hit.time as f32,
                            depth: (h64 - hit.distance).max(0.0) as f32,
                            zone: 0,
                        });
                    }
                }
            }
        }
    }
    // Sort, and drop repeats: a vertex of several triangles meets another triangle once from each, an edge shared by two
    // triangles meets another edge once from each pair.
    let list = &mut out[..count];
    sort_contacts(list);
    let mut kept = 0;
    for i in 0..count {
        let canonical = list[i];
        let same = kept > 0 && {
            let previous = &list[kept - 1];
            previous.kind == canonical.kind
                && (previous.v == canonical.v || (canonical.kind == EDGE_EDGE && same_edges(&previous.v, &canonical.v)))
        };
        if !same {
            list[kept] = canonical;
            kept += 1;
        }
    }
    found.count = kept;
    // Zones: contacts joined by a shared vertex.
    let parent = &mut scratch.parent[..vertices];
    for (i, p) in parent.iter_mut().enumerate() {
        *p = i as u32;
    }
    for c in out[..kept].iter() {
        let used = if c.kind == POINT_TRIANGLE { 4 } else { 4 };
        let first = find(parent, c.v[0]);
        for &v in c.v.iter().take(used).skip(1) {
            let r = find(parent, v);
            if r != first {
                let (lo, hi) = if first < r { (first, r) } else { (r, first) };
                parent[hi as usize] = lo;
            }
        }
    }
    for c in out[..kept].iter_mut() {
        c.zone = find(parent, c.v[0]);
    }
    found
}

/// Whether two edge pairs name the same two edges, each edge in either direction and the pair in either order.
fn same_edges(a: &[u32; 4], b: &[u32; 4]) -> bool {
    let edge = |x: u32, y: u32| if x < y { (x, y) } else { (y, x) };
    let (ea, eb) = ([edge(a[0], a[1]), edge(a[2], a[3])], [edge(b[0], b[1]), edge(b[2], b[3])]);
    (ea[0] == eb[0] && ea[1] == eb[1]) || (ea[0] == eb[1] && ea[1] == eb[0])
}
